/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The pins journey's driver (LIFECYCLE-3.4, 3.5, PANEL-2.1, VERIFICATION J12): agents in two groups, some of them pinned, a text file in
// front, and the window reloaded. With no tab revealed, the pinned agents' tabs alone come back, each in its group with its mark, one at
// a time in the Pins' order, each marked before the next opens; every other agent's tab stays hidden, no Pin changes, and nothing is
// given back - the last pinned agent's tab is in front of its group, that group the active one, the panel's selection on it. Then,
// the hidden agents opened again from their cards in their groups, the ways a person changes a Pin - a card's Pin and Unpin of an agent
// whose tab is behind, a tab's own Pin and Unpin, a close of a pinned tab - each leave its card and its tab agreeing, and a last reload
// shows what they came to. It runs in an editor that runs no tests, as the window reloads; each step is a line of FACADE_IT_PINS for the
// runner to judge.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

/** A tab title without the spinner's frame a busy agent's tab shows before its name (LIFECYCLE-2.2). */
const unspun = (title: string) => title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');

const OUT = process.env.FACADE_IT_PINS!;
/** How many agents each of the two groups holds. */
const PER_GROUP = Number(process.env.FACADE_IT_PINS_PER_GROUP ?? 6);
/** How long marks may take to follow a reload or a Pin, once the tabs are back. */
const SETTLE_MS = 15_000;

