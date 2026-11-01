/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import type * as vscode from 'vscode';
import { lineReader } from '../base/lines';
import type { LaunchPlan, PairFacts, RunId, RunMeta } from '../core/ports';
import type { AgentExecution } from '../host/execution/agentExecution';
import { PtydClient, PtydNotSent, ptydSocketPath } from '../host/execution/ptydClient';
import { PtydServer } from '../ptyd/server';
import { TOOL_PROTOCOL, ToolCall } from '../schema/protocol';
import { QUERY_ROUTE_MS } from '../schema/tools';
import { IDLE, program, programEnv } from './ptydPlace';
import { TestEmitter, withModules } from './withModules';

/** The shim as compiled. */
const SHIM = path.join(__dirname, '..', 'transport', 'shim.js');

suite('Transport: the window answers its runs\' tool calls and tells their tools are there (MCP-6.1)', function () {
	this.timeout(20_000);
	let home: string;
	let server: PtydServer;
	let Execution: typeof AgentExecution;
	const ports: AgentExecution[] = [];
	const cleanups: (() => void)[] = [];

	setup(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tools-'));
		server = new PtydServer(ptydSocketPath(home));
		assert.strictEqual(await server.listen(), true);
		const never = new TestEmitter<unknown>();
		class TabInputTerminal { }
		const vscodeApi = {
			TabInputTerminal,
			TabInputText: class { constructor(readonly uri: unknown) { } },
			commands: { executeCommand: async () => undefined },
			EventEmitter: TestEmitter,
			ThemeIcon: class { constructor(readonly id: string) { } },
			Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: path.posix.join(base.path, ...parts) }) },
			ViewColumn: { Active: -1 },
			TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
			Disposable: class { constructor(private readonly run: () => void) { } dispose() { this.run(); } },
			l10n: { t: (text: string) => text },
			workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: never.event },
			window: {
				activeTerminal: undefined,
				tabGroups: { onDidChangeTabs: never.event, onDidChangeTabGroups: never.event, all: [], activeTabGroup: { activeTab: undefined } },
				onDidChangeActiveTerminal: never.event,
				onDidCloseTerminal: never.event,
				createTerminal: (options: vscode.ExtensionTerminalOptions) => ({
					name: options.name, options, show() { }, dispose() { },
					tab: { input: new TabInputTerminal(), isPinned: false, isActive: false, label: options.name }
				})
			}
		};
		Execution = withModules({ vscode: vscodeApi })<typeof import('../host/execution/agentExecution')>(require.resolve('../host/execution/agentExecution')).AgentExecution;
	});

	teardown(() => {
		cleanups.splice(0).forEach(cleanup => cleanup());
		ports.splice(0).forEach(port => port.dispose());
		server.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	const portOf = (more: { readonly home?: string; readonly shimScript?: string } = {}) => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/ext/dist/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined, ...more });
		ports.push(port);
		return port;
	};
	const facts = (run: RunId): PairFacts => ({ run, name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', cwd: os.tmpdir() });
	const meta = (run: RunId): RunMeta => ({
		alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: os.tmpdir(),
		environment: 'local', yolo: true, root: run, origin: 'human', createdAt: 1
	});
	const plan = (script: string): LaunchPlan => ({
		cli: 'claude', displayName: 'Claude Code', command: 'claude', executable: process.execPath, args: ['-e', script],
		env: programEnv(), cwd: os.tmpdir(), tools: { state: 'not_injected' },
		input: { capability: { state: 'unavailable', reason: 'A test program has no input reader.' } }
	});
	const started = async (port: AgentExecution, run: RunId, script = 'setInterval(() => {}, 1000)') => {
		port.openPair(facts(run), { reveal: false });
		return port.spawn(run, plan(script), meta(run));
	};
	/** The run's shim as its CLI starts it, from the launch the window gives: requests by id over stdio. */
	const shimOf = (port: AgentExecution, run: RunId) => {
		const launch = port.shimLaunch(run);
		const child = spawn(launch.command, [...launch.args], { env: { ...programEnv(), ...launch.env, FACADE_AGENT: '#a1' }, stdio: ['pipe', 'pipe', 'inherit'] });
		cleanups.push(() => child.kill());
		const waiting = new Map<number, (result: any) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
		child.stdout.on('data', lineReader(line => {
			const message = JSON.parse(line);
			waiting.get(message.id)?.(message.result);
			waiting.delete(message.id);
		}, err => assert.fail(err)));
		let next = 1;
		return (method: string, params: unknown) => new Promise<any>(resolve => { // eslint-disable-line @typescript-eslint/no-explicit-any
			const id = next++;
			waiting.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	};
	const until = async <T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 5_000): Promise<T> => {
		const deadline = Date.now() + ms;
		for (; ;) {
			const value = await check();
			if (value !== undefined && value !== false) {
				return value;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${what}.`);
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};

	test('a run\'s shim starts with this host\'s runtime as Node, the shim beside ptyd\'s script or the one given, and ptyd\'s socket - addresses, no token', () => {
		assert.deepStrictEqual(portOf().shimLaunch('run-1'), {
			command: process.execPath,
			args: [path.join('/ext/dist', 'shim.js')],
			env: { ELECTRON_RUN_AS_NODE: '1', FACADE_RUN: 'run-1', FACADE_PTYD: ptydSocketPath(home) }
		});
		assert.deepStrictEqual(portOf({ shimScript: SHIM }).shimLaunch('run-2').args, [SHIM]);
	});

	test('the shim\'s hello tells the window its run\'s tools are there; each call is answered by the handler served, a failure where there is none or it throws', async () => {
		const port = portOf({ shimScript: SHIM });
		const connected: RunId[] = [];
		port.onDidConnectTools(run => connected.push(run));
		await started(port, 'run-3');
		const ask = shimOf(port, 'run-3');
		await ask('initialize', { protocolVersion: '2025-06-18' });
		await until('the run\'s tools', () => connected.length === 1);
		assert.deepStrictEqual(connected, ['run-3']);
		const unserved = await ask('tools/call', { name: 'list_agents', arguments: {} });
		assert.deepStrictEqual([unserved.isError, unserved.structuredContent.error.reason, unserved.structuredContent.effects.outcome], [true, 'window_unavailable', 'none']);
		assert.match(unserved.content[0].text, /The Facade Code window does not take tool calls now: the call had no effect/);
		const seen: { readonly call: ToolCall; readonly receivedAt: number }[] = [];
		const delivered: string[] = [];
		const served = port.serveTools(async (call, receivedAt) => {
			seen.push({ call, receivedAt });
			if (call.tool === 'stop_agent') {
				throw new Error('the store is gone');
			}
			return {
				answer: { text: `Listed for ${call.caller}.`, structured: { status: 'success', data: { agents: [] }, effects: { outcome: 'none' } }, isError: false },
				delivered: () => delivered.push(call.callId)
			};
		});
		const before = performance.now();
		const answered = await ask('tools/call', { name: 'list_agents', arguments: { limit: 5 } });
		assert.deepStrictEqual(answered, { content: [{ type: 'text', text: 'Listed for run-3.' }], structuredContent: { status: 'success', data: { agents: [] }, effects: { outcome: 'none' } }, isError: false });
		assert.deepStrictEqual(seen.map(({ call: { elapsedMs: _elapsed, ...call } }) => call), [{ protocol: TOOL_PROTOCOL, caller: 'run-3', tool: 'list_agents', arguments: { limit: 5 }, callId: '3', routeDeadlineMs: QUERY_ROUTE_MS }]);
		assert.ok(seen[0].call.elapsedMs >= 0 && seen[0].call.elapsedMs < 2_000);
		// When this window read the call, on its monotonic clock; what follows the answer once ptyd handed it to the shim
		assert.ok(seen[0].receivedAt >= before && seen[0].receivedAt <= performance.now());
		await until('the answer handed back', () => delivered.length === 1);
		assert.deepStrictEqual(delivered, ['3']);
		const thrown = await ask('tools/call', { name: 'stop_agent', arguments: { agent: '#a2' } });
		assert.deepStrictEqual([thrown.isError, thrown.structuredContent.error.code, thrown.structuredContent.effects.outcome], [true, 'FAILED', 'unknown']);
		assert.match(thrown.content[0].text, /could not complete stop_agent: the store is gone/);
		served.dispose();
		assert.strictEqual((await ask('tools/call', { name: 'list_agents', arguments: {} })).structuredContent.error.reason, 'window_unavailable');
	});

	test('allRunIds gives the runs of every workspace whose processes live; reads, text and keys pass to ptyd for this owner; an unreachable ptyd is said plainly', async () => {
		const port = portOf();
		await started(port, 'run-4', `process.stdin.setRawMode(true); process.stdout.write('ready\\r\\n'); process.stdin.on('data', d => process.stdout.write('got ' + JSON.stringify(d.toString()) + '\\r\\n')); setInterval(() => {}, 1000);`);
		await started(port, 'run-5', 'process.exit(0)');
		const other = await PtydClient.connect(ptydSocketPath(home), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		cleanups.push(() => other.dispose());
		await other.request('claim', { owner: 'workspace-2', generation: 1, token: 'other' });
		await other.request('spawn', { run: 'run-6', owner: 'workspace-2', ...program(IDLE), cwd: os.tmpdir(), cols: 80, rows: 24, meta: {} });
		await until('run-5 to end', async () => (await other.request('list', {})).find(run => run.run === 'run-5')?.exited);
		assert.deepStrictEqual([...await port.allRunIds()].sort(), ['run-4', 'run-6']);
		await until('its first line', async () => (await port.readScreen('run-4', 5)).text.includes('ready'));
		assert.deepStrictEqual(await port.typeText('run-4', 'hi', true), { outcome: 'applied', pasted: true, entered: true });
		assert.deepStrictEqual(await port.pressKeys('run-4', ['Escape', 'Up']), { outcome: 'applied', keysSent: 2 });
		const screen = await until('what went in', async () => {
			const read = await port.readScreen('run-4', 10);
			return read.text.some(line => line.includes('\\u001b[A')) && read;
		});
		assert.ok(screen.text.some(line => line.includes('hi')), screen.text.join('\n'));
		// Another workspace's run, or none, is not this window's to read or type into
		await assert.rejects(port.readScreen('run-6', 5), /ownership was transferred or expired/);
		await assert.rejects(port.readScreen('run-none', 5), /No run run-none/);
		await assert.rejects(port.typeText('run-none', 'x', false), /No run run-none/);
		assert.strictEqual((await port.inspectInput('run-4', 'codex-prompt')).state, 'unknown');
		// No ptyd listens for this home, and the script that would start one does not exist
		const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tools-none-'));
		cleanups.push(() => fs.rmSync(nowhere, { recursive: true, force: true }));
		const unreachable = portOf({ home: nowhere });
		// The port's own module copy: its error is a PtydNotSent by name - nothing was asked
		await assert.rejects(unreachable.allRunIds(), (err: Error) => err.constructor.name === PtydNotSent.name && /The agent runtime \(ptyd\) cannot be reached: ptyd did not start/.test(err.message));
	});
});
