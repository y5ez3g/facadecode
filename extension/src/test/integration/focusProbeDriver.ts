/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The focus probe's driver (FACADE_IT_ONLY=probe; LIFECYCLE-2.2, 3.4, 3.5): measured facts about the two residuals of Facade's marks -
// keys typed while a mark has borrowed the focus, and covered fronts that cannot be brought back. It runs in an isolated editor that
// runs no tests: alone for the editor's native behaviour (phase `native`), beside Facade Code for its marks (`facade`, and `reload`,
// whose window reloads). Its input is CDP-injected keyboard events (cdpInput.ts) into its own workbench page, which go wherever that
// page's DOM focus is - not OS-level keyboard or IME input, which this does not cover. Each case is a line of FACADE_IT_PROBE for the
// runner (focusProbe.ts): what was done, when each key was injected relative to the steps, what received it - a terminal's CLI by
// the input it logs, a text document by its changes, or nothing - and a verdict. A native case's is its method's: a lost or
// misdirected key, or a front not brought back, is a FAILURE. Facade's are judged by the rules as they stand (LIFECYCLE-3.4, 3.5): the
// person's own Pin or Unpin shows its agent's tab with the focus, as a click on its card does, the keys after it that agent's CLI's; a
// key reaching anything the person did not type into, or a front not as those rules leave it, is a FAILURE; and a reload's lost keys,
// which reached nothing and which the owner accepts, are counted apart from misdirected ones.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';
import { listTargets, Workbench, whereName, type FocusEntry, type RendererKey, type Where } from './cdpInput';

const OUT = process.env.FACADE_IT_PROBE!;
const PHASE = process.env.FACADE_IT_PROBE_PHASE ?? 'native';
const PORT = Number(process.env.FACADE_IT_PROBE_PORT);
const RECORD = process.env.FACADE_IT_RECORD!;
const FAKE = process.env.FACADE_IT_PROBE_FAKE!;
const ONLY = (process.env.FACADE_IT_PROBE_CASES ?? '').split(',').map(each => each.trim()).filter(Boolean);
/** FACADE_IT_PROBE_KEYS=char injects each key as keyDown, char and keyUp; else as a keyDown carrying its text and a keyUp (cdpInput.ts). */
const KEYS = process.env.FACADE_IT_PROBE_KEYS === 'char' ? 'keyDown+char' : 'keyDown+text';
/** How many times F1 and F2 run, each with agents of its own: FACADE_IT_PROBE_REPEAT, 3 by default. */
const REPEAT = Math.max(1, Number(process.env.FACADE_IT_PROBE_REPEAT ?? 3) || 3);
/** A fast typist's pace while a mark goes on: a key every 40 ms. */
const PACE = 40;

/** Whether case `id` runs: all where FACADE_IT_PROBE_CASES names none; `F2` selects `F2-card` too, and `F2-card` its own case alone. */
function wanted(id: string): boolean {
	return !ONLY.length || ONLY.some(each => id === each || id.startsWith(`${each}-`));
}

/** The editor's commands that focus its first to eighth group, as agentTerminals.ts's GROUP_FOCUS. */
const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(nth => `workbench.action.focus${nth}EditorGroup`);
/** Each key of a case is one of these, in turn: what reached a sink is told apart by its character and time. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PANEL = 'facade.facadecode';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const unspun = (title: string) => title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');
const base = (uri: vscode.Uri) => path.basename(uri.path);
const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err);

interface Line { readonly phase: string; readonly at?: number; readonly [key: string]: unknown }

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify({ ...line, at: Date.now() })}\n`);
}

function said(): Line[] {
	return fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 20_000, every = 50): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await sleep(every);
	}
}

/** Runs a command; a failure is noted, not thrown: what it did or did not do is the evidence. */
const notes: string[] = [];
async function cmd(id: string, ...args: unknown[]): Promise<unknown> {
	return await vscode.commands.executeCommand(id, ...args).then(result => result, err => {
		notes.push(`${id} failed: ${messageOf(err)}`);
		return undefined;
	});
}

// ---------------------------------------------------------------------------------------------------------------------------
// What the extension host sees, as it happens

interface HostEvent { readonly t: number; readonly ev: string; readonly [key: string]: unknown }
const hostEvents: HostEvent[] = [];
const docChanges: { readonly t: number; readonly file: string; readonly text: string }[] = [];

function brief(tab: vscode.Tab | undefined): string {
	return tab ? `g${tab.group.viewColumn}:${unspun(tab.label)}${tab.isPinned ? ' (pinned)' : ''}` : 'none';
}

function listen(): vscode.Disposable[] {
	const push = (ev: string, more: object) => hostEvents.push({ t: Date.now(), ev, ...more });
	return [
		vscode.window.onDidChangeActiveTerminal(terminal => push('activeTerminal', { name: terminal ? unspun(terminal.name) : null })),
		vscode.window.tabGroups.onDidChangeTabGroups(event => push('groups', {
			activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, opened: event.opened.map(group => group.viewColumn), closed: event.closed.map(group => group.viewColumn),
			changed: event.changed.map(group => `${group.viewColumn}${group.isActive ? ' (active)' : ''}`)
		})),
		vscode.window.tabGroups.onDidChangeTabs(event => push('tabs', {
			opened: event.opened.map(tab => `${brief(tab)}${tab.isActive ? ' (front)' : ''}`), closed: event.closed.map(brief), changed: event.changed.map(tab => `${brief(tab)}${tab.isActive ? ' (front)' : ''}`),
			activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, front: brief(vscode.window.tabGroups.activeTabGroup.activeTab)
		})),
		vscode.window.onDidChangeActiveTextEditor(editor => push('activeEditor', { file: editor ? base(editor.document.uri) : null, column: editor?.viewColumn })),
		vscode.window.onDidChangeWindowState(state => push('windowState', { focused: state.focused })),
		vscode.workspace.onDidChangeTextDocument(event => {
			const text = event.contentChanges.map(change => change.text).join('');
			if (text && event.document.uri.scheme === 'file') {
				docChanges.push({ t: Date.now(), file: base(event.document.uri), text });
			}
		})
	];
}

/** What the extension sees of the window's focus: its active group and tab, active terminal and active text editor, and each group's front. */
function seen(): object {
	const group = vscode.window.tabGroups.activeTabGroup;
	const editor = vscode.window.activeTextEditor;
	return {
		activeGroup: group.viewColumn, activeTab: brief(group.activeTab), activeTerminal: vscode.window.activeTerminal ? unspun(vscode.window.activeTerminal.name) : null,
		activeTextEditor: editor ? `${base(editor.document.uri)} (column ${editor.viewColumn})` : null, windowFocused: vscode.window.state.focused,
		fronts: vscode.window.tabGroups.all.map(each => `g${each.viewColumn}: ${each.activeTab ? unspun(each.activeTab.label) : '(empty)'} [${each.tabs.length} tabs]`)
	};
}

/** A tab as N3 compares it: its kind of input and that input's resources and types, its group and place there. */
interface TabDesc {
	readonly label: string;
	readonly kind: string;
	readonly group: number;
	readonly index: number;
	readonly uri?: string;
	readonly original?: string;
	readonly modified?: string;
	readonly viewType?: string;
	readonly notebookType?: string;
	readonly preview: boolean;
	readonly pinned: boolean;
}

function describeTab(tab: vscode.Tab): TabDesc {
	const input = tab.input as unknown;
	const common = { label: unspun(tab.label), group: tab.group.viewColumn, index: tab.group.tabs.indexOf(tab), preview: tab.isPreview, pinned: tab.isPinned };
	if (input instanceof vscode.TabInputText) { return { ...common, kind: 'text', uri: input.uri.toString() }; }
	if (input instanceof vscode.TabInputTextDiff) { return { ...common, kind: 'diff', original: input.original.toString(), modified: input.modified.toString() }; }
	if (input instanceof vscode.TabInputNotebook) { return { ...common, kind: 'notebook', uri: input.uri.toString(), notebookType: input.notebookType }; }
	if (input instanceof vscode.TabInputNotebookDiff) { return { ...common, kind: 'notebookDiff', original: input.original.toString(), modified: input.modified.toString(), notebookType: input.notebookType }; }
	if (input instanceof vscode.TabInputCustom) { return { ...common, kind: 'custom', uri: input.uri.toString(), viewType: input.viewType }; }
	if (input instanceof vscode.TabInputWebview) { return { ...common, kind: 'webview', viewType: input.viewType }; }
	if (input instanceof vscode.TabInputTerminal) { return { ...common, kind: 'terminal' }; }
	return { ...common, kind: input === undefined ? 'unknown (no input)' : `unknown (${(input as object).constructor?.name ?? typeof input})` };
}

const sameTab = (a: TabDesc | undefined, b: TabDesc | undefined) => !!a && !!b && a.kind === b.kind && a.label === b.label && a.uri === b.uri && a.original === b.original
	&& a.modified === b.modified && a.viewType === b.viewType && a.notebookType === b.notebookType;
const groupAt = (column: number) => vscode.window.tabGroups.all.find(group => group.viewColumn === column);
const frontOf = (column: number) => { const tab = groupAt(column)?.activeTab; return tab ? describeTab(tab) : undefined; };
const shortTab = (tab: TabDesc | undefined) => tab ? `${tab.kind} "${tab.label}"${tab.viewType ? ` ${tab.viewType}` : ''}${tab.notebookType ? ` ${tab.notebookType}` : ''}` : 'none';

// ---------------------------------------------------------------------------------------------------------------------------
// The page: CDP-injected keyboard events, and where its focus went

let wb: Workbench;
const rendererKeys: RendererKey[] = [];
const rendererFocus: FocusEntry[] = [];

async function pull(): Promise<void> {
	const { keys, focus } = await wb.drain();
	rendererKeys.push(...keys);
	rendererFocus.push(...focus);
}

/** The page's focus from `since`: the entry it was on then, and each change after. */
function focusSince(since: number): FocusEntry[] {
	const before = rendererFocus.filter(entry => entry.t < since).pop();
	return [...before ? [before] : [], ...rendererFocus.filter(entry => entry.t >= since)];
}

function focusAt(focus: readonly FocusEntry[], t: number): FocusEntry | undefined {
	return focus.filter(entry => entry.t <= t).pop();
}

interface Sent { readonly n: number; readonly char: string; readonly via: 'key' | 'insertText'; readonly sent: number; readonly acked: number }

/** Types one key at a time, each a character of its own; every fifth by Input.insertText, the others by key events. */
class Typist {
	private next = 0;
	readonly sent: Sent[] = [];

	async type(): Promise<Sent> {
		const n = this.next++;
		const char = ALPHABET[n % ALPHABET.length];
		const via = n % 5 === 4 ? 'insertText' : 'key';
		const sent = Date.now();
		if (via === 'key') {
			await wb.key(char);
		} else {
			await wb.insertText(char);
		}
		const entry: Sent = { n, char, via, sent, acked: Date.now() };
		this.sent.push(entry);
		return entry;
	}

	/** At each of `offsets` ms after `from`. */
	async at(from: number, offsets: readonly number[]): Promise<void> {
		for (const offset of offsets) {
			const wait = from + offset - Date.now();
			if (wait > 0) {
				await sleep(wait);
			}
			await this.type();
		}
	}

	/** One key every `every` ms until stopped. */
	stream(every: number): { stop(): Promise<void> } {
		let running = true;
		const loop = (async () => {
			while (running) {
				const started = Date.now();
				await this.type().catch(err => notes.push(`a key could not be injected: ${messageOf(err)}`));
				const wait = every - (Date.now() - started);
				if (wait > 0) {
					await sleep(wait);
				}
			}
		})();
		return { stop: async () => { running = false; await loop; } };
	}
}

interface Reception { readonly sink: string; readonly t: number; readonly char: string }

/** What a fake CLI logged as its input since `since`, its terminal's reports and answers left out. */
function ptyChunks(id: string, since: number): { readonly t: number; readonly data: string }[] {
	const file = `${RECORD}.stdin.${id}`;
	if (!fs.existsSync(file)) {
		return [];
	}
	return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; data: string })
		.filter(each => each.at >= since).map(each => ({ t: each.at, data: each.data }));
}

// eslint-disable-next-line no-control-regex
const stripped = (data: string) => data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b[\s\S]/g, '');

function receptions(ptys: readonly string[], since: number): Reception[] {
	const all: Reception[] = [];
	for (const id of ptys) {
		for (const chunk of ptyChunks(id, since)) {
			for (const char of stripped(chunk.data)) {
				if (/[A-Za-z0-9]/.test(char)) { all.push({ sink: `pty:${id}`, t: chunk.t, char }); }
			}
		}
	}
	for (const change of docChanges.filter(each => each.t >= since)) {
		for (const char of change.text) {
			if (/[A-Za-z0-9]/.test(char)) { all.push({ sink: `doc:${change.file}`, t: change.t, char }); }
		}
	}
	return all.sort((a, b) => a.t - b.t);
}

/** One key, where it went: a sink that received it, else what the page's document saw it reach, else the page's focus then. */
interface Placed extends Sent {
	readonly to: string;
	readonly receivedAt?: number;
	readonly dom?: string;
	readonly focus?: string;
}

/**
 * Each key matched to the first reception of its character after it, within `window` ms: under a cycle of the alphabet, as a key
 * typed again later must not take a lost one's place.
 */
