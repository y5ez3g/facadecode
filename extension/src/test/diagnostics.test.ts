/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Location, RunFacts } from '../core/ports';
import type { ScreenRead } from '../ptyd/protocol';
import { diagnosticsText, Diagnostics } from '../ui/diagnostics';
import { withModules } from './withModules';

function run(more: Partial<RunFacts> = {}): RunFacts {
	return {
		id: 'run-00000000000000000000000000000001', alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude',
		location: 'loc-1', cwd: '/Users/ada/shop', environment: 'local', yolo: false, createdAt: 1000,
		lifecycle: 'running', phase: 'running', pid: 42, startedAt: 2000, activity: 'working', reporting: true,
		root: 'run-00000000000000000000000000000001', origin: 'human', tools: 'available', ...more
	};
}

function diagnostics(more: Partial<Diagnostics> = {}): Diagnostics {
	return {
		at: Date.UTC(2026, 9, 31, 12),
		about: ['Facade Code 0.2.0', 'window component 0.2.0', 'Visual Studio Code 1.143.0', 'darwin arm64', 'local'],
		collaboration: true,
		agents: [],
		log: ['2026-10-31T11:00:00.000Z Agent @Ada #a1 started in /Users/ada/shop'],
		home: '/Users/ada',
		...more
	};
}

suite('Copy Diagnostics: what it copies (ARCHITECTURE-3.3, D116)', () => {
	test('catalog configuration errors remain visible even if a malformed catalog yields no custom entries', () => {
		const text = diagnosticsText(diagnostics({ clis: { where: '/repo', each: [], problems: [{ setting: 'facade.custom', problem: 'facade.custom must be an object; received array' }] } }));
		assert.match(text, /Configuration error \(facade.custom\): facade.custom must be an object; received array/);
	});

	test('versions, CLIs, agents with what their input reads and their last rows, and the log\'s end, the home folder written ~', () => {
		const text = diagnosticsText(diagnostics({
			clis: {
				where: '/Users/ada/shop',
				each: [
					{ choice: { id: 'claude', displayName: 'Claude Code', available: true }, version: '2.1.316', input: 'claude-frame' },
					{ choice: { id: 'codex', displayName: 'Codex', available: false, problem: 'facade.codex.command names no program' } },
					{ choice: { id: 'pi', displayName: 'Pi', available: false, notInstalled: true } }
				]
			},
			agents: [
				{
					facts: run({ version: '2.1.316', activitySince: Date.UTC(2026, 9, 31, 11, 55), inputAdapter: 'claude-frame' }),
					input: 'draft',
					screen: ['', '', '╭────╮', '│ > hello   ', '╰────╯']
				},
				{
					facts: run({ id: 'run-00000000000000000000000000000002', alias: '#a2', name: 'Bo', cli: 'codex', displayName: 'Codex', lifecycle: 'ended', tools: 'unavailable', toolsReason: 'its server did not start', end: { kind: 'abnormal', code: 3, at: Date.UTC(2026, 9, 31, 11) }, error: { reason: 'Exited with code 3', source: 'exit', at: Date.UTC(2026, 9, 31, 11) } })
				}
			]
		}));
		assert.strictEqual(text, [
			'Facade Code diagnostics, 2026-10-31T12:00:00.000Z',
			'Facade Code 0.2.0; window component 0.2.0; Visual Studio Code 1.143.0; darwin arm64; local',
			'Collaboration through Facade\'s tools: on',
			'',
			'CLIs for ~/shop',
			'- Claude Code (claude): 2.1.316; input reader claude-frame',
			'- Codex (codex): cannot start: facade.codex.command names no program',
			'- Pi (pi): not installed',
			'',
			'Agents in this window: 2',
			'- @Ada #a1 run-00000000000000000000000000000001: Claude Code 2.1.316, YOLO off, in ~/shop',
			'  running, working since 2026-10-31T11:55:00.000Z; tools available; input reader claude-frame, reads draft',
			'  | ╭────╮',
			'  | │ > hello',
			'  | ╰────╯',
			'- @Bo #a2 run-00000000000000000000000000000002: Codex, YOLO off, in ~/shop',
			'  ended; tools unavailable (its server did not start); input reader none',
			'  ended abnormal, code 3 at 2026-10-31T11:00:00.000Z',
			'  error from exit: Exited with code 3',
			'',
			'Agents log, its last 1 lines',
			'2026-10-31T11:00:00.000Z Agent @Ada #a1 started in ~/shop',
			''
		].join('\n'));
	});

	test('a window with no folder says CLIs are found for one; a starting agent names its stage, a blocked one what it waits on', () => {
		const text = diagnosticsText(diagnostics({
			agents: [{ facts: run({ lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false, blocker: { kind: 'permission', text: 'Allow Bash?' } }), input: 'nothing: it did not answer', screen: ['(its screen did not answer)'] }]
		}));
		assert.match(text, /^CLIs: no folder is open, and CLIs are found for one$/m);
		assert.match(text, /^ {2}starting \(launching_cli\), unknown, its CLI not reporting, waiting on its permission \("Allow Bash\?"\); tools available; input reader none, reads nothing: it did not answer$/m);
		assert.match(text, /^ {2}\| \(its screen did not answer\)$/m);
	});

	test('a home folder of one character is not written ~ throughout', () => {
		assert.match(diagnosticsText(diagnostics({ home: '/' })), /started in \/Users\/ada\/shop/);
	});
});

