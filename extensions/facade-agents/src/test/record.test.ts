/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { agentName, AgentTable, nameOfWorktree, NewAgent } from '../record/agents';
import { agentRef, describe, LedgerEventBody, parseAgentReference, PERSON } from '../record/events';
import { isLedgerHeld, Ledger, LedgerLockedError, lockStateOf, lockWait } from '../record/ledger';
import { identityOf, isWorkspaceId, recordDirOf, recordFor } from '../record/identity';
import { AGENTS_LOG } from '../record/log';
import { injectedFile, workspacesRoot } from '../record/paths';
import { cutNextWriteShort, fsError, replaceFsFunction, sleep, tempDir, waitFor } from './util';

const LEDGER = 'ledger.jsonl';
const LOCK = 'ledger.lock';
const LAST_ID = 'last-id';
/** A lock as another window writes it: its process id, and a mark of its own. */
const ANOTHERS_LOCK = '424242 0123456789ab';

/** An agent the person starts, or the agent `creator` does. */
function newAgent(name: string, creator?: number, worktree = 'main'): NewAgent {
	return { name, creator, cli: 'arg', model: 'small', effort: 'high', worktree, folder: '/lab' };
}

/** A worktree the person had Facade make, called `name`. */
function made(name: string): LedgerEventBody {
	return { type: 'worktree.made', name, folder: `/lab-${name}`, repository: '/lab', commit: 'c0ffee' };
}

/** What a call came to: `done`, or the code of what it threw, else its message. */
function outcome(call: () => unknown): string {
	try {
		call();
		return 'done';
	} catch (err) {
		return codeOf(err) ?? messageOf(err);
	}
}

/** What a window is told once another window took the ledger in `dir`. */
function takenFrom(dir: string): string {
	return `Another Facade window took this workspace's agents: the ledger in ${dir} takes no event more from this one.`;
}

/** Makes reading `file` fail with `code` while `failing` says so; returns what puts reading back. */
function failReading(file: string, code: string, failing: () => boolean = () => true): () => void {
	return replaceFsFunction('readFileSync', original => ((...args: Parameters<typeof fs.readFileSync>) => {
		if (args[0] === file && failing()) {
			throw fsError(code, 'open');
		}
		return original(...args);
	}) as typeof fs.readFileSync);
}