function place(sent: readonly Sent[], recs: readonly Reception[], keys: readonly RendererKey[], focus: readonly FocusEntry[], window: number): Placed[] {
	const used = new Set<Reception>(), usedKeys = new Set<RendererKey>();
	return sent.map(key => {
		const rec = recs.find(each => !used.has(each) && each.char === key.char && each.t >= key.sent - 5 && each.t <= key.acked + window);
		if (rec) { used.add(rec); }
		const event = keys.find(each => !usedKeys.has(each) && each.t >= key.sent - 5 && each.t <= key.acked + 100
			&& (key.via === 'key' ? each.type === 'keydown' && each.key === key.char : each.type === 'beforeinput' && each.data === key.char));
		if (event) { usedKeys.add(event); }
		const at = focusAt(focus, key.sent);
		const to = rec ? rec.sink : event ? `dom:${whereName(event.target)}` : at?.d.where === 'webview' ? `webview:${at.d.extension ?? '?'}` : `nothing (focus ${whereName(at?.d)})`;
		return { ...key, to, ...rec ? { receivedAt: rec.t } : {}, ...event ? { dom: whereName(event.target) } : {}, ...at ? { focus: whereName(at.d) } : {} };
	});
}

/** The sinks' receptions that no injected key accounts for: anything else typed into the window meanwhile. */
function foreign(recs: readonly Reception[], placed: readonly Placed[]): Reception[] {
	const claimed = new Map<string, number>();
	for (const key of placed) {
		if (key.receivedAt !== undefined) { claimed.set(`${key.to}|${key.char}|${key.receivedAt}`, (claimed.get(`${key.to}|${key.char}|${key.receivedAt}`) ?? 0) + 1); }
	}
	return recs.filter(rec => {
		const id = `${rec.sink}|${rec.char}|${rec.t}`;
		const left = claimed.get(id) ?? 0;
		if (left > 0) { claimed.set(id, left - 1); return false; }
		return true;
	});
}

interface Collected {
	readonly placed: Placed[];
	readonly focus: FocusEntry[];
	readonly host: HostEvent[];
	readonly foreign: Reception[];
	/** The resulting text: each document's that took a key or was meant to, and what each terminal's CLI got typed. */
	readonly texts: { readonly docs: { [file: string]: string }; readonly ptys: { [id: string]: string } };
}

async function collect(since: number, typist: Typist, ptys: readonly string[], docs: readonly string[] = [], window = 2_500): Promise<Collected> {
	await sleep(400);
	await pull();
	const recs = receptions(ptys, since);
	const placed = place(typist.sent, recs, rendererKeys.filter(each => each.t >= since), focusSince(since), window);
	const files = new Set([...docs, ...docChanges.filter(each => each.t >= since).map(each => each.file)]);
	const texts = {
		docs: Object.fromEntries([...files].map(name => [name, vscode.workspace.textDocuments.find(doc => base(doc.uri) === name)?.getText() ?? '(not open)'])),
		ptys: Object.fromEntries(ptys.map(id => [id, ptyChunks(id, since).map(chunk => stripped(chunk.data)).join('').replace(/[^\x20-\x7e]/g, '')]).filter(([, text]) => text))
	};
	return { placed, focus: focusSince(since), host: hostEvents.filter(each => each.t >= since), foreign: foreign(recs, placed), texts };
}

/** Keys as the evidence lists them: when each was injected relative to `t0`, by what, and where it went. */
function keyRows(placed: readonly Placed[], t0: number, ok: (key: Placed) => boolean, phaseOf?: (key: Placed) => string): object[] {
	return placed.map(key => ({
		n: key.n, char: key.char, via: key.via, atMs: key.sent - t0, ackMs: key.acked - key.sent, ...phaseOf ? { phase: phaseOf(key) } : {},
		to: key.to, ...key.receivedAt !== undefined ? { receivedMs: key.receivedAt - t0 } : {}, ...key.dom ? { domTarget: key.dom } : {}, focusThen: key.focus, ok: ok(key)
	}));
}

function focusRows(focus: readonly FocusEntry[], t0: number): string[] {
	return focus.map(entry => `${entry.t - t0}ms ${whereName(entry.d)}${entry.hasFocus ? '' : ' (page without focus)'}`);
}

function hostRows(host: readonly HostEvent[], t0: number): string[] {
	return host.map(({ t, ev, ...rest }) => `${t - t0}ms ${ev} ${JSON.stringify(rest)}`);
}

/** Destinations counted, in the order first seen. */
function tally(placed: readonly Placed[]): string {
	const counts = new Map<string, number>();
	for (const key of placed) { counts.set(key.to, (counts.get(key.to) ?? 0) + 1); }
	return [...counts].map(([to, count]) => `${count} → ${to}`).join('; ') || 'no keys';
}

/** A key that reached nothing - no focus, or the page's body - as against one that reached what it was not typed into. */
const lostKey = (key: Placed) => key.to.startsWith('nothing') || key.to.startsWith('dom:nothing');

/** Each group's fronts in turn, as `host`'s tab events told them: a tab each time one came to the front there, the same one once in a row. */
function frontSequence(host: readonly HostEvent[]): { [group: string]: string[] } {
	const fronts: { [group: string]: string[] } = {};
	for (const each of host.filter(one => one.ev === 'tabs')) {
		for (const entry of [...(each.opened as string[]), ...(each.changed as string[])]) {
			const front = /^g(\d+):(.*) \(front\)$/.exec(entry);
			if (!front) {
				continue;
			}
			const label = front[2].replace(/ \(pinned\)$/, '');
			const list = fronts[`g${front[1]}`] ??= [];
			if (list[list.length - 1] !== label) {
				list.push(label);
			}
		}
	}
	return fronts;
}