interface Step { readonly phase: string; readonly at?: number; readonly [key: string]: unknown }

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify({ ...line, at: Date.now() })}\n`);
}

function steps(): Step[] {
	return fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Step) : [];
}

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await sleep(100);
	}
}

/** One agent as its card and its tab show it. */
interface Agent {
	readonly alias: string;
	readonly runId: string;
	readonly name: string;
	readonly pinned: boolean;
	/** How many tabs show it: one, or none where it is hidden. */
	readonly tabs: number;
	readonly group?: number;
	readonly marked?: boolean;
}

interface Seen {
	readonly agents: readonly Agent[];
	readonly active?: string;
	readonly activeGroup: number;
	/** The agents whose tab's mark disagrees with their card. */
	readonly wrong: readonly string[];
}

function agentTabs(): { readonly label: string; readonly group: number; readonly pinned: boolean; readonly active: boolean }[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputTerminal)
		.map(tab => ({ label: unspun(tab.label), group: group.viewColumn, pinned: tab.isPinned, active: tab.isActive })));
}

async function seen(): Promise<Seen> {
	const cards = (await state()).cards;
	const tabs = agentTabs();
	const agents = cards.map(card => {
		const mine = tabs.filter(tab => tab.label === card.name || tab.label.startsWith(`${card.name} `));
		return { alias: card.alias, runId: card.runId, name: card.name, pinned: !!card.pinned, tabs: mine.length, ...mine[0] ? { group: mine[0].group, marked: mine[0].pinned } : {} };
	});
	const active = vscode.window.tabGroups.activeTabGroup.activeTab;
	return {
		agents, active: active ? unspun(active.label) : undefined, activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn,
		wrong: agents.filter(agent => agent.tabs > 0 && agent.marked !== agent.pinned).map(agent => agent.alias)
	};
}

/** Whether a tab title is `agent`'s: its name, or its name and short ID (LIFECYCLE-2.2). */
const isAgentLabel = (label: string | undefined, agent: { readonly name: string }) => !!label && (label === agent.name || label.startsWith(`${agent.name} `));

/**
 * The agent tabs that opened since this activation, in turn - as a reload's open, the driver watching from its activation, which
 * comes before Facade's restoration begins - and whether every agent tab that opened before each one showed its mark as it opened.
 */
const openings: { readonly label: string; readonly group: number; readonly earlierMarked: boolean }[] = [];
function watchOpenings(): vscode.Disposable {
	return vscode.window.tabGroups.onDidChangeTabs(event => {
		for (const tab of event.opened.filter(each => each.input instanceof vscode.TabInputTerminal)) {
			const earlier = new Set(openings.map(each => each.label));
			const tabs = agentTabs().filter(each => earlier.has(each.label));
			openings.push({ label: unspun(tab.label), group: tab.group.viewColumn, earlierMarked: tabs.every(each => each.pinned) });
		}
	});
}

/** The Pins and Unpins the window logged since `since`, which a reload or a mark must never make. */
function pinLines(since: number): string[] {
	const dir = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).map(key => path.join(dir, key, 'agents.log')).filter(file => fs.existsSync(file)) : [];
	return files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n')).filter(line => {
		const at = Date.parse(line.slice(0, 24));
		return Number.isFinite(at) && at >= since && /(Pinned|Unpinned) #a\d+|Could not synchronize the pin|for its mark|did not take its (mark|unmark)|meant for|Could not mark|Could not bring back/.test(line);
	});
}

/** Starts one agent as a person does, in the active group, and answers it once its tab is open. */
async function newAgent(): Promise<Agent> {
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	const card = await until('a new card', async () => {
		const added = (await state()).cards.find(each => !before.has(each.runId));
		if (added) {
			return added;
		}
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	}, 60_000);
	return await until(`the tab of ${card.alias}`, async () => (await seen()).agents.find(agent => agent.runId === card.runId && agent.tabs === 1));
}

/** Waits until every agent's tab agrees with its card, or `ms` passed: how long it took, or -1. */
async function agreed(ms = SETTLE_MS): Promise<{ readonly took: number; readonly seen: Seen }> {
	const start = Date.now();
	for (;;) {
		const now = await seen();
		if (!now.wrong.length) {
			return { took: Date.now() - start, seen: now };
		}
		if (Date.now() - start > ms) {
			return { took: -1, seen: now };
		}
		await sleep(100);
	}
}

async function fileIn(column: vscode.ViewColumn, name: string): Promise<void> {
	const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = path.join(folder, name);
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, `${name}\n`);
	}
	await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: column, preview: false });
}

/**
 * After a reload: the pinned agents' tabs alone back, each in its group with its mark agreeing with its card, none revealed, one at a
 * time in the Pins' order - the panel's, which lists the pinned cards in it (PANEL-2.1) - each marked before the next opened; every other
 * agent's tab hidden; no Pin changed; the last pinned agent's tab in front of its group, that group the active one, nothing given back,
 * and the panel's selection on it (LIFECYCLE-3.5).
 */
async function afterReload(which: number, reloadedAt: number, expected: readonly Agent[]): Promise<void> {
	await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 90_000);
	const pinned = expected.filter(agent => agent.pinned);
	const back = await until('every pinned agent\'s tab back, the others hidden', async () => {
		const now = await seen();
		return expected.every(agent => now.agents.some(each => each.runId === agent.runId && each.tabs === (agent.pinned ? 1 : 0))) ? now : undefined;
	}, 60_000).catch(() => undefined);
	const settled = await agreed();
	// Marks that come late, or go: what the window shows a while after
	await sleep(3_000);
	const later = await seen();
	const last = pinned[pinned.length - 1];
	const lastNow = last && later.agents.find(each => each.runId === last.runId);
	const aliasOf = (label: string) => expected.find(agent => isAgentLabel(label, agent))?.alias ?? label;
	write({
		phase: `reload-${which}`, back: !!back, took: settled.took, settled: settled.seen, later,
		// Each pinned agent's tab in the group it was in
		moved: pinned.filter(agent => agent.group !== undefined && later.agents.find(each => each.runId === agent.runId)?.group !== agent.group).map(agent => agent.alias),
		// No other agent's tab opened, though it was open before the reload
		shown: expected.filter(agent => !agent.pinned && later.agents.find(each => each.runId === agent.runId)?.tabs !== 0).map(agent => agent.alias),
		// The agent tabs in the order they opened, each once, and those that opened before the one before them showed its mark
		order: openings.map(each => aliasOf(each.label)), expectedOrder: pinned.map(agent => agent.alias),
		unmarkedBefore: openings.filter(each => !each.earlierMarked).map(each => aliasOf(each.label)),
		// Nothing given back: the last pinned agent's tab in front of its group, that group the active one, the panel's selection on it
		last: last?.alias ?? null,
		front: !last || (isAgentLabel(later.active, last) && later.activeGroup === lastNow?.group),
		selected: !last || (await state()).cards.find(card => card.selected)?.runId === last.runId,
		pinChanged: expected.filter(agent => later.agents.find(each => each.runId === agent.runId)?.pinned !== agent.pinned).map(agent => agent.alias),
		logged: pinLines(reloadedAt)
	});
}

/**
 * The agents a reload left hidden, opened again from their cards as a person does, each in the group it was in at `setup`: that
 * group made the active one, then the agent revealed there (LIFECYCLE-2.2).
 */
async function reopenHidden(setup: readonly Agent[]): Promise<void> {
	const focus = ['workbench.action.focusFirstEditorGroup', 'workbench.action.focusSecondEditorGroup'];
	for (const agent of setup.filter(each => !each.pinned && each.group !== undefined)) {
		const now = (await seen()).agents.find(each => each.runId === agent.runId);
		if (!now || now.tabs > 0) {
			continue;
		}
		await vscode.commands.executeCommand(focus[agent.group! - 1]);
		await vscode.commands.executeCommand('facade.revealAgent', { run_id: agent.runId });
		await until(`${agent.alias}'s tab again`, async () => (await seen()).agents.find(each => each.runId === agent.runId && each.tabs === 1), 10_000).catch(() => undefined);
	}
}

function reload(): void {
	write({ phase: 'reloading' });
	void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
}

