/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The focus probe (FACADE_IT_ONLY=probe; LIFECYCLE-2.2, 3.4, 3.5): evidence, not a gate, about keys typed while a mark has borrowed
// the focus and about covered fronts that cannot be brought back. Each of its sessions is an isolated official VS Code - user data,
// extensions, shared data and a Facade root of its own, fake CLIs only - opened with `--remote-debugging-port` on a free port of this
// computer's loopback, where focusProbeDriver.ts, beside it, types CDP-injected keyboard events into that window's own workbench page:
// `native` with the driver alone for the editor's own behaviour, `facade` and `reload` beside Facade Code. Never OS-level keyboard or
// IME input, which this does not cover. It writes probe-evidence.json and probe-summary.md to FACADE_IT_PROBE_OUT, else to the temporary
// folder's facade-it-probe; FACADE_IT_PROBE_CASES, such as `N1,N3,F2`, runs some cases alone. Each case's verdict is the driver's
// (focusProbeDriver.ts): a native method's, or Facade's by the rules as they stand; the run itself fails only where the probe could not
// run.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Workbench } from './cdpInput';
import { EDITOR_FLAGS, endEditors, endMatching } from './editors';

export interface FocusProbeContext {
	readonly executable: string;
	/** The run's temporary folder, and the parent of each session's Facade root. */
	readonly root: string;
	readonly home: string;
	/** The suite's settings, the built-ins but Claude Code's turned off. */
	readonly settings: { readonly [setting: string]: unknown };
	readonly extension: string;
	readonly windowComponent: string;
	readonly record: string;
	readonly claudeConfig: string;
	readonly fake: string;
	/**
	 * The FACADE_IT_PROBE_* variables the runner was given, read before it clears Facade's from its environment: _OUT, where the
	 * evidence goes; _CASES, a comma-separated subset of the cases; _KEYS=char, each key as keyDown, char and keyUp (cdpInput.ts).
	 */
	readonly env: { readonly [name: string]: string | undefined };
}

/** What every session's editor has beside the suite's settings: nothing that would type, suggest or ask for it. */
const PROBE_SETTINGS = {
	'editor.quickSuggestions': { other: false, comments: false, strings: false },
	'editor.wordBasedSuggestions': 'off',
	'editor.suggestOnTriggerCharacters': false,
	'editor.parameterHints.enabled': false,
	'editor.inlineSuggest.enabled': false,
	'workbench.startupEditor': 'none',
	'workbench.tips.enabled': false,
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'chat.disableAIFeatures': true,
	'terminal.integrated.confirmOnKill': 'never',
	'terminal.integrated.confirmOnExit': 'never',
	'telemetry.telemetryLevel': 'off',
	'update.mode': 'none',
	'extensions.autoUpdate': false,
	'extensions.autoCheckUpdates': false
};

/** The sessions, each in an editor of its own, and the cases each runs. */
const SESSIONS: readonly { readonly name: string; readonly short: string; readonly facade: boolean; readonly cases: readonly string[] }[] = [
	{ name: 'native', short: 'n', facade: false, cases: ['N1', 'N2', 'N3', 'N4', 'N5'] },
	{ name: 'facade', short: 'f', facade: true, cases: ['F1', 'F2', 'F4', 'F6'] },
	{ name: 'reload', short: 'r', facade: true, cases: ['F3', 'F7'] },
	// A floating editor window's, its own reload last
	{ name: 'floating', short: 'w', facade: true, cases: ['F5'] }
];

interface Line { readonly phase: string; readonly at?: number; readonly [key: string]: unknown }

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