/** The focus left `person` after `from` and came back to it: when, how long, and through where. */
function borrowOf(focus: readonly FocusEntry[], from: number, person: string, t0: number): { leftMs?: number; backMs?: number; ms?: number; path: string[] } {
	const after = focus.filter(entry => entry.t >= from);
	const left = after.find(entry => whereName(entry.d) !== person);
	if (!left) {
		return { path: [] };
	}
	const back = after.find(entry => entry.t > left.t && whereName(entry.d) === person);
	const path: string[] = [];
	for (const entry of after.filter(each => each.t >= left.t && (!back || each.t <= back.t))) {
		const name = `${entry.t - t0}ms ${whereName(entry.d)}`;
		if (!path.length || !path[path.length - 1].endsWith(whereName(entry.d))) { path.push(name); }
	}
	return { leftMs: left.t - t0, ...back ? { backMs: back.t - t0, ms: back.t - left.t } : {}, path };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The window: files, groups and fake CLIs

const folder = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

function file(name: string, content?: string | Buffer): vscode.Uri {
	const at = path.join(folder(), name);
	if (!fs.existsSync(at)) {
		fs.writeFileSync(at, content ?? `${name}\n`);
	}
	return vscode.Uri.file(at);
}

async function showFile(name: string, column: number, focus = true): Promise<void> {
	await vscode.window.showTextDocument(file(name), { viewColumn: column, preview: false, preserveFocus: !focus });
}

const terminals = new Map<string, vscode.Terminal>();

/** A terminal running the suite's fake CLI, which logs its input as `<record>.stdin.<id>`: no Facade's, a person's own. */
async function fakeTerminal(id: string, location: vscode.TerminalEditorLocationOptions | vscode.TerminalLocation): Promise<vscode.Terminal> {
	const terminal = vscode.window.createTerminal({ name: id, shellPath: FAKE, env: { FACADE_IT_RECORD: RECORD, FACADE_AGENT: id }, location });
	terminals.set(id, terminal);
	await until(`${id}'s fake CLI`, () => fs.existsSync(`${RECORD}.${id}`) || undefined, 20_000);
	await sleep(500);
	return terminal;
}

/** The window as a case begins: no quick input, one empty group, no terminal of the probe's, nothing unsaved. */
async function reset(): Promise<void> {
	await cmd('workbench.action.closeQuickOpen');
	await cmd('workbench.action.files.saveAll');
	await cmd('workbench.action.closeAllGroups');
	// A floating window's groups, which the main window's Close All Editor Groups leaves
	const left = vscode.window.tabGroups.all.filter(group => group !== vscode.window.tabGroups.all[0]);
	if (left.length) {
		await vscode.window.tabGroups.close(left).then(undefined, err => notes.push(`closing groups left: ${messageOf(err)}`));
	}
	for (const terminal of terminals.values()) {
		terminal.dispose();
	}
	terminals.clear();
	await cmd('workbench.action.closePanel');
	await cmd('workbench.action.closeAuxiliaryBar');
	await until('one group', () => vscode.window.tabGroups.all.length === 1 || undefined, 5_000).catch(() => undefined);
	await sleep(400);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Results

type Verdict = 'PASS' | 'FAILURE' | 'BLOCKED';

interface CaseResult {
	readonly id: string;
	readonly title: string;
	/** What was done, in a line. */
	readonly done: string;
	/** What was measured, in a line. */
	readonly measured: string;
	readonly verdict: Verdict;
	readonly [key: string]: unknown;
}

function report(result: CaseResult): void {
	write({ phase: 'case', ...result, notes: notes.splice(0) });
}

// ---------------------------------------------------------------------------------------------------------------------------
// N1-N5: the editor's own behaviour, no Facade

/**
 * N1: `terminal.show(true)` - a mark's first step - then typing: `behind`, the terminal's tab behind the text file focused in the
 * active group; `front`, its tab in front of the active group and focused, as an in-place Pin finds it; `other`, its tab behind in
 * another group, the person's text file focused in group 1.
 */
async function n1(variant: 'behind' | 'front' | 'other'): Promise<CaseResult> {
	await reset();
	const column = variant === 'other' ? 2 : 1;
	if (column === 2) {
		await showFile('n1.txt', 1);
		await showFile('n1-2.txt', 2);
	}
	const id = `n1${variant[0]}`;
	const terminal = await fakeTerminal(id, { viewColumn: column, preserveFocus: false });
	if (variant === 'front') {
		terminal.show(false);
	} else {
		if (column === 2) {
			await showFile('n1-2.txt', 2);
		}
		await showFile('n1.txt', 1);
	}
	await sleep(800);
	await pull();
	const person = await wb.active();
	const before = seen();
	const typist = new Typist();
	const since = Date.now();
	await typist.at(since, [0, 150]);
	await sleep(250);
	const t0 = Date.now();
	terminal.show(true);
	await typist.at(t0, [0, 20, 50, 100, 200, 400, 700, 1_000, 1_500]);
	await sleep(500);
	const after = seen();
	const end = await wb.active();
	const got = await collect(since, typist, [id], ['n1.txt']);
	const intent = variant === 'front' ? `pty:${id}` : 'doc:n1.txt';
	const later = got.placed.filter(key => key.sent >= t0);
	const bad = got.placed.filter(key => key.to !== intent);
	return {
		id: variant === 'behind' ? 'N1' : `N1-${variant}`,
		title: variant === 'behind' ? 'terminal.show(true) on a terminal tab behind the focused text file, same group; then typing'
			: variant === 'front' ? 'terminal.show(true) on the terminal tab already in front of the active group and focused; then typing'
				: 'terminal.show(true) on a terminal tab behind in another group, the person\'s text file focused in group 1; then typing',
		done: `${variant === 'front' ? `fake CLI terminal "${id}" in front of group 1, focused` : variant === 'behind' ? `n1.txt focused in group 1, fake CLI terminal "${id}" behind it` : `n1.txt focused in group 1, fake CLI terminal "${id}" behind n1-2.txt in group 2`}; terminal.show(true) at 0 ms; ${typist.sent.length} keys (2 before)`,
		measured: `front after: ${(after as { activeTab: string }).activeTab}; DOM focus after: ${whereName(end.d)}; before: ${tally(got.placed.filter(key => key.sent < t0))}; after show: ${tally(later)}`,
		verdict: bad.length ? 'FAILURE' : 'PASS',
		person: whereName(person.d), seenBefore: before, seenAfter: after, focusAfter: whereName(end.d), texts: got.texts,
		keys: keyRows(got.placed, t0, key => key.to === intent), intent, focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign
	};
}

/** N2: focus{First..Eighth}EditorGroup to a group whose front is a terminal tab: do typed keys reach that terminal's process? */
async function n2(): Promise<CaseResult[]> {
	await reset();
	for (let column = 1; column <= 8; column++) {
		await showFile(`n2-${column}.txt`, column);
	}
	if (vscode.window.tabGroups.all.length !== 8) {
		throw new Error(`eight groups could not be made: ${vscode.window.tabGroups.all.length}`);
	}
	const ids: string[] = [];
	for (let column = 1; column <= 8; column++) {
		ids.push(`n2t${column}`);
		await fakeTerminal(`n2t${column}`, { viewColumn: column, preserveFocus: true });
	}
	const fronts = vscode.window.tabGroups.all.map(group => brief(group.activeTab));
	await cmd(GROUP_FOCUS[7]);
	await sleep(600);
	const results: CaseResult[] = [];
	for (let column = 1; column <= 8; column++) {
		await pull();
		const from = await wb.active();
		const typist = new Typist();
		const since = Date.now();
		await cmd(GROUP_FOCUS[column - 1]);
		const t0 = Date.now();
		await typist.at(t0, [0, 30, 100, 300]);
		await sleep(300);
		const end = await wb.active();
		const got = await collect(since, typist, ids);
		const intent = `pty:n2t${column}`;
		const bad = got.placed.filter(key => key.to !== intent);
		results.push({
			id: `N2-g${column}`, title: `${GROUP_FOCUS[column - 1].replace('workbench.action.', '')} to a group whose front is a terminal tab`,
			done: `from ${whereName(from.d)}; ${GROUP_FOCUS[column - 1]} (awaited ${t0 - since} ms); keys at 0, 30, 100, 300 ms after it resolved`,
			measured: `active group ${vscode.window.tabGroups.activeTabGroup.viewColumn}, active terminal ${vscode.window.activeTerminal ? unspun(vscode.window.activeTerminal.name) : 'none'}; DOM focus ${whereName(end.d)}; keys: ${tally(got.placed)}`,
			verdict: bad.length ? 'FAILURE' : 'PASS',
			fronts, texts: got.texts, keys: keyRows(got.placed, t0, key => key.to === intent), intent, focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign
		});
	}
	return results;
}

interface Method {
	readonly name: string;
	/** Run with group 2 the active group, as during a mark of a tab there; else with the person's focus in group 1. */
	readonly inActiveGroup: boolean;
	run(covered: TabDesc, now: TabDesc, person: vscode.Terminal | undefined): Promise<string | undefined>;
}

const COLUMN = 2;
const showOptions = { viewColumn: COLUMN, preserveFocus: true, preview: false };

/** The ways a covered front may be brought back (N3): resource-based without focus, and the editor's own commands in the active group. */
const METHODS: readonly Method[] = [
	{
		name: '(a) as Facade shows a covered front back now (agentTerminals.ts showBack)', inActiveGroup: false,
		run: async covered => {
			if (covered.kind === 'terminal') {
				return undefined;
			}
			if (!covered.uri) {
				return undefined;
			}
			await cmd('vscode.open', vscode.Uri.parse(covered.uri), { viewColumn: COLUMN, preserveFocus: true, preview: covered.preview });
			return 'vscode.open(input.uri, { viewColumn, preserveFocus: true })';
		}
	},
	{
		name: '(a) resource-based by its kind, without focus', inActiveGroup: false,
		run: async (covered, _now, person) => {
			switch (covered.kind) {
				case 'text':
					await cmd('vscode.open', vscode.Uri.parse(covered.uri!), showOptions);
					return 'vscode.open';
				case 'diff':
					await cmd('vscode.diff', vscode.Uri.parse(covered.original!), vscode.Uri.parse(covered.modified!), covered.label, showOptions);
					return 'vscode.diff';
				case 'notebook':
					await cmd('vscode.openWith', vscode.Uri.parse(covered.uri!), covered.notebookType, showOptions);
					return `vscode.openWith(uri, '${covered.notebookType}')`;
				case 'notebookDiff':
					await cmd('vscode.diff', vscode.Uri.parse(covered.original!), vscode.Uri.parse(covered.modified!), covered.label, showOptions);
					return 'vscode.diff (notebooks)';
				case 'custom':
					await cmd('vscode.openWith', vscode.Uri.parse(covered.uri!), covered.viewType, showOptions);
					return `vscode.openWith(uri, '${covered.viewType}')`;
				case 'terminal':
					person?.show(true);
					return person ? 'Terminal.show(true)' : undefined;
				default:
					return undefined;
			}
		}
	},
	{
		// Not one of the methods asked for: whether focusing the person's group again after (a) undoes what (a) moves
		name: '(a) resource-based by its kind, then the person\'s group focused again (extra)', inActiveGroup: false,
		run: async (covered, now, person) => {
			const did = await METHODS[1].run(covered, now, person);
			if (did) {
				await sleep(300);
				await cmd(GROUP_FOCUS[0]);
			}
			return did && `${did}, then ${GROUP_FOCUS[0].replace('workbench.action.', '')}`;
		}
	},
	{
		name: '(b) workbench.action.openEditorAtIndexN in the active group', inActiveGroup: true,
		run: async (_covered, now) => {
			if (now.index < 0 || now.index > 8) {
				return undefined;
			}
			await cmd(`workbench.action.openEditorAtIndex${now.index + 1}`);
			return `openEditorAtIndex${now.index + 1}`;
		}
	},
	{
		name: '(b) workbench.action.openPreviousRecentlyUsedEditorInGroup in the active group', inActiveGroup: true,
		run: async () => {
			await cmd('workbench.action.openPreviousRecentlyUsedEditorInGroup');
			return 'openPreviousRecentlyUsedEditorInGroup';
		}
	}
];

const NOTEBOOK = (source: string) => JSON.stringify({
	cells: [
		{ cell_type: 'markdown', metadata: {}, source: ['# probe'] },
		{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [source] }
	],
	metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
	nbformat: 4, nbformat_minor: 5
}, undefined, 1);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** N3: each kind of front, covered by a terminal tab in its group, brought back each way. */
async function n3(): Promise<CaseResult[]> {
	await reset();
	file('n3-left.txt', 'one\ntwo\n');
	file('n3-right.txt', 'one\nthree\n');
	file('n3.ipynb', NOTEBOOK('print(1)'));
	file('n3-b.ipynb', NOTEBOOK('print(2)'));
	file('n3.png', PNG);
	file('n3.md', '# n3\n\nA preview.\n');
	await showFile('n3-home.txt', 1);
	await showFile('n3-spacer.txt', COLUMN, false);
	const cover = await fakeTerminal('n3c', { viewColumn: COLUMN, preserveFocus: true });
	let person: vscode.Terminal | undefined;
	let people = 0;
	const kinds: { readonly name: string; readonly id: string; open(): Promise<void> }[] = [
		{ name: 'text file', id: 'text', open: () => showFile('n3.txt', COLUMN) },
		{ name: 'text diff (vscode.diff)', id: 'diff', open: async () => { await cmd('vscode.diff', file('n3-left.txt'), file('n3-right.txt'), 'n3 diff', { viewColumn: COLUMN, preview: false }); } },
		{ name: 'notebook (.ipynb by vscode.open)', id: 'notebook', open: async () => { await cmd('vscode.open', file('n3.ipynb'), { viewColumn: COLUMN, preview: false }); } },
		{ name: 'notebook diff (vscode.diff of two .ipynb)', id: 'notebookDiff', open: async () => { await cmd('vscode.diff', file('n3.ipynb'), file('n3-b.ipynb'), 'n3 notebook diff', { viewColumn: COLUMN, preview: false }); } },
		{ name: 'custom editor (imagePreview.previewEditor on a .png)', id: 'custom', open: async () => { await cmd('vscode.openWith', file('n3.png'), 'imagePreview.previewEditor', { viewColumn: COLUMN, preview: false }); } },
		{ name: 'webview (markdown.showPreview)', id: 'webview', open: async () => { await cmd(GROUP_FOCUS[COLUMN - 1]); await cmd('markdown.showPreview', file('n3.md')); } },
		{ name: 'Settings UI (workbench.action.openSettings2)', id: 'settings', open: async () => { await cmd(GROUP_FOCUS[COLUMN - 1]); await cmd('workbench.action.openSettings2'); } },
		{ name: 'the person\'s own terminal in an editor tab', id: 'terminal', open: async () => { person = await fakeTerminal(`n3p${++people}`, { viewColumn: COLUMN, preserveFocus: false }); } }
	];
	const keep = (tab: TabDesc) => tab.label === 'n3-spacer.txt' || tab.label === 'n3c' || tab.label === 'n3-home.txt';
	if (frontOf(COLUMN)?.label !== 'n3c' || frontOf(1)?.label !== 'n3-home.txt') {
		throw new Error(`the groups could not be set up: ${JSON.stringify(seen())}`);
	}
	const results: CaseResult[] = [];
	for (const kind of kinds) {
		const trials: object[] = [];
		let opened: TabDesc | undefined;
		let openedIn: number | undefined;
		const open = async () => {
			const others = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => JSON.stringify(describeTab(tab))));
			await kind.open();
			// Whatever opened new, of the kind asked for or not: what opened is the evidence. One the editor opened in another group -
			// a markdown preview goes where its document's editor is, the Settings UI to the side of a terminal - is moved into group 2
			const fresh = await until(`${kind.name} to open`, () => vscode.window.tabGroups.all.flatMap(group => group.tabs).map(describeTab)
				.find(tab => !keep(tab) && !others.has(JSON.stringify(tab)) && tab.label !== 'n3-home.txt'), 8_000).catch(() => undefined);
			if (fresh && fresh.group !== COLUMN) {
				openedIn = fresh.group;
				await cmd(GROUP_FOCUS[fresh.group - 1]);
				const known = await vscode.commands.getCommands(true);
				await cmd(known.includes('workbench.action.moveEditorToSecondGroup') ? 'workbench.action.moveEditorToSecondGroup'
					: fresh.group > COLUMN ? 'workbench.action.moveEditorToPreviousGroup' : 'workbench.action.moveEditorToNextGroup');
			}
			await until(`${kind.name} in front of group ${COLUMN}`, () => {
				const front = frontOf(COLUMN);
				return front && !keep(front) && !others.has(JSON.stringify(front)) ? front : undefined;
			}, 8_000).catch(() => undefined);
			await sleep(800);
			const front = frontOf(COLUMN);
			opened = front && !keep(front) ? front : undefined;
		};
		try {
			await open();
			if (!opened) {
				throw new Error(`${kind.name} did not open in group ${COLUMN}: ${JSON.stringify(seen())}`);
			}
			for (const method of METHODS) {
				// The kind in front of group 2 to begin with, nothing else beside the spacer and the cover
				const stray = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => { const desc = describeTab(tab); return !keep(desc) && !sameTab(desc, opened); });
				if (stray.length) { await vscode.window.tabGroups.close(stray).then(undefined, err => notes.push(`closing strays: ${messageOf(err)}`)); await sleep(400); }
				let present = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => sameTab(describeTab(tab), opened));
				if (!present) {
					await open();
					present = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => sameTab(describeTab(tab), opened));
				}
				if (!present) {
					trials.push({ method: method.name, outcome: 'blocked: the kind could not be opened again', verdict: 'BLOCKED' });
					continue;
				}
				if (!sameTab(frontOf(COLUMN), opened)) {
					await cmd(GROUP_FOCUS[COLUMN - 1]);
					await cmd(`workbench.action.openEditorAtIndex${describeTab(present).index + 1}`);
					await sleep(500);
				}
				// Where the person is: group 1's file, else group 2 as a mark makes it the active group
				if (method.inActiveGroup) {
					await cmd(GROUP_FOCUS[COLUMN - 1]);
				} else {
					await showFile('n3-home.txt', 1);
				}
				await sleep(500);
				// Covered: the cover's terminal in front of its group, as a mark brings an agent's tab there
				cover.show(true);
				const covered = await until('the cover in front', () => frontOf(COLUMN)?.label === 'n3c' || undefined, 3_000).then(() => true, () => false);
				await sleep(400);
				await pull();
				const groupBefore = vscode.window.tabGroups.activeTabGroup.viewColumn;
				const drawnBefore = await wb.activeGroup();
				const focusBefore = await wb.active();
				const all = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.map(describeTab));
				const tabsBefore = all();
				const now = tabsBefore.find(tab => sameTab(tab, opened))!;
				const countBefore = groupAt(COLUMN)?.tabs.length ?? 0;
				const t0 = Date.now();
				const did = await method.run(opened, now, person);
				if (did) {
					await until('a change of group 2\'s front', () => frontOf(COLUMN)?.label !== 'n3c' || undefined, 1_500).catch(() => undefined);
				}
				await sleep(600);
				const front = frontOf(COLUMN);
				const tabsAfter = all();
				const countAfter = groupAt(COLUMN)?.tabs.length ?? 0;
				const added = tabsAfter.filter(tab => !tabsBefore.some(each => sameTab(each, tab) && each.group === tab.group));
				const focusAfter = await wb.active();
				const groupAfter = vscode.window.tabGroups.activeTabGroup.viewColumn;
				const drawnAfter = await wb.activeGroup();
				const back = sameTab(front, opened) && countAfter === countBefore && !added.length;
				const outcome = !did ? 'nothing done: no API of this kind for this front'
					: back ? 'the same tab is in front again, tab count unchanged'
						: front?.label === 'n3c' && !added.length ? 'nothing happened: the cover stays in front'
							: added.length ? `a new tab opened: ${added.map(tab => `g${tab.group} ${shortTab(tab)}`).join(', ')}; front ${shortTab(front)}`
								: front && front.kind !== opened.kind ? `a different kind is in front: ${shortTab(front)}`
									: `front ${shortTab(front)}, tabs ${countBefore} → ${countAfter}`;
				const focusKept = groupAfter === groupBefore && drawnAfter === drawnBefore && whereName(focusAfter.d) === whereName(focusBefore.d);
				const verdict: Verdict = !covered ? 'BLOCKED' : back && (method.inActiveGroup || focusKept) ? 'PASS' : 'FAILURE';
				trials.push({
					method: method.name, did: did ?? null, outcome, verdict, covered, ms: Date.now() - t0,
					tabsBefore: countBefore, tabsAfter: countAfter, front: front ?? null, added,
					activeGroupBefore: groupBefore, activeGroupAfter: groupAfter, drawnActiveGroupBefore: drawnBefore, drawnActiveGroupAfter: drawnAfter,
					focusBefore: whereName(focusBefore.d), focusAfter: whereName(focusAfter.d),
					...method.inActiveGroup ? {} : { focusKept }
				});
			}
		} catch (err) {
			trials.push({ outcome: `blocked: ${messageOf(err)}`, verdict: 'BLOCKED' });
		}
		const verdicts = trials.map(trial => (trial as { verdict: Verdict }).verdict);
		results.push({
			id: `N3-${kind.id}`, title: `bring back a covered front: ${kind.name}`,
			done: `${kind.name} in front of group ${COLUMN}${opened ? ` (opened as ${shortTab(opened)})` : ''}, covered by a terminal tab there; each method in turn`,
			measured: trials.map(trial => {
				const each = trial as { method?: string; outcome: string; focusKept?: boolean; activeGroupBefore?: number; activeGroupAfter?: number; drawnActiveGroupAfter?: number; focusBefore?: string; focusAfter?: string };
				const method = each.method ?? '';
				const short = `${method.split(' ')[0]} ${method.includes('Facade') ? 'Facade-now' : method.includes('(extra)') ? 'by-kind+refocus' : method.includes('kind') ? 'by-kind' : method.includes('Index') ? 'index' : method.includes('Previous') ? 'MRU' : ''}`;
				const moved = each.focusKept === false ? ` (active group ${each.activeGroupBefore} → ${each.activeGroupAfter} by the API, ${each.drawnActiveGroupAfter} as drawn; DOM focus ${each.focusBefore === each.focusAfter ? 'stayed' : `${each.focusBefore} → ${each.focusAfter}`})` : '';
				return `${short}: ${each.outcome}${moved}`;
			}).join(' | '),
			verdict: verdicts.includes('FAILURE') ? 'FAILURE' : verdicts.every(each => each === 'PASS') ? 'PASS' : 'BLOCKED',
			opened: opened ?? null, ...openedIn !== undefined ? { openedInGroup: openedIn } : {}, trials
		});
		// Only the spacer and the cover stay in group 2
		const left = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !keep(describeTab(tab)));
		if (left.length) { await vscode.window.tabGroups.close(left).then(undefined, err => notes.push(`closing ${kind.name}: ${messageOf(err)}`)); }
		if (person) { person.dispose(); person = undefined; }
		await sleep(600);
	}
	return results;
}

