/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isEqualPath, isInsideFolder } from '../base/files';
import { Contract, WindowWorkbench } from '../contract/tools';
import { FacadeError } from '../core/errors';
import { workOf } from '../core/facade';
import { Machine, MachineAnswers, Presence, SilentWindow, WINDOW_REQUESTS } from '../core/machine';
import { MachineCounters } from '../record/counters';
import { Caller, PERSON } from '../record/events';
import { HUMAN, isForeign } from '../record/messages';
import { noticesFor, OutboxNotice, postNotice } from '../record/outbox';
import { settled, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** A workspace of a test's machine: its world, and the contract another workspace's requests reach it through. */
interface Window {
	readonly record: string;
	readonly label: string;
	world: World;
	contract: Contract;
	/** How it answers the others: as it is, not at all - silent - with its agent framework off, or gone: closed, or its app crashed. */
	state: 'answering' | 'silent' | 'off' | 'closed' | 'crashed';
	/** Its unsaved editors, as its workbench would name them in any folder a deletion asks of. */
	editors: string[];
}

/** The deletion marks of the machine, shared by its workspaces: by folder, the workspace deleting it. */
type Marks = Map<string, string>;

/**
 * The machine as one workspace of a test sees the others: each request goes to the other workspace's contract as its pipe
 * would hand it, its arguments as JSON - nothing is shared but what goes through, the outbox and the deletion marks.
 */
class LinkedMachine implements Machine {

	constructor(readonly self: { readonly record: string; readonly label: string }, private readonly others: () => readonly Window[], private readonly outbox: string, private readonly marks: Marks) { }

	ask(tool: string, args: object, waitMs = 0, only?: string): Promise<MachineAnswers> {
		return this.asking(tool, args, waitMs, only, false);
	}

	askEvery(tool: string, args: object, waitMs = 0): Promise<MachineAnswers> {
		return this.asking(tool, args, waitMs, undefined, true);
	}

	async callEvery(tool: string, args: object): Promise<MachineAnswers> {
		const answers: { record: string; label: string; answer: unknown }[] = [];
		const silent: SilentWindow[] = [];
		for (const window of this.others()) {
			if (window.state === 'silent') {
				silent.push({ record: window.record, label: window.label, reason: 'not answering' });
			} else if (window.state === 'answering' || window.state === 'off') {
				this.calls.push(`${tool} ${window.record}`);
				answers.push({ record: window.record, label: window.label, answer: await this.send(window, tool, args) });
			}
		}
		return { answers, silent };
	}

	/** The whole calls `callEvery` handed each workspace, in order: each once (O8). */
	readonly calls: string[] = [];

	/** As the host's: a workspace whose framework is off says so to hello, and is asked - `evenOff` - only what protects work in it. */
	private async asking(tool: string, args: object, waitMs: number, only: string | undefined, evenOff: boolean): Promise<MachineAnswers> {
		if (waitMs && this.others().some(each => each.state === 'silent' && (only === undefined || each.record === only))) {
			await new Promise(resolve => setTimeout(resolve, waitMs));
		}
		const answers: { record: string; label: string; answer: unknown }[] = [];
		const silent: SilentWindow[] = [];
		for (const window of this.others().filter(each => only === undefined || each.record === only)) {
			if (window.state === 'closed' || window.state === 'crashed') {
				continue;
			}
			if (window.state === 'silent') {
				silent.push({ record: window.record, label: window.label, reason: 'not answering' });
				continue;
			}
			// Off by the switch as hello tells it
			if ((window.state === 'off' || !window.world.switches.framework) && !evenOff) {
				silent.push({ record: window.record, label: window.label, reason: 'framework off' });
				continue;
			}
			answers.push({ record: window.record, label: window.label, answer: await this.send(window, tool, args) });
		}
		return { answers, silent };
	}

	askOne(record: string, tool: string, args: object): Promise<unknown> {
		return this.send(this.window(record), tool, args);
	}

	async call(record: string, tool: string, args: object, progress: (message: string) => void): Promise<unknown> {
		const window = this.window(record);
		if (window.state !== 'answering') {
			throw new FacadeError('UNAVAILABLE', `workspace ${window.label} is not answering`);
		}
		return JSON.parse(JSON.stringify(await window.contract.windowCall(tool, JSON.parse(JSON.stringify(args)), progress, () => undefined, workbenchOf(window)) ?? null));
	}

	notice(record: string, notice: OutboxNotice): boolean {
		const window = this.others().find(each => each.record === record);
		if (!window || window.state === 'closed' || window.state === 'crashed') {
			return false;
		}
		postNotice(this.outbox, record, notice);
		if (window.state === 'answering') {
			window.world.facade.mail.takeNotices();
		}
		return true;
	}

	async presence(record: string): Promise<Presence> {
		const window = this.others().find(each => each.record === record);
		if (!window || window.state === 'closed' || window.state === 'crashed') {
			return { kind: 'gone', label: window?.label ?? record, closed: window?.state !== 'crashed', load: 'load-1' };
		}
		return { kind: window.state === 'answering' ? 'live' : window.state === 'off' ? 'off' : 'silent', label: window.label, load: 'load-1' };
	}

	async known(): Promise<readonly { readonly record: string; readonly label: string; readonly workspace?: string }[]> {
		return this.others().filter(each => each.state !== 'closed' && each.state !== 'crashed').map(each => ({ record: each.record, label: each.label, workspace: each.label }));
	}

	async mark(folder: string): Promise<{ readonly placed: true } | { readonly placed: false; readonly by: string }> {
		const by = this.marks.get(folder);
		if (by !== undefined && by !== this.self.label) {
			return { placed: false, by };
		}
		this.marks.set(folder, this.self.label);
		return { placed: true };
	}

	async unmark(folder: string): Promise<void> {
		if (this.marks.get(folder) === this.self.label) {
			this.marks.delete(folder);
		}
	}

	markOver(folder: string): string | undefined {
		return [...this.marks].find(([marked]) => isEqualPath(folder, marked) || isInsideFolder(folder, marked))?.[1];
	}

	async otherVersions(): Promise<readonly string[]> {
		return [];
	}

	private window(record: string): Window {
		const found = this.others().find(each => each.record === record);
		if (!found) {
			throw new FacadeError('NOT_FOUND', `no workspace ${record}`);
		}
		return found;
	}

	private async send(window: Window, tool: string, args: object): Promise<unknown> {
		if (window.state !== 'answering' && window.state !== 'off') {
			throw new FacadeError('FAILED', `workspace ${window.label} is not answering`);
		}
		return JSON.parse(JSON.stringify(await window.contract.windowCall(tool, JSON.parse(JSON.stringify(args)), () => undefined, () => undefined, workbenchOf(window)) ?? null));
	}
}

/** A workspace's workbench, as another workspace's deletion asks it: no terminals, its unsaved editors, which a release with discard drops. */
function workbenchOf(window: Window): WindowWorkbench {
	return {
		workIn: async () => ({ terminals: [], editors: [...window.editors] }),
		workRelease: async (_folder, discard) => {
			if (discard) {
				window.editors = [];
			}
			return [...window.editors];
		}
	};
}

suite('Core: the workspaces of the machine', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let windows: Window[];
	let counters: MachineCounters;
	let marks: Marks;

	setup(() => {
		temp = tempDir('facade-machine-');
		counters = new MachineCounters(path.join(temp.dir, 'counters.json'), path.join(temp.dir, 'workspaces'));
		windows = [];
		marks = new Map();
	});

	teardown(() => {
		windows.forEach(each => each.world.dispose());
		temp.remove();
	});

	/** A workspace of the machine over a repository of its own, called `name`: its worlds number from the machine's counters. */
	function open(name: string, options: { readonly startTimeoutMs?: number; readonly ownNumbers?: boolean; readonly alsoHas?: string; readonly locate?: string } = {}): Window {
		const lab = path.join(temp.dir, name);
		fs.mkdirSync(lab, { recursive: true });
		const record = `${name}-record`;
		const self = { record, label: name };
		const outbox = path.join(temp.dir, 'outbox');
		const machine = new LinkedMachine(self, () => windows.filter(each => each.record !== record), outbox, marks);
		const world = fakeWorld(path.join(temp.dir, 'workspaces', record), {
			// With its own numbers, as a record before machine numbering: every number may be another workspace's too
			repositories: { [lab]: ['work'], ...(options.alsoHas ? { [path.join(temp.dir, options.alsoHas)]: ['work'] } : {}) }, machine, ...(options.ownNumbers ? {} : { counters }), notices: () => noticesFor(outbox, record), roomsFolder: path.join(temp.dir, 'rooms'),
			...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
			...(options.locate !== undefined ? { locate: () => options.locate } : {})
		});
		const window: Window = { record, label: name, world, contract: new Contract(world.facade), state: 'answering', editors: [] };
		windows.push(window);
		return window;
	}

	/** A root the person starts in workspace `of`, and its MCP server connected. */
	async function root(of: Window, name: string, yolo = true) {
		of.world.switches.yolo = yolo;
		const started = await of.world.startUp(PERSON, { name, cli: 'arg', folder: worktreeFolder(path.join(temp.dir, of.label), 'work') });
		of.world.hello(started.id);
		return callerOf(of.world.agent(started.id));
	}

	/** `start_agent` from `from`'s caller into a folder of `to`, its child's MCP server connecting there as its terminal opens. */
	async function startAcross(from: Window, caller: Caller, args: object, to: Window) {
		const before = to.world.terminals.launched.length;
		let over = false;
		const call = from.contract.call(caller, 'start_agent', args, () => undefined);
		call.then(() => over = true, () => over = true);
		await until(() => over || to.world.terminals.launched.length > before, 10_000);
		if (!over) {
			to.world.hello(Number(/#a(\d+)$/.exec(to.world.terminals.launched[before].name)?.[1]));
		}
		return settled(call, 10_000);
	}

	/** The rows of a list's text - each agent's line cut before its creator, with the workspace it ends with - and its other lines that say where. */
	function rowsOf(text: string): string[] {
		return text.split('\n').filter(line => /^@|^Your children|^Not listed/.test(line)).map(line => line.replace(/ {2}creator[\s\S]*?(( {2}workspace \S+)?)$/, '$1'));
	}

	test('numbers are unique on the machine: two workspaces starting agents and sending messages take turns from its counters; nothing is shared below the mark (L2, L12; LA-23)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		const again = await root(a, 'again');
		const sent = [a.world.facade.mail.send(lead, ['@again'], 'One.', undefined)[0].id, b.world.facade.mail.send(other, ['@human'], 'Two.', undefined)[0].id];

		assert.deepStrictEqual({ agents: [lead.id, other.id, again.id], sent, shared: [counters.shared('agents'), counters.shared('messages')] }, {
			agents: [1, 2, 3],
			sent: [1, 2],
			shared: [0, 0]
		});
	});

	test('a workspace answers cross-window messages while its CLI look is stuck; rows wait only two seconds (REMOTE.md R2; O8)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		let release = () => { };
		b.world.refreshes.waiting = new Promise(resolve => release = resolve);
		const caller = a.world.facade.identityOf(lead);
		const ask = (request: string) => b.contract.windowCall(request, { caller, ids: [] }, () => undefined, () => undefined, workbenchOf(b));
		const start = Date.now();
		const messages = await settled(ask(WINDOW_REQUESTS.messages));
		const messageMs = Date.now() - start;
		const rows = await settled(ask(WINDOW_REQUESTS.rows));
		const rowsMs = Date.now() - start - messageMs;
		const looks = b.world.refreshes.count;
		release();

		assert.deepStrictEqual({ messages: !!messages, prompt: messageMs <= 10, rows: !!rows, rowsMs, looks }, {
			messages: true, prompt: true, rows: true, rowsMs: 2000, looks: 1
		});
	});

	test('list_agents lists the caller\'s own workspace, named once, without all; with all every workspace, a row of another naming it; YOLO off sees its tree in every workspace; a silent workspace is named (O6; OR-31, OR-40)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const c = open('gamma');
		const lead = await root(a, 'lead');
		const off = await root(a, 'quiet', false);
		await root(b, 'other');
		await startAcross(a, off, { name: 'helper', cli: 'arg', folder: worktreeFolder(path.join(temp.dir, 'beta'), 'work') }, b);
		c.state = 'silent';
		const own = await a.contract.call(lead, 'list_agents', {}, () => undefined);
		const all = await a.contract.call(lead, 'list_agents', { all: true }, () => undefined);
		const tree = await a.contract.call(off, 'list_agents', {}, () => undefined);
		const treeAll = await a.contract.call(off, 'list_agents', { all: true }, () => undefined);

		assert.deepStrictEqual({
			own: [own.text.split('\n')[0], ...rowsOf(own.text)],
			all: rowsOf(all.text),
			tree: rowsOf(tree.text),
			treeAll: rowsOf(treeAll.text)
		}, {
			own: ['You are @lead #a1 in workspace alpha. YOLO on: you can reach every agent in every Facade workspace on this machine.', '@lead #a1 (you)'],
			all: ['@lead #a1 (you)', '@quiet #a2', '@other #a3  workspace beta', '@helper #a4  workspace beta', 'Not listed: workspace gamma is not answering (it may be reloading, restarting or busy).'],
			tree: ['@quiet #a2 (you)', 'Your children in other workspaces: @helper #a4 (workspace beta, betareco). list_agents all:true lists them.'],
			treeAll: ['@quiet #a2 (you)', '@helper #a4  workspace beta', 'Not listed: workspace gamma is not answering (it may be reloading, restarting or busy).']
		});
	});

	test('a reference is resolved across the machine: a number or a name of the other workspace reaches its agent there, stop_agent stopping it in its own workspace by an agent of the caller\'s; a name in both workspaces is refused, naming each with its workspace (O2, O5, O8; OR-32)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		await root(a, 'review');
		const other = await root(b, 'other');
		await root(b, 'review');
		const named = await a.contract.call(lead, 'stop_agent', { agent: '@other' }, () => undefined);
		const twice = await a.contract.call(lead, 'stop_agent', { agent: '@review' }, () => undefined);
		const end = b.world.agent(other.id!).end;

		assert.deepStrictEqual({ named: named.text, twice: twice.text, by: isForeign(end?.by) ? `${end?.by.name} of ${end?.by.window}` : end?.by, alpha: a.world.agent(lead.id!).state }, {
			named: 'Stopped @other #a3: its terminal closed. Its worktree is unchanged.',
			twice: '\'@review\' is ambiguous: it matches @review #a2 (workspace alpha, alpharec), @review #a4 (workspace beta, betareco). Pass the one you mean as written here.',
			by: 'lead of alpha-record',
			alpha: 'running'
		});
	});

	test('a child started in another workspace, starting one of its own there, keeps it in the tree whose root is back where it began: with YOLO off they reach each other (O8, O11; OR-39)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead', false);
		const folder = worktreeFolder(path.join(temp.dir, 'beta'), 'work');
		const child = b.world.agent(((await startAcross(a, lead, { name: 'child', cli: 'arg', folder }, b)).data as { id: number }).id);
		const grand = b.world.agent(((await startAcross(b, callerOf(child), { name: 'grand', cli: 'arg', folder }, b)).data as { id: number }).id);
		const report = await b.contract.call(callerOf(grand), 'send_message', { to: `#a${child.id}`, text: 'Done.' }, () => undefined);

		assert.deepStrictEqual({ tree: b.world.facade.treeOf(grand), report: report.text.split('\n')[0] }, {
			tree: { root: lead.id, window: 'alpha-record' },
			report: `Sent #m${(report.data as { messages?: { id: number }[] }).messages?.[0].id} to @child #a${child.id}. Not yet fetched.`
		});
	});

	test('the sender\'s copy of a message to another workspace is read as any message here: by its sender, not by an agent of another tree with YOLO off (M4; O1)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		const quiet = await root(a, 'quiet', false);
		await a.contract.call(lead, 'send_message', { to: `#a${other.id}`, text: 'For the tree alone.' }, () => undefined);
		const copy = [...a.world.table.state.mail.messages.keys()].pop()!;
		const outsider = await a.contract.call(quiet, 'read_messages', { ids: `#m${copy}` }, () => undefined);
		const sender = await a.contract.call(lead, 'read_messages', { ids: `#m${copy}` }, () => undefined, listener => listener(true));

		assert.deepStrictEqual({ outsider: outsider.text, sender: ((sender.data as { messages?: { text?: string }[] }).messages ?? []).map(each => each.text) }, {
			outsider: `Cannot fetch #m${copy}: it is outside your reach. With YOLO off, an ID lookup can read only messages to or from your tree, rooted at @quiet #a${quiet.id}. Nothing was fetched.`,
			sender: ['For the tree alone.']
		});
	});

	test('a start in a workspace whose framework is off is refused saying so, as an agent of it is - not as one that may answer shortly (O3, O8)', async () => {
		const a = open('alpha');
		const b = open('beta', { alsoHas: 'alpha' });
		const lead = await root(a, 'lead');
		b.world.switches.framework = false;
		const started = await a.contract.call(lead, 'start_agent', { name: 'there', cli: 'arg', workspace: 'beta' }, () => undefined);

		assert.deepStrictEqual({ text: started.text, reason: (started.data as { reason?: string }).reason }, {
			text: 'Cannot start an agent there: workspace beta has its agent framework turned off (framework_disabled), so no agent can start there until it is turned on there. Nothing was started.',
			reason: 'frameworkOff'
		});
	});

	test('a message from before this session, its chat rooms deleted from another workspace, is said to be no longer available - not in a room that is gone (M9; M10)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const other = await root(b, 'other');
		const gone = await root(b, 'gone');
		await b.contract.call(other, 'send_message', { to: `#a${gone.id}`, text: 'Old.' }, () => undefined);
		const old = [...b.world.table.state.mail.messages.keys()].pop()!;
		await b.world.facade.stopAgent(PERSON, `#a${gone.id}`);
		a.world.facade.mail.deleteRooms();
		// As the workspace starts afresh: the agents that ended leave the list, their mailboxes with them
		b.world.table.clearList();
		const read = await b.contract.call(PERSON, 'read_messages', { ids: `#m${old}` }, () => undefined);

		assert.strictEqual(read.text, `Message #m${old} predates this window's current session, and its chat rooms were deleted. The message is no longer available.`);
	});

	test('the person\'s history of every workspace says which did not answer, whose messages are not in it, in its text and its data (M9)', async () => {
		open('alpha');
		const b = open('beta');
		b.state = 'silent';
		const read = await settled(windows[0].contract.call(PERSON, 'read_messages', { all: true }, () => undefined), 20_000);

		assert.deepStrictEqual({ text: read.text, silent: (read.data as { silent?: string[] }).silent }, {
			text: 'No messages have been sent to you.\nNot included: the messages of workspace beta, which did not answer. Retry shortly for them.',
			silent: ['beta']
		});
	});

	test('a reference ending in a workspace that has no such agent is not found there - never taken for this workspace\'s agent of that number or name - and nothing is done (O2; OR-32)', async () => {
		const a = open('alpha');
		open('beta');
		const lead = await root(a, 'lead');
		const victim = await root(a, 'victim');
		const byNumber = await a.contract.call(lead, 'stop_agent', { agent: `#a${victim.id} (workspace beta)` }, () => undefined);
		const byName = await a.contract.call(lead, 'stop_agent', { agent: '@victim (workspace beta, betareco)' }, () => undefined);

		assert.deepStrictEqual({ byNumber: byNumber.text, byName: byName.text, victim: a.world.agent(victim.id!).state }, {
			byNumber: `Workspace beta, betareco has no agent '#a${victim.id}' that you can reach. Nothing was done. Call list_agents with all:true to see every reachable run.`,
			byName: 'Workspace beta, betareco has no agent \'@victim\' that you can reach. Nothing was done. Call list_agents with all:true to see every reachable run.',
			victim: 'running'
		});
	});

	test('numbers given before machine numbering, an agent\'s and a message\'s held by both workspaces, are refused written as each workspace\'s; written so, each picks its own, here or there - a silent workspace not named is not waited for (O2, O8; M4; OR-32)', async () => {
		const a = open('alpha', { ownNumbers: true });
		const b = open('beta', { ownNumbers: true });
		const c = open('gamma', { ownNumbers: true });
		const lead = await root(a, 'claude');
		const other = await root(b, 'claude');
		await a.contract.call(lead, 'send_message', { to: '#a1 (workspace alpha, alpharec)', text: 'Mine.' }, () => undefined);
		await b.contract.call(other, 'send_message', { to: '#a1 (workspace beta, betareco)', text: 'Theirs.' }, () => undefined);
		const agent = await a.contract.call(lead, 'read_screen', { agent: '@claude #a1' }, () => undefined);
		const message = await a.contract.call(lead, 'read_messages', { ids: '#m1' }, () => undefined);
		c.state = 'silent';
		const there = await settled(a.contract.call(lead, 'send_message', { to: '@claude #a1 (workspace beta, betareco)', text: 'Hi.' }, () => undefined), 5_000);
		const theirs = await settled(a.contract.call(lead, 'read_messages', { ids: ['#m1 (workspace beta, betareco)'] }, () => undefined, listener => listener(true)), 5_000);
		const mine = await settled(a.contract.call(lead, 'read_messages', { ids: '#m1 (workspace alpha, alpharec)' }, () => undefined, listener => listener(true)), 5_000);
		const texts = (result: { readonly data?: unknown }) => ((result.data as { messages?: { text?: string }[] }).messages ?? []).map(each => each.text);

		assert.deepStrictEqual({ lead: lead.id, other: other.id, agent: agent.text, message: message.text, there: there.text.split('\n')[0], theirs: texts(theirs), mine: texts(mine) }, {
			lead: 1,
			other: 1,
			agent: '\'@claude #a1\' is ambiguous: it matches @claude #a1 (workspace alpha, alpharec), @claude #a1 (workspace beta, betareco). Pass the one you mean as written here.',
			message: '#m1 is ambiguous: 2 workspaces each hold a different message with that ID, given before numbers were unique on the machine. Pass the one you mean as written here: #m1 (workspace alpha, alpharec), #m1 (workspace beta, betareco). Nothing was fetched.',
			there: 'Sent #m2 to @claude #a1 (workspace beta, betareco). Not yet fetched.',
			theirs: ['Theirs.'],
			mine: ['Mine.']
		});
	});

	test('a silent workspace keeps a name it may hold from being settled for a moment, then the call is refused naming it and the way round; a number above the shared mark, found, needs no wait (O8; OR-40)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const c = open('gamma');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		c.state = 'silent';
		const byName = await settled(a.contract.call(lead, 'read_screen', { agent: '@nobody' }, () => undefined), 20_000);
		const byNumber = await settled(a.world.facade.locate(lead, `#a${other.id}`), 20_000);

		assert.deepStrictEqual({ byName: byName.text, byNumber }, {
			byName: 'Cannot resolve \'@nobody\' yet: workspace gamma is not answering (it may be reloading, restarting or busy), and it may hold a match. Nothing was done. Retry shortly, or use the agent ID (#a7) of the agent you mean, or end the reference in the workspace you mean, as #a7 (workspace lab).',
			byNumber: { here: false, window: 'beta-record', label: 'beta', id: other.id }
		});
	});

	test('with YOLO off, an agent of another workspace outside the caller\'s tree is refused as outside it - as one of its own workspace would be - not taken for no agent at all (O1, O2; OR-07, OR-31)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const off = await root(a, 'quiet', false);
		const other = await root(b, 'other');
		const stopped = await a.contract.call(off, 'stop_agent', { agent: `#a${other.id}` }, () => undefined);

		assert.deepStrictEqual({ text: stopped.text, code: (stopped.data as { code?: string }).code, there: b.world.agent(other.id!).state }, {
			text: `#a${other.id} is outside your tree. With YOLO off, you can reach only your tree: your human-started root and all its descendants.`,
			code: 'REFUSED',
			there: 'running'
		});
	});

	test('an agent of a workspace whose framework is off is out of reach, said so - not taken for no agent at all; once it is on again, the message goes (O8; L13; OR-34)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		b.world.switches.framework = false;
		const off = await a.contract.call(lead, 'send_message', { to: `#a${other.id}`, text: 'Hi.' }, () => undefined);
		b.world.switches.framework = true;
		const on = await a.contract.call(lead, 'send_message', { to: `#a${other.id}`, text: 'Hi.' }, () => undefined);

		assert.deepStrictEqual({ off: off.text, on: on.text.split('\n')[0] }, {
			off: `Cannot reach '#a${other.id}': workspace beta has its agent framework turned off (framework_disabled), so its agents cannot be reached until it is turned on there; no workspace that answers has it. Nothing was done.`,
			on: `Sent #m1 to @other #a${other.id} (workspace beta, betareco). Not yet fetched.`
		});
	});

	test('a message to an agent of another workspace is numbered and rung there, the sender\'s copy kept here under that number; its reply comes back; read by number, a copy takes its state from the recipient\'s workspace (M2, M4, M11; MS-29, MS-30)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		const sent = await a.world.facade.mail.sendAcross(lead, ['@other'], 'Report?', undefined);
		const id = sent.sent[0].id;
		const there = b.world.table.state.mail.messages.get(id);
		const fetched = await b.world.fetched(other.id!);
		const reply = await b.world.facade.mail.sendAcross(other, ['#a1'], 'Done.', `#m${id}`);
		const copy = await a.world.facade.mail.fetch(lead, { ids: [`#m${id}`] }, listener => listener(true));
		const got = await a.world.fetched(lead.id!);

		assert.deepStrictEqual({
			sent: sent.sent.map(each => `#m${each.id} to ${each.to}`),
			there: isForeign(there?.from) ? `from ${there?.from.name} of ${there?.from.window} to #a${there?.to}` : there?.from,
			fetched: fetched.messages.map(each => `${each.from}: ${each.text}`),
			copy: copy.messages.map(each => `#m${each.id} ${each.state} in ${each.window}`),
			got: got.messages.map(each => `#m${each.id} from ${each.from}, reply to #m${each.replyTo}: ${each.text}`),
			replied: reply.sent.map(each => each.id)
		}, {
			sent: [`#m1 to @other #a2 (workspace beta, betareco)`],
			there: 'from lead of alpha-record to #a2',
			fetched: ['@lead #a1 (workspace alpha, alpharec): Report?'],
			copy: ['#m1 delivered in beta'],
			got: ['#m2 from @other #a2 (workspace beta, betareco), reply to #m1: Done.'],
			replied: [2]
		});
	});

	test('a recipient that ends with mail of another workspace\'s sender unread returns it through that workspace\'s outbox, once however often it is left, a reload of the sender\'s workspace meanwhile too; one whose workspace closes ends with it (M6; L6; MS-31, LA-24)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		await root(b, 'second');
		await a.world.facade.mail.sendAcross(lead, ['@other'], 'First.', undefined);
		await a.world.facade.mail.sendAcross(lead, ['@second'], 'Second.', undefined);
		a.state = 'silent';
		await b.world.facade.stopAgent(PERSON, `#a${other.id}`);
		const whileSilent = a.world.facadeMessagesTo(lead.id!).length;
		a.state = 'answering';
		a.world.facade.mail.takeNotices();
		b.world.facade.windowClosing();
		a.world.facade.mail.takeNotices();
		const back = a.world.facadeMessagesTo(lead.id!).map(text => text.split('\n')[0]);

		assert.deepStrictEqual({ whileSilent, back, beta: [...b.world.table.state.agents.values()].map(agent => `${agent.name} ${agent.state}: ${agent.end?.reason}`) }, {
			whileSilent: 0,
			back: [
				'#m1 was returned because @other #a2 (workspace beta, betareco) ended without fetching it (stopped by @human with stop_agent).',
				'#m2 was returned because @second #a3 (workspace beta, betareco) ended without fetching it (stopped: its window closed).'
			],
			beta: ['other ended: with stop_agent', 'second ended: its window closed']
		});
	});

	test('an agent of another workspace written as Facade writes it - `@name #a7 (workspace beta, betareco)` - is a reference to it; the person\'s message from another workspace that its recipient ends without goes back to the person there (O2; M6)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const lead = await root(a, 'lead');
		const other = await root(b, 'other');
		const sent = await a.world.facade.mail.sendAcross(lead, ['@other #a2 (workspace beta, betareco)'], 'Hi.', undefined);
		await a.world.facade.mail.sendAcross(PERSON, ['#a2'], 'From the person.', undefined);
		await b.world.facade.stopAgent(PERSON, `#a${other.id}`);
		const returnsTo = (window: Window) => (window.world.table.state.mail.mailboxes.get(HUMAN) ?? []).map(id => window.world.table.state.mail.messages.get(id)!).filter(message => message.facade === 'returned').map(message => window.world.table.messages.textOf(message)?.split('\n')[0]);
		const person = returnsTo(a);

		assert.deepStrictEqual({ sent: sent.sent.map(each => each.to), person, there: returnsTo(b) }, {
			sent: ['@other #a2 (workspace beta, betareco)'],
			person: ['#m2 was returned because @other #a2 (workspace beta, betareco) ended without fetching it (stopped by @human with stop_agent).'],
			there: []
		});
	});

	test('a child started by path in a folder of another workspace starts there, the caller\'s, its task numbered there and its copy kept here; its end and its workspace\'s close tell its creator; a crash of that workspace is told by the creator\'s own (O3, O8, O11; M7, M8; OR-38, OR-39, OR-41, MS-32)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const c = open('gamma');
		const lead = await root(a, 'lead');
		const theirs = worktreeFolder(path.join(temp.dir, 'beta'), 'work');
		const started = await startAcross(a, lead, { name: 'helper', cli: 'arg', folder: theirs, task: 'Look around.' }, b);
		const helper = b.world.agent((started.data as { id: number }).id);
		const task = b.world.table.state.mail.tasks.get(helper.id);
		await startAcross(a, lead, { name: 'third', cli: 'arg', folder: worktreeFolder(path.join(temp.dir, 'gamma'), 'work') }, c);
		await b.world.facade.stopAgent(PERSON, `#a${helper.id}`);
		a.world.facade.mail.takeNotices();
		c.state = 'crashed';
		await a.world.facade.checkAway();
		const told = a.world.facadeMessagesTo(lead.id!).map(text => text.split('\n')[0]);

		assert.deepStrictEqual({
			result: started.text.split('\n').slice(-1)[0],
			helper: { creator: helper.creatorAfar && `${helper.creatorAfar.name} of ${helper.creatorAfar.window}`, yolo: helper.yolo, folder: helper.folder === theirs },
			task: { there: isForeign(b.world.table.state.mail.messages.get(task!)?.from), copy: isForeign(a.world.table.state.mail.messages.get(task!)?.to) },
			children: a.world.table.state.childrenAfar.get(lead.id!)?.map(each => `${each.name} in ${each.window}`),
			told
		}, {
			result: 'The child runs in workspace beta.',
			helper: { creator: 'lead of alpha-record', yolo: true, folder: true },
			task: { there: true, copy: true },
			children: ['helper in beta-record', 'third in gamma-record'],
			told: [
				'#m1 was returned because @helper #a2 (workspace beta, betareco) ended without fetching it (stopped by @human with stop_agent).',
				'@helper #a2 (workspace beta, betareco) ended: stopped by @human with stop_agent. It can no longer receive messages. No final screen was saved. Call read_screen with agent #a2 to find out why.',
				'@third #a3 (workspace gamma, gammarec) ended with its workspace gamma, whose app ended unexpectedly. It can no longer receive messages.'
			]
		});
	});

	test('a folder several workspaces have is refused until workspace names one; a named workspace without it is refused; an ambiguous workspace name is refused (O2, O3; OR-38)', async () => {
		const a = open('alpha');
		open('beta');
		const lead = await root(a, 'lead');
		const shared = worktreeFolder(path.join(temp.dir, 'alpha'), 'work');
		const theirs = worktreeFolder(path.join(temp.dir, 'beta'), 'work');
		const wrong = await a.contract.call(lead, 'start_agent', { name: 'x', cli: 'arg', folder: shared, workspace: 'beta' }, () => undefined);
		const nowhere = await a.contract.call(lead, 'start_agent', { name: 'x', cli: 'arg', folder: theirs, workspace: 'delta' }, () => undefined);

		assert.deepStrictEqual({ wrong: wrong.text, nowhere: nowhere.text.split('.')[0] }, {
			wrong: `${shared} is no folder of workspace beta. Nothing was started. Workspaces that have it: alpha.`,
			nowhere: 'No workspace on this machine is named \'delta\''
		});
	});

	test('on Windows, a child of another workspace\'s agent starts through cmd.exe all the same: its first line names its creator with that workspace, in parentheses, which reach it whole (O2; L10)', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const a = open('alpha');
		const b = open('beta', { locate: path.join(temp.dir, 'bin', 'arg.cmd') });
		const lead = await root(a, 'lead');
		const started = await startAcross(a, lead, { name: 'there', cli: 'arg', task: 'Look.', folder: worktreeFolder(path.join(temp.dir, 'beta'), 'work') }, b);
		const { args } = b.world.terminals.launched[0];

		assert.deepStrictEqual({ started: started.isError ? started.text : true, first: /created by (@\S+ #a\d+ \(workspace [^)]*\))/.exec(args[args.length - 1])?.[1] }, { started: true, first: `@lead #a${lead.id} (workspace alpha, alpharec)` });
	});

	test('with workspace and no folder, the child starts there in the caller\'s own folder, which that workspace has too (O3; OR-38)', async () => {
		const a = open('alpha');
		const b = open('beta', { alsoHas: 'alpha' });
		const lead = await root(a, 'lead');
		const started = await startAcross(a, lead, { name: 'there', cli: 'arg', workspace: 'beta' }, b);
		const child = b.world.agent((started.data as { id: number }).id);

		assert.deepStrictEqual({ folder: child.folder, creator: child.creatorAfar?.id }, { folder: a.world.agent(lead.id!).folder, creator: lead.id });
	});

	test('another workspace\'s deletion asks what this one has there, as the caller reaches it - a YOLO-off caller reaches no other tree - and that one\'s deletion mark refuses a start there here (O5; WT-8; OR-33, OR-34)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const off = await root(a, 'quiet', false);
		const other = await root(b, 'other');
		const theirs = worktreeFolder(path.join(temp.dir, 'beta'), 'work');
		const asked = await b.world.facade.workIn(theirs, { id: off.id, name: off.name, from: { window: 'alpha-record', label: 'alpha', yolo: false, root: off.id, rootWindow: 'alpha-record' } });
		marks.set(theirs, 'alpha');
		const blocked = await b.contract.call(other, 'start_agent', { name: 'late', cli: 'arg' }, () => undefined);

		assert.deepStrictEqual({ asked, blocked: blocked.text }, {
			asked: [{ agent: '@other #a2', id: 2, reached: false }],
			blocked: `Cannot start an agent in ${theirs} while workspace alpha is deleting it. Choose another folder, or retry once the deletion is over.`
		});
	});

	test('what protects work in a workspace is asked whatever its framework switch, as the workspace that answers it would be: an agent deleting stops there only what it reaches, the others left and said; who asks is told on as it came, and a caller named back to its own workspace is the one it knows (O1, O5, O8)', async () => {
		const a = open('alpha');
		const b = open('beta');
		const off = await root(a, 'quiet', false);
		const other = await root(b, 'other');
		const theirs = worktreeFolder(path.join(temp.dir, 'beta'), 'work');
		const foreign = { id: off.id, name: off.name, from: { window: 'alpha-record', label: 'alpha', yolo: false, root: off.id, rootWindow: 'alpha-record' } };
		b.world.switches.framework = false;
		const machine = a.world.facade.machine!;
		const asked = await machine.askEvery(WINDOW_REQUESTS.workIn, { folder: theirs, caller: foreign });
		const plain = await machine.ask(WINDOW_REQUESTS.workIn, { folder: theirs, caller: foreign });
		const released = await machine.callEvery(WINDOW_REQUESTS.workRelease, { folder: theirs, discard: false, caller: foreign });
		const back = await b.contract.windowCall(WINDOW_REQUESTS.workIn, { folder: theirs, caller: { id: other.id, name: other.name, from: { window: 'beta-record', label: 'beta' } } }, () => undefined, () => undefined, { workIn: async () => ({ terminals: [], editors: [] }), workRelease: async () => [] });

		assert.deepStrictEqual({
			asked: asked.answers.map(each => [each.record, workOf(each.answer).agents]),
			plain: plain.silent.map(each => each.reason),
			released: released.answers.map(each => [each.record, each.answer]),
			once: (machine as LinkedMachine).calls,
			there: b.world.agent(other.id!).state,
			told: a.world.facade.identityOf(foreign),
			back: workOf(back).agents
		}, {
			asked: [['beta-record', [{ agent: '@other #a2', id: 2, reached: false }]]],
			plain: ['framework off'],
			released: [['beta-record', { stopping: ['@other #a2, outside the deleting agent\'s tree'], left: [] }]],
			once: ['window.workRelease beta-record'],
			there: 'running',
			told: foreign,
			back: [{ agent: '@other #a2', id: 2, reached: true }]
		});
	});
});