suite('Record: agents, their numbers, names and tokens', () => {

	let temp: { dir: string; remove(): void };
	let table: AgentTable;

	setup(() => {
		temp = tempDir('facade-agents-');
		table = AgentTable.open({ dir: temp.dir });
	});

	teardown(() => {
		table.dispose();
		temp.remove();
	});

	test('an agent gets the next number, never one given before: numbers count up from 1, across a reopening too', () => {
		const first = table.start(newAgent('main'));
		table.end(first.agent.id, 'exited', 'its CLI ended');
		const second = table.start(newAgent('main'));
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });
		const third = table.start(newAgent('main'));

		assert.deepStrictEqual([first.agent.id, second.agent.id, third.agent.id], [1, 2, 3]);
	});

	test('numbers count on from the highest ever given, which last-id keeps: past a ledger begun anew - the old one moved aside - and past a number its ledger never recorded', () => {
		table.start(newAgent('main'));
		table.start(newAgent('clamp'));
		table.dispose();
		// As the person moves aside a ledger that does not open.
		fs.renameSync(path.join(temp.dir, LEDGER), path.join(temp.dir, 'ledger.broken.jsonl'));
		table = AgentTable.open({ dir: temp.dir });
		const anew = table.start(newAgent('main')).agent.id;
		table.dispose();
		// Given by a window that ended before its ledger recorded it.
		fs.writeFileSync(path.join(temp.dir, LAST_ID), '9');
		table = AgentTable.open({ dir: temp.dir });
		const pastAGap = table.start(newAgent('main')).agent.id;
		table.dispose();
		fs.writeFileSync(path.join(temp.dir, LAST_ID), 'nine');
		table = AgentTable.open({ dir: temp.dir });
		const pastNonsense = table.start(newAgent('main')).agent.id;

		assert.deepStrictEqual({ anew, pastAGap, pastNonsense, kept: fs.readFileSync(path.join(temp.dir, LAST_ID), 'utf8') }, { anew: 3, pastAGap: 10, pastNonsense: 11, kept: '11' });
	});

	test('a workspace whose ledger an older Facade wrote counts on from its last-pid, where there is no last-id: no number is given twice', () => {
		table.dispose();
		fs.writeFileSync(path.join(temp.dir, 'last-pid'), '7');
		table = AgentTable.open({ dir: temp.dir });
		const fromLastPid = table.start(newAgent('main')).agent.id;
		table.dispose();
		fs.writeFileSync(path.join(temp.dir, 'last-pid'), '99');
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ fromLastPid, lastIdFirst: table.start(newAgent('main')).agent.id }, { fromLastPid: 8, lastIdFirst: 9 });
	});

	test('each agent\'s token is written to its run folder, and names it until it ends; the ledger keeps its hash alone; the person\'s token is the person\'s', () => {
		const main = table.start(newAgent('main'));
		const personsToken = fs.readFileSync(path.join(temp.dir, 'you.token'), 'utf8');
		const heard = table.authenticate(fs.readFileSync(main.tokenFile, 'utf8'));
		table.end(main.agent.id, 'stopped', 'its tab was closed', { by: 'human' });

		assert.deepStrictEqual({
			heard,
			afterExit: table.authenticate(main.token),
			person: table.authenticate(personsToken),
			stranger: table.authenticate('not a token'),
			inTheLedger: fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8').includes(main.token),
			runFileGone: !fs.existsSync(main.tokenFile)
		}, { heard: { id: 1, name: 'main' }, afterExit: undefined, person: PERSON, stranger: undefined, inTheLedger: false, runFileGone: true });
	});

	test('an agent is starting, connected once its MCP server said hello, running once it started, stopping once Facade set out to stop it, and ends once: the first end stands, with how, by whom, why, its exit code and when', () => {
		const main = table.start(newAgent('main'));
		const states = [main.agent.state];
		table.launched(main.agent.id, 4242);
		table.connected(main.agent.id);
		states.push(main.agent.state);
		table.running(main.agent.id);
		states.push(main.agent.state);
		table.stopping(main.agent.id, 'with stop_agent', 'human');
		states.push(main.agent.state);
		const first = table.end(main.agent.id, 'stopped', 'with stop_agent', { by: 'human', exitCode: 143 });
		const second = table.end(main.agent.id, 'exited', 'its CLI ended with exit code 1', { exitCode: 1 });
		table.running(main.agent.id);

		assert.deepStrictEqual({ states, connected: main.agent.connected, processId: main.agent.processId, first: first && { ...first, time: 0 }, second, state: main.agent.state, end: main.agent.end === first, stopping: main.agent.stopping }, {
			states: ['starting', 'starting', 'running', 'stopping'],
			connected: true,
			processId: 4242,
			first: { kind: 'stopped', by: 'human', reason: 'with stop_agent', exitCode: 143, time: 0 },
			second: undefined,
			state: 'ended',
			end: true,
			stopping: undefined
		});
	});

	test('a task to type is written whole to a file of its agent\'s own, made knowing its number; its typing, once begun, is not known to have arrived until it was typed; an argument\'s and none are never typed', () => {
		const told = table.start({ ...newAgent('main'), task: id => `You are #a${id}.\n\nAdd clamp.` });
		const byArgument = table.start({ ...newAgent('other'), task: 'argument' });
		const none = table.start(newAgent('none'));
		const pending = told.agent.task;
		table.taskTyping(told.agent.id);
		const typing = told.agent.task;
		table.taskTyped(told.agent.id);
		table.taskTyped(told.agent.id);
		table.taskTyping(byArgument.agent.id);
		table.taskTyped(none.agent.id);
		const types = fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).type);

		assert.deepStrictEqual({
			taskFile: table.taskFileOf(told.agent.id) === path.join(table.runsDir, '1.task.md'),
			task: fs.readFileSync(path.join(table.runsDir, '1.task.md'), 'utf8'),
			tasks: [pending, typing, told.agent.task, byArgument.agent.task, none.agent.task],
			types
		}, {
			taskFile: true,
			task: 'You are #a1.\n\nAdd clamp.',
			tasks: ['pending', 'unknown', 'typed', 'argument', 'none'],
			types: ['agent.started', 'agent.started', 'agent.started', 'task.typing', 'task.typed']
		});
	});

	test('an agent\'s creator is the one that started it, and stays so once that one ended: nobody takes in the agents it started', () => {
		const main = table.start(newAgent('main')).agent;
		const child = table.start(newAgent('clamp', main.id, 'clamp')).agent;
		const grandchild = table.start(newAgent('slug', child.id, 'slug')).agent;
		const before = { main: main.creator, child: child.creator, grandchild: grandchild.creator, ofMain: table.childrenOf(main.id).map(each => each.id) };
		table.end(child.id, 'stopped', 'with stop_agent', { by: main.id });

		assert.deepStrictEqual({
			before,
			grandchild: grandchild.creator,
			ofMain: table.childrenOf(main.id).map(each => each.id),
			ofTheChild: table.childrenOf(child.id).map(each => each.id),
			ofThePerson: table.childrenOf(undefined).map(each => each.id)
		}, {
			before: { main: undefined, child: 1, grandchild: 2, ofMain: [2] },
			grandchild: 2,
			ofMain: [],
			ofTheChild: [3],
			ofThePerson: [1]
		});
	});

	test('a name is a label: agents that have not ended may share it, and one that ended has it no more', () => {
		const first = table.start(newAgent('main')).agent;
		const second = table.start(newAgent('main')).agent;
		const both = table.liveNamed('main').map(each => each.id);
		table.end(first.id, 'exited', 'its CLI ended');

		assert.deepStrictEqual({ both, one: table.liveNamed('main').map(each => each.id), none: table.liveNamed('nobody'), second: second.name }, { both: [1, 2], one: [2], none: [], second: 'main' });
	});

	test('a name is taken as it is given, trimmed: one that is no name - with an @, in upper case, reserved - is refused, saying why; a worktree\'s gives a name, its branch\'s slashes as dashes, never one Facade keeps', () => {
		const refused = (text: string) => {
			try {
				return agentName(text);
			} catch (err) {
				return messageOf(err);
			}
		};

		assert.deepStrictEqual({
			named: [agentName('clamp'), agentName(' slug.2_x ')],
			refused: [refused('@clamp'), refused('Clamp'), refused('human'), refused('you'), refused('-x'), refused('a b'), refused('x'.repeat(41))],
			ofWorktrees: [nameOfWorktree('Feature/Clamp-It'), nameOfWorktree('main'), nameOfWorktree('human'), nameOfWorktree('init'), nameOfWorktree('---')]
		}, {
			named: ['clamp', 'slug.2_x'],
			refused: [
				'"@clamp" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'"Clamp" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'"human" is reserved: choose another name.',
				'"you" is reserved: choose another name.',
				'"-x" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'"a b" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				`"${'x'.repeat(41)}" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.`
			],
			ofWorktrees: ['feature-clamp-it', 'main', 'agent', 'agent', 'agent']
		});
	});

	test('an agent\'s number is written #a7, and a tool\'s reference reads #a7, #7, a7 and 7 as its number - a7 and 7 bare, as a name could be them too - @name and name as a name, @name #a7 as both, and #m7 as another kind\'s number', () => {
		assert.deepStrictEqual({
			written: [agentRef(7), describe({ id: 7, name: 'lint' }), describe(PERSON)],
			read: ['#a7', '#7', ' a7 ', '7', '#A7', '@Lint', 'lint', '@lint #a7', '@lint #7', '#m7', '@lint #m7'].map(parseAgentReference)
		}, {
			written: ['#a7', '@lint #a7', '@human'],
			read: [
				{ kind: 'number', id: 7, bare: false },
				{ kind: 'number', id: 7, bare: false },
				{ kind: 'number', id: 7, bare: true },
				{ kind: 'number', id: 7, bare: true },
				{ kind: 'number', id: 7, bare: false },
				{ kind: 'name', name: 'lint' },
				{ kind: 'name', name: 'lint' },
				{ kind: 'number', id: 7, name: 'lint', bare: false },
				{ kind: 'number', id: 7, name: 'lint', bare: false },
				{ kind: 'other', text: '#m7' },
				{ kind: 'other', text: '@lint #m7' }
			]
		});
	});

	test('the run files of an agent go once it ends, and those of every agent that has ended go as the table opens', () => {
		const gone = table.start({ ...newAgent('gone'), task: () => 'Task.' });
		const runs = table.start({ ...newAgent('runs'), task: () => 'Task.' });
		table.end(gone.agent.id, 'exited', 'its terminal closed');
		const afterExit = fs.readdirSync(table.runsDir).sort();
		// A file a crash left, of a number the ledger never recorded.
		fs.writeFileSync(path.join(table.runsDir, '9.token'), 'x');
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ afterExit, afterOpening: fs.readdirSync(table.runsDir).sort(), runs: runs.agent.id }, {
			afterExit: ['2.task.md', '2.token'],
			afterOpening: ['2.task.md', '2.token'],
			runs: 2
		});
	});

	test('nothing is started once another window took the ledger: no number is given, and no token or task written, which could be that window\'s', () => {
		table.start(newAgent('main'));
		fs.writeFileSync(path.join(temp.dir, LOCK), ANOTHERS_LOCK);
		const refused = outcome(() => table.start({ ...newAgent('late'), task: () => 'Task.' }));

		assert.deepStrictEqual({ refused, runs: fs.readdirSync(table.runsDir), lastId: fs.readFileSync(path.join(temp.dir, LAST_ID), 'utf8') }, {
			refused: takenFrom(temp.dir),
			runs: ['1.token'],
			lastId: '1'
		});
	});
});