/**
 * N3-split: what the state (a) leaves does to the person's next shortcut - a covered text file brought back by vscode.open with
 * preserveFocus in group 2 while the person's focus is in group 1's file; then Cmd+W, which closes the active group's active editor,
 * and one key.
 */
async function n3Split(): Promise<CaseResult> {
	await reset();
	await showFile('n3s-home.txt', 1);
	await showFile('n3s.txt', COLUMN, false);
	await fakeTerminal('n3sc', { viewColumn: COLUMN, preserveFocus: true });
	await showFile('n3s-home.txt', 1);
	await sleep(500);
	if (frontOf(COLUMN)?.label !== 'n3sc') {
		throw new Error(`group 2's file is not covered: ${JSON.stringify(seen())}`);
	}
	await pull();
	const person = await wb.active();
	const t0 = Date.now();
	await cmd('vscode.open', file('n3s.txt'), { viewColumn: COLUMN, preserveFocus: true, preview: false });
	await sleep(600);
	const between = { api: vscode.window.tabGroups.activeTabGroup.viewColumn, drawn: await wb.activeGroup(), focus: whereName((await wb.active()).d), fronts: frontsNow() };
	const tabsBefore = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => `g${group.viewColumn}:${unspun(tab.label)}`));
	const tCut = Date.now();
	await wb.chord('cmd+w');
	await sleep(800);
	const tabsAfter = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => `g${group.viewColumn}:${unspun(tab.label)}`));
	const closed = tabsBefore.filter(each => !tabsAfter.includes(each));
	const typist = new Typist();
	await typist.at(Date.now(), [0]);
	await sleep(300);
	const got = await collect(t0, typist, [], ['n3s-home.txt', 'n3s.txt']);
	const meant = closed.length === 1 && closed[0] === 'g1:n3s-home.txt';
	return {
		id: 'N3-split', title: 'after (a): the person\'s Cmd+W - the active group\'s, or the focused file\'s?',
		done: `the person in ${whereName(person.d)}; group 2's n3s.txt covered by a terminal; vscode.open(n3s.txt, { viewColumn: 2, preserveFocus: true }) at 0 ms; CDP-injected Cmd+W at ${tCut - t0} ms; one key after`,
		measured: `after vscode.open: active group ${between.api} by the API, ${between.drawn} as drawn, DOM focus ${between.focus}; Cmd+W closed ${closed.join(', ') || 'nothing'}; the key → ${got.placed.map(key => key.to).join(', ')}`,
		verdict: meant && got.placed.every(key => key.to === 'doc:n3s-home.txt') ? 'PASS' : 'FAILURE',
		between, tabsBefore, tabsAfter, closed, texts: got.texts, keys: keyRows(got.placed, t0, key => key.to === 'doc:n3s-home.txt'), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0)
	};
}

/** N4: ten groups, the focus commands past the eighth, a floating editor window, and focus commands for a group that is not there. */
async function n4(): Promise<CaseResult[]> {
	await reset();
	for (let column = 1; column <= 9; column++) {
		await showFile(`n4-${column}.txt`, column);
	}
	// Past the ninth, the API opens beside the active group: the ninth's; else a new group to its right
	await vscode.window.showTextDocument(file('n4-10.txt'), { viewColumn: 10 as vscode.ViewColumn, preview: false }).then(undefined, err => notes.push(`showTextDocument in column 10: ${messageOf(err)}`));
	await sleep(500);
	if (vscode.window.tabGroups.all.length < 10) {
		await cmd('workbench.action.focusLastEditorGroup');
		await cmd('workbench.action.newGroupRight');
		await vscode.window.showTextDocument(file('n4-10.txt'), { viewColumn: vscode.ViewColumn.Active, preview: false });
		await sleep(500);
	}
	const made = vscode.window.tabGroups.all.map(group => group.viewColumn);
	const steps: { step: string; activeGroup: number; groups: number }[] = [];
	const step = async (name: string, action: () => Promise<unknown>) => {
		await action();
		await sleep(500);
		steps.push({ step: name, activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, groups: vscode.window.tabGroups.all.length });
	};
	await step('focusEighthEditorGroup', () => cmd(GROUP_FOCUS[7]));
	await step('focusNextGroup ×1', () => cmd('workbench.action.focusNextGroup'));
	await step('focusNextGroup ×2', () => cmd('workbench.action.focusNextGroup'));
	await step('focusNextGroup ×3', () => cmd('workbench.action.focusNextGroup'));
	await step('focusLastEditorGroup', () => cmd('workbench.action.focusLastEditorGroup'));
	await step('focusPreviousGroup', () => cmd('workbench.action.focusPreviousGroup'));
	const reached9 = steps[1].activeGroup === 9, reached10 = steps[2].activeGroup === 10;
	const results: CaseResult[] = [{
		id: 'N4-ten', title: 'ten groups: focusEighthEditorGroup, then focusNextGroup ×k',
		done: `groups made: ${made.join(', ')}; ${steps.map(each => each.step).join(', ')}`,
		measured: steps.map(each => `${each.step} → active ${each.activeGroup}`).join('; '),
		verdict: made.length === 10 && reached9 && reached10 ? 'PASS' : 'FAILURE', made, steps
	}];

	// A floating window: one of group 10's two editors moved into it, group 10 staying
	await vscode.window.showTextDocument(file('n4-10b.txt'), { viewColumn: 10 as vscode.ViewColumn, preview: false });
	await sleep(300);
	const beforeWindow = vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, front: brief(group.activeTab) }));
	const pagesBefore = (await listTargets(PORT)).filter(target => target.type === 'page').map(target => target.title);
	await cmd('workbench.action.focusLastEditorGroup');
	await cmd('workbench.action.moveEditorToNewWindow');
	await sleep(3_000);
	const afterWindow = vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, front: brief(group.activeTab), active: group.isActive }));
	const pagesAfter = (await listTargets(PORT)).filter(target => target.type === 'page').map(target => target.title);
	const floating = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.label === 'n4-10b.txt'));
	const floatColumn = floating?.viewColumn;
	const tries: { step: string; activeGroup: number; reached: boolean }[] = [];
	const attempt = async (name: string, action: () => Promise<unknown>) => {
		await action();
		await sleep(600);
		const active = vscode.window.tabGroups.activeTabGroup.viewColumn;
		tries.push({ step: name, activeGroup: active, reached: active === floatColumn });
	};
	const available = (await vscode.commands.getCommands(true)).filter(id => /focus/i.test(id) && /(window|auxiliary|floating)/i.test(id) && /workbench/i.test(id));
	await attempt('focusLastEditorGroup', () => cmd('workbench.action.focusLastEditorGroup'));
	await attempt('focusNextGroup from the main window\'s last', async () => { await cmd('workbench.action.focusLastEditorGroup'); await cmd('workbench.action.focusNextGroup'); });
	await attempt('focusPreviousGroup from the first', async () => { await cmd(GROUP_FOCUS[0]); await cmd('workbench.action.focusPreviousGroup'); });
	for (const [index, id] of GROUP_FOCUS.entries()) {
		await attempt(`focus${['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][index]}EditorGroup`, () => cmd(id));
	}
	for (const id of available.filter(each => !/close|move|copy|new/i.test(each)).slice(0, 6)) {
		await attempt(id, () => cmd(id));
	}
	// The API by its view column: does it open in the floating window's group?
	let apiOpen: string | undefined;
	let focusedFloating: { activeTabGroup: number; activeTextEditor: number | null; floatingGroupIsActive: boolean | null } | undefined;
	if (floatColumn !== undefined) {
		await vscode.window.showTextDocument(file('n4-api.txt'), { viewColumn: floatColumn, preview: false, preserveFocus: true }).then(undefined, err => notes.push(`showTextDocument in ${floatColumn}: ${messageOf(err)}`));
		await sleep(600);
		apiOpen = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.label === 'n4-api.txt'))?.viewColumn?.toString() ?? 'nowhere';
		// The floating window's group given the focus: which group the API then calls the active one
		await vscode.window.showTextDocument(file('n4-api.txt'), { viewColumn: floatColumn, preview: false, preserveFocus: false }).then(undefined, err => notes.push(`focusing group ${floatColumn}: ${messageOf(err)}`));
		await sleep(600);
		focusedFloating = { activeTabGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, activeTextEditor: vscode.window.activeTextEditor?.viewColumn ?? null, floatingGroupIsActive: vscode.window.tabGroups.all.find(group => group.viewColumn === floatColumn)?.isActive ?? null };
	}
	results.push({
		id: 'N4-floating', title: 'a floating editor window (moveEditorToNewWindow): its groups\' view columns and which focus commands reach them',
		done: `10 groups; n4-10b.txt moved from group 10 to a new window; pages ${JSON.stringify(pagesBefore)} → ${JSON.stringify(pagesAfter)}`,
		measured: `floating group's viewColumn: ${floatColumn ?? 'none'} (groups now ${afterWindow.map(each => each.column).join(', ')}); reached by: ${tries.filter(each => each.reached).map(each => each.step).join(', ') || `none of ${tries.length} focus commands tried`}; showTextDocument(viewColumn ${floatColumn}) opened in group ${apiOpen}; with the focus there, the API's activeTabGroup is ${focusedFloating?.activeTabGroup}, the active editor's column ${focusedFloating?.activeTextEditor}, the floating group's isActive ${focusedFloating?.floatingGroupIsActive}`,
		verdict: floatColumn !== undefined && tries.some(each => each.reached) ? 'PASS' : 'FAILURE',
		beforeWindow, afterWindow, tries, focusedFloating: focusedFloating ?? null, focusCommandsAvailable: available
	});
	// Its editors closed, the floating window with them
	const floatingNow = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.label === 'n4-10b.txt'));
	if (floatingNow) { await vscode.window.tabGroups.close(floatingNow).then(undefined, err => notes.push(`closing the floating group: ${messageOf(err)}`)); }
	await sleep(1_500);

	// A focus command for a group that is not there
	await reset();
	await showFile('n4-x.txt', 1);
	const created: { step: string; groupsBefore: number; groupsAfter: number; activeGroup: number }[] = [];
	for (const [name, index] of [['focusThirdEditorGroup with 1 group', 2], ['focusSecondEditorGroup with 1 group', 1], ['focusFifthEditorGroup with 2 groups', 4], ['focusThirdEditorGroup with 2 groups', 2], ['focusEighthEditorGroup with 3 groups', 7]] as const) {
		await cmd(GROUP_FOCUS[0]);
		await sleep(200);
		const groupsBefore = vscode.window.tabGroups.all.length;
		await cmd(GROUP_FOCUS[index]);
		await sleep(500);
		created.push({ step: name, groupsBefore, groupsAfter: vscode.window.tabGroups.all.length, activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn });
	}
	results.push({
		id: 'N4-missing', title: 'focusNthEditorGroup where that group does not exist',
		done: created.map(each => each.step).join('; '),
		measured: created.map(each => `${each.step}: groups ${each.groupsBefore} → ${each.groupsAfter}, active ${each.activeGroup}`).join('; '),
		// A fact for Facade's give-back, not a key or a front: PASS where no command made a group it was not asked for
		verdict: created.every(each => each.groupsAfter === each.groupsBefore) ? 'PASS' : 'FAILURE', created
	});
	return results;
}