/** Changes a Pin as a person does, and says how the card and the tab followed. */
/**
 * What `run` does to `alias`'s Pin, `pinned` once done: whether its card and its tab followed, what was in front before and after, and
 * the tab `shows` names - a card's Pin or Unpin shows its tab as a click on the card does (LIFECYCLE-3.4).
 */
async function act(what: string, run: () => Thenable<unknown>, alias: string, pinned: boolean, shows?: { readonly name: string; readonly group: number }): Promise<object> {
	const since = Date.now();
	const before = await seen();
	await run();
	const card = await until(`${alias}'s card ${pinned ? 'pinned' : 'unpinned'}`, async () => (await seen()).agents.find(agent => agent.alias === alias && agent.pinned === pinned), 5_000).catch(() => undefined);
	const tab = await until(`${alias}'s tab to agree`, async () => {
		const agent = (await seen()).agents.find(each => each.alias === alias);
		return agent && (agent.tabs === 0 || agent.marked === pinned) ? agent : undefined;
	}, 5_000).catch(() => undefined);
	await sleep(1_000);
	const after = await seen();
	return {
		what, alias, card: !!card, tab: !!tab, tookMs: Date.now() - since, activeBefore: before.active, activeAfter: after.active, groupBefore: before.activeGroup,
		groupAfter: after.activeGroup, ...shows ? { shows } : {}, wrong: after.wrong, others: after.agents.filter(agent => agent.alias !== alias && before.agents.find(each => each.alias === agent.alias)?.pinned !== agent.pinned).map(agent => agent.alias),
		logged: pinLines(since)
	};
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Watched from the first moment, before Facade's restoration opens a tab
	context.subscriptions.push(watchOpenings());
	try {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 90_000);
		const done = steps();
		const reloads = done.filter(step => step.phase === 'reloading');
		if (!reloads.length) {
			// Two groups, each with a text file and agents; a pinned agent at every other place, the first of the second group unpinned
			await fileIn(vscode.ViewColumn.One, 'one.md');
			for (let index = 0; index < PER_GROUP; index++) {
				await newAgent();
			}
			await fileIn(vscode.ViewColumn.Two, 'two.md');
			for (let index = 0; index < PER_GROUP; index++) {
				await newAgent();
			}
			const agents = (await seen()).agents;
			for (const [index, agent] of agents.entries()) {
				if (index % 2 === 0) {
					await until(`Pin offered for ${agent.alias}`, async () => (await state()).cards.find(card => card.runId === agent.runId)?.menu.pin || undefined, 30_000);
					await vscode.commands.executeCommand('facade.pinAgent', { run_id: agent.runId });
				}
			}
			await until('the Pins', async () => (await seen()).agents.filter(agent => agent.pinned).length === Math.ceil(agents.length / 2) || undefined);
			// Their marks on, the person back at the file in the first group, the tabs as they were left
			await agreed();
			await fileIn(vscode.ViewColumn.One, 'one.md');
			await sleep(1_000);
			write({ phase: 'setup', seen: await seen(), logged: pinLines(0).filter(line => !/(Pinned|Unpinned) #a\d+/.test(line)) });
			reload();
			return;
		}
		const setup = done.find(step => step.phase === 'setup')!.seen as Seen;
		const reloadedAt = reloads[reloads.length - 1].at!;
		if (reloads.length === 1 || reloads.length === 2) {
			await afterReload(reloads.length, reloadedAt, setup.agents);
			if (reloads.length === 1) {
				reload();
				return;
			}
			// The agents the reloads left hidden opened again from their cards, in their groups; then what a person does with Pins, each on
			// an agent of its own
			await reopenHidden(setup.agents);
			await fileIn(vscode.ViewColumn.One, 'one.md');
			const agents = (await seen()).agents;
			const inGroup = (column: number) => agents.filter(agent => agent.group === column);
			const [g1, g2] = [inGroup(1), inGroup(2)];
			const front = (column: number) => vscode.window.tabGroups.all.find(group => group.viewColumn === column)?.activeTab;
			// Behind: not its group's front tab
			const behind = (list: readonly Agent[], pinned: boolean) => list.find(agent => agent.pinned === pinned && unspun(front(agent.group!)?.label ?? '') !== agent.name);
			const results: object[] = [];
			// From its card: its tab shown as a click on the card shows it, in front of its group with the focus, and marked there
			const cardPin = behind(g2, false);
			if (cardPin) { results.push(await act('card Pin of a tab behind, in the other group', () => vscode.commands.executeCommand('facade.pinAgent', { run_id: cardPin.runId }), cardPin.alias, true, { name: cardPin.name, group: cardPin.group! })); }
			await fileIn(vscode.ViewColumn.One, 'one.md');
			const cardUnpin = behind(g1, true);
			if (cardUnpin) { results.push(await act('card Unpin of a tab behind', () => vscode.commands.executeCommand('facade.unpinAgent', { run_id: cardUnpin.runId }), cardUnpin.alias, false, { name: cardUnpin.name, group: cardUnpin.group! })); }
			// From the Command Palette, about the selected card: its tab shown as its card's Pin shows it, and marked there
			const selected = async (agent: Agent, column: number, file: string) => {
				await vscode.commands.executeCommand('facade.revealAgent', { run_id: agent.runId });
				await sleep(500);
				await fileIn(column, file);
				await fileIn(vscode.ViewColumn.One, 'one.md');
				await sleep(500);
			};
			const palettePin = (await seen()).agents.find(agent => agent.group === 2 && !agent.pinned && unspun(front(2)?.label ?? '') !== agent.name);
			if (palettePin) {
				await selected(palettePin, vscode.ViewColumn.Two, 'two.md');
				results.push(await act('palette Pin of a tab behind, in the other group', () => vscode.commands.executeCommand('facade.pinAgent'), palettePin.alias, true, { name: palettePin.name, group: palettePin.group! }));
			}
			const paletteUnpin = (await seen()).agents.find(agent => agent.group === 1 && agent.pinned && unspun(front(1)?.label ?? '') !== agent.name);
			if (paletteUnpin) {
				await selected(paletteUnpin, vscode.ViewColumn.One, 'one.md');
				results.push(await act('palette Unpin of a tab behind', () => vscode.commands.executeCommand('facade.unpinAgent'), paletteUnpin.alias, false, { name: paletteUnpin.name, group: paletteUnpin.group! }));
			}
			// A hidden agent pinned from the Command Palette: its tab opens in front of the active group, marked
			const hiding = (await seen()).agents.find(agent => agent.group === 1 && !agent.pinned && agent.tabs > 0);
			if (hiding) {
				await vscode.commands.executeCommand('facade.revealAgent', { run_id: hiding.runId });
				await sleep(500);
				const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(each => each.input instanceof vscode.TabInputTerminal
					&& (unspun(each.label) === hiding.name || unspun(each.label).startsWith(`${hiding.name} `)));
				if (tab) {
					await vscode.window.tabGroups.close(tab);
					await until(`${hiding.alias} hidden`, async () => (await seen()).agents.find(agent => agent.alias === hiding.alias && agent.tabs === 0), 5_000);
				}
				results.push(await act('palette Pin of a hidden agent', () => vscode.commands.executeCommand('facade.pinAgent'), hiding.alias, true, { name: hiding.name, group: vscode.window.tabGroups.activeTabGroup.viewColumn }));
			}
			const tabPin = (await seen()).agents.find(agent => agent.group === 1 && !agent.pinned);
			if (tabPin) {
				results.push(await act('tab Pin', async () => {
					await vscode.commands.executeCommand('facade.revealAgent', { run_id: tabPin.runId });
					await sleep(500);
					await vscode.commands.executeCommand('workbench.action.pinEditor');
				}, tabPin.alias, true));
			}
			const tabUnpin = (await seen()).agents.find(agent => agent.group === 2 && agent.pinned);
			if (tabUnpin) {
				results.push(await act('tab Unpin', async () => {
					await vscode.commands.executeCommand('facade.revealAgent', { run_id: tabUnpin.runId });
					await sleep(500);
					await vscode.commands.executeCommand('workbench.action.unpinEditor');
				}, tabUnpin.alias, false));
			}
			// A close of a tab showing its mark Unpins its agent, which goes on (LIFECYCLE-3.4): by its tab's Close, as its context menu
			// closes it - the editor keeps a pinned tab from the keyboard's Close
			const closed = (await seen()).agents.find(agent => agent.group === 1 && agent.pinned && agent.marked);
			if (closed) {
				results.push(await act('close of a pinned tab', async () => {
					const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(each => each.input instanceof vscode.TabInputTerminal
						&& (unspun(each.label) === closed.name || unspun(each.label).startsWith(`${closed.name} `)));
					if (tab) {
						await vscode.window.tabGroups.close(tab);
					}
				}, closed.alias, false));
			}
			const final = await seen();
			write({ phase: 'actions', results, final });
			// The person back at the file; the last reload shows what the Pins came to
			await agreed();
			await fileIn(vscode.ViewColumn.One, 'one.md');
			await sleep(1_000);
			write({ phase: 'expected', seen: await seen() });
			reload();
			return;
		}
		const expected = done.filter(step => step.phase === 'expected').pop()!.seen as Seen;
		await afterReload(reloads.length, reloadedAt, expected.agents);
		write({ phase: 'done' });
	} catch (err) {
		write({ phase: 'error', error: err instanceof Error ? err.stack ?? err.message : String(err), seen: await seen().catch(() => undefined) });
	}
}

export function deactivate(): void {
	// Nothing to let go
}