suite('Record: the ledger on disk', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-ledger-');
	});

	teardown(() => {
		temp.remove();
	});

	test('a reload loses nothing: agents, their states, how they ended, their tasks, their processes, their tokens and the person\'s, the worktrees made', () => {
		let table = AgentTable.open({ dir: temp.dir });
		const main = table.start({ ...newAgent('main'), task: () => 'Lead.' });
		table.launched(main.agent.id, 4242);
		table.connected(main.agent.id);
		table.taskTyping(main.agent.id);
		table.taskTyped(main.agent.id);
		table.running(main.agent.id);
		const gone = table.start(newAgent('clamp', main.agent.id, 'clamp'));
		table.end(gone.agent.id, 'failed', 'it did not start within 120 seconds');
		const stopping = table.start({ ...newAgent('slug', main.agent.id, 'slug'), task: 'argument' });
		table.stopping(stopping.agent.id, 'with stop_agent', main.agent.id);
		table.recordWorktree({ name: 'clamp', folder: '/lab-worktrees/clamp', repository: '/lab', commit: 'c0ffee', madeBy: main.agent.id });
		const personsToken = fs.readFileSync(path.join(temp.dir, 'you.token'), 'utf8');
		const before = structuredClone([...table.state.agents.values()]);
		table.dispose();

		table = AgentTable.open({ dir: temp.dir });
		const reloaded = {
			agents: [...table.state.agents.values()],
			token: table.authenticate(main.token),
			personsToken: fs.readFileSync(path.join(temp.dir, 'you.token'), 'utf8') === personsToken,
			worktrees: [...table.state.worktrees.values()],
			next: table.start(newAgent('next')).agent.id
		};
		table.dispose();

		assert.deepStrictEqual(reloaded, {
			agents: before,
			token: { id: 1, name: 'main' },
			personsToken: true,
			worktrees: [{ name: 'clamp', folder: '/lab-worktrees/clamp', repository: '/lab', commit: 'c0ffee', madeBy: 1 }],
			next: 4
		});
	});

	test('a worktree Facade made that is gone is its no more: its record goes, and stays gone at the next start; a folder it did not make records nothing', () => {
		let table = AgentTable.open({ dir: temp.dir });
		table.recordWorktree({ name: 'clamp', folder: '/lab-worktrees/clamp', repository: '/lab', commit: 'c0ffee' });
		table.recordWorktree({ name: 'slug', folder: '/lab-worktrees/slug', repository: '/lab', commit: 'c0ffee' });
		table.forgetWorktree('/lab-worktrees/clamp');
		const seq = table.state.seq;
		table.forgetWorktree('/lab-worktrees/never');
		const now = { worktrees: [...table.state.worktrees.keys()], nothingMore: table.state.seq === seq, slug: table.madeWorktree('/lab-worktrees/slug')?.name, clamp: table.madeWorktree('/lab-worktrees/clamp') };
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ now, again: [...table.state.worktrees.keys()] }, {
			now: { worktrees: ['/lab-worktrees/slug'], nothingMore: true, slug: 'slug', clamp: undefined },
			again: ['/lab-worktrees/slug']
		});
		table.dispose();
	});

	test('a last line cut short by a crash is dropped, and the file is repaired', () => {
		let table = AgentTable.open({ dir: temp.dir });
		const main = table.start(newAgent('main'));
		const seq = table.state.seq;
		table.dispose();
		const file = path.join(temp.dir, LEDGER);
		fs.appendFileSync(file, '{"v":4,"seq":2,"type":"agent.ru');

		table = AgentTable.open({ dir: temp.dir });
		const afterCrash = table.state.seq;
		table.end(main.agent.id, 'exited', 'its terminal closed');
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ afterCrash, state: table.get(main.agent.id)?.state, lines: fs.readFileSync(file, 'utf8').split('\n').map(line => line && JSON.parse(line).type) }, {
			afterCrash: seq,
			state: 'ended',
			lines: ['agent.started', 'agent.ended', '']
		});
		table.dispose();
	});

	test('an event the disk took only part of leaves nothing of it: the line is cut back, the state stays, and the next event follows the last whole one', () => {
		const ledger = Ledger.open(temp.dir);
		ledger.append(made('clamp'));
		const file = path.join(temp.dir, LEDGER);
		const whole = fs.readFileSync(file, 'utf8');
		const restore = cutNextWriteShort();
		const failed = outcome(() => ledger.append(made('slug')));
		restore();
		const afterFailure = { cutBack: fs.readFileSync(file, 'utf8') === whole, seq: ledger.state.seq };
		ledger.append(made('next'));
		ledger.close();
		const reopened = Ledger.open(temp.dir);
		reopened.close();

		assert.deepStrictEqual({ failed, afterFailure, worktrees: [...reopened.state.worktrees.keys()] }, {
			failed: 'ENOSPC',
			afterFailure: { cutBack: true, seq: 1 },
			worktrees: ['/lab-clamp', '/lab-next']
		});
	});

	test('an event cut short that cannot be cut back closes the ledger, so that it stays the last line, which the next opening drops; Facade let go of it, the window staying', () => {
		const ledger = Ledger.open(temp.dir);
		ledger.append(made('clamp'));
		const restoreWrite = cutNextWriteShort();
		const restoreTruncate = replaceFsFunction('truncateSync', () => () => {
			throw fsError('EIO', 'ftruncate');
		});
		const failed = outcome(() => ledger.append(made('slug')));
		restoreWrite();
		restoreTruncate();
		const refused = outcome(() => ledger.append(made('late')));
		const lock = fs.readFileSync(path.join(temp.dir, LOCK), 'utf8');
		const reopened = Ledger.open(temp.dir);
		reopened.close();

		assert.deepStrictEqual({ failed, refused, lock, seq: reopened.state.seq, lines: fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8').split('\n').length }, {
			failed: 'ENOSPC',
			refused: `The ledger in ${temp.dir} is closed.`,
			lock: 'released',
			seq: 1,
			lines: 2
		});
	});

	test('a line that cannot be read before the last stops the workspace from opening while its agents may run, and says which: one that is no event, or one that does not fit those before it; the file is left as it was, and no lock', () => {
		const table = AgentTable.open({ dir: temp.dir });
		table.start(newAgent('main'));
		table.dispose();
		const file = path.join(temp.dir, LEDGER);
		const lines = fs.readFileSync(file, 'utf8');
		const broken = (line: string) => {
			fs.writeFileSync(file, `${lines}${line}\n{"v":4,"seq":3,"time":1,"type":"agent.running","id":1}\n`);
			try {
				AgentTable.open({ dir: temp.dir }).dispose();
				return 'opened';
			} catch (err) {
				return messageOf(err);
			} finally {
				assert.strictEqual(fs.readFileSync(file, 'utf8').startsWith(`${lines}${line}\n`), true);
			}
		};
		// #2 started by #1, and a worktree made by #1, as Facade writes them but for `fields`.
		const started = (fields: object) => JSON.stringify({ v: 4, seq: 2, time: 1, type: 'agent.started', id: 2, name: 'clamp', creator: 1, cli: 'arg', model: 'small', effort: 'high', worktree: 'clamp', folder: '/lab', task: 'pending', tokenHash: 'ab'.repeat(32), ...fields });
		const worktree = (fields: object) => JSON.stringify({ v: 4, seq: 2, time: 1, type: 'worktree.made', name: 'clamp', folder: '/lab-clamp', repository: '/lab', commit: 'c0ffee', madeBy: 1, ...fields });
		const event = (fields: object) => JSON.stringify({ v: 4, seq: 2, time: 1, id: 1, ...fields });
		const said = `Line 2 of ${file} is not an event Facade can read, so this window starts and stops no agent of this workspace while an agent of it may still run. Its next start with none running begins a new list.`;

		assert.deepStrictEqual({
			asWritten: [broken(started({})), broken(worktree({})), broken(event({ type: 'agent.stopping', by: 'human', reason: 'its tab was closed' })), broken(event({ type: 'agent.ended', kind: 'exited', reason: 'its CLI ended', exitCode: 3 })), broken(event({ type: 'agent.launched', processId: 42 })), broken(event({ type: 'list.cleared', id: undefined }))],
			thePersons: [broken(started({ creator: undefined })), broken(worktree({ madeBy: undefined }))],
			noEffort: broken(started({ effort: undefined })),
			anEmptyEffort: broken(started({ effort: '' })),
			notJson: broken('{"v":4,'),
			unknownKind: broken(event({ type: 'agent.later' })),
			wrongKind: broken(event({ type: 'agent.ended', kind: 'vanished', reason: '?' })),
			anExitCodeNoNumber: broken(event({ type: 'agent.ended', kind: 'exited', reason: '?', exitCode: 'one' })),
			aStartingTaskTyped: broken(started({ task: 'typed' })),
			noProcess: broken(event({ type: 'agent.launched', processId: 0 })),
			outOfTurn: broken('{"v":4,"seq":5,"time":1,"type":"agent.running","id":1}'),
			anOlderVersions: broken('{"v":3,"seq":2,"time":1,"type":"agent.running","id":1}'),
			noNumber: broken(started({ id: 0 })),
			aNumberGivenBefore: broken(started({ id: 1, creator: undefined })),
			aCreatorOfNoNumber: broken(started({ creator: 0 })),
			aNullCreator: broken(started({ creator: null })),
			anUnknownCreator: broken(started({ id: 5, creator: 4 })),
			anEscapeInTheName: broken(started({ name: `${String.fromCharCode(27)}[2J` })),
			aReservedName: [broken(started({ name: 'human' })), broken(started({ name: 'you' }))],
			noFolder: broken(started({ folder: '' })),
			noTokenHash: broken(started({ tokenHash: 'a token' })),
			anUnknownAgent: broken(event({ type: 'agent.ended', id: 9, kind: 'stopped', reason: '?' })),
			anUnknownStopper: broken(event({ type: 'agent.stopping', by: 9, reason: '?' })),
			anUnknownMaker: broken(worktree({ madeBy: 9 })),
			aWorktreeWithoutFolder: broken(worktree({ folder: '' })),
			lockLeft: fs.existsSync(path.join(temp.dir, LOCK))
		}, {
			asWritten: ['opened', 'opened', 'opened', 'opened', 'opened', 'opened'],
			thePersons: ['opened', 'opened'],
			noEffort: said,
			anEmptyEffort: said,
			notJson: said,
			unknownKind: said,
			wrongKind: said,
			anExitCodeNoNumber: said,
			aStartingTaskTyped: said,
			noProcess: said,
			outOfTurn: said,
			anOlderVersions: said,
			noNumber: said,
			aNumberGivenBefore: said,
			aCreatorOfNoNumber: said,
			aNullCreator: said,
			anUnknownCreator: said,
			anEscapeInTheName: said,
			aReservedName: [said, said],
			noFolder: said,
			noTokenHash: said,
			anUnknownAgent: said,
			anUnknownStopper: said,
			anUnknownMaker: said,
			aWorktreeWithoutFolder: said,
			lockLeft: false
		});
	});

	test('a ledger that is there but cannot be read is not taken for an empty one: opening it fails, and leaves no lock', () => {
		fs.mkdirSync(path.join(temp.dir, LEDGER));
		const opened = outcome(() => Ledger.open(temp.dir).close());

		assert.deepStrictEqual({ opened, lockLeft: fs.existsSync(path.join(temp.dir, LOCK)) }, { opened: 'EISDIR', lockLeft: false });
	});

	test('a token of the person\'s that cannot be read is not made anew, which would cut off the scripts that hold it: the workspace does not open, and says why', () => {
		AgentTable.open({ dir: temp.dir }).dispose();
		const file = path.join(temp.dir, 'you.token');
		const token = fs.readFileSync(file, 'utf8');
		const restore = failReading(file, 'EACCES');
		let opened: string;
		try {
			opened = outcome(() => AgentTable.open({ dir: temp.dir }).dispose());
		} finally {
			restore();
		}

		assert.deepStrictEqual({ opened, kept: fs.readFileSync(file, 'utf8') === token, then: outcome(() => AgentTable.open({ dir: temp.dir }).dispose()) }, { opened: 'EACCES', kept: true, then: 'done' });
	});

	test('a ledger another version wrote is left as it is while its agents may run; once none can, it is kept beside, as it is, and a new list begins, its numbers going on', () => {
		fs.writeFileSync(path.join(temp.dir, LAST_ID), '6');
		const old = `{"v":3,"seq":1,"time":1,"type":"agent.started","id":6,"name":"main","cli":"arg","model":"small","effort":"high","worktree":"main","folder":"/lab","tokenHash":"${'ab'.repeat(32)}"}\n`;
		const file = path.join(temp.dir, LEDGER);
		fs.writeFileSync(file, old);

		const whileTheyMayRun = outcome(() => AgentTable.open({ dir: temp.dir, mayMoveAside: () => false }).dispose());
		const untouched = fs.readFileSync(file, 'utf8') === old;
		const table = AgentTable.open({ dir: temp.dir, mayMoveAside: () => true });
		const fresh = { agents: table.state.agents.size, id: table.start(newAgent('main')).agent.id };
		table.dispose();
		const kept = fs.readdirSync(temp.dir).filter(name => /^ledger\.v3\.\d+\.jsonl$/.test(name));

		assert.deepStrictEqual({ whileTheyMayRun, untouched, fresh, kept: kept.length, same: kept.length === 1 && fs.readFileSync(path.join(temp.dir, kept[0]), 'utf8') === old }, {
			whileTheyMayRun: `${file} is a ledger of version 3, which this Facade does not read, so this window starts and stops no agent of this workspace while an agent of it may still run. Its next start with none running begins a new list.`,
			untouched: true,
			fresh: { agents: 0, id: 7 },
			kept: 1,
			same: true
		});
	});

	test('a ledger with a line it cannot read is kept beside, as it is, once none of its agents can run, and a new list begins', () => {
		const table = AgentTable.open({ dir: temp.dir });
		table.start(newAgent('main'));
		table.dispose();
		const file = path.join(temp.dir, LEDGER);
		fs.appendFileSync(file, '{"v":4,"seq":7}\n{"v":4,"seq":8}\n');
		const broken = fs.readFileSync(file, 'utf8');

		const reopened = AgentTable.open({ dir: temp.dir, mayMoveAside: () => true });
		const fresh = { agents: reopened.state.agents.size, id: reopened.start(newAgent('main')).agent.id };
		reopened.dispose();
		const kept = fs.readdirSync(temp.dir).filter(name => /^ledger\.unreadable\.\d+\.jsonl$/.test(name));

		assert.deepStrictEqual({ fresh, kept: kept.length, same: kept.length === 1 && fs.readFileSync(path.join(temp.dir, kept[0]), 'utf8') === broken }, { fresh: { agents: 0, id: 2 }, kept: 1, same: true });
	});

	test('a new list drops the agents that ended before it, but for the creators of the agents it keeps, and stays so through a reopening: numbers go on, and a creator it dropped is named by its number alone', () => {
		let table = AgentTable.open({ dir: temp.dir });
		const lead = table.start(newAgent('lead')).agent;
		const child = table.start(newAgent('child', lead.id)).agent;
		const done = table.start(newAgent('done')).agent;
		const grandchild = table.start(newAgent('grandchild', child.id)).agent;
		table.end(lead.id, 'exited', 'its CLI ended');
		table.end(done.id, 'stopped', 'its tab was closed', { by: 'human' });
		table.end(child.id, 'exited', 'its CLI ended');
		table.clearList();
		const listed = [...table.state.agents.keys()];
		table.dispose();
		table = AgentTable.open({ dir: temp.dir });

		assert.deepStrictEqual({ listed, again: [...table.state.agents.keys()], creators: [child, grandchild].map(each => table.whoIs(table.get(each.id)?.creator)), next: table.start(newAgent('next')).agent.id }, {
			listed: [2, 4],
			again: [2, 4],
			creators: ['#a1', '@child #a2'],
			next: 5
		});
		table.dispose();
	});

	test('the log has a line for each start and each end - the agent, its creator, how it ended and who stopped it, named as Facade names them - kept through a new list and a ledger begun anew', () => {
		let table = AgentTable.open({ dir: temp.dir });
		const lead = table.start(newAgent('lead')).agent;
		const child = table.start(newAgent('child', lead.id)).agent;
		table.end(child.id, 'stopped', 'with stop_agent', { by: lead.id });
		table.end(lead.id, 'exited', 'its CLI ended with exit code 1', { exitCode: 1 });
		table.clearList();
		table.dispose();
		fs.appendFileSync(path.join(temp.dir, LEDGER), '{"v":4,"seq":97}\n{"v":4,"seq":98}\n');
		table = AgentTable.open({ dir: temp.dir, mayMoveAside: () => true });
		const next = table.start(newAgent('next')).agent;
		table.end(next.id, 'stopped', 'its tab was closed', { by: 'human' });
		table.dispose();
		const lines = fs.readFileSync(path.join(temp.dir, AGENTS_LOG), 'utf8').split('\n');

		assert.deepStrictEqual({ lines: lines.map(line => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/, '')), timed: lines.slice(0, -1).every(line => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/.test(line)) }, {
			lines: [
				'started  @lead #a1  arg small high  by @human  in /lab',
				'started  @child #a2  arg small high  by @lead #a1  in /lab',
				'ended    @child #a2  stopped by @lead #a1: with stop_agent',
				'ended    @lead #a1  exited: its CLI ended with exit code 1',
				'started  @next #a3  arg small high  by @human  in /lab',
				'ended    @next #a3  stopped by @human: its tab was closed',
				''
			],
			timed: true
		});
	});

	test('a line the log cannot take is left out: the agent starts and ends all the same', () => {
		fs.mkdirSync(path.join(temp.dir, AGENTS_LOG));
		const table = AgentTable.open({ dir: temp.dir });
		const agent = table.start(newAgent('main')).agent;
		const end = table.end(agent.id, 'exited', 'its CLI ended');
		table.dispose();

		assert.deepStrictEqual({ id: agent.id, end: end?.kind }, { id: 1, end: 'exited' });
	});

	test('a ledger that was closed takes no event more: it says so, and writes nothing into the file another window may hold by then', () => {
		const ledger = Ledger.open(temp.dir);
		ledger.append(made('clamp'));
		ledger.close();
		const next = Ledger.open(temp.dir);
		const written = fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8');
		const refused = outcome(() => ledger.append(made('late')));
		next.close();

		assert.deepStrictEqual({ refused, unchanged: fs.readFileSync(path.join(temp.dir, LEDGER), 'utf8') === written, seq: ledger.state.seq }, {
			refused: `The ledger in ${temp.dir} is closed.`,
			unchanged: true,
			seq: 1
		});
	});

	test('a second window is refused while the first is alive, and takes over once it is gone; a window that closed holds the ledger a minute, for its reload', () => {
		const lock = path.join(temp.dir, LOCK);
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		let refused: string | undefined;
		let touchedAt: boolean | undefined;
		try {
			Ledger.open(temp.dir, { isRunning: () => true });
		} catch (err) {
			refused = err instanceof LedgerLockedError ? err.message : `not refused: ${err}`;
			touchedAt = err instanceof LedgerLockedError && err.pid === 424242 && err.touchedAt === fs.statSync(lock).mtimeMs;
		}
		Ledger.open(temp.dir, { isRunning: () => false }).close();
		const heldAfterClosing = isLedgerHeld(temp.dir, () => true);
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);

		assert.deepStrictEqual({ refused, touchedAt, lock: fs.readFileSync(lock, 'utf8'), heldAfterClosing, heldAMinuteOn: isLedgerHeld(temp.dir, () => true) }, {
			refused: 'Another Facade window (process 424242) has this workspace\'s agents.',
			touchedAt: true,
			lock: 'closed',
			heldAfterClosing: true,
			heldAMinuteOn: false
		});
	});

	test('a lock whose process is alive, but that no window has touched for a while, is no window\'s - its process id may be another program\'s by now - and is taken over', () => {
		const lock = path.join(temp.dir, LOCK);
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		const longAgo = new Date(Date.now() - 5 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		const heldBefore = isLedgerHeld(temp.dir, () => true);

		const ledger = Ledger.open(temp.dir, { isRunning: () => true });
		const taken = fs.readFileSync(lock, 'utf8').startsWith(`${process.pid} `);
		const heldNow = isLedgerHeld(temp.dir, () => true);
		ledger.close();

		assert.deepStrictEqual({ heldBefore, taken, heldNow }, { heldBefore: false, taken: true, heldNow: true });
	});

	test('a ledger says how the window that had it before let go of it - as the window went: it quit, closed or reloaded; or as Facade let go of its agents, the window staying - and which window that was: this workspace\'s or another\'s, this very window or another load of it; nothing the first time, nor after a crash, its lock left behind', () => {
		const lock = path.join(temp.dir, LOCK);
		const first = Ledger.open(temp.dir, { owner: 'lab', session: 'load-1' });
		const firstTime = first.lastClose;
		first.close();
		const closedLock = fs.readFileSync(lock, 'utf8');
		// Its extension host starting again, in the same load of the window
		const sameLoad = Ledger.open(temp.dir, { owner: 'lab', session: 'load-1' });
		const thisWindow = sameLoad.lastClose;
		sameLoad.close('facade');
		const releasedLock = fs.readFileSync(lock, 'utf8');
		// After a reload, or the window closed and opened again
		const nextLoad = Ledger.open(temp.dir, { owner: 'lab', session: 'load-2' });
		const ownWindow = nextLoad.lastClose;
		nextLoad.close();
		// Another workspace's window, a minute on
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		const another = Ledger.open(temp.dir, { owner: 'notes', session: 'load-3' });
		const anotherWindow = another.lastClose;
		another.close();
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		const afterCrash = Ledger.open(temp.dir, { isRunning: () => false });
		const crashed = afterCrash.lastClose;
		afterCrash.close();

		assert.deepStrictEqual({ firstTime, closedLock, thisWindow, releasedLock, ownWindow, anotherWindow, crashed }, {
			firstTime: undefined,
			closedLock: 'closed lab load-1',
			thisWindow: { by: 'window', ownWindow: true, thisWindow: true },
			releasedLock: 'released lab load-1',
			ownWindow: { by: 'facade', ownWindow: true, thisWindow: false },
			anotherWindow: { by: 'window', ownWindow: false, thisWindow: false },
			crashed: undefined
		});
	});

	test('a ledger closed as its window reloads, or let go of by Facade, is that workspace\'s to take back at once; another workspace\'s window waits for a minute, then takes it', () => {
		const lock = path.join(temp.dir, LOCK);
		Ledger.open(temp.dir, { owner: 'lab' }).close();
		const closedBy = fs.readFileSync(lock, 'utf8');
		let refused: string | undefined;
		let touchedAt: boolean | undefined;
		try {
			Ledger.open(temp.dir, { owner: 'notes' }).close();
		} catch (err) {
			refused = err instanceof LedgerLockedError ? `${err.pid}: ${err.message}` : messageOf(err);
			touchedAt = err instanceof LedgerLockedError && err.touchedAt === fs.statSync(lock).mtimeMs;
		}
		const reloaded = outcome(() => Ledger.open(temp.dir, { owner: 'lab' }).close('facade'));
		const releasedBy = fs.readFileSync(lock, 'utf8');
		const releasedRefused = outcome(() => Ledger.open(temp.dir, { owner: 'notes' }).close());
		const turnedOnAgain = outcome(() => Ledger.open(temp.dir, { owner: 'lab' }).close());
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);

		assert.deepStrictEqual({ closedBy, refused, touchedAt, reloaded, releasedBy, releasedRefused, turnedOnAgain, aMinuteOn: outcome(() => Ledger.open(temp.dir, { owner: 'notes' }).close()), lock: fs.readFileSync(lock, 'utf8') }, {
			closedBy: 'closed lab',
			refused: 'undefined: Another Facade window has this workspace\'s agents: it closed them a moment ago, as it reloads.',
			touchedAt: true,
			reloaded: 'done',
			releasedBy: 'released lab',
			releasedRefused: 'Another Facade window has this workspace\'s agents: Facade there let go of them a moment ago.',
			turnedOnAgain: 'done',
			aMinuteOn: 'done',
			lock: 'closed notes'
		});
	});

	test('a window that finds the ledger locked waits while the window before lets go of it, then while nobody touches the lock, until it may take it over; a lock touched again after the handover is a running window\'s', () => {
		const realNow = Date.now;
		const start = 1_000_000;
		let now = start;
		Date.now = () => now;
		const at = (time: number, wait: (err: unknown) => boolean, err: unknown) => {
			now = time;
			return wait(err);
		};
		const locked = (touchedAt: number) => new LedgerLockedError(424242, touchedAt);
		/** A wait that begins at `start`. */
		const waitFromStart = () => {
			now = start;
			return lockWait(10_000);
		};
		try {
			// The window before touches it as it lets go; then a window that runs touches it again.
			const running = waitFromStart();
			const handedOver = [
				at(start, running, locked(start - 1_000)),
				at(start + 5_000, running, locked(start + 5_000)),
				at(start + 10_000, running, locked(start + 5_000)),
				at(start + 30_000, running, locked(start + 5_000)),
				at(start + 35_000, running, locked(start + 35_000))
			];
			// Nobody touches it: its window ended, and its process id is another program's now.
			const ended = waitFromStart();
			const untouched = [
				at(start, ended, locked(start - 20_000)),
				at(start + 10_000, ended, locked(start - 20_000)),
				at(start + 94_999, ended, locked(start - 20_000)),
				at(start + 95_000, ended, locked(start - 20_000))
			];
			const other = waitFromStart();

			assert.deepStrictEqual({ handedOver, untouched, otherFailure: at(start, other, new Error('EACCES')) }, {
				handedOver: [true, true, true, true, false],
				untouched: [true, true, true, false],
				otherFailure: false
			});
		} finally {
			Date.now = realNow;
		}
	});

	test('a window whose ledger another window took is told, once: as its heartbeat finds it, or as an event does', async () => {
		const told = { beat: 0, event: 0 };
		const beat = path.join(temp.dir, 'beat');
		const event = path.join(temp.dir, 'event');
		const beating = Ledger.open(beat, { heartbeatMs: 10, onTaken: () => told.beat++ });
		const writing = Ledger.open(event, { onTaken: () => told.event++ });
		fs.writeFileSync(path.join(beat, LOCK), ANOTHERS_LOCK);
		fs.writeFileSync(path.join(event, LOCK), ANOTHERS_LOCK);
		const refused = [outcome(() => writing.append(made('late'))), outcome(() => writing.append(made('later')))];
		await waitFor(() => told.beat > 0, 1000);
		// Long enough for another beat, which should tell nobody again.
		await sleep(50);

		assert.deepStrictEqual({ told, refused, afterwards: outcome(() => beating.append(made('late'))) }, {
			told: { beat: 1, event: 1 },
			refused: [takenFrom(event), takenFrom(event)],
			afterwards: takenFrom(beat)
		});
	});

	test('a lock that names this window\'s own process - left by an opening of it that never closed - is no other window\'s, and is taken over', () => {
		const lock = path.join(temp.dir, LOCK);
		const left = `${process.pid} 0123456789ab`;
		fs.writeFileSync(lock, left);
		const ledger = Ledger.open(temp.dir, { isRunning: () => true });
		const taken = fs.readFileSync(lock, 'utf8');
		ledger.close();

		assert.deepStrictEqual({ mine: taken.startsWith(`${process.pid} `), anew: taken !== left }, { mine: true, anew: true });
	});

	test('the window that has the ledger open touches its lock as often as it is told to, so that other windows see it is there', async () => {
		const ledger = Ledger.open(temp.dir, { heartbeatMs: 10 });
		const lock = path.join(temp.dir, LOCK);
		const longAgo = new Date(Date.now() - 5 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		const before = isLedgerHeld(temp.dir, () => true);
		const touched = await waitFor(() => isLedgerHeld(temp.dir, () => true), 1000).then(() => true, () => false);
		ledger.close();

		assert.deepStrictEqual({ before, touched }, { before: false, touched: true });
	});

	test('a window whose lock another window took - this one stood still past the lock\'s time - writes nothing more: its next event says why, and the other\'s lock stays', () => {
		const ledger = Ledger.open(temp.dir);
		ledger.append(made('clamp'));
		const file = path.join(temp.dir, LEDGER);
		const lock = path.join(temp.dir, LOCK);
		const written = fs.readFileSync(file, 'utf8');
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		const refused = outcome(() => ledger.append(made('late')));
		ledger.close();

		assert.deepStrictEqual({ refused, unchanged: fs.readFileSync(file, 'utf8') === written, lock: fs.readFileSync(lock, 'utf8'), seq: ledger.state.seq }, {
			refused: takenFrom(temp.dir),
			unchanged: true,
			lock: ANOTHERS_LOCK,
			seq: 1
		});
	});

	test('nor does it touch that window\'s lock: the heartbeat that finds the lock another\'s stops', async () => {
		const ledger = Ledger.open(temp.dir, { heartbeatMs: 10 });
		const lock = path.join(temp.dir, LOCK);
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		const longAgo = new Date(Date.now() - 5 * 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		await sleep(100);
		const refused = outcome(() => ledger.append(made('late')));

		assert.deepStrictEqual({ touched: fs.statSync(lock).mtimeMs > Date.now() - 60_000, refused, lock: fs.readFileSync(lock, 'utf8') }, {
			touched: false,
			refused: takenFrom(temp.dir),
			lock: ANOTHERS_LOCK
		});
	});

	test('a lock another program holds open for a moment - a scanner, on Windows - is read again; one it holds longer is not taken for another window\'s: the event fails, and the ledger stays open', async () => {
		const ledger = Ledger.open(temp.dir, { heartbeatMs: 10 });
		let reads = 3;
		const restore = failReading(path.join(temp.dir, LOCK), 'EBUSY', () => reads-- > 0);
		let held = 'not tried';
		try {
			ledger.append(made('clamp'));
			reads = Infinity;
			held = outcome(() => ledger.append(made('slug')));
			// Nor can the heartbeats meanwhile read it.
			await sleep(100);
		} finally {
			restore();
		}
		ledger.append(made('next'));
		ledger.close();

		assert.deepStrictEqual({ held, worktrees: [...ledger.state.worktrees.keys()] }, { held: 'EBUSY', worktrees: ['/lab-clamp', '/lab-next'] });
	});

	test('a lock another program holds open too long to be read counts as held, whose it is not being known: what the windows put in folders is not taken back over it', () => {
		const lock = path.join(temp.dir, LOCK);
		fs.writeFileSync(lock, ANOTHERS_LOCK);
		const restore = failReading(lock, 'EBUSY');
		let unreadable: boolean;
		try {
			unreadable = isLedgerHeld(temp.dir, () => false);
		} finally {
			restore();
		}

		assert.deepStrictEqual({ unreadable, read: isLedgerHeld(temp.dir, () => false) }, { unreadable: true, read: false });
	});
});