/** N5: the focus where no editor group's command brings it back - the bottom panel's terminal, the Explorer, Quick Open - and a borrow. */
async function n5(): Promise<CaseResult[]> {
	await reset();
	await showFile('n5.txt', 1);
	await fakeTerminal('n5b', { viewColumn: COLUMN, preserveFocus: true });
	const panel = await fakeTerminal('n5p', vscode.TerminalLocation.Panel);
	const ids = ['n5b', 'n5p'];
	const results: CaseResult[] = [];
	for (const where of ['panel terminal', 'Explorer', 'Quick Open'] as const) {
		await cmd('workbench.action.closeQuickOpen');
		await showFile('n5.txt', 1);
		await sleep(300);
		if (where === 'panel terminal') {
			panel.show(false);
		} else if (where === 'Explorer') {
			await cmd('workbench.view.explorer');
			await cmd('workbench.files.action.focusFilesExplorer');
		} else {
			void cmd('workbench.action.quickOpen');
		}
		await sleep(900);
		await pull();
		const person = await wb.active();
		const sees = seen();
		const original = vscode.window.tabGroups.activeTabGroup.viewColumn;
		const typist = new Typist();
		const since = Date.now();
		await typist.at(since, [0, 120]);
		await sleep(150);
		// The borrow as a mark makes it: another group's focus, then the group the extension takes to be the person's
		const t0 = Date.now();
		await cmd(GROUP_FOCUS[COLUMN - 1]);
		const t1 = Date.now();
		await typist.at(t1, [0, 50, 150]);
		await sleep(150);
		const t2 = Date.now();
		await cmd(GROUP_FOCUS[original - 1]);
		const t3 = Date.now();
		await typist.at(t3, [0, 50, 150, 400, 800]);
		await sleep(400);
		const end = await wb.active();
		const after = seen();
		const got = await collect(since, typist, ids, ['n5.txt']);
		const intended = (key: Placed) => where === 'panel terminal' ? key.to === 'pty:n5p'
			: where === 'Explorer' ? key.to.startsWith('dom:') && /sidebar/.test(key.to) : key.to === 'dom:quick input';
		const phaseOf = (key: Placed) => key.sent < t0 ? 'before' : key.sent < t3 ? 'during' : 'after';
		const bad = got.placed.filter(key => !intended(key));
		results.push({
			id: `N5-${where === 'panel terminal' ? 'panel' : where === 'Explorer' ? 'explorer' : 'quickopen'}`, title: `focus in the ${where}; a borrow: focus group ${COLUMN}, then focus back group ${original}`,
			done: `the person in the ${where} (${whereName(person.d)}); keys before, during (after ${GROUP_FOCUS[COLUMN - 1]} at ${t1 - t0} ms) and after ${GROUP_FOCUS[original - 1]} (at ${t2 - t0}-${t3 - t0} ms)`,
			measured: `the extension saw: ${JSON.stringify(sees)}; focus at the end: ${whereName(end.d)}; keys: before ${tally(got.placed.filter(key => phaseOf(key) === 'before'))}; during ${tally(got.placed.filter(key => phaseOf(key) === 'during'))}; after ${tally(got.placed.filter(key => phaseOf(key) === 'after'))}`,
			verdict: bad.length ? 'FAILURE' : 'PASS',
			person: whereName(person.d), seenAtPerson: sees, seenAfter: after, focusEnd: whereName(end.d), texts: got.texts,
			keys: keyRows(got.placed, t0, intended, phaseOf), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign
		});
	}
	return results;
}

// ---------------------------------------------------------------------------------------------------------------------------
// F1-F4: Facade's marks

interface Card { readonly runId: string; readonly alias: string; readonly name: string }

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

function agentTab(card: Card): vscode.Tab | undefined {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTerminal
		&& (unspun(tab.label) === card.name || unspun(tab.label).startsWith(`${card.name} `)));
}

/** Starts one agent as a person does, in the active group, and waits for its tab and for Pin to be offered. */
async function newAgent(): Promise<Card> {
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	const card = await until('a new card', async () => {
		const added = (await state()).cards.find(each => !before.has(each.runId));
		if (added) {
			return added;
		}
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	}, 60_000, 100);
	const found = { runId: card.runId, alias: card.alias, name: card.name };
	await until(`the tab of ${card.alias}`, () => agentTab(found) || undefined, 20_000);
	await until(`Pin offered for ${card.alias}`, async () => (await state()).cards.find(each => each.runId === card.runId)?.menu.pin || undefined, 30_000);
	await until(`${card.alias}'s fake CLI`, () => fs.existsSync(`${RECORD}.${card.alias}`) || undefined, 20_000);
	return found;
}

async function activateFacade(): Promise<void> {
	await vscode.extensions.getExtension('facade.facadecode')!.activate();
	await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 90_000, 200);
}

/** No agent and no editor left from a case before. */
async function resetFacade(): Promise<void> {
	for (const card of (await state()).cards) {
		await cmd('facade.closeAgent', { run_id: card.runId });
	}
	await until('no agents', async () => (await state()).cards.length === 0 || undefined, 15_000).catch(() => notes.push('agents were left from a case before'));
	await reset();
}

/** The Facade log's lines since `since`: a mark's own reports of what it could not do among them. */
function facadeLog(since: number): string[] {
	const dir = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).map(key => path.join(dir, key, 'agents.log')).filter(each => fs.existsSync(each)) : [];
	return files.flatMap(each => fs.readFileSync(each, 'utf8').split('\n')).filter(line => {
		const at = Date.parse(line.slice(0, 24));
		return Number.isFinite(at) && at >= since;
	}).slice(-40);
}

/** When `card`'s tab first shows its pin mark, polled every 10 ms; undefined where it does not within `ms`. */
async function pinnedAt(card: Card, ms = 6_000): Promise<number | undefined> {
	return await until(`${card.alias}'s mark`, () => agentTab(card)?.isPinned ? Date.now() : undefined, ms, 10).catch(() => undefined);
}

function frontsNow(): { [column: string]: string } {
	return Object.fromEntries(vscode.window.tabGroups.all.map(group => [`g${group.viewColumn}`, group.activeTab ? unspun(group.activeTab.label) : '(empty)']));
}

/**
 * How the person pins: `card`, from the card's menu - its run given, their focus at Facade's panel, as a click on the card leaves it;
 * `palette`, from the Command Palette or a key - no run given, the selected agent's, their focus where it was.
 */
type Via = 'card' | 'palette';

/** The person as `via` leaves them before the Pin: at the panel for a card's; for the palette's, where they are, `card` selected. */
async function readyToPin(via: Via, card: Card): Promise<void> {
	if (via === 'card') {
		// Its view's own focus command, again where the page does not have it a moment later - as with a floating window open
		for (let attempt = 1; attempt <= 3; attempt++) {
			await cmd('facade.agents.focus');
			await sleep(400);
			const at = await wb.active();
			if (at.d.where === 'webview' && at.d.extension === PANEL) {
				return;
			}
			notes.push(`facade.agents.focus, attempt ${attempt}: the main window's focus is at ${whereName(at.d)}${at.hasFocus ? '' : ', the page without focus'}`);
		}
		return;
	}
	await cmd('facade.selectRow', { run_id: card.runId });
	await until(`${card.alias} selected`, async () => (await state()).cards.find(each => each.selected)?.runId === card.runId || undefined, 5_000);
}

/** The Pin as `via` gives it: with its run from the card's menu, with none from the Command Palette or a key. */
function pinBy(via: Via, card: Card): void {
	void (via === 'card' ? cmd('facade.pinAgent', { run_id: card.runId }) : cmd('facade.pinAgent'));
}

const pinCall = (via: Via) => via === 'card' ? 'facade.pinAgent {run_id} (a card\'s menu)' : 'facade.pinAgent with no argument, the agent selected (the Command Palette\'s or a key\'s)';
const atPanel = (key: Placed) => key.to === `webview:${PANEL}` || key.to.startsWith(`dom:webview ${PANEL}`);

/** Whether a tab's label is `agent`'s, a spinner or a number after its name included. */
const isAgentLabel = (label: string | undefined, agent: Card) => !!label && (label === agent.name || label.startsWith(`${agent.name} `));

/** Whether the focus `at` is in `agent`'s terminal. */
const inAgent = (at: { readonly d?: Where }, agent: Card) => at.d?.where === 'terminal' && whereName(at.d).includes(`"${agent.name}`);

/**
 * Keys typed across the person's own Pin or Unpin, which shows its agent's tab with the focus as a click on its card does (LIFECYCLE-3.4):
 * each reaching where the person was or that agent's CLI, and none where the person was again once one has reached that CLI - the focus
 * never given back over the person's showing.
 */
function acrossShowing(placed: readonly Placed[], wasAt: (key: Placed) => boolean, agent: Card): { readonly bad: readonly Placed[]; readonly back: readonly Placed[] } {
	const cli = `pty:${agent.alias}`;
	const inOrder = [...placed].sort((a, b) => a.sent - b.sent);
	const first = inOrder.findIndex(key => key.to === cli);
	return {
		bad: inOrder.filter(key => !wasAt(key) && key.to !== cli),
		back: first < 0 ? [] : inOrder.slice(first + 1).filter(key => wasAt(key))
	};
}

/**
 * F1: the agent's tab in front of the active group, its terminal the active one; its Pin - `palette`: the person typing in its
 * terminal; `card`: the person at the panel, as a click on its card leaves them.
 */
async function f1(via: Via, round: number): Promise<CaseResult> {
	await resetFacade();
	await showFile('f1.txt', 1);
	const agent = await newAgent();
	await cmd('facade.revealAgent', { run_id: agent.runId });
	await sleep(800);
	await readyToPin(via, agent);
	await sleep(1_000);
	await pull();
	const person = await wb.active();
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(PACE);
	await sleep(400);
	const t0 = Date.now();
	pinBy(via, agent);
	const pinned = await pinnedAt(agent);
	await sleep(1_600);
	await stream.stop();
	const end = await wb.active();
	const got = await collect(since, typist, [agent.alias], [], 1_200);
	// From its card the agent's tab is shown with the focus, as a click on the card does, its CLI taking the keys from then; from the
	// palette or a key the person is in its terminal already, and stays there
	const cli = `pty:${agent.alias}`;
	const intent = via === 'card' ? `webview:${PANEL}, then ${cli}` : cli;
	const showing = acrossShowing(got.placed, key => via === 'card' ? atPanel(key) : key.to === cli, agent);
	const bad = [...showing.bad, ...showing.back];
	const intended = (key: Placed) => !bad.includes(key);
	const focused = inAgent(end, agent);
	const borrow = borrowOf(got.focus, t0, whereName(person.d), t0);
	const phaseOf = (key: Placed) => key.sent < t0 ? 'before Pin' : pinned === undefined || key.sent < pinned ? 'Pin to mark' : 'after mark';
	return {
		id: `F1-${via}.${round}`, title: via === 'card' ? 'type during an in-place card Pin: the agent\'s tab is the active group\'s front, the person at the panel'
			: 'type during an in-place palette Pin: the agent\'s tab is the active group\'s front, its terminal focused',
		done: `${agent.alias} "${agent.name}" in front of group 1; the person at ${whereName(person.d)}; a key every ${PACE} ms; ${pinCall(via)} at 0 ms`,
		measured: `mark on at ${pinned === undefined ? 'never' : `${pinned - t0} ms`}; ${borrow.leftMs === undefined ? 'focus never left the person' : `focus left the person at ${borrow.leftMs} ms${borrow.backMs !== undefined ? `, back at ${borrow.backMs} ms` : ', not back'}`}; focus at the end: ${whereName(end.d)}; keys: before ${tally(got.placed.filter(key => key.sent < t0))}; from Pin ${tally(got.placed.filter(key => key.sent >= t0))}`,
		verdict: bad.length || pinned === undefined || !focused ? 'FAILURE' : 'PASS',
		agent, via, intent, pinnedMs: pinned === undefined ? null : pinned - t0, borrow, focused, focusEnd: whereName(end.d), person: whereName(person.d), texts: got.texts,
		keys: keyRows(got.placed, t0, intended, phaseOf), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign, log: facadeLog(since)
	};
}

/**
 * F2: a Pin of an agent whose tab is behind - `card`/`palette`: in another group; `same-card`/`same-palette`: behind the file in front of
 * the active group, the person's - by its card, the person at the panel, or by the palette, the person in their file.
 */
async function f2(variant: 'card' | 'palette' | 'same-card' | 'same-palette', round: number): Promise<CaseResult> {
	await resetFacade();
	const via: Via = variant.endsWith('card') ? 'card' : 'palette';
	const column = variant.startsWith('same') ? 1 : 2;
	const mine = `f2-${variant}-1.txt`, theirs = column === 1 ? mine : `f2-${variant}-2.txt`;
	await showFile(mine, 1);
	if (column === 2) {
		await showFile(theirs, 2);
	}
	const agent = await newAgent();
	await showFile(theirs, column);
	await showFile(mine, 1);
	await readyToPin(via, agent);
	await sleep(1_200);
	await pull();
	const person = await wb.active();
	const frontsBefore = frontsNow();
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(PACE);
	await sleep(400);
	const t0 = Date.now();
	pinBy(via, agent);
	const pinned = await pinnedAt(agent);
	await sleep(1_600);
	await stream.stop();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const got = await collect(since, typist, [agent.alias], [mine, theirs], 1_200);
	// Its tab shown in front of its group with the focus, as a click on its card does, and marked there: nothing given back over it, the
	// person's own group's front as it was where that is another
	const cli = `pty:${agent.alias}`;
	const intent = `${via === 'card' ? `webview:${PANEL}` : `doc:${mine}`}, then ${cli}`;
	const showing = acrossShowing(got.placed, key => via === 'card' ? atPanel(key) : key.to === `doc:${mine}`, agent);
	const bad = [...showing.bad, ...showing.back];
	const intended = (key: Placed) => !bad.includes(key);
	const borrow = borrowOf(got.focus, t0, whereName(person.d), t0);
	const phaseOf = (key: Placed) => borrow.leftMs === undefined || key.sent < t0 + borrow.leftMs ? 'before the showing' : 'shown';
	const shown = isAgentLabel(frontsAfter[`g${column}`], agent);
	const ownStays = column === 1 || frontsAfter.g1 === frontsBefore.g1;
	const focused = inAgent(end, agent);
	return {
		id: `F2-${variant}.${round}`,
		title: `type during a ${via} Pin of an agent whose tab is behind ${column === 2 ? 'in another group' : 'the file in front of the active group'} (the person ${via === 'card' ? 'at the panel' : 'in their file'})`,
		done: `${agent.alias} behind ${theirs} in group ${column}; the person at ${whereName(person.d)}; a key every ${PACE} ms; ${pinCall(via)} at 0 ms`,
		measured: `mark on at ${pinned === undefined ? 'never' : `${pinned - t0} ms`}; focus ${borrow.leftMs === undefined ? 'never left the person' : `left the person at ${borrow.leftMs} ms${borrow.backMs === undefined ? ', not back' : `, back at ${borrow.backMs} ms`}`}; focus at the end: ${whereName(end.d)}${focused ? ' (the agent\'s)' : ''}; group ${column}'s front ${frontsBefore[`g${column}`]} → ${frontsAfter[`g${column}`]}${column === 2 ? `; group 1's ${frontsBefore.g1} → ${frontsAfter.g1}` : ''}; keys: ${tally(got.placed)}`,
		verdict: bad.length || pinned === undefined || !shown || !ownStays || !focused ? 'FAILURE' : 'PASS',
		agent, via, intent, pinnedMs: pinned === undefined ? null : pinned - t0, borrow, frontsBefore, frontsAfter, shown, ownStays, focused, focusEnd: whereName(end.d), person: whereName(person.d), texts: got.texts,
		keys: keyRows(got.placed, t0, intended, phaseOf), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign, log: facadeLog(since)
	};
}

