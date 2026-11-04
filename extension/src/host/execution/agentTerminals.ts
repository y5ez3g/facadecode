/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { TERMINAL_REGISTRATION_MS, WINDOW_TERMINALS_COMMAND, type TerminalOwner, type TerminalRegistration } from '../../base/windowIdentity';
import type { PairFacts, RunId } from '../../core/ports';
import { cliTerminalIcon } from '../../ui/presentation';
import type { WindowColours } from './terminalColours';
import { AgentPty } from './agentPty';

/** One run's terminal resource; process state and subscriptions belong to the execution coordinator. */
export interface AgentTerminal {
	readonly pty: AgentPty;
	/** Opens its tab: in the active group, or in `column`'s where that is given - the last group where it is gone (LIFECYCLE-3.5). */
	open(reveal: boolean, column?: number): void;
	reveal(preserveFocus: boolean): boolean;
	/** Closes its tab, the run and its pseudoterminal going on: opened again, it draws the run's screen (LIFECYCLE-2.2). */
	hide(): boolean;
	rename(name: string): void;
	/** Its agent's short ID, and whether its tab shows it (LIFECYCLE-2.2). */
	label(alias: string, shown: boolean): void;
	dispose(): void;
}

interface TerminalEntry {
	readonly run: RunId;
	name: string;
	readonly cli: string;
	readonly pty: AgentPty;
	terminal: vscode.Terminal | undefined;
	opening?: boolean;
	readonly lifetime: AbortController;
	tab?: vscode.Tab;
	observedPin?: boolean;
	wantedPin?: boolean;
	applyingPin?: boolean;
	/** A restored terminal opens behind the editor it covered; this is not a human activation. */
	background?: { readonly since: number; readonly covered?: vscode.Tab };
	/** Its tab is closing as Facade hid it: no close of the person's (LIFECYCLE-2.2). */
	hiding?: boolean;
	/** Facade's Pin of its agent, which a group's one unpinned agent tab counts - its mark following (LIFECYCLE-2.2, 3.4). */
	pinned?: boolean;
	/** When its tab was last active, by this host's clock: what a reload into one group goes by (LIFECYCLE-2.2, 3.5). */
	activeAt?: number;
	/** The group its tab is to open in; none, the active one. */
	openIn?: number;
}

interface TerminalOptions {
	readonly media: vscode.Uri;
	readonly log: (line: string) => void;
	readonly terminalOwner?: TerminalOwner & { readonly remote: boolean };
	readonly activated: (run: RunId | undefined) => void;
	/** The person closed `run`'s tab - `marked` where it showed its pin mark - as the editor reports a close of theirs (LIFECYCLE-2.2, 3.4). */
	readonly closed: (run: RunId, marked: boolean) => void;
	readonly pinned?: (run: RunId, pinned: boolean) => void;
	readonly renamed: (run: RunId, name: string) => void;
	/** The window's terminal colours, which each terminal reports as it opens and the theme changes (ARCHITECTURE-2.3). */
	readonly colours?: WindowColours;
	/** Where `run`'s tab is now: open in the group of `column`, or hidden - what a reload brings back (LIFECYCLE-2.2, 3.5). */
	readonly placed?: (run: RunId, column: number | undefined, activeAt: number | undefined) => void;
	/**
	 * The editor copied `run`'s tab - a split, a copying drag, Copy into New Window - into a terminal with no process: `copy`, which
	 * closes as the caller says (LIFECYCLE-2.2).
	 */
	readonly copied?: (run: RunId, copy: vscode.Terminal, column: number | undefined) => void;
}

/** Active-terminal and active-tab changes within this interval identify one change (LIFECYCLE-2.2). */
const TOGETHER_MS = 250;
/** A terminal created by Facade may be correlated with an opening tab for this long. */
const OPENING_MS = 2_000;
/** A tab of an agent closed while its terminal stays open is that tab moved where one tab opens within this (LIFECYCLE-2.2). */
const MOVE_MS = 1_000;

