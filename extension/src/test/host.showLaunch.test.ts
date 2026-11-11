/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { LaunchDescription } from '../clis/describe';
import { TEST_SETTINGS_FILE } from './settingsFixtures';
import { tempDir } from './util';
import { withModules } from './withModules';

/** The editor's API as the document needs it: each text in English, its `{n}` filled in. */
const api = {
	l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) },
	Uri: { from: (parts: object) => parts },
	ThemeIcon: class { constructor(readonly id: string) { } },
	QuickPickItemKind: { Separator: -1 }
};

suite('Show Agent Launch: its argument and its document (CLIS-4.1, UX-3.1)', () => {
	const { launchDocument, locationArgument } = withModules({ vscode: api })<typeof import('../host/showLaunch')>(require.resolve('../host/showLaunch'));
	const now = new Date('2026-10-31T01:02:03Z');
	const file = TEST_SETTINGS_FILE;
	const codex = (more: Partial<LaunchDescription> = {}): LaunchDescription => ({
		cli: 'codex', displayName: 'Codex', setting: 'clis.codex', enabled: true, problems: [],
		program: { file: '/bin/codex', configured: '', throughCmd: false }, cwd: '/repo',
		environment: { sources: ['host', 'launch', 'run'], variables: [{ source: 'launch', name: 'CODEX_HOME', value: '/home/ada/.codex-qwen' }, { source: 'run', name: 'ELECTRON_RUN_AS_NODE', value: null }] },
		args: ['--sandbox', 'workspace-write', '-c', 'a b'], yolo: false,
		sandbox: { state: 'on', by: ['--sandbox', 'workspace-write'] }, approvals: { state: 'native' }, trust: { kind: 'arguments', args: ['-c', 'a b'] },
		...more
	});
	const header = [
		'Agent launch in main',
		'Working location: /repo',
		'Computed at 2026-10-31 01:02:03 UTC without starting any CLI. This shows the configuration a new agent would use now, not an observation of a running process. Secret values are <redacted>.'
	];

	test('nothing, as the Command Palette gives, or null, asks the person; { location_id } alone names a location; anything else fails without a guess', () => {
		const refused = [{}, { location_id: 7 }, { location_id: 'loc-1', branch: 'x' }, 'loc-1', ['loc-1']].map(argument => {
			try {
				return locationArgument(argument);
			} catch (err) {
				return (err as { reason?: string }).reason;
			}
		});
		assert.deepStrictEqual([locationArgument(undefined), locationArgument(null), locationArgument({ location_id: 'loc-1' }), refused], [undefined, undefined, 'loc-1', Array(5).fill('invalid_argument')]);
	});

	test('a location\'s document: YOLO from the settings file, then each CLI as a start there would have it - its program, environment, arguments in order, YOLO, sandbox, approvals and trust', () => {
		const text = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: false, launches: [codex()], entries: [], problems: [], file, now });
		assert.deepStrictEqual(text.split('\n'), [
			...header,
			'YOLO: off, from yolo in ~/.facade/facade.json; applies to newly started agents',
			'',
			'Codex (codex, clis.codex)',
			'  Status: available',
			'  Executable: /bin/codex (found on PATH)',
			'  Working directory: /repo',
			'  Environment layers, lowest precedence first: the extension host\'s environment → clis.codex.env → all agents',
			'    CODEX_HOME set (clis.codex.env)',
			'    ELECTRON_RUN_AS_NODE removed (all agents)',
			'  Arguments, in order:',
			'    --sandbox',
			'    workspace-write',
			'    -c',
			'    "a b"',
			'  YOLO: off',
			'  Sandbox: on, by --sandbox workspace-write',
			'  Approvals: the CLI\'s own',
			'  Trust: for this launch alone, by -c "a b"',
			''
		]);
	});

	test('CONFIGURATION-4.2: a variable the person sets is named, never its value, whatever its name; one Facade or the integration sets shows its value', () => {
		const launch = codex({
			environment: {
				sources: ['host', 'terminal', 'launch', 'adapter', 'run', 'facade'], variables: [
					{ source: 'terminal', name: 'HTTP_PROXY', value: 'http://user:pw@proxy' },
					{ source: 'launch', name: 'MY_TOKEN', value: 'plain-looking' },
					{ source: 'launch', name: 'ANTHROPIC_API_KEY', value: null },
					{ source: 'adapter', name: 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', value: '1' },
					{ source: 'facade', name: 'FACADE_CODE_SESSION_FILE', value: '/home/ada/.facade/runs/<run ID>.session.json' }
				]
			}
		});
		const lines = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: true, launches: [launch], entries: [], problems: [], file, now }).split('\n');
		const at = lines.findIndex(line => line.startsWith('  Environment layers'));
		// The terminal setting of the system the editor runs on
		const system = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
		assert.deepStrictEqual(lines.slice(at + 1, at + 6), [
			`    HTTP_PROXY set (terminal.integrated.env.${system})`,
			'    MY_TOKEN set (clis.codex.env)',
			'    ANTHROPIC_API_KEY removed (clis.codex.env)',
			'    CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 (the Codex integration)',
			'    FACADE_CODE_SESSION_FILE=/home/ada/.facade/runs/<run ID>.session.json (Facade\'s tools and session tracking)'
		]);
		assert.ok(!lines.join('\n').includes('pw@proxy') && !lines.join('\n').includes('plain-looking'));
	});

	test('withheld folder trust is shown as not granted, with no claim that a file entry will be written', () => {
		const launch = codex({ trust: { kind: 'file', target: { file: '/home/ada/.claude.json', keys: ['projects', '/home/ada', 'hasTrustDialogAccepted'], entry: { value: true }, folder: '/home/ada', withheld: 'the home folder covers all projects' } } });
		const text = launchDocument({ location: { label: 'home', path: '/home/ada' }, yolo: false, launches: [launch], entries: [], problems: [], file, now });
		assert.match(text, /Trust: none provided for home folder, parents, or filesystem root; CLI prompts in its terminal/);
		assert.ok(!text.includes('merged into'));
	});

	test('trust kept in a CLI\'s file is said to be merged into it where it exists; where it does not, that no entry is written and the CLI prompts in its terminal (CLIS-4.1, 3.3)', () => {
		const temp = tempDir('fd-show-trust-');
		try {
			const claudeFile = path.join(temp.dir, '.claude.json');
			const trustIn = (target: string) => launchDocument({ location: { label: 'main', path: '/repo' }, yolo: false, now, entries: [], problems: [], file,
				launches: [codex({ trust: { kind: 'file', target: { file: target, keys: ['projects', '/repo', 'hasTrustDialogAccepted'], entry: { value: true }, folder: '/repo' } } })] }).split('\n').find(line => line.startsWith('  Trust:'));
			const missing = trustIn(claudeFile);
			fs.writeFileSync(claudeFile, '{}');
			assert.deepStrictEqual([missing, trustIn(claudeFile)], [
				`  Trust: no entry is written, as ${claudeFile} does not exist; the CLI prompts in its terminal`,
				`  Trust: {"projects":{"/repo":{"hasTrustDialogAccepted":true}}} merged into ${claudeFile} before each start; unreadable files are preserved and the CLI prompts in its terminal`
			]);
		} finally {
			temp.remove();
		}
	});

	test('a CLI turned off, misconfigured, not found or unable to start says why, by its entry in the file, and no plan or program is invented for it', () => {
		const sections = (launch: LaunchDescription) => launchDocument({ location: { label: 'main', path: '/repo', environment: 'SSH: build' }, yolo: true, launches: [launch], entries: [], problems: [], file, now }).split('\n').slice(5);
		const off = sections(codex({ enabled: false, args: undefined, trust: undefined }));
		const wrong = sections(codex({
			problems: [{ text: 'clis.codex.args[0] is --yolo, which Facade sets or decides itself; remove it', said: { kind: 'args_reserved', values: ['clis.codex.args', '0', '--yolo'] } }],
			program: { unresolved: true }, args: undefined, trust: undefined
		}));
		const missing = sections(codex({ program: { missing: 'codex was not found', said: { kind: 'not_on_path', values: ['codex', '/repo', 'clis.codex'] } }, args: undefined, trust: undefined }));
		const unsafe = sections(codex({ planProblem: { text: 'refused', said: { kind: 'cmd_unsafe_setting', values: ['codex.cmd', 'clis.codex.args', '1', '"!"', 'clis.codex'] } }, args: undefined, trust: undefined }));
		assert.deepStrictEqual([off[1], off.find(line => line.startsWith('  Arguments')), wrong.slice(1, 5), missing.slice(1, 3), unsafe[1]], [
			'  Status: off; clis.codex.enabled is false, so New Agent does not offer it',
			'  Arguments: none; CLI cannot start with current configuration',
			[
				'  Status: cannot start until configuration errors are fixed',
				'  Configuration errors:',
				'    - clis.codex.args[0] is --yolo, which Facade sets or decides itself; remove it',
				'  Executable: unresolved until configuration errors are fixed'
			],
			[
				'  Status: cannot start: codex was not found on PATH in /repo, and clis.codex.command does not name its location',
				'  Executable: not found: codex was not found on PATH in /repo, and clis.codex.command does not name its location'
			],
			'  Status: cannot start: codex.cmd runs via cmd.exe, which cannot safely accept clis.codex.args[1] containing "!"; set clis.codex.command to the CLI executable or Node entry point'
		]);
		assert.strictEqual(launchDocument({ location: { label: 'main', path: '/repo', environment: 'SSH: build' }, yolo: true, launches: [], entries: [], problems: [], file, now }).split('\n')[1], 'Working location: /repo (SSH: build)');
	});

	test('a program\'s section says its command came from its entry, its YOLO is not applied and its sandbox, approvals and trust are its own (CONFIGURATION-2.3)', () => {
		const program = codex({
			cli: 'my cli', displayName: 'my cli', setting: 'clis["my cli"]',
			program: { file: '/bin/my-cli', configured: 'my-cli', throughCmd: false },
			args: ['--fast'], yolo: undefined, sandbox: { state: 'unknown' }, approvals: { state: 'unknown' }, trust: { kind: 'unknown' }
		});
		const text = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: true, launches: [program], entries: [], problems: [], file, now }).split('\n');
		assert.deepStrictEqual(text.slice(5, 8).concat(text.slice(-6)), [
			'my cli (my cli, clis["my cli"])',
			'  Status: available',
			'  Executable: /bin/my-cli (from clis["my cli"].command "my-cli")',
			'    --fast',
			'  YOLO: not applied; a custom CLI starts exactly as configured',
			'  Sandbox: unknown; Facade does not read a custom CLI\'s configuration',
			'  Approvals: unknown; Facade does not read a custom CLI\'s configuration',
			'  Trust: not granted by Facade; a custom CLI that prompts for folder trust asks in its terminal',
			''
		]);
	});

	test('CONFIGURATION-4.1: a settings file with errors lists them under the file\'s name instead of YOLO, any secret in them redacted, and shows no CLI', () => {
		const problems = [
			{ text: `${file}:3:12: yolo must be true or false; received string`, said: { kind: 'settings_yolo', values: [file, '3', '12', 'string'] } },
			{ text: `${file}:1:1: this is not valid JSON with comments`, said: { kind: 'settings_syntax', values: [file, '1', '1'] } }
		];
		const text = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: true, launches: [], entries: [], problems, file, now }).split('\n');
		assert.deepStrictEqual(text.slice(3), [
			'~/.facade/facade.json has errors; no agent can start until they are fixed:',
			'  - ~/.facade/facade.json:3:12: yolo must be true or false; received string',
			'  - ~/.facade/facade.json:1:1: this is not valid JSON with comments',
			''
		]);
	});

	test('without a folder, each CLI\'s entry with whether it is off and its errors; a location since gone says so', () => {
		const noFolder = launchDocument({
			yolo: true, launches: [], problems: [], file, now,
			entries: [
				{ adapter: { id: 'codex', displayName: 'Codex', setting: 'clis.codex' }, enabled: false, problems: [] },
				{ adapter: { id: 'pi', displayName: 'Pi', setting: 'clis.pi' }, enabled: true, problems: [{ text: 'x', said: { kind: 'entry_enabled_type', values: ['clis.pi.enabled', 'string'] } }] }
			] as never
		});
		assert.deepStrictEqual([
			noFolder.split('\n'),
			launchDocument({ gone: 'shop · login-fix', yolo: true, launches: [], entries: [], problems: [], file, now })
		], [
			[
				'No folder is open. Open a folder to view agent launch details.',
				'Computed at 2026-10-31 01:02:03 UTC without starting any CLI. This shows the configuration a new agent would use now, not an observation of a running process. Secret values are <redacted>.',
				'YOLO: on, from yolo in ~/.facade/facade.json; applies to newly started agents',
				'', 'Codex (codex, clis.codex)', '  Status: off; clis.codex.enabled is false, so New Agent does not offer it', '  Configuration errors: none',
				'', 'Pi (pi, clis.pi)', '  Configuration errors:', '    - clis.pi.enabled must be true or false; received string', ''
			],
			'Working location shop · login-fix is no longer available. Run Show Agent Launch again to choose another.\n'
		]);
	});
});