/**
 * F4: a shortcut of the person's as their Pin shows its agent's tab and marks it - Cmd+1, Cmd+3 or Ctrl+Tab - and whether Facade
 * overrides it; the Pin by the palette, the person in their file, or by the card, the person at the panel.
 */
async function f4(variant: 'cmd1' | 'cmd3' | 'ctrltab', via: Via): Promise<CaseResult> {
	await resetFacade();
	await showFile('f4-1b.txt', 1);
	await showFile('f4-1.txt', 1);
	await showFile('f4-2.txt', 2);
	const agent = await newAgent();
	await showFile('f4-2.txt', 2);
	await showFile('f4-3.txt', 3);
	await showFile('f4-1.txt', 1);
	await readyToPin(via, agent);
	await sleep(1_200);
	await pull();
	const person = await wb.active();
	const frontsBefore = frontsNow();
	const chord = variant === 'cmd1' ? 'cmd+1' : variant === 'cmd3' ? 'cmd+3' : 'ctrl+tab';
	// Ctrl+Tab acts in the group the Pin's showing took the person to, the agent's: what was in front there before it comes back
	const target = variant === 'cmd1' ? 'f4-1.txt' : variant === 'cmd3' ? 'f4-3.txt' : 'f4-2.txt';
	const targetGroup = variant === 'cmd3' ? 3 : variant === 'ctrltab' ? 2 : 1;
	const since = Date.now();
	let fired: { at: number; why: string; acked?: number } | undefined;
	const fire = (why: string) => {
		if (fired) {
			return;
		}
		const entry: { at: number; why: string; acked?: number } = { at: Date.now(), why };
		fired = entry;
		void wb.chord(chord).then(() => { entry.acked = Date.now(); }, err => notes.push(`the shortcut failed: ${messageOf(err)}`));
	};
	const watch = [
		vscode.window.onDidChangeActiveTerminal(terminal => { if (terminal && (unspun(terminal.name) === agent.name || unspun(terminal.name).startsWith(`${agent.name} `))) { fire('its terminal became the active one'); } }),
		vscode.window.tabGroups.onDidChangeTabGroups(() => { if (vscode.window.tabGroups.activeTabGroup.viewColumn === 2) { fire('group 2 became the active group'); } })
	];
	const t0 = Date.now();
	pinBy(via, agent);
	const late = setTimeout(() => fire('no sign of the mark within 3 s'), 3_000);
	const pinned = await pinnedAt(agent);
	await sleep(2_500);
	clearTimeout(late);
	watch.forEach(each => each.dispose());
	await pull();
	const settled = await wb.active();
	const frontsSettled = frontsNow();
	const groupSettled = vscode.window.tabGroups.activeTabGroup.viewColumn;
	const typist = new Typist();
	const tProbe = Date.now();
	await typist.at(tProbe, [0, 150, 300]);
	await sleep(300);
	const got = await collect(since, typist, [agent.alias], ['f4-1.txt', 'f4-1b.txt', 'f4-2.txt', 'f4-3.txt']);
	const intent = `doc:${target}`;
	const navigated = settled.d.where === 'code-editor' && settled.d.group === targetGroup && whereName(settled.d).includes(target);
	const bad = got.placed.filter(key => key.to !== intent);
	const borrow = borrowOf(got.focus, t0, whereName(person.d), t0);
	// The agent's tab, which the Pin showed in front of its group: left there by Facade - but where the person's Ctrl+Tab brought back what
	// was in front of it
	const shownStays = variant === 'ctrltab' || isAgentLabel(frontsSettled.g2, agent);
	return {
		id: `F4-${variant}${via === 'card' ? '-card' : ''}`, title: `${chord.replace('cmd', 'Cmd').replace('ctrl', 'Ctrl').replace('tab', 'Tab')} while a mark is under way (a ${via} Pin of an agent behind in group 2)`,
		done: `the person at ${whereName(person.d)}; ${pinCall(via)} at 0 ms; the CDP-injected shortcut at ${fired ? `${fired.at - t0} ms (${fired.why})` : 'never'}; 3 keys typed 2.5 s after the mark`,
		measured: `mark on at ${pinned === undefined ? 'never' : `${pinned - t0} ms`}; shortcut sent ${fired ? `${fired.at - t0}-${(fired.acked ?? fired.at) - t0} ms` : 'never'}; focus path: ${borrow.path.join(' → ') || 'unchanged'}; settled at ${whereName(settled.d)} (active group ${groupSettled}): the person's navigation ${navigated ? 'kept' : 'not kept'}; fronts ${JSON.stringify(frontsBefore)} → ${JSON.stringify(frontsSettled)}: group 2's front ${shownStays ? 'as the Pin and the person left it' : 'changed by Facade'}; the 3 keys: ${tally(got.placed)}`,
		verdict: navigated && !bad.length && shownStays && pinned !== undefined ? 'PASS' : 'FAILURE',
		navigated, shownStays, agent, via, intent, wanted: `editor g${targetGroup} ${target}`, shortcut: fired ? { atMs: fired.at - t0, ackMs: fired.acked === undefined ? null : fired.acked - t0, why: fired.why } : null,
		pinnedMs: pinned === undefined ? null : pinned - t0, settled: whereName(settled.d), frontsBefore, frontsSettled, borrow, texts: got.texts,
		keys: keyRows(got.placed, t0, key => key.to === intent), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign, log: facadeLog(since)
	};
}

/**
 * F3 before its reload: six pinned agents in three groups; group 3 with its file in front, group 2 an agent, group 1 its file focused.
 * `settled`: each of those fronts arranged more than 4 s after Facade's last action - past the 3 s in which Facade takes a change of
 * the front for its own (agentTerminals.ts EXPECT_MS) - where `quick` arranges them at once, as the old probe did.
 */
async function f3Setup(variant: 'quick' | 'settled'): Promise<void> {
	await activateFacade();
	await resetFacade();
	const pause = variant === 'settled' ? 4_500 : 0;
	const prefix = variant === 'settled' ? 'f3s' : 'f3';
	const agents: (Card & { group: number })[] = [];
	for (const column of [1, 2, 3]) {
		await showFile(`${prefix}-${column}.txt`, column);
		for (let index = 0; index < 2; index++) {
			agents.push({ ...await newAgent(), group: column });
		}
	}
	for (const agent of agents) {
		await cmd('facade.pinAgent', { run_id: agent.runId });
		await sleep(300);
	}
	await until('six marks', () => agents.every(agent => agentTab(agent)?.isPinned) || undefined, 30_000).catch(() => notes.push('not every mark was on before the reload'));
	await sleep(pause);
	await showFile(`${prefix}-3.txt`, 3);
	await sleep(pause);
	await cmd('facade.revealAgent', { run_id: agents[3].runId });
	await sleep(800 + pause);
	await showFile(`${prefix}-1.txt`, 1);
	await sleep(1_500 + pause);
	await cmd('workbench.action.files.saveAll');
	await pull();
	const person = await wb.active();
	write({ phase: 'f3-setup', variant, prefix, pauseMs: pause, agents, fronts: frontsNow(), seen: seen(), person: whereName(person.d), marks: agents.map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn}${agentTab(agent)?.isPinned ? '*' : ''}`), log: facadeLog(0).slice(-12), notes: notes.splice(0) });
	write({ phase: 'reloading' });
	void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
}

/** F3 after its reload: keys typed all through the restoration of the six pinned agents; where they went, and each group's front after. */
async function f3After(activatedAt: number): Promise<CaseResult> {
	const lines = said();
	const setup = lines.filter(line => line.phase === 'f3-setup').pop() as Line & { variant: string; prefix: string; pauseMs: number; agents: (Card & { group: number })[]; fronts: { [column: string]: string }; person: string };
	const prefix = setup.prefix ?? 'f3';
	const reloadedAt = lines.filter(line => line.phase === 'reloading').pop()!.at!;
	// The person can type once a text editor is back, as the window restores it
	const ready = await until('a restored text editor', () => vscode.window.activeTextEditor ? Date.now() : undefined, 30_000, 25).catch(() => Date.now());
	await pull();
	const person = await wb.active();
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(100);
	const activeAt = await until('Facade active', () => vscode.extensions.getExtension('facade.facadecode')?.isActive ? Date.now() : undefined, 90_000, 25).catch(() => undefined);
	await until('the panel state', async () => (await state().catch(() => undefined))?.loading === false ? true : undefined, 90_000, 200).catch(() => undefined);
	const back = await until('the six tabs back with their marks', () => setup.agents.every(agent => agentTab(agent)?.isPinned) ? Date.now() : undefined, 60_000, 25).catch(() => undefined);
	await sleep(5_000);
	await stream.stop();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const got = await collect(since, typist, setup.agents.map(agent => agent.alias), [`${prefix}-1.txt`, `${prefix}-2.txt`, `${prefix}-3.txt`]);
	const intent = `doc:${prefix}-1.txt`;
	const borrow = borrowOf(got.focus, since, whereName(person.d), reloadedAt);
	// A key that reached nothing is the reload's loss, which the owner accepts; one that reached anything else - a CLI, another file - is not
	const lost = got.placed.filter(key => key.to !== intent && lostKey(key));
	const bad = got.placed.filter(key => key.to !== intent && !lostKey(key));
	// Each group's fronts in turn as the reload's tabs opened
	const sequence = frontSequence(got.host);
	const frontsWrong = Object.entries(setup.fronts).filter(([column, front]) => frontsAfter[column] !== front).map(([column, front]) => `${column}: ${front} → ${frontsAfter[column] ?? 'gone'}`);
	const marks = setup.agents.map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn ?? '-'}${agentTab(agent)?.isPinned ? '*' : ''}`);
	// Each second's keys, where they went
	const seconds = new Map<number, Placed[]>();
	for (const key of got.placed) { const second = Math.floor((key.sent - since) / 1_000); seconds.set(second, [...seconds.get(second) ?? [], key]); }
	return {
		id: setup.variant === 'settled' ? 'F3-settled' : 'F3',
		title: `type during a reload that restores 6 pinned agents across 3 groups${setup.variant === 'settled' ? ', the fronts arranged more than 4 s after Facade\'s last action' : ''}`,
		done: `before the reload: ${JSON.stringify(setup.fronts)}, focus ${setup.person}, arranged ${setup.pauseMs ? `${setup.pauseMs} ms apart, past Facade's 3 s` : 'at once after the marks'}; marks ${JSON.stringify(setup.marks)}; after it the driver typed a key every 100 ms from ${since - reloadedAt} ms after the reload request until 5 s after every mark was back`,
		measured: `driver up ${activatedAt - reloadedAt} ms, typing from ${since - reloadedAt} ms (focus then ${whereName(person.d)}), Facade active ${activeAt === undefined ? 'never' : `${activeAt - reloadedAt} ms`}, all marks back ${back === undefined ? 'never' : `${back - reloadedAt} ms`} after the reload request; keys: ${tally(got.placed)} - lost ${lost.length} (accepted), misdirected ${bad.length}; each group's fronts in turn: ${Object.entries(sequence).map(([group, fronts]) => `${group} ${fronts.join(' → ')}`).join('; ') || 'none seen'}; fronts after: ${JSON.stringify(frontsAfter)}${frontsWrong.length ? ` (changed: ${frontsWrong.join('; ')})` : ''}; focus at the end ${whereName(end.d)}`,
		verdict: bad.length || frontsWrong.length || back === undefined || !(end.d.where === 'code-editor' && end.d.group === 1 && whereName(end.d).includes(`${prefix}-1.txt`)) ? 'FAILURE' : 'PASS',
		agents: setup.agents, frontsBefore: setup.fronts, frontsAfter, frontsWrong, marks, lost: lost.length, misdirected: bad.length, sequence, focusEnd: whereName(end.d), readyMs: ready - reloadedAt, borrow, texts: got.texts,
		perSecond: [...seconds].map(([second, keys]) => `${second}s: ${tally(keys)}`),
		keys: keyRows(got.placed, reloadedAt, key => key.to === intent), focus: focusRows(got.focus, reloadedAt), host: hostRows(got.host, reloadedAt), foreign: got.foreign, log: facadeLog(reloadedAt)
	};
}

/**
 * F7 before its reload: six agents in one group, as the owner had them - two pinned, three not, and the group's front, pinned too where
 * `pinned-front` - each made the active one in turn more than 3 s apart (past agentTerminals.ts's EXPECT_MS), the front last, with no
 * file of the person's there.
 */
