/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS_ROUTE_COMMAND, WINDOW_ALLOCATE_COMMAND, WINDOW_DIRECTORY_COMMAND, WINDOW_PUBLISH_COMMAND, WINDOW_ROUTE_COMMAND, WORKSPACE_REPUBLISH_COMMAND } from '../base/windowNetwork';
import type { RunChange, RunFacts } from '../core/ports';
import { allocateNumbers, environmentFloor } from '../record/windowRegistry';
import { runFacts } from './contractFakes';
import { tempDir } from './util';
import { TestEmitter, withModules } from './withModules';

type Command = (...args: unknown[]) => unknown;

/** What taking a number threw: a refusal, with its code, reason and the person's words. */
function refusalOf(take: () => unknown): { readonly code?: string; readonly reason?: string; readonly said?: unknown; readonly message: string } {
	try {
		take();
	} catch (err) {
		return err as { code?: string; reason?: string; said?: unknown; message: string };
	}
	return assert.fail('a number was given');
}

/** The editor's commands as the workspace extension reaches its window component through them, scripted by each test. */
function fakeEditor() {
	const handlers = new Map<string, Command>();
	const executed: { readonly id: string; readonly args: readonly unknown[] }[] = [];
	const registered = new Map<string, Command>();
	const vscode = {
		env: { sessionId: 'session-1' },
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => {
				executed.push({ id, args });
				const handler = handlers.get(id);
				if (!handler) {
					throw new Error(`command '${id}' not found`);
				}
				return handler(...args);
			},
			registerCommand: (id: string, run: Command) => {
				registered.set(id, run);
				return { dispose: () => registered.delete(id) };
			}
		}
	};
	const client = withModules({ vscode })<typeof import('../host/client')>(require.resolve('../host/client'));
	return { client, handlers, executed, registered };
}