suite('Copy Diagnostics: the command (UX-3.1, ARCHITECTURE-3.3)', () => {
	test('it gathers each part, a screen or input that fails or does not answer said so, and puts the text on the clipboard with a notice of what it holds', async function () {
		this.timeout(20_000);
		const handlers = new Map<string, () => Promise<void>>();
		const clipboard: string[] = [];
		const notices: string[] = [];
		const api = {
			l10n: { t: (text: string) => text },
			env: { appName: 'Visual Studio Code', remoteName: undefined, clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
			version: '1.143.0',
			extensions: { getExtension: (id: string) => id === 'facade.facadecode-window' ? { packageJSON: { version: '0.2.0' } } : undefined },
			commands: { registerCommand: (id: string, handler: () => Promise<void>) => { handlers.set(id, handler); return { dispose: () => undefined }; } },
			window: { showInformationMessage: async (text: string) => void notices.push(text) }
		};
		const { registerDiagnostics } = withModules({ vscode: api })<typeof import('../host/diagnostics')>(require.resolve('../host/diagnostics'));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-diagnostics-'));
		try {
			const logFile = path.join(dir, 'agents.log');
			fs.writeFileSync(logFile, Array.from({ length: 250 }, (_, n) => `2026-10-31T11:00:00.000Z line ${n + 1} in ${dir}/app`).join('\n') + '\n');
			const ada = run({ inputAdapter: 'claude-frame' });
			const bo = run({ id: 'run-00000000000000000000000000000002', alias: '#a2', name: 'Bo' });
			const ended = run({ id: 'run-00000000000000000000000000000003', alias: '#a3', name: 'Cy', lifecycle: 'ended' });
			const location = { id: 'loc-1', path: `${dir}/app`, uri: 'file:///app', environment: 'local', label: 'main', folders: [], kind: 'checkout', opened: true, git: 'ok' } as unknown as Location;
			registerDiagnostics({
				agents: { list: () => [ada, bo, ended] },
				locations: { snapshot: () => ({ locations: [location], folders: [], pending: false }) },
				clis: {
					list: async () => ({ clis: [{ id: 'claude', displayName: 'Claude Code', available: true }], problems: [] }),
					describe: () => ({ launches: [{ cli: 'claude', takes: { model: true, effort: true }, input: { adapter: 'claude-frame', capability: { state: 'supported', reason: '' } }, version: { version: '2.1.316', source: '' } }] }),
					collaborationEnabled: () => true
				} as unknown as Parameters<typeof registerDiagnostics>[0]['clis'],
				readScreen: async id => {
					if (id === bo.id) {
						throw new Error('ptyd is not running');
					}
					return { lines: [], text: ['', '│ > ', '╰──╯'], buffer: 'normal', older: false } as unknown as ScreenRead;
				},
				inspect: id => id === bo.id ? new Promise(() => undefined) : Promise.resolve('usable'),
				logFile,
				version: '0.2.0',
				home: dir
			});
			await handlers.get('facade.copyDiagnostics')!();
			const [text] = clipboard;
			assert.match(text, /^Facade Code 0\.2\.0; window component 0\.2\.0; Visual Studio Code 1\.143\.0; \w+ \w+; local$/m);
			assert.match(text, /^CLIs for ~\/app\n- Claude Code \(claude\): 2\.1\.316; input reader claude-frame$/m);
			assert.match(text, /^ {2}running, working; tools available; input reader claude-frame, reads usable\n {2}\| │ >\n {2}\| ╰──╯$/m);
			assert.match(text, /^- @Bo #a2 .*\n {2}running, working; tools available; input reader none, reads nothing: it did not answer\n {2}\| \(its screen could not be read: ptyd is not running\)$/m);
			assert.match(text, /^- @Cy #a3 .*\n {2}ended; tools available; input reader none$/m);
			assert.match(text, /^Agents log, its last 200 lines\n2026-10-31T11:00:00\.000Z line 51 in ~\/app\n/m);
			assert.ok(text.endsWith('line 250 in ~/app\n') && !text.includes(dir), 'the log\'s end, the home folder written ~');
			assert.deepStrictEqual(notices, ["Facade's diagnostics are copied. They include your agents' screens, which can show code or keys: read them before you share them."]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test('in a remote window the window component is named by the version it answered with, which that extension host sees no other way (D116)', async () => {
		const copied: string[] = [];
		const remoteApi = (handlers: Map<string, () => Promise<void>>) => ({
			l10n: { t: (text: string) => text },
			env: { appName: 'Visual Studio Code', remoteName: 'ssh-remote', clipboard: { writeText: async (text: string) => void copied.push(text) } },
			version: '1.143.0',
			extensions: { getExtension: () => undefined },
			commands: { registerCommand: (id: string, handler: () => Promise<void>) => { handlers.set(id, handler); return { dispose: () => undefined }; } },
			window: { showInformationMessage: async () => undefined }
		});
		const deps = {
			agents: { list: () => [] }, locations: { snapshot: () => ({ locations: [], folders: [], pending: false }) },
			clis: { list: async () => [], describe: () => ({ launches: [] }), collaborationEnabled: () => false } as never,
			readScreen: async () => ({ lines: [], text: [], buffer: 'normal', older: false }) as unknown as ScreenRead,
			inspect: async () => 'usable', logFile: path.join(os.tmpdir(), 'facade-no-such-agents.log'), version: '0.2.0', home: '/home/ada'
		};
		for (const [component, named] of [['0.2.0', 'window component 0.2.0'], [undefined, 'window component out of sight of this extension host']] as const) {
			const handlers = new Map<string, () => Promise<void>>();
			const { registerDiagnostics } = withModules({ vscode: remoteApi(handlers) })<typeof import('../host/diagnostics')>(require.resolve('../host/diagnostics'));
			registerDiagnostics({ ...deps, ...component ? { component } : {} });
			await handlers.get('facade.copyDiagnostics')!();
			assert.ok(copied[copied.length - 1].split('\n')[1].includes(`; ${named}; `), copied[copied.length - 1].split('\n')[1]);
			assert.match(copied[copied.length - 1], /; remote ssh-remote\n/);
		}
	});
});