async function f7Setup(variant: 'front' | 'pinned-front'): Promise<void> {
	await activateFacade();
	await resetFacade();
	const agents: Card[] = [];
	for (let index = 0; index < 6; index++) {
		agents.push(await newAgent());
	}
	// The second and the fourth pinned, and the last made active - the group's front - where `pinned-front`
	const pinned = [1, 3, ...variant === 'pinned-front' ? [5] : []];
	for (const index of pinned) {
		await cmd('facade.pinAgent', { run_id: agents[index].runId });
		await sleep(600);
	}
	await until('the marks', () => pinned.every(index => agentTab(agents[index])?.isPinned) || undefined, 30_000).catch(() => notes.push('not every mark was on before the reload'));
	// The order they were last active in, the front last
	const order = [2, 0, 3, 4, 1, 5];
	for (const index of order) {
		await cmd('facade.revealAgent', { run_id: agents[index].runId });
		await sleep(3_500);
	}
	await pull();
	const person = await wb.active();
	write({
		phase: 'f7-setup', variant, agents, pinned: pinned.map(index => agents[index].alias), lastActive: order.map(index => agents[index].alias), fronts: frontsNow(), seen: seen(), person: whereName(person.d),
		marks: agents.map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn}${agentTab(agent)?.isPinned ? '*' : ''}`), log: facadeLog(0).slice(-12), notes: notes.splice(0)
	});
	write({ phase: 'reloading' });
	void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
}

/**
 * F7 after its reload: the order the six tabs came to the front in - each once, the pinned ones not the group's front first, the others
 * not the front next, each by when it was last active, the front last, nothing switched back (LIFECYCLE-3.5) - their marks and the focus.
 */
async function f7After(activatedAt: number): Promise<CaseResult> {
	const lines = said();
	const setup = lines.filter(line => line.phase === 'f7-setup').pop() as Line & { variant: string; agents: Card[]; pinned: string[]; lastActive: string[]; fronts: { [column: string]: string }; person: string; marks: string[] };
	const reloadedAt = lines.filter(line => line.phase === 'reloading').pop()!.at!;
	const activeAt = await until('Facade active', () => vscode.extensions.getExtension('facade.facadecode')?.isActive ? Date.now() : undefined, 90_000, 25).catch(() => undefined);
	await until('the panel state', async () => (await state().catch(() => undefined))?.loading === false ? true : undefined, 90_000, 200).catch(() => undefined);
	const pinnedCards = setup.agents.filter(agent => setup.pinned.includes(agent.alias));
	const back = await until('the six tabs back, the pinned ones marked', () => setup.agents.every(agent => agentTab(agent)) && pinnedCards.every(agent => agentTab(agent)?.isPinned) ? Date.now() : undefined, 60_000, 25).catch(() => undefined);
	await sleep(5_000);
	await pull();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const host = hostEvents.filter(each => each.t >= reloadedAt);
	// Group 1's fronts in turn, an agent's told by its alias
	const aliasOf = (label: string) => setup.agents.find(agent => isAgentLabel(label, agent))?.alias ?? label;
	const sequence = (frontSequence(host).g1 ?? []).map(aliasOf);
	const shown = sequence.filter(each => setup.agents.some(agent => agent.alias === each));
	const front = setup.lastActive[setup.lastActive.length - 1];
	const rank = (alias: string) => alias === front ? 2 : setup.pinned.includes(alias) ? 0 : 1;
	const expected = [...setup.lastActive].sort((a, b) => rank(a) - rank(b) || setup.lastActive.indexOf(a) - setup.lastActive.indexOf(b));
	const once = new Set(shown).size === shown.length;
	const inOrder = JSON.stringify(shown) === JSON.stringify(expected);
	const frontCard = setup.agents.find(agent => agent.alias === front)!;
	const frontBack = isAgentLabel(frontsAfter.g1, frontCard);
	const marks = setup.agents.map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn ?? '-'}${agentTab(agent)?.isPinned ? '*' : ''}`);
	const marksRight = setup.agents.every(agent => !!agentTab(agent)?.isPinned === setup.pinned.includes(agent.alias));
	const focused = inAgent(end, frontCard);
	return {
		id: setup.variant === 'pinned-front' ? 'F7-pinned-front' : 'F7',
		title: `a reload of six agents in one group, two of them pinned${setup.variant === 'pinned-front' ? ' and the group\'s front pinned too' : ''}: the order their tabs come to the front in`,
		done: `before the reload: fronts ${JSON.stringify(setup.fronts)}, last active in the order ${setup.lastActive.join(', ')}, pinned ${setup.pinned.join(', ')}; marks ${JSON.stringify(setup.marks)}; no file of the person's`,
		measured: `driver up ${activatedAt - reloadedAt} ms, Facade active ${activeAt === undefined ? 'never' : `${activeAt - reloadedAt} ms`}, every tab back and the pinned ones marked ${back === undefined ? 'never' : `${back - reloadedAt} ms`} after the reload request; group 1's fronts in turn: ${sequence.join(' → ') || 'none seen'} (${inOrder ? 'as' : 'not as'} LIFECYCLE-3.5's ${expected.join(' → ')}${once ? '' : '; one in front more than once'}); front after ${frontsAfter.g1}; marks ${JSON.stringify(marks)}; focus at the end ${whereName(end.d)}`,
		verdict: inOrder && once && frontBack && marksRight && focused ? 'PASS' : 'FAILURE',
		agents: setup.agents, pinned: setup.pinned, lastActive: setup.lastActive, expected, sequence, once, inOrder, frontsBefore: setup.fronts, frontsAfter, marks, marksRight, focused, focusEnd: whereName(end.d),
		host: hostRows(host, reloadedAt), log: facadeLog(reloadedAt)
	};
}

/**
 * F6: a palette Pin of an agent whose tab is behind a front no resource reopens - a markdown preview (webview) or the Settings UI - in
 * group 2, the person in their file in group 1: the Pin shows the agent's tab in front of it with the focus, as a click on its card
 * does, and marks it there, that front staying behind (LIFECYCLE-3.4).
 */
async function f6(kind: 'webview' | 'settings'): Promise<CaseResult> {
	await resetFacade();
	const mine = `f6-${kind}-1.txt`;
	await showFile(mine, 1);
	await showFile(`f6-${kind}-2.md`, 2);
	const agent = await newAgent();
	const others = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => JSON.stringify(describeTab(tab))));
	if (kind === 'webview') {
		await showFile(`f6-${kind}-2.md`, 2);
		await cmd('markdown.showPreview');
	} else {
		await cmd(GROUP_FOCUS[1]);
		await cmd('workbench.action.openSettings2');
	}
	// What opened, moved into group 2 where the editor put it elsewhere (N3)
	const fresh = await until(`the ${kind} to open`, () => vscode.window.tabGroups.all.flatMap(group => group.tabs).map(describeTab)
		.find(tab => !others.has(JSON.stringify(tab)) && tab.kind !== 'text' && tab.kind !== 'terminal'), 8_000);
	if (fresh.group !== 2) {
		await cmd(GROUP_FOCUS[fresh.group - 1]);
		await cmd(fresh.group > 2 ? 'workbench.action.moveEditorToPreviousGroup' : 'workbench.action.moveEditorToNextGroup');
	}
	const front = await until(`the ${kind} in front of group 2`, () => { const tab = frontOf(2); return tab && tab.kind === fresh.kind ? tab : undefined; }, 5_000);
	if (agentTab(agent)?.group.viewColumn !== 2) {
		throw new Error(`the agent's tab is not in group 2: ${JSON.stringify(seen())}`);
	}
	await showFile(mine, 1);
	await readyToPin('palette', agent);
	await sleep(1_200);
	await pull();
	const person = await wb.active();
	const frontsBefore = frontsNow();
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(PACE);
	await sleep(400);
	const t0 = Date.now();
	pinBy('palette', agent);
	const pinned = await pinnedAt(agent);
	await sleep(1_600);
	await stream.stop();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const got = await collect(since, typist, [agent.alias], [mine], 1_200);
	// Its tab shown in front of group 2 with the focus, as a click on its card does, the webview or Settings behind it: nothing given back
	const cli = `pty:${agent.alias}`;
	const intent = `doc:${mine}, then ${cli}`;
	const showing = acrossShowing(got.placed, key => key.to === `doc:${mine}`, agent);
	const bad = [...showing.bad, ...showing.back];
	const borrow = borrowOf(got.focus, t0, whereName(person.d), t0);
	const shown = isAgentLabel(frontsAfter.g2, agent);
	const focused = inAgent(end, agent);
	return {
		id: `F6-${kind}`, title: `a palette Pin of an agent whose tab is behind ${kind === 'webview' ? 'a markdown preview (webview)' : 'the Settings UI'} in group 2 (the person in their file)`,
		done: `group 2: ${shortTab(front)} in front, ${agent.alias} behind it; the person at ${whereName(person.d)}; a key every ${PACE} ms; ${pinCall('palette')} at 0 ms`,
		measured: `mark on at ${pinned === undefined ? 'never' : `${pinned - t0} ms`}; focus ${borrow.leftMs === undefined ? 'never left the person' : `left the person at ${borrow.leftMs} ms${borrow.backMs === undefined ? ', not back' : `, back at ${borrow.backMs} ms`}`}; group 2's front ${frontsBefore.g2} → ${frontsAfter.g2} (${shown ? 'the agent shown' : 'the agent not shown'}); focus at the end ${whereName(end.d)}${focused ? ' (the agent\'s)' : ''}; keys: ${tally(got.placed)}`,
		verdict: bad.length || pinned === undefined || !shown || !focused ? 'FAILURE' : 'PASS',
		agent, intent, front, pinnedMs: pinned === undefined ? null : pinned - t0, borrow, frontsBefore, frontsAfter, shown, focused, focusEnd: whereName(end.d), person: whereName(person.d), texts: got.texts,
		keys: keyRows(got.placed, t0, key => !bad.includes(key)), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign, log: facadeLog(since)
	};
}

/**
 * A floating editor window made of `agent`'s tab, in front of group 1, moved into it (moveEditorToNewWindow) as a person moves a tab
 * out - Facade opens an agent's tab in the main window's active group, never in a floating one - and `name` opened over it there.
 */
async function floatingGroup(agent: Card, name: string): Promise<vscode.TabGroup> {
	await cmd('facade.revealAgent', { run_id: agent.runId });
	await sleep(500);
	await cmd('workbench.action.moveEditorToNewWindow');
	const group = await until(`${agent.alias}'s tab in a floating window`, () => { const tab = agentTab(agent); return tab && tab.group.viewColumn !== 1 ? tab.group : undefined; }, 8_000);
	await sleep(800);
	// Active there with its terminal once: Facade knows a moved tab again so (LIFECYCLE-2.2)
	await cmd('facade.revealAgent', { run_id: agent.runId });
	await sleep(1_000);
	revealedIn = { activeTabGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, activeTab: brief(vscode.window.tabGroups.activeTabGroup.activeTab), activeTerminal: vscode.window.activeTerminal ? unspun(vscode.window.activeTerminal.name) : null, agentTabActive: !!agentTab(agent)?.isActive };
	await vscode.window.showTextDocument(file(name), { viewColumn: group.viewColumn, preview: false });
	await until(`${name} in front of the floating window's group`, () => unspun(groupOf(name)?.activeTab?.label ?? '') === name || undefined, 5_000);
	return groupOf(name)!;
}

/** What the API said as the floating window's agent was revealed there: whether the active group and tab followed it. */
let revealedIn: object | undefined;

/** The floating window's page, watched as it is - its own DOM focus and whether it has the system's - beside the main one's. */
async function floatingPage(name: string): Promise<Workbench | undefined> {
	const page = await Workbench.find(PORT, each => each.target.id !== wb.target.id && !each.main && each.title.includes(name), 8_000).catch(() => undefined);
	await page?.install(false).catch(() => undefined);
	return page;
}

/** The group showing `name`, wherever its view column is now, and its front. */
const groupOf = (name: string) => vscode.window.tabGroups.all.find(group => group.tabs.some(tab => unspun(tab.label) === name));

/**
 * F5: an agent's tab behind a file in a floating editor window's group, the person in the main window: its Pin by the card (the person
 * at the panel) or the palette (the person in their file) - whether its tab is shown in front there, its mark goes on, a group is made,
 * and where keys typed into the main window go.
 */