/** Copies the editor makes within this of one another are copied together - a whole group's - and none of them is attributed. */
const COPIES_MS = 300;

/** Why a tab is where it is now: what decides, where its group has another unpinned agent tab, which one stays (LIFECYCLE-2.2). */
type Placement = 'opened' | 'moved' | 'active' | 'unpinned';

/** Owns native terminal resources, tab identity, names and focus; it never starts or ends a CLI process. */
export class AgentTerminals implements vscode.Disposable {
	private readonly entries = new Map<RunId, TerminalEntry>();
	private opening: { readonly pair: TerminalEntry; readonly at: number }[] = [];
	/** Agents' tabs closed with their terminals still open: moved, where one tab opens to take each (LIFECYCLE-2.2). */
	private movedOut: { readonly pair: TerminalEntry; readonly at: number }[] = [];
	/** Copies of agents' tabs the editor made lately, attributed together once no other follows (LIFECYCLE-2.2). */
	private copies: vscode.Terminal[] = [];
	private copiesTimer: ReturnType<typeof setTimeout> | undefined;
	/** The group the next agent's tab opens in: a copy's, where an agent starts in its place (LIFECYCLE-2.2). */
	private nextColumn: number | undefined;
	private terminalActivatedAt = -Infinity;
	private tabActivatedAt = -Infinity;
	private readonly disposables: vscode.Disposable[] = [];
	private creation = Promise.resolve();
	private revealRequested?: { readonly pair: TerminalEntry; readonly preserveFocus: boolean };
	/** The system's reduced-motion preference as the panel's page said it last; none until it has (LIFECYCLE-2.2). */
	private systemReduced: boolean | undefined;