suite('The workspace extension on the client network (ARCHITECTURE-2.1; RULES-1.1, 2.2)', () => {

	let home: ReturnType<typeof tempDir>;
	setup(() => home = tempDir('facade-client-'));
	teardown(() => home.remove());

	test('alias numbers come from this computer\'s counter ahead of need, a pool for each window that never meets another\'s', async () => {
		const first = fakeEditor();
		const second = fakeEditor();
		for (const editor of [first, second]) {
			editor.handlers.set(WINDOW_ALLOCATE_COMMAND, (session, kind, count, floor) => {
				assert.strictEqual(session, 'session-1');
				return allocateNumbers(home.dir, kind as 'agent', count as number, floor as number);
			});
		}
		const fallback = () => assert.fail('the computer\'s counter answers: no fallback');
		const a = new first.client.AliasPool('agent', fallback, () => undefined);
		const b = new second.client.AliasPool('agent', fallback, () => undefined);
		assert.deepStrictEqual([await a.prime(), await b.prime()], [true, true]);
		const given: number[] = [];
		for (let take = 0; take < 300; take++) {
			given.push((take % 3 ? a : b).next());
			// Refills run between takes, as the editor answers commands while nothing else runs
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.strictEqual(new Set(given).size, given.length, 'no number given twice across the two windows');
		assert.ok(given.every(n => Number.isSafeInteger(n) && n > 0));
		// Each pool takes a batch at a time, in order: the first window's first numbers are the counter's first
		assert.deepStrictEqual(given.filter((_, at) => at % 3 && at < 9), [1, 2, 3, 4, 5, 6]);
		// A remote window's pool by default: more at hand than a burst uses before the next numbers come
		assert.deepStrictEqual(first.executed.filter(each => each.id === WINDOW_ALLOCATE_COMMAND).every(each => each.args[1] === 'agent' && each.args[2] === first.client.REMOTE_POOL.size), true);
		const agents = first.client.agentAliases(a);
		assert.match(agents.next(), /^#a\d+$/);
	});

	test('a local window\'s pool, run dry, takes its next number from this computer\'s counter itself: never one another window has', async () => {
		const first = fakeEditor();
		const second = fakeEditor();
		// The first window's component answers; the second's pool never gets numbers from it and falls back to the counter directly
		first.handlers.set(WINDOW_ALLOCATE_COMMAND, (_session, kind, count, floor) => allocateNumbers(home.dir, kind as 'agent', count as number, floor as number));
		const a = new first.client.AliasPool('agent', () => assert.fail('the component answers'), () => undefined, 'session-1', first.client.LOCAL_POOL);
		const b = new second.client.AliasPool('agent', () => allocateNumbers(home.dir, 'agent', 1).first, () => undefined, 'session-1', second.client.LOCAL_POOL);
		await a.prime();
		const given: number[] = [];
		for (let take = 0; take < 60; take++) {
			given.push((take % 2 ? a : b).next());
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.strictEqual(new Set(given).size, given.length, 'the counter itself and the pool of numbers taken from it never give one number twice');
	});

	test('RULES-2.2: with no number from the window component, a remote window\'s start or send is refused before any effect - no other counter stands in - said in the log; so is a local one\'s whose counter cannot be read', async () => {
		const editor = fakeEditor();
		const log: string[] = [];
		const pool = new editor.client.AliasPool('message', undefined, line => log.push(line));
		assert.strictEqual(await pool.prime(), false);
		const refused = refusalOf(() => pool.next());
		assert.deepStrictEqual([refused.code, refused.reason, refused.said], ['UNAVAILABLE', 'unavailable', { kind: 'numbers_unavailable', values: [] }]);
		assert.ok(log.some(line => line.startsWith('Could not take message numbers from this computer\'s counter: command \'facade.window.allocate\' not found')), log.join('\n'));
		// A component that answers with no numbers gives none either; nor does a local window\'s counter that cannot be read
		editor.handlers.set(WINDOW_ALLOCATE_COMMAND, () => undefined);
		const empty = new editor.client.AliasPool('message', undefined, () => undefined);
		const unreadable = new editor.client.AliasPool('agent', () => { throw new Error('the counter is damaged'); }, () => undefined, 'session-1', editor.client.LOCAL_POOL);
		assert.strictEqual(await empty.prime(), false);
		assert.match(refusalOf(() => empty.next()).message, /^No message number could be taken from this computer's counter: /);
		assert.strictEqual(refusalOf(() => unreadable.next()).message, 'No agent number could be taken from this computer\'s counter: the counter is damaged. Nothing was started or sent; try again.');
	});

	test('RULES-2.2: a remote window asks for numbers past those its environment\'s earlier counters gave, which its component cannot read; one it cannot read gives none', async () => {
		const editor = fakeEditor();
		const asked: unknown[] = [];
		editor.handlers.set(WINDOW_ALLOCATE_COMMAND, (_session, kind, count, floor) => { asked.push(floor); return allocateNumbers(home.dir, kind as 'agent', count as number, floor as number); });
		// 0.0.1 gave #a1 to #a41 in that environment, whose Facade directory is not this computer's
		const remote = tempDir('facade-remote-');
		try {
			fs.writeFileSync(path.join(remote.dir, 'agent-aliases.json'), JSON.stringify({ last: 41 }));
			const pool = new editor.client.AliasPool('agent', undefined, () => undefined, 'session-1', editor.client.REMOTE_POOL, () => environmentFloor(remote.dir, 'agent'));
			assert.strictEqual(await pool.prime(), true);
			assert.deepStrictEqual([asked, pool.next()], [[41], 42]);
			fs.writeFileSync(path.join(remote.dir, 'message-aliases.json'), '{');
			const log: string[] = [];
			const unreadable = new editor.client.AliasPool('message', undefined, line => log.push(line), 'session-1', editor.client.REMOTE_POOL, () => environmentFloor(remote.dir, 'message'));
			assert.strictEqual(await unreadable.prime(), false);
			assert.strictEqual(refusalOf(() => unreadable.next()).reason, 'unavailable');
			assert.ok(log.some(line => line.includes('message-aliases.json')), log.join('\n'));
		} finally {
			remote.remove();
		}
	});

	test('ARCHITECTURE-4.3, RULES-2.2: a window component too old for the client network leaves no other window - each one unavailable as protocol_incompatible, nothing carried - and no number: a start or send is refused, saying to update it on this computer and reload', async () => {
		const editor = fakeEditor();
		const network = new editor.client.OutdatedComponent('win-1');
		const listed = await network.directory().then(() => 'listed', (err: { code?: string; reason?: string }) => [err.code, err.reason]);
		const routed = await network.route();
		assert.deepStrictEqual([network.self, listed, routed.ok, !routed.ok && [routed.reason, routed.effects]], ['win-1', ['UNAVAILABLE', 'protocol_incompatible'], false, ['protocol_incompatible', 'none']]);
		for (const take of [() => editor.client.NO_AGENT_NUMBERS.next(), () => editor.client.NO_MESSAGE_NUMBERS.next()]) {
			const refused = refusalOf(take);
			assert.deepStrictEqual([refused.code, refused.reason, refused.said], ['UNAVAILABLE', 'unavailable', { kind: 'component_outdated', values: [] }]);
			assert.match(refused.message, /Update "Facade Code Window Component" on this computer, then reload the window\.$/);
		}
	});

	test('routes distinguish a missing command from an unreadable reply after dispatch', async () => {
		const editor = fakeEditor();
		const network = new editor.client.ClientNetwork('win-1', 'session-1');
		const missing = await network.route('win-2', 'agents', { caller: 'x' }, 9_000);
		assert.deepStrictEqual([missing.ok, !missing.ok && missing.reason, !missing.ok && missing.effects], [false, 'window_unavailable', 'none']);
		editor.handlers.set(WINDOW_ROUTE_COMMAND, () => undefined);
		const silent = await network.route('win-2', 'agents', {}, 9_000);
		assert.deepStrictEqual([silent.ok, !silent.ok && silent.effects], [false, 'unknown']);
		const answered = { ok: false, reason: 'timeout', message: 'No answer within 9 seconds.', effects: 'unknown' };
		editor.handlers.set(WINDOW_ROUTE_COMMAND, (session, request) => {
			assert.deepStrictEqual([session, request], ['session-1', { to: 'win-2', op: 'deliver', args: { id: 'm-1' }, deadlineMs: 2_993 }]);
			return answered;
		});
		assert.deepStrictEqual(await network.route('win-2', 'deliver', { id: 'm-1' }, 2_993), answered);
		// The directory: as the component lists it, or an error where it lists nothing usable
		await assert.rejects(network.directory(), /not found/);
		editor.handlers.set(WINDOW_DIRECTORY_COMMAND, () => ({ self: 'win-1', windows: 'none' }));
		await assert.rejects(network.directory(), /did not list the open windows/);
		const directory = { self: 'win-1', windows: [{ window: 'win-1', label: 'Design', environment: 'local', agents: [] }], unavailable: [] };
		editor.handlers.set(WINDOW_DIRECTORY_COMMAND, () => directory);
		assert.deepStrictEqual(await network.directory(), directory);
		assert.strictEqual(await editor.client.networkAddress('session-1'), 'win-1');
		editor.handlers.delete(WINDOW_DIRECTORY_COMMAND);
		assert.strictEqual(await editor.client.networkAddress('session-1'), undefined);
	});

	test('ARCHITECTURE-4.3: only a component without the directory command is too old; a directory call that fails otherwise is tried again', async () => {
		const editor = fakeEditor();
		const directory = { self: 'win-1', windows: [{ window: 'win-1', label: 'Design', environment: 'local', agents: [] }], unavailable: [] };
		let calls = 0;
		editor.handlers.set(WINDOW_DIRECTORY_COMMAND, () => { if (++calls < 3) { throw new Error('EACCES: permission denied, scandir'); } return directory; });
		const paused: number[] = [];
		assert.strictEqual(await editor.client.networkAddress('session-1', 5, async ms => { paused.push(ms); }), 'win-1');
		assert.deepStrictEqual([calls, paused], [3, [1_000, 1_000]]);
		// A failure that lasts gives up after its tries; a missing command at once
		editor.handlers.set(WINDOW_DIRECTORY_COMMAND, () => { throw new Error('EACCES: permission denied, scandir'); });
		paused.length = 0;
		assert.strictEqual(await editor.client.networkAddress('session-1', 3, async ms => { paused.push(ms); }), undefined);
		assert.strictEqual(paused.length, 2);
		editor.handlers.delete(WINDOW_DIRECTORY_COMMAND);
		paused.length = 0;
		assert.strictEqual(await editor.client.networkAddress('session-1', 3, async ms => { paused.push(ms); }), undefined);
		assert.strictEqual(paused.length, 0);
	});

	test('outer route timeout bounds the wait but does not cancel, repeat or invent the outcome of a dispatched command', async () => {
		const editor = fakeEditor();
		const network = new editor.client.ClientNetwork('win-1');
		const expired = await network.route('win-2', 'deliver', {}, 0);
		assert.ok(!expired.ok && expired.reason === 'timeout' && expired.effects === 'none');
		assert.strictEqual(editor.executed.length, 0);
		let release!: (value: unknown) => void;
		editor.handlers.set(WINDOW_ROUTE_COMMAND, () => new Promise(resolve => release = resolve));
		const timedOut = await network.route('win-2', 'deliver', {}, 10);
		assert.ok(!timedOut.ok && timedOut.reason === 'timeout' && timedOut.effects === 'unknown');
		release({ ok: true, result: 'late' });
		editor.handlers.set(WINDOW_ROUTE_COMMAND, () => { throw new Error('Reply lost after forwarding'); });
		const lost = await network.route('win-2', 'deliver', {}, 1000);
		assert.ok(!lost.ok && lost.effects === 'unknown');
		assert.strictEqual(editor.executed.length, 2, 'one dispatch for each non-expired request');
	});

	test('what other windows route here is served while registered; an incomplete request is refused before anything is served', async () => {
		const editor = fakeEditor();
		const served: unknown[] = [];
		const registration = editor.client.serveRoutes(async route => { served.push(route); return 'answered'; });
		const command = editor.registered.get(AGENTS_ROUTE_COMMAND)!;
		assert.strictEqual(await command({ from: 'win-2', op: 'summary', args: {}, deadlineMs: 9_000 }), 'answered');
		assert.throws(() => command({ op: 'summary', args: {}, deadlineMs: 9_000 }), /incomplete/);
		assert.deepStrictEqual(served, [{ from: 'win-2', op: 'summary', args: {}, deadlineMs: 9_000 }]);
		registration.dispose();
		assert.ok(!editor.registered.has(AGENTS_ROUTE_COMMAND));
	});

	test('the agents this window holds are told to its component as they change - who they are and their trees, never what they do - with the window\'s name', async () => {
		const editor = fakeEditor();
		const published: unknown[][] = [];
		const labels: unknown[] = [];
		editor.handlers.set(WINDOW_PUBLISH_COMMAND, (_session, agents, label) => {
			published.push(agents as unknown[]);
			labels.push(label);
		});
		const runs: RunFacts[] = [runFacts(1, { name: 'lead', activity: 'working', title: 'Secret plan' })];
		const changes = new TestEmitter<RunChange>();
		const publication = editor.client.publishAgents({ list: () => runs, onDidChange: changes.event }, 'app [SSH: box]', () => undefined, 'session-1');
		assert.deepStrictEqual(published, [[{ run: runs[0].id, alias: '#a1', name: 'lead', root: runs[0].id, yolo: false, cli: 'claude', lifecycle: 'running' }]]);
		// What an agent reports stays here; changes that come together are told once
		changes.fire({ run: runs[0].id, kind: 'reported' });
		runs.push(runFacts(2, { name: 'worker', root: runs[0].id, creator: runs[0].id, origin: 'agent' }));
		changes.fire({ run: runs[1].id, kind: 'added' });
		changes.fire({ run: runs[1].id, kind: 'lifecycle' });
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.strictEqual(published.length, 2);
		assert.deepStrictEqual(labels, ['app [SSH: box]', 'app [SSH: box]']);
		assert.deepStrictEqual(published[1], [
			{ run: runs[0].id, alias: '#a1', name: 'lead', root: runs[0].id, yolo: false, cli: 'claude', lifecycle: 'running' },
			{ run: runs[1].id, alias: '#a2', name: 'worker', root: runs[0].id, creator: runs[0].id, yolo: false, cli: 'claude', lifecycle: 'running' }
		]);
		assert.ok(!JSON.stringify(published).includes('Secret plan') && !JSON.stringify(published).includes('working'));
		// Disposed, nothing more is told
		publication.dispose();
		changes.fire({ run: runs[1].id, kind: 'renamed' });
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.strictEqual(published.length, 2);
	});

	test('a component that cannot listen is said in the log, once, and its return too; a component that started again is told the agents at once, as it asks (ARCHITECTURE-2.1)', async () => {
		const editor = fakeEditor();
		let status: unknown = { listening: false, problem: 'listen EADDRINUSE' };
		let published = 0;
		editor.handlers.set(WINDOW_PUBLISH_COMMAND, () => { published++; return status; });
		const logged: string[] = [];
		const runs: RunFacts[] = [runFacts(1, { name: 'lead' })];
		const changes = new TestEmitter<RunChange>();
		const publication = editor.client.publishAgents({ list: () => runs, onDidChange: changes.event }, 'Window', line => logged.push(line), 'session-1');
		await new Promise(resolve => setTimeout(resolve, 0));
		const republish = editor.registered.get(WORKSPACE_REPUBLISH_COMMAND)!;
		republish('session-1');
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(published, 2, 'a starting component asks, and is told at once');
		assert.deepStrictEqual(logged, ['Other Facade windows cannot reach this window now: listen EADDRINUSE']);
		republish('another-session');
		status = { listening: true };
		republish('session-1');
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual([published, logged], [3, ['Other Facade windows cannot reach this window now: listen EADDRINUSE', 'Other Facade windows can reach this window again.']]);
		publication.dispose();
		assert.ok(!editor.registered.has(WORKSPACE_REPUBLISH_COMMAND));
	});
});