async function f5(via: Via): Promise<CaseResult> {
	await resetFacade();
	const mine = `f5-${via}-1.txt`, theirs = `f5-${via}-float.txt`;
	await showFile(mine, 1);
	const agent = await newAgent();
	const floating = await floatingGroup(agent, theirs);
	const column = floating.viewColumn;
	const revealed = revealedIn;
	if (agentTab(agent)?.group.viewColumn !== column || agentTab(agent)?.isActive) {
		throw new Error(`the agent's tab is not behind ${theirs} in the floating window's group ${column}: ${JSON.stringify(seen())}`);
	}
	await showFile(mine, 1);
	await readyToPin(via, agent);
	await sleep(1_200);
	const page = await floatingPage(theirs);
	await pull();
	const person = await wb.active();
	const frontsBefore = frontsNow();
	const groupsBefore = vscode.window.tabGroups.all.map(group => group.viewColumn);
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(PACE);
	await sleep(400);
	const t0 = Date.now();
	pinBy(via, agent);
	const pinned = await pinnedAt(agent, 4_000);
	await sleep(pinned === undefined ? 400 : 2_000);
	await stream.stop();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const groupsAfter = vscode.window.tabGroups.all.map(group => group.viewColumn);
	const floatFront = groupOf(theirs)?.activeTab;
	const floatFocus = page ? (await page.drain().catch(() => ({ focus: [] as FocusEntry[] }))).focus : [];
	page?.close();
	const got = await collect(since, typist, [agent.alias], [mine, theirs], 1_200);
	const intent = via === 'card' ? `webview:${PANEL}` : `doc:${mine}`;
	const intended = (key: Placed) => via === 'card' ? atPanel(key) : key.to === intent;
	const bad = got.placed.filter(key => !intended(key));
	const borrow = borrowOf(got.focus, t0, whereName(person.d), t0);
	const made = hostEvents.filter(each => each.t >= t0 && each.ev === 'groups' && (each.opened as number[]).length).map(each => `${each.t - t0}ms opened ${JSON.stringify(each.opened)}`);
	// The Pin shows its tab in front of the floating group, as a click on its card does; its mark goes on as that group next becomes the
	// active one, the person in that window - which this probe's input, the main page's alone, does not model: told, not judged
	const shown = !!floatFront && isAgentLabel(unspun(floatFront.label), agent);
	const marked = !!agentTab(agent)?.isPinned;
	return {
		id: `F5-${via}`, title: `a ${via} Pin of an agent whose tab is behind a file in a floating editor window's group (viewColumn ${column})`,
		done: `main window: ${mine} in group 1; floating window: ${theirs} in front of its group ${column}, ${agent.alias} behind it; the person at ${whereName(person.d)}; a key every ${PACE} ms into the main window; ${pinCall(via)} at 0 ms`,
		measured: `revealed in the floating window, the API's active group was ${JSON.stringify(revealed)}; mark ${pinned === undefined ? `not on (tab ${marked ? 'marked later' : 'unmarked'})` : `on at ${pinned - t0} ms`}; floating group's front ${theirs} → ${floatFront ? unspun(floatFront.label) : 'none'}; groups ${groupsBefore.join(',')} → ${groupsAfter.join(',')}${made.length ? ` (made meanwhile: ${made.join('; ')})` : ''}; main window focus ${borrow.path.join(' → ') || 'unchanged'}; floating window focus ${focusRows(floatFocus, t0).join(' → ') || 'not watched'}; keys: ${tally(got.placed)}`,
		verdict: bad.length || !shown || groupsAfter.length !== groupsBefore.length ? 'FAILURE' : 'PASS',
		agent, via, intent, column, revealed: revealed ?? null, pinnedMs: pinned === undefined ? null : pinned - t0, marked, shown, frontsBefore, frontsAfter, groupsBefore, groupsAfter, made, borrow,
		floatFocus: focusRows(floatFocus, t0), focusEnd: whereName(end.d), person: whereName(person.d), texts: got.texts,
		keys: keyRows(got.placed, t0, intended), focus: focusRows(got.focus, t0), host: hostRows(got.host, t0), foreign: got.foreign, log: facadeLog(since)
	};
}

/**
 * F5-reload before its reload: a pinned agent behind the person's file in group 1, and a floating window whose group shows its file in
 * front of another pinned agent - both marked in place, by the palette, before their files covered them.
 */
async function f5ReloadSetup(): Promise<void> {
	await resetFacade();
	await showFile('f5r-1.txt', 1);
	// The floating window's agent: pinned and marked in front of group 1, its tab then moved out, its file opened over it there
	const away = await newAgent();
	await readyToPin('palette', away);
	pinBy('palette', away);
	await until(`${away.alias}'s mark`, () => agentTab(away)?.isPinned || undefined, 10_000).catch(() => notes.push(`${away.alias} was not marked before its tab moved`));
	const floating = await floatingGroup(away, 'f5r-float.txt');
	await sleep(2_000);
	// Group 1's agent: pinned and marked in front, then the person's file in front of it
	await showFile('f5r-1.txt', 1);
	const main = await newAgent();
	await readyToPin('palette', main);
	pinBy('palette', main);
	await until(`${main.alias}'s mark`, () => agentTab(main)?.isPinned || undefined, 10_000).catch(() => notes.push(`${main.alias} was not marked before the reload`));
	await showFile('f5r-1.txt', 1);
	await sleep(1_500);
	await cmd('workbench.action.files.saveAll');
	await pull();
	const person = await wb.active();
	const pages = (await listTargets(PORT)).filter(target => target.type === 'page').map(target => target.title);
	write({
		phase: 'f5r-setup', agents: [{ ...main, where: 'group 1, behind f5r-1.txt', group: agentTab(main)?.group.viewColumn }, { ...away, where: `floating group ${floating.viewColumn}, behind f5r-float.txt`, group: agentTab(away)?.group.viewColumn }],
		fronts: frontsNow(), seen: seen(), person: whereName(person.d), pages,
		marks: [main, away].map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn}${agentTab(agent)?.isPinned ? '*' : ''}`), log: facadeLog(0).slice(-15), notes: notes.splice(0)
	});
	write({ phase: 'reloading' });
	void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
}

/** F5-reload after it: whether the floating window, the agents' tabs, their marks and each group's front come back; keys typed throughout. */
async function f5ReloadAfter(activatedAt: number): Promise<CaseResult> {
	const lines = said();
	const setup = lines.find(line => line.phase === 'f5r-setup') as Line & { agents: (Card & { group?: number })[]; fronts: { [column: string]: string }; person: string; pages: string[]; marks: string[] };
	const reloadedAt = lines.filter(line => line.phase === 'reloading').pop()!.at!;
	const ready = await until('a restored text editor', () => vscode.window.activeTextEditor ? Date.now() : undefined, 30_000, 25).catch(() => Date.now());
	await pull();
	const person = await wb.active();
	const typist = new Typist();
	const since = Date.now();
	const stream = typist.stream(100);
	const activeAt = await until('Facade active', () => vscode.extensions.getExtension('facade.facadecode')?.isActive ? Date.now() : undefined, 90_000, 25).catch(() => undefined);
	await until('the panel state', async () => (await state().catch(() => undefined))?.loading === false ? true : undefined, 90_000, 200).catch(() => undefined);
	const back = await until('both tabs back', () => setup.agents.every(agent => agentTab(agent)) ? Date.now() : undefined, 45_000, 25).catch(() => undefined);
	await until('both marks', () => setup.agents.every(agent => agentTab(agent)?.isPinned) || undefined, 10_000, 25).catch(() => undefined);
	await sleep(5_000);
	await stream.stop();
	const end = await wb.active();
	const frontsAfter = frontsNow();
	const pages = (await listTargets(PORT)).filter(target => target.type === 'page').map(target => target.title);
	const got = await collect(since, typist, setup.agents.map(agent => agent.alias), ['f5r-1.txt', 'f5r-float.txt']);
	const intent = 'doc:f5r-1.txt';
	// A key that reached nothing is the reload's loss, which the owner accepts; one that reached anything else is not
	const lost = got.placed.filter(key => key.to !== intent && lostKey(key));
	const bad = got.placed.filter(key => key.to !== intent && !lostKey(key));
	const marks = setup.agents.map(agent => `${agent.alias}:g${agentTab(agent)?.group.viewColumn ?? '-'}${agentTab(agent)?.isPinned ? '*' : ''}`);
	const floatGroup = groupOf('f5r-float.txt');
	const floatFront = floatGroup?.activeTab ? unspun(floatGroup.activeTab.label) : undefined;
	const borrow = borrowOf(got.focus, since, whereName(person.d), reloadedAt);
	// Each back where LIFECYCLE-3.5 puts it: group 1's in group 1; the floating window's in the main window's last group, its own gone as
	// the reload's tabs open - the editor opens that window again after them - which is group 1 here
	const moved = setup.agents.map((agent, index) => ({ agent, want: index === 0 ? agent.group : 1 })).filter(each => agentTab(each.agent)?.group.viewColumn !== each.want)
		.map(each => `${each.agent.alias}: group ${each.agent.group} → ${agentTab(each.agent)?.group.viewColumn ?? 'hidden'}, not ${each.want}`);
	const ok = !bad.length && !moved.length && frontsAfter.g1 === 'f5r-1.txt' && floatFront === 'f5r-float.txt' && setup.agents.every(agent => agentTab(agent)?.isPinned)
		&& end.d.where === 'code-editor' && end.d.group === 1;
	return {
		id: 'F5-reload', title: 'a reload with a floating editor window: a pinned agent behind its file there, another behind the person\'s file in group 1',
		done: `before the reload: fronts ${JSON.stringify(setup.fronts)}, marks ${JSON.stringify(setup.marks)}, pages ${JSON.stringify(setup.pages)}, focus ${setup.person}; after it a key every 100 ms from ${since - reloadedAt} ms`,
		measured: `driver up ${activatedAt - reloadedAt} ms, typing from ${since - reloadedAt} ms after the reload request; pages after ${JSON.stringify(pages)}; floating window's file ${floatGroup ? `in group ${floatGroup.viewColumn}, its front ${floatFront}` : 'not open'}; tabs back ${back === undefined ? 'not all' : `${back - reloadedAt} ms`} after the reload request, marks ${JSON.stringify(marks)}${moved.length ? ` (not where LIFECYCLE-3.5 puts them: ${moved.join('; ')})` : ' (the floating window\'s back in the main window, as LIFECYCLE-3.5 puts it)'}; fronts ${JSON.stringify(setup.fronts)} → ${JSON.stringify(frontsAfter)}; Facade active ${activeAt === undefined ? 'never' : `${activeAt - reloadedAt} ms`}; focus away from the person ${borrow.ms === undefined ? (borrow.leftMs === undefined ? 'never' : `from ${borrow.leftMs} ms, not back`) : `${borrow.ms} ms (${borrow.leftMs} → ${borrow.backMs} ms)`}; keys: ${tally(got.placed)} - lost ${lost.length} (accepted), misdirected ${bad.length}; focus at the end ${whereName(end.d)}`,
		verdict: ok ? 'PASS' : 'FAILURE',
		agents: setup.agents, frontsBefore: setup.fronts, frontsAfter, marks, moved, lost: lost.length, misdirected: bad.length, pagesBefore: setup.pages, pagesAfter: pages, readyMs: ready - reloadedAt, borrow, texts: got.texts, focusEnd: whereName(end.d),
		keys: keyRows(got.placed, reloadedAt, key => key.to === intent), focus: focusRows(got.focus, reloadedAt), host: hostRows(got.host, reloadedAt), foreign: got.foreign, log: facadeLog(reloadedAt)
	};
}

// ---------------------------------------------------------------------------------------------------------------------------

async function run(id: string, work: () => Promise<CaseResult | CaseResult[]>): Promise<void> {
	if (!wanted(id)) {
		return;
	}
	try {
		const results = await work();
		for (const result of Array.isArray(results) ? results : [results]) {
			report(result);
		}
	} catch (err) {
		report({ id, title: id, done: '', measured: `blocked: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, verdict: 'BLOCKED' });
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const activatedAt = Date.now();
	try {
		context.subscriptions.push(...listen());
		const name = vscode.workspace.workspaceFolders![0].name;
		wb = await Workbench.connect(PORT, name);
		const installed = await wb.install();
		wb.form = KEYS;
		write({ phase: 'meta', session: PHASE, vscode: vscode.version, platform: `${process.platform}-${process.arch}`, page: wb.title, socket: wb.cdp.kind, instrumentation: installed, focusEmulation: true, keyForm: KEYS, activatedAt });
		if (PHASE === 'native') {
			await reset();
			await run('N1', () => n1('behind'));
			await run('N1-front', () => n1('front'));
			await run('N1-other', () => n1('other'));
			await run('N2', n2);
			await run('N3', n3);
			await run('N3-split', n3Split);
			await run('N5', n5);
			await run('N4', n4);
		} else if (PHASE === 'facade') {
			await activateFacade();
			for (let round = 1; round <= REPEAT; round++) {
				await run('F1-palette', () => f1('palette', round));
				await run('F1-card', () => f1('card', round));
				await run('F2-card', () => f2('card', round));
				await run('F2-palette', () => f2('palette', round));
				await run('F2-same-palette', () => f2('same-palette', round));
				await run('F2-same-card', () => f2('same-card', round));
			}
			await run('F4-cmd1', () => f4('cmd1', 'palette'));
			await run('F4-cmd3', () => f4('cmd3', 'palette'));
			await run('F4-ctrltab', () => f4('ctrltab', 'palette'));
			await run('F4-cmd3-card', () => f4('cmd3', 'card'));
			await run('F6-webview', () => f6('webview'));
			await run('F6-settings', () => f6('settings'));
		} else if (PHASE === 'floating') {
			if (!said().some(line => line.phase === 'reloading')) {
				await activateFacade();
				await run('F5-card', () => f5('card'));
				await run('F5-palette', () => f5('palette'));
				if (wanted('F5-reload')) {
					await f5ReloadSetup();
					return;
				}
			} else {
				await run('F5-reload', () => f5ReloadAfter(activatedAt));
			}
		} else if (PHASE === 'reload') {
			// Each case asked for with a reload of its own, in turn: F3, F3-settled, F7 and F7-pinned-front
			const cases = [
				{ id: 'F3', setup: () => f3Setup('quick'), after: f3After },
				{ id: 'F3-settled', setup: () => f3Setup('settled'), after: f3After },
				{ id: 'F7', setup: () => f7Setup('front'), after: f7After },
				{ id: 'F7-pinned-front', setup: () => f7Setup('pinned-front'), after: f7After }
			].filter(each => wanted(each.id));
			const reloads = said().filter(line => line.phase === 'reloading').length;
			const measured = cases[reloads - 1];
			if (measured) {
				await run(measured.id, () => measured.after(activatedAt));
			}
			if (cases[reloads]) {
				await cases[reloads].setup();
				return;
			}
		}
		write({ phase: 'done' });
	} catch (err) {
		write({ phase: 'error', error: err instanceof Error ? err.stack ?? err.message : String(err), notes: notes.splice(0) });
	}
}

export function deactivate(): void {
	wb?.close();
}