	constructor(private readonly options: TerminalOptions) {
		this.disposables.push(
			// A new theme's colours, as the terminals open report them again
			vscode.window.onDidChangeActiveColorTheme(() => { for (const entry of this.entries.values()) { entry.pty.askColours(); } }),
			vscode.workspace.onDidChangeConfiguration(change => {
				if (change.affectsConfiguration('workbench.reduceMotion')) { this.moved(); }
			}),
			vscode.window.onDidChangeActiveTerminal(terminal => {
				this.terminalActivatedAt = Date.now();
				this.correlate();
				const pair = terminal && this.pairOf(terminal);
				if (pair) { this.applyPin(pair); }
				// A terminal made behind the person's work, becoming active as it opens, moves no selection (PANEL-2.1)
				if (!pair || !this.opensBehind(pair)) {
					this.options.activated(pair?.run);
				}
			}),
			vscode.window.tabGroups.onDidChangeTabs(event => this.tabsChanged(event)),
			vscode.window.onDidOpenTerminal(terminal => this.maybeCopy(terminal)),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.groupsChanged()),
			vscode.window.onDidCloseTerminal(terminal => {
				const pair = this.pairOf(terminal);
				if (!pair) {
					return;
				}
				const marked = pair.observedPin === true;
				this.movedOut = this.movedOut.filter(each => each.pair !== pair);
				pair.terminal = undefined;
				pair.wantedPin ??= pair.observedPin;
				pair.observedPin = undefined;
				pair.tab = undefined;
				this.opening = this.opening.filter(each => each.pair !== pair);
				// The window going keeps what a reload brings back
				if (terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) {
					this.options.placed?.(pair.run, undefined, undefined);
				}
				if (pair.hiding) {
					pair.hiding = false;
					return;
				}
				// The person closed the tab - not the window going: it is hidden, the agent going on, and the same pseudoterminal opens
				// in a new tab as its card opens it (LIFECYCLE-2.2). A close of a tab showing its pin mark Unpins (3.4).
				if (terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) {
					this.options.closed(pair.run, marked);
				}
			})
		);
	}

	/**
	 * Facade's Pin of `run` changed: its tab's mark follows once that exact tab is active - never revealed merely to pin it - and an
	 * Unpin leaves its group one unpinned agent tab (LIFECYCLE-2.2, 3.4).
	 */
	pin(run: RunId, pinned: boolean): void {
		const pair = this.entries.get(run);
		if (pair) {
			pair.pinned = pinned;
			pair.wantedPin = pinned;
			this.applyPin(pair);
			if (!pinned) { this.oneUnpinned(pair, 'unpinned'); }
		}
	}

	/**
	 * `keep`'s group shows at most one unpinned agent tab (LIFECYCLE-2.2): the others there are hidden, their agents going on. The one
	 * opened or moved in stays; after an Unpin the group's active one, else the one just unpinned. A tab Facade cannot tell counts for
	 * no agent and hides none; pinned agents' tabs never hide one another.
	 */
	private oneUnpinned(keep: TerminalEntry, why: Placement): void {
		const column = keep.tab?.group?.viewColumn;
		if (column === undefined || keep.pinned || !keep.terminal) {
			return;
		}
		const together = [keep, ...[...this.entries.values()].filter(other => other !== keep && !other.pinned && other.terminal && !other.hiding && other.tab?.group?.viewColumn === column)];
		if (together.length < 2) {
			return;
		}
		const stays = why === 'unpinned' ? together.find(each => each.tab?.isActive) ?? keep : keep;
		for (const other of together) {
			if (other !== stays) {
				this.hidePair(other);
			}
		}
	}

	/** Closes `pair`'s tab as Facade hides it: no close of the person's, its agent going on (LIFECYCLE-2.2). */
	private hidePair(pair: TerminalEntry): boolean {
		const terminal = pair.terminal;
		if (this.entries.get(pair.run) !== pair || !terminal) {
			return false;
		}
		if (this.revealRequested?.pair === pair) { this.revealRequested = undefined; }
		pair.hiding = true;
		terminal.dispose();
		return true;
	}

	private applyPin(pair: TerminalEntry): void {
		if (pair.wantedPin === undefined || !pair.tab || pair.applyingPin) { return; }
		if (pair.tab.isPinned === pair.wantedPin) {
			pair.observedPin = pair.tab.isPinned; pair.wantedPin = undefined; return;
		}
		if (pair.tab !== vscode.window.tabGroups.activeTabGroup.activeTab || vscode.window.activeTerminal !== pair.terminal) { return; }
		const wanted = pair.wantedPin;
		pair.applyingPin = true;
		void vscode.commands.executeCommand(wanted ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor').then(() => {
			pair.applyingPin = false;
			if (pair.tab?.isPinned === wanted) {
				pair.observedPin = wanted;
				if (pair.wantedPin === wanted) { pair.wantedPin = undefined; }
			}
			// A second action while the command was in flight wins; never retry a failed/no-op command in a loop.
			if (pair.wantedPin !== undefined && pair.wantedPin !== wanted) { this.applyPin(pair); }
		}, err => { pair.applyingPin = false; this.options.log(`Could not synchronize the pin of ${pair.run}: ${messageOf(err)}`); });
	}

	/**
	 * Whether a busy tab's spinner keeps one frame still (LIFECYCLE-2.2, UX-2.2), as the editor stills its own progress: always with
	 * `workbench.reduceMotion` on, never with it off; at `auto`, until the panel's page says the system allows motion - the extension
	 * host cannot read it - and again once it says the system asks for less.
	 */
	private still(): boolean {
		const setting = vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion');
		return setting === 'on' || (setting !== 'off' && this.systemReduced !== false);
	}

	/** The system's reduced-motion preference, as the panel's page says it: each busy tab's spinner follows it. */
	systemMotion(reduced: boolean): void {
		if (reduced !== this.systemReduced) {
			this.systemReduced = reduced;
			this.moved();
		}
	}

	private moved(): void {
		for (const pair of this.entries.values()) {
			pair.pty.motionChanged();
		}
	}

	/** Register the pseudoterminal first; the coordinator opens the native tab after registering its run. */
	create(facts: Pick<PairFacts, 'run' | 'name' | 'cli' | 'pinned'>, reveal: boolean): AgentTerminal {
		const pty = new AgentPty(facts.name, line => this.options.log(line), () => this.still(), (osc, rgb) => this.options.colours?.learn(osc, rgb));
		const covered = reveal ? undefined : vscode.window.tabGroups.activeTabGroup.activeTab;
		const pair: TerminalEntry = {
			run: facts.run, name: facts.name, cli: facts.cli, pty, terminal: undefined, lifetime: new AbortController(), ...facts.pinned ? { pinned: true } : {},
			...this.nextColumn !== undefined ? { openIn: this.nextColumn } : {},
			...reveal ? {} : { background: { since: Date.now(), ...covered ? { covered } : {} } }
		};
		this.entries.set(facts.run, pair);
		this.nextColumn = undefined;
		return {
			pty,
			open: (reveal, column) => {
				if (column !== undefined) {
					pair.openIn = column;
				}
				this.openPair(pair, reveal);
			},
			reveal: preserveFocus => {
				if (this.entries.get(pair.run) !== pair) {
					return false;
				}
				if (!pair.terminal) {
					// In the group the person is in, wherever it last was
					pair.openIn = undefined;
					this.revealRequested = { pair, preserveFocus };
					// A kept run whose tab was closed has none until it is opened again
					if (!pair.opening) {
						this.openPair(pair, !preserveFocus);
					}
					return true;
				}
				this.revealRequested = undefined;
				pair.background = undefined;
				pair.terminal.show(preserveFocus);
				return true;
			},
			hide: () => this.hidePair(pair),
			rename: name => {
				pair.name = name;
				pty.rename(name);
			},
			label: (alias, shown) => pty.label(alias, shown),
			dispose: () => this.remove(pair)
		};
	}

	/** Opens `pair`'s native terminal where it has none: at once, or after this host's earlier registrations. */
	private openPair(pair: TerminalEntry, reveal: boolean): void {
		if (this.entries.get(pair.run) !== pair || pair.terminal || pair.opening) {
			return;
		}
		if (!this.options.terminalOwner) {
			this.createTerminal(pair, reveal);
			return;
		}
		if (reveal) { this.revealRequested = { pair, preserveFocus: false }; }
		pair.opening = true;
		this.creation = this.creation.then(() => this.createRegistered(pair)).catch(err => {
			this.options.log(`Could not register terminal for ${pair.run}: ${messageOf(err)}`);
		}).finally(() => { pair.opening = false; });
	}

	/**
	 * A terminal the editor opened that Facade did not: a copy of an agent's tab where it has neither a shell nor a pseudoterminal of
	 * its own and the name an agent's tab was opened under - a person's own shell never is (LIFECYCLE-2.2).
	 */
	private maybeCopy(terminal: vscode.Terminal): void {
		if (this.pairOf(terminal)) {
			return;
		}
		const options = terminal.creationOptions as vscode.TerminalOptions & { readonly pty?: unknown };
		if ('pty' in options || options.shellPath !== undefined || options.shellArgs !== undefined || options.cwd !== undefined || options.env !== undefined
			|| typeof options.name !== 'string' || ![...this.entries.values()].some(pair => pair.pty.createdName() === options.name)) {
			return;
		}
		this.copies.push(terminal);
		clearTimeout(this.copiesTimer);
		this.copiesTimer = setTimeout(() => this.attributeCopies(), COPIES_MS);
	}

	/**
	 * The copies made together: one, of the agent whose open tab alone was opened under its name, is told; several at once - a whole
	 * group's - or one whose name two open agent tabs bear close, starting nothing (LIFECYCLE-2.2).
	 */
	private attributeCopies(): void {
		const copies = this.copies;
		this.copies = [];
		this.copiesTimer = undefined;
		const name = copies.length === 1 ? (copies[0].creationOptions as vscode.TerminalOptions).name : undefined;
		const sources = name === undefined ? [] : [...this.entries.values()].filter(pair => pair.terminal && pair.pty.createdName() === name);
		if (sources.length === 1 && this.options.copied) {
			// The copy's group: the one terminal tab no agent's is - the editor may not have made that group active yet
			const strays = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTerminal && !this.pairOfTab(tab));
			this.options.copied(sources[0].run, copies[0], strays.length === 1 ? strays[0].group?.viewColumn : undefined);
			return;
		}
		this.options.log(`Closed ${copies.length === 1 ? 'a copy of an agent tab whose agent could not be told' : `${copies.length} copies of agent tabs made together`}; no agent started.`);
		for (const copy of copies) {
			copy.dispose();
		}
	}

	/** Opens the next agent's tab in `column`'s group: in a copy's place (LIFECYCLE-2.2). */
	openNextIn(column: number | undefined): void {
		this.nextColumn = column;
	}

	/** Remove identity before disposing native resources, so their callbacks cannot become a human close. */
	private remove(pair: TerminalEntry): void {
		if (this.entries.get(pair.run) !== pair) {
			return;
		}
		this.entries.delete(pair.run);
		if (this.revealRequested?.pair === pair) { this.revealRequested = undefined; }
		pair.lifetime.abort();
		this.opening = this.opening.filter(each => each.pair !== pair);
		pair.terminal?.dispose();
		pair.pty.dispose();
	}

	dispose(): void {
		clearTimeout(this.copiesTimer);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		for (const pair of this.entries.values()) {
			this.remove(pair);
		}
	}

	async finishRestore(): Promise<void> {
		const owner = this.options.terminalOwner;
		if (!owner) { return; }
		const restored = [...this.entries.values()];
		await this.creation;
		const runs = restored.filter(pair => this.entries.get(pair.run) === pair && pair.terminal).map(pair => pair.run);
		await vscode.commands.executeCommand(WINDOW_TERMINALS_COMMAND, { ...owner, kind: 'retire', runs });
	}

	/** Creates the native tab with the agent's name; later rename events apply once the terminal opens. */
	private createTerminal(pair: TerminalEntry, reveal: boolean): void {
		const { cli, pty } = pair;
		const covered = reveal ? undefined : vscode.window.tabGroups.activeTabGroup.activeTab;
		pair.background = reveal ? undefined : { since: Date.now(), ...covered ? { covered } : {} };
		pair.terminal = vscode.window.createTerminal({
			name: pty.creationName(),
			pty,
			iconPath: cliTerminalIcon(cli),
			// The editor area alone (LIFECYCLE-2.2); never restored by the editor itself after a reload, which reattaches instead
			location: { viewColumn: this.columnFor(pair), preserveFocus: !reveal },
			isTransient: true
		});
		this.opening.push({ pair, at: Date.now() });
	}

	/** The group `pair`'s tab opens in: the one it was in, the last one where that is gone, else the active one (LIFECYCLE-3.5). */
	private columnFor(pair: TerminalEntry): vscode.ViewColumn {
		if (pair.openIn === undefined) {
			return vscode.ViewColumn.Active;
		}
		const columns = vscode.window.tabGroups.all.map(group => group.viewColumn).filter(Number.isFinite);
		return columns.length ? Math.min(pair.openIn, Math.max(...columns)) : vscode.ViewColumn.Active;
	}

	private createQueuedTerminal(pair: TerminalEntry): void {
		const intent = this.revealRequested?.pair === pair ? this.revealRequested : undefined;
		this.createTerminal(pair, !!intent && !intent.preserveFocus);
		if (intent && this.revealRequested === intent && pair.terminal) {
			this.revealRequested = undefined;
			pair.background = undefined;
			pair.terminal.show(intent.preserveFocus);
		}
	}

	/** Serialize our creates and finish only after this host has observed its actual object's public open event. */
	private async createRegistered(pair: TerminalEntry): Promise<void> {
		const owner = this.options.terminalOwner!;
		const current = () => this.entries.get(pair.run) === pair && !pair.lifetime.signal.aborted;
		if (!current()) { return; }
		const request = (value: TerminalRegistration, terminal?: vscode.Terminal) => new Promise<boolean | string | undefined>((resolve, reject) => {
			const timer = setTimeout(() => resolve(undefined), TERMINAL_REGISTRATION_MS);
			const command = terminal === undefined
				? vscode.commands.executeCommand<boolean | string>(WINDOW_TERMINALS_COMMAND, value)
				: vscode.commands.executeCommand<boolean | string>(WINDOW_TERMINALS_COMMAND, value, terminal);
			command.then(result => { clearTimeout(timer); resolve(result); }, err => { clearTimeout(timer); reject(err); });
		});
		let ticket: string | undefined;
		let finished = false;
		let cancelOpen: (() => void) | undefined;
		try {
			let result = await request({ ...owner, kind: 'begin', run: pair.run });
			if (result === false && current()) {
				// A window component that started again - its extension host restarted while this one went on - knows no owner: told
				// this activation's claim again, it registers this activation's terminals from now on (ARCHITECTURE-2.2)
				if (await request({ ...owner, kind: 'activate' }) === true && current()) {
					result = await request({ ...owner, kind: 'begin', run: pair.run });
				}
			}
			if (typeof result === 'string') { ticket = result; }
			if (!current()) { return; }
			if (!ticket) {
				// Unavailable registration never prevents using this host's own terminal, and never guesses an old one.
				this.options.log(`Terminal registration unavailable for ${pair.run}.`);
				this.createQueuedTerminal(pair);
				return;
			}
			const observed = new Set<vscode.Terminal>();
			let resolveOpen!: (opened: boolean) => void;
			const opened = new Promise<boolean>(resolve => { resolveOpen = resolve; });
			const subscription = vscode.window.onDidOpenTerminal(terminal => {
				observed.add(terminal);
				if (terminal === pair.terminal) { resolveOpen(true); }
			});
			const aborted = () => resolveOpen(false);
			const timer = setTimeout(aborted, TERMINAL_REGISTRATION_MS);
			pair.lifetime.signal.addEventListener('abort', aborted, { once: true });
			cancelOpen = () => {
				clearTimeout(timer);
				subscription.dispose();
				pair.lifetime.signal.removeEventListener('abort', aborted);
			};
			this.createQueuedTerminal(pair);
			if (pair.terminal && observed.has(pair.terminal)) { resolveOpen(true); }
			if (!await opened || !current() || !pair.terminal) { return; }
			finished = true;
			const accepted = await request({ ...owner, kind: 'finish', run: pair.run, ticket }, owner.remote ? undefined : pair.terminal);
			if (accepted !== true) { this.options.log(`Terminal registration was ambiguous or superseded for ${pair.run}.`); }
		} catch (error) {
			if (current() && !pair.terminal) { this.createQueuedTerminal(pair); }
			throw error;
		} finally {
			cancelOpen?.();
			// A finish ends the capture whatever it answers: only an unfinished one is cancelled
			if (ticket && !finished) {
				await request({ ...owner, kind: 'cancel', run: pair.run, ticket }).then(undefined,
					err => this.options.log(`Could not cancel terminal registration for ${pair.run}: ${messageOf(err)}`));
			}
		}
	}

	/**
	 * Tabs opened, closed or changed (LIFECYCLE-2.2). A terminal tab that opens is the tab of the one terminal Facade created and
	 * is waiting for one, where exactly one tab and one terminal are; any other number is ambiguous, and nothing is matched.
	 */
	private tabsChanged(event: vscode.TabChangeEvent): void {
		const now = Date.now();
		this.opening = this.opening.filter(each => now - each.at <= OPENING_MS && this.entries.get(each.pair.run) === each.pair);
		// An agent's tab closed while its terminal stays open has moved, where one tab opens to take it (LIFECYCLE-2.2)
		for (const tab of event.closed) {
			const pair = this.pairOfTab(tab);
			if (pair) {
				pair.tab = undefined;
				if (pair.terminal && !pair.hiding) {
					this.movedOut.push({ pair, at: now });
				}
			}
		}
		this.movedOut = this.movedOut.filter(each => now - each.at <= MOVE_MS && this.entries.get(each.pair.run) === each.pair && !!each.pair.terminal && !each.pair.tab);
		const opened = event.opened.filter(tab => tab.input instanceof vscode.TabInputTerminal && !this.pairOfTab(tab));
		if (opened.length === 1 && this.opening.length === 1) {
			const { pair } = this.opening.shift()!;
			this.match(pair, opened[0], 'opened');
			this.uncover(pair, opened[0]);
		} else if (opened.length === 1 && this.movedOut.length === 1 && !this.opening.length) {
			// One moved: the tab that opens is its (LIFECYCLE-2.2)
			const { pair } = this.movedOut.shift()!;
			this.match(pair, opened[0], 'moved');
		} else if (opened.length && this.movedOut.length) {
			// Several moved at once cannot be told apart: each is known again as it becomes active with its terminal, acting on none till then
			this.movedOut = [];
		} else if (opened.length) {
			// Several made behind the person's work at once cannot be told apart, but what they covered still can: shown again
			const active = opened.find(tab => tab.isActive);
			const covered = this.opening[0]?.pair.background?.covered;
			if (active && covered && this.opening.every(each => this.opensBehind(each.pair) && each.pair.background?.covered === covered)) {
				this.uncover(this.opening[0].pair, active);
			}
			this.opening = [];
		}
		if (event.changed.some(tab => tab.isActive) || event.opened.some(tab => tab.isActive)) {
			this.tabActivatedAt = now;
			this.correlate();
		}
		for (const tab of event.changed) {
			const pair = this.pairOfTab(tab);
			if (!pair) { continue; }
			if (pair.wantedPin === undefined && !pair.applyingPin && pair.observedPin !== tab.isPinned) {
				pair.observedPin = tab.isPinned;
				this.options.pinned?.(pair.run, tab.isPinned);
			}
			this.applyPin(pair);
		}
		// A terminal's tab changes as its name does, which the editor has told its terminal by then
		this.observeNames();
	}

	/** VS Code 1.105 can replace every Tab object in a group-model update without a tab-change event. */
	private groupsChanged(): void {
		const present = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
		for (const pair of this.entries.values()) {
			if (pair.tab && !present.has(pair.tab)) { pair.tab = undefined; }
		}
		this.tabActivatedAt = Date.now();
		this.correlate();
		const pair = vscode.window.activeTerminal && this.pairOf(vscode.window.activeTerminal);
		if (pair) { this.applyPin(pair); }
	}

	/**
	 * What each run's tab shows now, read from the run's own terminal - never matched by a title, which can repeat (LIFECYCLE-2.2).
	 * The editor's naming of a tab by the name its terminal was created with is undone. A person's rename of a tab is told, as the
	 * name they gave it; then the tab says the agent's name - its new one where the rename took, else the one it has.
	 */
	observeNames(): void {
		for (const pair of [...this.entries.values()]) {
			const shown = pair.terminal && this.entries.get(pair.run) === pair ? pair.pty.shown(pair.terminal.name) : undefined;
			if (shown === 'reset') {
				pair.pty.sayName();
			} else if (shown) {
				const before = pair.pty.tabName();
				this.options.renamed(pair.run, shown.renamed);
				if (this.entries.get(pair.run) === pair && pair.pty.tabName() === before) {
					pair.pty.sayName();
				}
			}
		}
	}

	/**
	 * Where the active terminal and the active tab changed together, the active tab is the active terminal's: matched where neither
	 * is matched otherwise; a conflict is ambiguous, and nothing changes (LIFECYCLE-2.2). Never by a tab's label.
	 */
	private correlate(): void {
		if (Math.abs(this.terminalActivatedAt - this.tabActivatedAt) > TOGETHER_MS) {
			return;
		}
		const terminal = vscode.window.activeTerminal;
		const pair = terminal && this.pairOf(terminal);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!pair || !tab || !(tab.input instanceof vscode.TabInputTerminal)) {
			return;
		}
		const holder = this.pairOfTab(tab);
		if ((!holder || holder === pair) && (!pair.tab || pair.tab === tab)) {
			const before = pair.activeAt;
			pair.activeAt = Date.now();
			this.match(pair, tab, 'active');
			if (before !== pair.activeAt && pair.tab === tab) {
				this.options.placed?.(pair.run, tab.group?.viewColumn, pair.activeAt);
			}
		}
	}

	/** Whether `pair` was made behind the person's work and is still opening: past that, or once revealed, it is not. */
	private opensBehind(pair: TerminalEntry): boolean {
		if (pair.background && Date.now() - pair.background.since > OPENING_MS) {
			pair.background = undefined;
		}
		return !!pair.background;
	}

	/**
	 * `tab`, the new tab of a terminal made behind the person's work, opened active over the tab they had in front: that one is shown
	 * again, without focus - a file, notebook or custom editor by its resource, another agent's terminal by its pair (LIFECYCLE-2.2).
	 */
	private uncover(pair: TerminalEntry, tab: vscode.Tab): void {
		const covered = pair.background?.covered;
		if (this.entries.get(pair.run) !== pair || !covered || !tab.isActive || !this.opensBehind(pair) || covered === tab) {
			return;
		}
		// Returning to the covered editor before xterm is ready can leave this terminal permanently unopened in VS Code.
		if (!pair.pty.isOpen) {
			void pair.pty.ready.then(opened => { if (opened) { this.uncover(pair, tab); } });
			return;
		}
		pair.background = { since: pair.background!.since };
		if (covered.input instanceof vscode.TabInputTerminal) {
			this.pairOfTab(covered)?.terminal?.show(true);
			return;
		}
		const uri = (covered.input as { readonly uri?: unknown } | undefined)?.uri;
		if (uri && covered.group.tabs.includes(covered)) {
			const options: vscode.TextDocumentShowOptions = { viewColumn: covered.group.viewColumn, preserveFocus: true, preview: covered.isPreview };
			void vscode.commands.executeCommand('vscode.open', uri, options).then(undefined, err => this.options.log(`Could not show the tab ${pair.run}'s terminal covered again: ${messageOf(err)}`));
		}
	}

	private match(pair: TerminalEntry, tab: vscode.Tab, why: Placement): void {
		const placedBefore = pair.tab?.group?.viewColumn;
		pair.tab = tab;
		if (placedBefore !== tab.group?.viewColumn) {
			this.options.placed?.(pair.run, tab.group?.viewColumn, pair.activeAt);
		}
		if (pair.observedPin !== tab.isPinned) {
			const changed = pair.observedPin !== undefined || tab.isPinned;
			pair.observedPin = tab.isPinned;
			if (changed && pair.wantedPin === undefined && !pair.applyingPin) { this.options.pinned?.(pair.run, tab.isPinned); }
		}
		this.applyPin(pair);
		this.oneUnpinned(pair, why);
	}

	private pairOfTab(tab: vscode.Tab): TerminalEntry | undefined {
		for (const pair of this.entries.values()) {
			if (pair.tab === tab) {
				return pair;
			}
		}
		return undefined;
	}

	/** The pair whose terminal `terminal` is, by identity: never by its name (LIFECYCLE-2.2). */
	private pairOf(terminal: vscode.Terminal): TerminalEntry | undefined {
		for (const pair of this.entries.values()) {
			if (pair.terminal === terminal) {
				return pair;
			}
		}
		return undefined;
	}

}