suite('Record: where a workspace\'s record is', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-paths-');
	});

	teardown(() => {
		temp.remove();
	});

	test('what every window shares is under ~/.facade: the workspaces\' records, and what Facade put where', () => {
		const home = path.join(os.homedir(), '.facade');

		assert.deepStrictEqual([workspacesRoot(), injectedFile()], [path.join(home, 'workspaces'), path.join(home, 'injected.json')]);
	});

	test('a workspace has a record of its own, named by an id its storage keeps: the record names the workspace; the id and the record stay through reopenings', () => {
		const root = path.join(temp.dir, 'workspaces');
		const first = recordFor(root, undefined, 'file:///lab', () => false);
		const again = recordFor(root, first.id, 'file:///lab', () => false);

		assert.deepStrictEqual({
			id: isWorkspaceId(first.id),
			dir: first.dir === recordDirOf(root, first.id),
			isNew: [first.isNew, again.isNew],
			same: again.dir === first.dir,
			names: identityOf(first.dir)
		}, { id: true, dir: true, isNew: [true, false], same: true, names: 'file:///lab' });
	});

	test('a record that names another workspace goes with this very window, as its folder window became a workspace or it was saved under another name; any other workspace with the same id - the old file after Save As, the folder opened on its own again - gets a record of its own, as one with an id that is no id does', () => {
		const root = path.join(temp.dir, 'workspaces');
		const lab = recordFor(root, undefined, 'file:///lab', () => false);
		const askedOf: string[] = [];
		const moved = recordFor(root, lab.id, 'file:///lab.code-workspace', dir => {
			askedOf.push(dir);
			return true;
		});
		const theFolderAgain = recordFor(root, lab.id, 'file:///lab', () => false);
		const noId = recordFor(root, 'lab', 'file:///lab', () => true);

		assert.deepStrictEqual({
			askedOf: askedOf.map(dir => dir === lab.dir),
			moved: { same: moved.dir === lab.dir, isNew: moved.isNew, names: identityOf(lab.dir) },
			theFolderAgain: { other: theFolderAgain.dir !== lab.dir, isNew: theFolderAgain.isNew, names: identityOf(theFolderAgain.dir) },
			noId: { other: noId.dir !== lab.dir && noId.dir !== theFolderAgain.dir, isNew: noId.isNew }
		}, {
			askedOf: [true],
			moved: { same: true, isNew: false, names: 'file:///lab.code-workspace' },
			theFolderAgain: { other: true, isNew: true, names: 'file:///lab' },
			noId: { other: true, isNew: true }
		});
	});

	test('the lock of a record says which window load closed it, and whether a window holds it now', () => {
		const ledger = Ledger.open(temp.dir, { owner: 'lab', session: 'load-1' });
		const held = lockStateOf(temp.dir);
		ledger.close();

		assert.deepStrictEqual({ held, closed: lockStateOf(temp.dir), none: lockStateOf(path.join(temp.dir, 'none')) }, {
			held: { held: true },
			closed: { held: false, closedIn: 'load-1' },
			none: { held: false }
		});
	});
});
