/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { LaunchDescription } from '../clis/describe';
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
	const codex = (more: Partial<LaunchDescription> = {}): LaunchDescription => ({
		cli: 'codex', displayName: 'Codex', setting: 'facade.codex', enabled: true, problems: [],
		program: { file: '/bin/codex', configured: '', throughCmd: false }, cwd: '/repo',
		environment: { sources: ['host', 'launch', 'run'], variables: [{ source: 'launch', name: 'OPENAI_API_KEY', value: '<redacted>' }, { source: 'run', name: 'ELECTRON_RUN_AS_NODE', value: null }] },
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

	test('a location\'s document: each CLI as a start there would have it - its program, environment, arguments in order, YOLO, sandbox, approvals and trust', () => {
		const text = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: { value: false }, launches: [codex()], entries: [], problems: [], now });
		assert.deepStrictEqual(text.split('\n'), [
			...header,
			'YOLO: off, from facade.yolo; applies to newly started agents',
			'',
			'Codex (codex, facade.codex)',
			'  Status: available',
			'  Executable: /bin/codex (found on PATH)',
			'  Working directory: /repo',
			'  Environment layers, lowest precedence first: the extension host\'s environment → facade.codex.launch.environment → all agents',
			'    OPENAI_API_KEY=<redacted> (facade.codex.launch.environment)',
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

	test('CLIS-4.1: what a start adds to a CLI\'s environment is named as Facade\'s tools and session tracking, last among its layers', () => {
		const launch = codex({ environment: { sources: ['host', 'run', 'facade'], variables: [{ source: 'facade', name: 'FACADE_CODE_SESSION_FILE', value: '/home/ada/.facade/runs/<run ID>.session.json' }] } });
		const lines = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: { value: false }, launches: [launch], entries: [], problems: [], now }).split('\n');
		assert.ok(lines.includes('  Environment layers, lowest precedence first: the extension host\'s environment → all agents → Facade\'s tools and session tracking'), lines.join('\n'));
		assert.ok(lines.includes('    FACADE_CODE_SESSION_FILE=/home/ada/.facade/runs/<run ID>.session.json (Facade\'s tools and session tracking)'), lines.join('\n'));
	});

	test('withheld folder trust is shown as not granted, with no claim that a file entry will be written', () => {
		const launch = codex({ trust: { kind: 'file', target: { file: '/home/ada/.claude.json', keys: ['projects', '/home/ada', 'hasTrustDialogAccepted'], entry: { value: true }, folder: '/home/ada', withheld: 'the home folder covers all projects' } } });
		const text = launchDocument({ location: { label: 'home', path: '/home/ada' }, yolo: { value: false }, launches: [launch], entries: [], problems: [], now });
		assert.match(text, /Trust: none provided for home folder, parents, or filesystem root; CLI prompts in its terminal/);
		assert.ok(!text.includes('merged into'));
	});

	test('trust kept in a CLI\'s file is said to be merged into it where it exists; where it does not, that no entry is written and the CLI prompts in its terminal (CLIS-4.1, 3.3)', () => {
		const temp = tempDir('fd-show-trust-');
		try {
			const file = path.join(temp.dir, '.claude.json');
			const trustIn = (target: string) => launchDocument({ location: { label: 'main', path: '/repo' }, yolo: { value: false }, now, entries: [], problems: [],
				launches: [codex({ trust: { kind: 'file', target: { file: target, keys: ['projects', '/repo', 'hasTrustDialogAccepted'], entry: { value: true }, folder: '/repo' } } })] }).split('\n').find(line => line.startsWith('  Trust:'));
			const missing = trustIn(file);
			fs.writeFileSync(file, '{}');
			assert.deepStrictEqual([missing, trustIn(file)], [
				`  Trust: no entry is written, as ${file} does not exist; the CLI prompts in its terminal`,
				`  Trust: {"projects":{"/repo":{"hasTrustDialogAccepted":true}}} merged into ${file} before each start; unreadable files are preserved and the CLI prompts in its terminal`
			]);
		} finally {
			temp.remove();
		}
	});

	test('a CLI turned off, misconfigured, not found or unable to start says why, and no plan or program is invented for it', () => {
		const sections = (launch: LaunchDescription) => launchDocument({ location: { label: 'main', path: '/repo', environment: 'SSH: build' }, yolo: { value: true }, launches: [launch], entries: [], problems: [], now }).split('\n').slice(5);
		const off = sections(codex({ enabled: false, args: undefined, trust: undefined }));
		const wrong = sections(codex({
			problems: [{ text: 'facade.codex.launch.arguments must be an array of strings; received object', said: { kind: 'arguments_type', values: ['facade.codex.launch.arguments', 'object'] } }],
			program: { unresolved: true }, args: undefined, trust: undefined
		}));
		const missing = sections(codex({ program: { missing: 'codex was not found', said: { kind: 'not_on_path', values: ['codex', '/repo', 'facade.codex'] } }, args: undefined, trust: undefined }));
		const unsafe = sections(codex({ planProblem: { text: 'refused', said: { kind: 'cmd_unsafe_setting', values: ['codex.cmd', 'facade.codex.launch.arguments', '1', '"!"', 'facade.codex'] } }, args: undefined, trust: undefined }));
		assert.deepStrictEqual([off[1], off.find(line => line.startsWith('  Arguments')), wrong.slice(1, 5), missing.slice(1, 3), unsafe[1]], [
			'  Status: off; facade.codex.enabled is false, so New Agent does not offer it',
			'  Arguments: none; CLI cannot start with current configuration',
			[
				'  Status: cannot start until configuration errors are fixed',
				'  Configuration errors:',
				'    - facade.codex.launch.arguments must be an array of strings; received object',
				'  Executable: unresolved until configuration errors are fixed'
			],
			[
				'  Status: cannot start: codex was not found on PATH in /repo, and facade.codex.path is not configured',
				'  Executable: not found: codex was not found on PATH in /repo, and facade.codex.path is not configured'
			],
			'  Status: cannot start: codex.cmd runs via cmd.exe, which cannot safely accept facade.codex.launch.arguments[1] containing "!"; set facade.codex.path to the CLI executable or Node entry point'
		]);
		assert.strictEqual(launchDocument({ location: { label: 'main', path: '/repo', environment: 'SSH: build' }, yolo: { value: true }, launches: [], entries: [], problems: [], now }).split('\n')[1], 'Working location: /repo (SSH: build)');
	});

	test('a custom CLI\'s section says its YOLO is not applied and its sandbox, approvals and trust are its own; a wrong facade.custom is said at the top (CLIS-3.4)', () => {
		const custom = codex({
			cli: 'my-cli', displayName: 'my-cli', setting: 'facade.custom.my-cli',
			program: { file: '/bin/my-cli', configured: 'my-cli', throughCmd: false },
			args: ['--fast'], yolo: undefined, sandbox: { state: 'unknown' }, approvals: { state: 'unknown' }, trust: { kind: 'unknown' }
		});
		const text = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: { value: true }, launches: [custom], entries: [], problems: [], now }).split('\n');
		assert.deepStrictEqual(text.slice(5, 8).concat(text.slice(-6)), [
			'my-cli (my-cli, facade.custom.my-cli)',
			'  Status: available',
			'  Executable: /bin/my-cli (from facade.custom.my-cli.path "my-cli")',
			'    --fast',
			'  YOLO: not applied; a custom CLI starts exactly as configured',
			'  Sandbox: unknown; Facade does not read a custom CLI\'s configuration',
			'  Approvals: unknown; Facade does not read a custom CLI\'s configuration',
			'  Trust: not granted by Facade; a custom CLI that prompts for folder trust asks in its terminal',
			''
		]);
		const problems = [{ text: 'facade.custom must be an object of custom CLIs by ID; received array', said: { kind: 'custom_type', values: ['facade.custom', 'array'] } }];
		const wrong = launchDocument({ location: { label: 'main', path: '/repo' }, yolo: { value: true }, launches: [], entries: [], problems, now }).split('\n');
		assert.deepStrictEqual(wrong.slice(3, 6), [
			'YOLO: on, from facade.yolo; applies to newly started agents',
			'Configuration errors:',
			'  - facade.custom must be an object of custom CLIs by ID; received array'
		]);
	});

	test('a wrong facade.yolo shows no arguments and no YOLO, sandbox or approvals; without a folder, each CLI\'s settings and errors; a location since gone says so', () => {
		const yolo = { problem: 'facade.yolo must be true or false; received "yes"', received: '"yes"' };
		const wrongYolo = launchDocument({ location: { label: 'main', path: '/repo' }, yolo, launches: [codex()], entries: [], problems: [], now }).split('\n');
		const adapter = { id: 'codex', displayName: 'Codex', setting: 'facade.codex' };
		const noFolder = launchDocument({
			yolo: { value: true }, launches: [], problems: [], now,
			entries: [
				{ adapter, enabled: false, problems: [] },
				{ adapter: { id: 'pi', displayName: 'Pi', setting: 'facade.pi' }, enabled: true, problems: [{ text: 'x', said: { kind: 'enabled_type', values: ['facade.pi', 'string'] } }] }
			] as never
		});
		assert.deepStrictEqual([
			wrongYolo[3],
			wrongYolo.filter(line => /^ {2}(Arguments|YOLO|Sandbox|Approvals)/.test(line)),
			noFolder.split('\n').slice(3),
			launchDocument({ gone: 'shop · login-fix', yolo: { value: true }, launches: [], entries: [], problems: [], now })
		], [
			'YOLO: facade.yolo must be true or false; received "yes". No agent can start until resolved.',
			['  Arguments: not shown until facade.yolo is fixed'],
			['', 'Codex (codex, facade.codex)', '  Status: off; facade.codex.enabled is false, so New Agent does not offer it', '  Configuration errors: none',
				'', 'Pi (pi, facade.pi)', '  Configuration errors:', '    - facade.pi.enabled must be true or false; received string', ''],
			'Working location shop · login-fix is no longer available. Run Show Agent Launch again to choose another.\n'
		]);
		assert.strictEqual(noFolder.split('\n')[0], "No folder is open. Open a folder to view agent launch details.");
	});
});