/** One session's editor, until its driver says it is done or failed: what it wrote. */
async function session(ctx: FocusProbeContext, name: string, short: string, withFacade: boolean): Promise<{ lines: Line[]; output: string }> {
	const folder = path.join(ctx.root, `fprobe-${name}`);
	// VS Code's IPC socket lives below user data: short names, within the platform's limit
	const user = path.join(ctx.root, `u-q${short}`), extensions = path.join(ctx.root, `x-q${short}`), shared = path.join(ctx.root, `s-q${short}`);
	const facade = path.join(ctx.home, `probe-${name}`);
	const out = path.join(ctx.root, `probe-${name}.jsonl`);
	const driver = path.join(ctx.root, `driver-probe-${name}`);
	for (const dir of [folder, path.join(user, 'User'), facade, driver]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ ...ctx.settings, ...PROBE_SETTINGS }));
	// Activated at once: after a reload it types before Facade's restoration begins
	fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'focus-probe-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['*'], main: './extension.js' }));
	fs.copyFileSync(path.join(__dirname, 'focusProbeDriver.js'), path.join(driver, 'extension.js'));
	fs.copyFileSync(path.join(__dirname, 'cdpInput.js'), path.join(driver, 'cdpInput.js'));
	for (const file of fs.readdirSync(path.dirname(ctx.record)).filter(each => each.startsWith(`${path.basename(ctx.record)}.`))) {
		fs.rmSync(path.join(path.dirname(ctx.record), file));
	}
	const port = await freePort();
	let output = '';
	const editor = spawn(ctx.executable, [folder, '--new-window', '--disable-extensions', '--user-data-dir', user, '--extensions-dir', extensions, '--shared-data-dir', shared,
		...withFacade ? [`--extensionDevelopmentPath=${ctx.extension}`, `--extensionDevelopmentPath=${ctx.windowComponent}`] : [],
		`--extensionDevelopmentPath=${driver}`, `--remote-debugging-port=${port}`, ...EDITOR_FLAGS], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env, FACADE_HOME: facade, FACADE_IT_RECORD: ctx.record, FACADE_IT_PROBE: out, FACADE_IT_PROBE_PHASE: name, FACADE_IT_PROBE_PORT: String(port),
			FACADE_IT_PROBE_FAKE: ctx.fake, CLAUDE_CONFIG_DIR: ctx.claudeConfig,
			...Object.fromEntries(['FACADE_IT_PROBE_CASES', 'FACADE_IT_PROBE_KEYS'].filter(each => ctx.env[each]).map(each => [each, ctx.env[each]!]))
		}
	});
	const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-16_000); };
	editor.stdout?.on('data', append);
	editor.stderr?.on('data', append);
	const lines = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
	// The page's focus emulated for the whole session, reloads included: it takes itself to be the window in front, as one a person
	// types in is, whichever window the system has in front
	let holder: Workbench | undefined;
	let holding = true;
	const hold = (async () => {
		while (holding) {
			if (!holder || holder.cdp.closed) {
				holder = await Workbench.connect(port, path.basename(folder), 5_000).catch(() => undefined);
				await holder?.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	})();
	try {
		const end = Date.now() + 1_200_000;
		let shown = 0;
		while (Date.now() < end && !lines().some(line => line.phase === 'done' || line.phase === 'error')) {
			// Each case as it is written, for a look at a long run
			for (const line of lines().slice(shown)) {
				if (line.phase === 'case') { console.log(`    ${String(line.id)}: ${String(line.verdict)}`); }
			}
			shown = lines().length;
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return { lines: lines(), output };
	} finally {
		holding = false;
		await hold;
		holder?.close();
		try {
			await endEditors([editor]);
		} finally {
			endMatching(user);
			endMatching(path.join(facade, 'extension', 'ptyd'));
		}
	}
}

const cell = (text: unknown) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The evidence in a page: each case's verdict and what was measured, and each borrow's duration. */
function summary(evidence: { generatedAt: string; input: string; snapshot: object; meta: Line[]; cases: Line[]; problems: string[] }): string {
	const meta = evidence.meta[0] ?? {};
	const rows = evidence.cases.map(each => `| ${cell(each.id)} | ${cell(each.title)} | ${cell(each.done)} | ${cell(each.measured)} | **${cell(each.verdict)}** |`);
	const borrows = evidence.cases.filter(each => each.borrow).map(each => {
		const borrow = each.borrow as { leftMs?: number; backMs?: number; ms?: number; path: string[] };
		return `| ${cell(each.id)} | ${borrow.leftMs ?? '-'} | ${borrow.backMs ?? 'not back'} | ${borrow.ms ?? '-'} | ${cell(borrow.path.join(' → '))} |`;
	});
	// N3 as a matrix: each kind of covered front, by each way of bringing it back
	type Trial = { method?: string; verdict: string; outcome: string; focusKept?: boolean; activeGroupBefore?: number; activeGroupAfter?: number; drawnActiveGroupAfter?: number; focusBefore?: string; focusAfter?: string };
	const kinds = evidence.cases.filter(each => Array.isArray(each.trials));
	const methods = [...new Set(kinds.flatMap(each => (each.trials as Trial[]).map(trial => trial.method).filter((method): method is string => !!method)))];
	const matrix = kinds.map(each => {
		const trials = each.trials as Trial[];
		return `| ${cell(each.id)} | ${cell((each.opened as { kind?: string; viewType?: string; notebookType?: string } | null)?.kind ?? 'did not open')} | ${methods.map(method => {
			const trial = trials.find(one => one.method === method);
			if (!trial) {
				return '-';
			}
			const moved = trial.focusKept === false ? `; active group ${trial.activeGroupBefore} → ${trial.activeGroupAfter} (drawn ${trial.drawnActiveGroupAfter}), DOM focus ${trial.focusBefore === trial.focusAfter ? 'stayed' : `→ ${trial.focusAfter}`}` : '';
			return `**${trial.verdict}** ${cell(trial.outcome)}${cell(moved)}`;
		}).join(' | ')} |`;
	});
	return [
		`# Facade focus probe`,
		'',
		`Generated ${evidence.generatedAt}. Editor: VS Code ${cell(meta.vscode)} on ${cell(meta.platform)}, each session an isolated profile with fake CLIs only.`,
		'',
		`Input: ${evidence.input}.`,
		'',
		`Build: ${cell(JSON.stringify(evidence.snapshot))}.`,
		'',
		'A native case (N) judges its method: a lost or misdirected key, or a front not brought back, is a FAILURE. Facade\'s cases (F) are judged by the rules as they stand (LIFECYCLE-3.4, 3.5): the person\'s own Pin or Unpin shows its agent\'s tab with the focus, as a click on its card does, and the keys after it are that agent\'s CLI\'s; a key reaching anything the person did not type into, or a front not as those rules leave it, is a FAILURE; a reload\'s lost keys, which reached nothing and which the owner accepts, are counted apart from misdirected ones. BLOCKED means the case could not be measured.',
		'',
		'| Case | Question | Done | Measured | Verdict |',
		'| --- | --- | --- | --- | --- |',
		...rows,
		'',
		...matrix.length ? [
			'## N3: covered fronts, by method',
			'',
			'(a) runs with the person\'s focus in group 1 and must leave the active group and the focus there; (b) runs with group 2 active, as during a mark there.',
			'',
			`| Case | Opened as | ${methods.map(cell).join(' | ')} |`,
			`| --- | --- | ${methods.map(() => '---').join(' | ')} |`,
			...matrix,
			''
		] : [],
		'## Borrow durations',
		'',
		'Milliseconds from the Pin command; focus as the page\'s DOM had it (polled every 10 ms).',
		'',
		'| Case | Focus left the person | Focus back | Borrow ms | Path |',
		'| --- | --- | --- | --- | --- |',
		...borrows,
		'',
		...evidence.problems.length ? ['## Problems', '', ...evidence.problems.map(each => `- ${each}`), ''] : []
	].join('\n');
}

/** Runs the sessions the cases asked for need, and writes their evidence. */
export async function focusProbe(ctx: FocusProbeContext): Promise<void> {
	const dir = ctx.env.FACADE_IT_PROBE_OUT ?? path.join(os.tmpdir(), 'facade-it-probe');
	fs.mkdirSync(dir, { recursive: true });
	const only = (ctx.env.FACADE_IT_PROBE_CASES ?? '').split(',').map(each => each.trim()).filter(Boolean);
	const selected = (cases: readonly string[]) => !only.length || only.some(each => cases.some(id => each === id || each.startsWith(`${id}-`)));
	const cases: Line[] = [], meta: Line[] = [], problems: string[] = [];
	for (const each of SESSIONS.filter(one => selected(one.cases))) {
		console.log(`  Focus probe: the ${each.name} session`);
		const { lines, output } = await session(ctx, each.name, each.short, each.facade);
		cases.push(...lines.filter(line => line.phase === 'case').map(line => ({ ...line, session: each.name })));
		meta.push(...lines.filter(line => line.phase === 'meta'));
		for (const line of lines.filter(one => one.phase === 'error')) {
			problems.push(`${each.name}: the driver failed: ${String(line.error)}`);
		}
		if (!lines.some(line => line.phase === 'done' || line.phase === 'error')) {
			problems.push(`${each.name}: the driver did not finish; editor output: ${output.slice(-2_000)}`);
		}
	}
	// Which build this measured: the file the marks are in, by its digest
	const source = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'host', 'execution', 'agentTerminals.ts');
	const snapshot = { agentTerminals: fs.existsSync(source) ? crypto.createHash('sha1').update(fs.readFileSync(source)).digest('hex') : 'not found', source };
	const evidence = {
		generatedAt: new Date().toISOString(),
		input: `CDP-injected keyboard events (Input.dispatchKeyEvent ${ctx.env.FACADE_IT_PROBE_KEYS === 'char' ? 'keyDown, char and keyUp' : 'keyDown carrying its text, then keyUp'}; every fifth key Input.insertText) into each isolated editor's own workbench renderer, which delivers them to its DOM focus, with the page's focus emulated; not OS-level keyboard or IME input, which this does not cover`,
		snapshot, meta, cases, problems
	};
	fs.writeFileSync(path.join(dir, 'probe-evidence.json'), `${JSON.stringify(evidence, undefined, 2)}\n`);
	fs.writeFileSync(path.join(dir, 'probe-summary.md'), `${summary(evidence)}\n`);
	console.log(`  Focus probe: ${cases.length} cases, ${cases.filter(each => each.verdict === 'FAILURE').length} FAILURE, ${cases.filter(each => each.verdict === 'BLOCKED').length} BLOCKED; evidence in ${dir}`);
	for (const each of cases) {
		console.log(`    ${String(each.id)} ${String(each.verdict)}: ${String(each.measured).slice(0, 300)}`);
	}
	if (problems.length) {
		throw new Error(`The focus probe could not run:\n    ${problems.join('\n    ')}`);
	}
}
