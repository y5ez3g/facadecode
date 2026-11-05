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
	/**
	 * Opens its tab: in the active group, or in `column`'s where that is given - the last group where it is gone (LIFECYCLE-3.5); `activeAt`,
	 * when it was last active there, and `front`, whether it was its group's front, for its group's front tab after a reload.
	 */
	open(reveal: boolean, column?: number, activeAt?: number, front?: boolean): void;
	/** A reload's pinned tab just opened gets its mark now, in front as it is (LIFECYCLE-3.4). */
	markOpened(): Promise<void>;
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
	/** The folder its agent works in: where a terminal a copy of its tab becomes starts. */
	readonly cwd?: string;
	readonly cli: string;
	readonly pty: AgentPty;
	terminal: vscode.Terminal | undefined;
	opening?: boolean;
	readonly lifetime: AbortController;
	tab?: vscode.Tab;
	observedPin?: boolean;
	wantedPin?: boolean;
	applyingPin?: boolean;
	/** A restored terminal opens behind the editor it covered - a terminal no agent's with its terminal; this is not a human activation. */
	background?: { readonly since: number; readonly covered?: vscode.Tab; readonly coveredTerminal?: vscode.Terminal };
	/** Its tab is closing as Facade hid it: no close of the person's (LIFECYCLE-2.2). */
	hiding?: boolean;
	/** Facade's Pin of its agent, which a group's one unpinned agent tab counts - its mark following (LIFECYCLE-2.2, 3.4). */
	pinned?: boolean;
	/** When its tab was last active, by this host's clock: what a reload into one group goes by (LIFECYCLE-2.2, 3.5). */
	activeAt?: number;
	/** The group its tab is to open in; none, the active one. */
	openIn?: number;
	/** When Facade's Pin of its agent last changed, by this host's clock: a mark changed on its unknown tab after it wins (LIFECYCLE-3.4). */
	pinnedAt?: number;
	/** The group its tab was last told to be in (LIFECYCLE-3.5). */
	placedColumn?: number;
	/** Whether its tab was last told to be its group's front, and whether it was so before the reload that brought it back (LIFECYCLE-3.5). */
	placedFront?: boolean;
	wasFront?: boolean;
	/** What its opening behind the person's work is expected to bring to the front, withdrawn once its tab is known. */
	opensExpected?: () => void;
	/** When the person last showed its tab - a card's click, Go to Agent, its card's Pin or Unpin: a mark then goes on where it is in front. */
	shownAt?: number;
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
	/** Where `run`'s tab is now: open in the group of `column`, its group's front or not, or hidden - what a reload brings back (LIFECYCLE-2.2, 3.5). */
	readonly placed?: (run: RunId, column: number | undefined, activeAt: number | undefined, front: boolean | undefined) => void;
}

/** A group's front as Facade brings it back: its tab, and the terminal it shows where that is a terminal no agent's (LIFECYCLE-3.4). */
interface Front {
	readonly tab: vscode.Tab;
	readonly terminal?: vscode.Terminal;
}

/**
 * What Facade expects in front of the active group from an action of its own, until when: a change to it is Facade's, whenever the
 * editor tells it within that; any other change is the person's (LIFECYCLE-3.4, 3.5).
 */
interface Expected {
	readonly column: number | undefined;
	readonly matches: (tab: vscode.Tab | undefined) => boolean;
	readonly until: number;
}

/** Each group's front as the editor restored it, by view column, and the active group, as a reload's first tab opened (LIFECYCLE-3.5). */
interface Capture {
	readonly at: number;
	/** How often the person had brought something to the front by then: a later move of theirs is newer than the capture. */
	readonly moves: number;
	readonly active: number | undefined;
	readonly fronts: ReadonlyMap<number, Front>;
}

/** Active-terminal and active-tab changes within this interval identify one change (LIFECYCLE-2.2). */
const TOGETHER_MS = 250;
/** A terminal created by Facade may be correlated with an opening tab for this long. */
const OPENING_MS = 2_000;
/** The editor's commands that focus its first to eighth group, by view column: a group made the active one (LIFECYCLE-2.2, 3.4). */
const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(nth => `workbench.action.focus${nth}EditorGroup`);
/** The editor's commands that focus the group after and before the active one: a group past the eighth is reached step by step. */
const FOCUS_NEXT_GROUP = 'workbench.action.focusNextGroup';
const FOCUS_PREVIOUS_GROUP = 'workbench.action.focusPreviousGroup';
/** How long what Facade expects in front from an action of its own is waited for: a change to it within this is Facade's (LIFECYCLE-3.4, 3.5). */
const EXPECT_MS = 3_000;
/** How long after an opening tab is known its front still counts as Facade's: the editor tells of it in more than one event. */
const OPENED_MS = 500;
/** How long after the person showed an agent's tab a mark goes on where that tab comes to the front, never by borrowing the focus. */
const SHOWN_MARK_MS = 3_000;
/** A tab of an agent closed while its terminal stays open is that tab moved where one tab opens within this (LIFECYCLE-2.2). */
const MOVE_MS = 1_000;

/** A copy's tab opens within this of its terminal, and is told apart from other tabs by it (LIFECYCLE-2.2). */
const COPIES_MS = 100;

/** Owns native terminal resources, tab identity, names and focus; it never starts or ends a CLI process. */
export class AgentTerminals implements vscode.Disposable {
	private readonly entries = new Map<RunId, TerminalEntry>();
	private opening: { readonly pair: TerminalEntry; readonly at: number }[] = [];
	/** Agents' tabs closed with their terminals still open: moved, where one tab opens to take each (LIFECYCLE-2.2). */
	private movedOut: { readonly pair: TerminalEntry; readonly at: number }[] = [];
	/** Agents' tabs behind the person's work waiting for their mark to follow their Pin, and whether one is being marked. */
	private marks: TerminalEntry[] = [];
	private marking = false;
	/** While a reload's tabs open, their marks wait: each would take the front tab a mark goes on (finishRestore). */
	private restoring = true;
	private restoringTimer: ReturnType<typeof setTimeout> | undefined;
	/** A mark's command is under way: a mark changing meanwhile is Facade's, never taken for the person's. */
	private markingCommand = false;
	/** Tabs not known yet whose mark a mark's command changed: undone once known, never taken for the person's. */
	private readonly wrongMarks = new WeakSet<vscode.Tab>();
	/** Marks that failed one after another for an agent's tab: tried again once its tab is known anew, after two. */
	private readonly markFailures = new Map<TerminalEntry, number>();
	/** Each group's front as the editor restored it, taken as a reload's first tab began to open: in front again at its end (LIFECYCLE-3.5). */
	private capture: Capture | undefined;
	/** The groups a reload's coming agents were the fronts of: their tabs open last, and nothing else need be in front there meanwhile. */
	private recordedFronts: ReadonlySet<number> = new Set();
	/** What Facade's own actions are to bring to the front, and how many marks hold a tab in front now (LIFECYCLE-3.4). */
	private expected: Expected[] = [];
	private borrowing = 0;
	/** This window's terminals are gone: no mark goes on, and one under way does nothing more. */
	private disposed = false;
	/** Marks go on one at a time, whoever asks - the queue's and a reload's tab just opened alike (LIFECYCLE-3.4). */
	private markLane: Promise<void> = Promise.resolve();
	/**
	 * How often the person has brought something to the front, the groups they did since a reload's capture and what they brought to the
	 * front there last, the group they did so in last, and what was in front last.
	 */
	private personMoves = 0;
	private readonly personColumns = new Set<number>();
	private readonly personFronts = new Map<number, vscode.Tab>();
	private personLast: number | undefined;
	private seenFront: { readonly column?: number; readonly tab?: vscode.Tab } = {};
	/** Copies of agents' tabs the editor made, each becoming an ordinary terminal: their tabs told apart as they become active (LIFECYCLE-2.2). */
	private copies: vscode.Terminal[] = [];
	/** When each copy's terminal opened, and its tab, as it became active with that terminal (LIFECYCLE-2.2). */
	private readonly copyAt = new Map<vscode.Terminal, number>();
	private readonly copyTabs = new Map<vscode.Terminal, vscode.Tab>();
	/** Terminal tabs no agent's that opened lately: where a copy's tab became active with no terminal, the one that opened with it. */
	private strayOpened: { readonly tab: vscode.Tab; readonly at: number }[] = [];
	/** Terminal tabs Facade cannot tell: the mark each showed last, and when it changed - a person's pin or unpin there (LIFECYCLE-3.4). */
	private readonly strayMarks = new WeakMap<vscode.Tab, { readonly pinned: boolean; readonly changedAt?: number }>();
	private terminalActivatedAt = -Infinity;
	private tabActivatedAt = -Infinity;
	private readonly disposables: vscode.Disposable[] = [];
	private creation = Promise.resolve();
	private revealRequested?: { readonly pair: TerminalEntry; readonly preserveFocus: boolean };
	/** The system's reduced-motion preference as the panel's page said it last; none until it has (LIFECYCLE-2.2). */
	private systemReduced: boolean | undefined;

	constructor(private readonly options: TerminalOptions) {
		// What is in front as this window's terminals begin, seen already: the first change after it is the first that tells anything
		const group = vscode.window.tabGroups.activeTabGroup;
		this.seenFront = { column: group?.viewColumn, tab: group?.activeTab };
		// A restore that never says it finished holds no mark for longer than this
		this.restoringTimer = setTimeout(() => { this.restoring = false; this.markQueue(); }, 60_000);
		this.disposables.push(
			// A new theme's colours, as the terminals open report them again
			vscode.window.onDidChangeActiveColorTheme(() => { for (const entry of this.entries.values()) { entry.pty.askColours(); } }),
			vscode.workspace.onDidChangeConfiguration(change => {
				if (change.affectsConfiguration('workbench.reduceMotion')) { this.moved(); }
			}),
			vscode.window.onDidChangeActiveTerminal(terminal => {
				this.terminalActivatedAt = Date.now();
				this.noteFront();
				this.correlate();
				const pair = terminal && this.pairOf(terminal);
				if (pair) { this.applyPin(pair); }
				// A terminal made behind the person's work, becoming active as it opens, moves no selection (PANEL-2.1)
				if (!pair || !this.opensBehind(pair)) {
					this.options.activated(pair?.run);
				}
				this.noteFront();
			}),
			vscode.window.tabGroups.onDidChangeTabs(event => this.tabsChanged(event)),
			vscode.window.onDidOpenTerminal(terminal => this.maybeCopy(terminal)),
			vscode.window.tabGroups.onDidChangeTabGroups(event => this.groupsChanged(event)),
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
					this.place(pair, undefined);
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
	 * The groups a reload's coming agents were the fronts of, as their records say: each where its tab opens - the last group where its
	 * own is gone, as a floating window's is, which the editor opens again only after Facade's tabs (columnFor; LIFECYCLE-3.5).
	 */
	frontsRecorded(columns: readonly number[]): void {
		this.recordedFronts = new Set(columns.map(column => this.openingColumn(column) ?? column));
	}

	/** Facade's Pin of `run` changed: its tab's mark follows at once, in front or not (LIFECYCLE-3.4). */
	pin(run: RunId, pinned: boolean): void {
		const pair = this.entries.get(run);
		if (pair) {
			pair.pinned = pinned;
			pair.pinnedAt = Date.now();
			pair.wantedPin = pinned;
			// A Pin or Unpin asked anew is tried anew, whatever came of the marks before it; its tab shows it at once, in front or not
			this.markFailures.delete(pair);
			this.applyPin(pair);
		}
	}

	/**
	 * Puts `pair`'s tab's mark where its Pin wants it though the tab is behind the person's work, by making it its group's front tab,
	 * pinning or unpinning it there and bringing back what was in front, one tab at a time: the editor's pin acts on the active group's
	 * front tab alone. No tab of Facade's opens meanwhile, as one would take the front.
	 */
	private markNow(pair: TerminalEntry): void {
		if (!this.marks.includes(pair)) {
			this.marks.push(pair);
		}
		this.markQueue();
	}

	private markQueue(): void {
		if (this.marking || this.restoring || this.disposed || !this.marks.length) {
			return;
		}
		this.marking = true;
		void this.markQueued().catch(err => this.options.log(`Could not mark a tab: ${messageOf(err)}`)).finally(() => {
			this.marking = false;
			this.markQueue();
		});
	}

	/**
	 * After a reload, each group's front again as it was: the agent tab recorded as its front where that agent came back, else what the
	 * editor restored in front before Facade opened a tab, else the agent tab last active there - the other groups without the focus,
	 * then the active one with it. A group the person brought something to the front in since, and the active one where they did so
	 * anywhere, keeps theirs (LIFECYCLE-3.5). The runs' fronts are told as they are then.
	 */
	private async restoreFronts(): Promise<void> {
		const capture = this.capture;
		this.capture = undefined;
		const missed = new Set<number>();
		try {
			if (!capture) {
				return;
			}
			const theirs = (column?: number) => this.personMoves > capture.moves && (column === undefined || this.personColumns.has(column));
			for (const column of vscode.window.tabGroups.all.map(group => group.viewColumn).filter(each => each !== capture.active)) {
				// One the person brought something to the front in since keeps theirs: what they last brought there, in front again though a
				// later tab of the reload's opened over it
				if (theirs(column)) {
					await this.backToTheirs(column);
					continue;
				}
				const front = this.frontAfterReload(column, capture);
				// One an extension cannot show without its group's focus - a webview, Settings, a terminal of the person's it cannot tell -
				// stays behind, its group's front not saved as the agent's over it
				if (front && !await this.refront(front, false, false)) {
					missed.add(column);
				}
			}
			if (capture.active !== undefined && !theirs()) {
				const front = this.frontAfterReload(capture.active, capture);
				if (front && !(await this.focusColumn(capture.active) && await this.refront(front, true))) {
					missed.add(capture.active);
				} else if (front) {
					// In front already, the tabs that opened over it may have left the focus nowhere: it is there again
					await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => undefined);
				}
			} else if (theirs()) {
				// The active group's too, where the person brought something to the front in it
				if (capture.active !== undefined && theirs(capture.active)) {
					await this.backToTheirs(capture.active);
				}
				// The group the person last brought something to the front in is the active one again, its front theirs: a later tab of the
				// reload's made its own group the active one as it opened there
				if (this.personLast !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn !== this.personLast) {
					await this.activateColumn(this.personLast);
				}
			}
		} finally {
			this.personColumns.clear();
			this.personFronts.clear();
			this.recordedFronts = new Set();
			this.syncFronts(missed);
		}
	}

	/**
	 * `column`'s group the active one again, its front untouched and the keyboard's focus left where the person has it - the Explorer, the
	 * panel - where the editor allows: a file in front by showing it again without the focus, which makes its group the active one, as the
	 * probe saw; a front of another kind by its group's focus command, which takes the focus there.
	 */
	private async activateColumn(column: number): Promise<boolean> {
		const front = vscode.window.tabGroups.all.find(group => group.viewColumn === column)?.activeTab;
		if (front?.input instanceof vscode.TabInputText) {
			const withdraw = this.expect(column, tab => sameTab(tab, front));
			try {
				await vscode.commands.executeCommand('vscode.open', front.input.uri, { viewColumn: column, preserveFocus: true, preview: front.isPreview }).then(undefined, () => undefined);
				if (await this.settle(() => vscode.window.tabGroups.activeTabGroup.viewColumn === column, 500)) {
					return true;
				}
			} finally {
				withdraw();
			}
		}
		return this.focusColumn(column);
	}

	/**
	 * What the person last brought to the front of `column`'s group since a reload's capture, in front there again without the focus - a
	 * later tab of the reload's may have opened over it, there or as they were in another group (LIFECYCLE-3.5).
	 */
	private async backToTheirs(column: number): Promise<void> {
		const tab = this.personFronts.get(column);
		const now = tab && this.currentTab(tab);
		if (!now || now.isActive || now.group?.viewColumn !== column) {
			return;
		}
		const pair = this.pairOfTab(now);
		await this.refront({ tab: now, ...pair?.terminal ? { terminal: pair.terminal } : {} }, false, false);
	}

	/** What is to be in front of `column`'s group after a reload (restoreFronts). */
	private frontAfterReload(column: number, capture: Capture): Front | undefined {
		const agents = [...this.entries.values()].filter(pair => pair.terminal && pair.tab && !pair.hiding && pair.tab.group?.viewColumn === column)
			.sort((a, b) => (b.activeAt ?? -Infinity) - (a.activeAt ?? -Infinity));
		const recorded = agents.find(pair => pair.wasFront);
		if (recorded?.tab) {
			return { tab: recorded.tab };
		}
		return capture.fronts.get(column) ?? (agents[0]?.tab ? { tab: agents[0].tab } : undefined);
	}

	/** Once no tab of Facade's is opening, for ten seconds at most: one opening would take the front tab a mark goes on. */
	private async quiet(): Promise<void> {
		const end = Date.now() + 10_000;
		for (;;) {
			const chain = this.creation;
			await chain;
			const now = Date.now();
			// A tab opening, or one opened over the person's work that has not shown that again yet (uncover)
			const opening = this.opening.some(each => now - each.at <= OPENING_MS)
				|| [...this.entries.values()].some(each => each.opening || (each.background?.covered !== undefined && now - each.background.since <= OPENING_MS));
			if ((chain === this.creation && !opening) || now > end) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}

	private async markQueued(): Promise<void> {
		for (let pair = this.marks.shift(); pair; pair = this.marks.shift()) {
			await this.quiet();
			const next = pair;
			await this.inLane(() => this.markOne(next, false));
		}
	}

	/** `mark` once the marks before it are done, whoever asked for them (LIFECYCLE-3.4). */
	private inLane(mark: () => Promise<void>): Promise<void> {
		const turn = this.markLane.then(mark, mark);
		this.markLane = turn.then(() => undefined, () => undefined);
		return turn;
	}

	/** Whether `test` holds within `ms`; never, once this window's terminals are gone - a mark under way then stops where it is. */
	private async settle(test: () => boolean, ms = 1_000): Promise<boolean> {
		for (let waited = 0; !this.disposed && !test() && waited < ms; waited += 25) {
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		return !this.disposed && test();
	}

	/** A reload's pinned tab just opened, in front in its group: its mark goes on now, the reload's next tab waiting for it. */
	private async markOpened(pair: TerminalEntry): Promise<void> {
		// Its tab as this host knows it, which the editor tells as it opens
		await this.settle(() => !!pair.tab || this.entries.get(pair.run) !== pair, 2_000);
		await this.inLane(() => this.markOne(pair, true)).catch(err => this.options.log(`Could not mark ${pair.run}'s tab: ${messageOf(err)}`));
	}

	/**
	 * Puts `pair`'s tab's mark where its Pin wants it (LIFECYCLE-3.4). In front of the active group the editor marks it as it is,
	 * nothing of the person's taken. Else Facade brings it to the front - its group made the active one, step by step past the
	 * eighth - the person's keys reaching its terminal meanwhile not its CLI's, marks it, and gives back its group's front, the person's
	 * group with the focus and its front, and the focus to the panel where its card asked. The person bringing something else to the
	 * front meanwhile keeps theirs: nothing is given back over it. A reload's pinned tab just `opened`, in front of its group as it is,
	 * gives back a file or other editor the person had in front of the active group as the reload began, where no agent was that
	 * group's front; its own group's front comes back with the reload's others at its end (3.5).
	 */
	private async markOne(pair: TerminalEntry, opened: boolean): Promise<void> {
		const wanted = pair.wantedPin;
		if (this.disposed || this.entries.get(pair.run) !== pair || !pair.terminal || !pair.tab || wanted === undefined || pair.tab.isPinned === wanted || pair.applyingPin) {
			return;
		}
		// A mark that did not go on is tried again only once its tab is known anew, its Pin or Unpin is asked again, or the person brings
		// its tab to the front, where it goes on as it is: never in a loop (LIFECYCLE-3.4)
		if (this.markFailures.has(pair)) {
			return;
		}
		const groups = vscode.window.tabGroups;
		const capture = opened ? this.capture : undefined;
		// At a reload, what goes back in front is a file or other editor of the person's in the active group - no agent being recorded as
		// its front, which opens last and is in front then - and nothing once the person has gone elsewhere (LIFECYCLE-3.5)
		const reloadFront = capture && capture.active !== undefined && this.personMoves === capture.moves && !this.recordedFronts.has(capture.active)
			? capture.fronts.get(capture.active) : undefined;
		const beforeColumn = capture ? (this.personMoves === capture.moves ? capture.active : undefined) : groups.activeTabGroup.viewColumn;
		const before = capture ? reloadFront : this.frontOf(groups.activeTabGroup);
		// A reload's tab just opened: in front of its group, which the editor makes the active one a moment after
		if (opened) {
			await this.settle(() => this.inFront(pair), 500);
		}
		// The person showed its tab a moment ago - its card's Pin or Unpin does: marked where it comes to the front, never by borrowing the
		// focus, which went to it with the person's showing (LIFECYCLE-3.4)
		if (Date.now() - (pair.shownAt ?? -Infinity) < SHOWN_MARK_MS && !this.inFront(pair) && !await this.settle(() => this.inFront(pair), 2_000)) {
			this.failedMark(pair, 'did not come to the front as the person showed it');
			return;
		}
		if (this.inFront(pair)) {
			// Marked where it is: the focus stays where the person has it
			await this.applyMark(pair, wanted);
			// A reload's tab opened over what the person had in front: that is in front again (3.5)
			if (capture && before && before.tab !== pair.tab) {
				await this.giveBack(pair, undefined, before, beforeColumn);
			}
			return;
		}
		const terminal = pair.terminal;
		const column = pair.tab.group?.viewColumn;
		const elsewhere = column !== groups.activeTabGroup.viewColumn;
		const ownFront = elsewhere && !capture && pair.tab.group ? this.frontOf(pair.tab.group) : undefined;
		const moves = this.personMoves;
		// The person's keys reaching any agent's terminal while Facade holds the focus are not its CLI's (LIFECYCLE-2.2, 3.4)
		this.borrow(true);
		// Shown in its group, which the editor may make the active one
		const shown = this.expect(column, tab => this.isPairTab(tab, pair));
		try {
			terminal.show(true);
			if (elsewhere && (column === undefined || !await this.focusColumn(column))) {
				// A group no focus command reaches - a floating window's: its tab takes its mark as it next comes to the front
				this.failedMark(pair, `did not come to the front: its group ${column ?? 'unknown'} is not one the editor's focus commands reach`);
				return;
			}
			if (!this.inFront(pair) && !await this.settle(() => this.inFront(pair))) {
				const active = groups.activeTabGroup.activeTab;
				this.failedMark(pair, `did not come to the front: in front ${active?.label ?? 'nothing'} in group ${groups.activeTabGroup.viewColumn}, the active terminal ${vscode.window.activeTerminal?.name ?? 'none'}`);
				return;
			}
			await this.applyMark(pair, wanted);
		} finally {
			try {
				// The person brought another tab to the front meanwhile, the mark on or not: theirs stands, nothing given back over it
				if (this.personMoves === moves) {
					await this.giveBack(pair, ownFront, before, beforeColumn);
				}
			} finally {
				shown();
				this.borrow(false);
			}
		}
	}

	/**
	 * The editor's pin or unpin of the active group's front tab, `pair`'s: checked, and a mark it changed on another tab undone - on a
	 * tab not known yet, once it is - never taken for the person's (LIFECYCLE-3.4).
	 */
	private async applyMark(pair: TerminalEntry, wanted: boolean): Promise<void> {
		const others = [...this.entries.values()].filter(each => each !== pair && each.tab).map(each => ({ pair: each, tab: each.tab!, pinned: each.tab!.isPinned }));
		const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
		const unknown = tabs.filter(each => each.input instanceof vscode.TabInputTerminal && !this.pairOfTab(each)).map(each => ({ tab: each, pinned: each.isPinned }));
		// The person's files and other editors too: one the command reached instead, the person having brought it to the front meanwhile
		const editors = tabs.filter(each => !(each.input instanceof vscode.TabInputTerminal)).map(each => ({ tab: each, pinned: each.isPinned }));
		// The editor's command acts on what is in front as it runs: on this tab alone
		if (vscode.window.tabGroups.activeTabGroup.activeTab !== pair.tab) {
			this.failedMark(pair, 'was not in front as its mark was to go on');
			return;
		}
		pair.applyingPin = true;
		this.markingCommand = true;
		try {
			await vscode.commands.executeCommand(wanted ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor');
			// The editor tells its tabs' change in its own time
			await this.settle(() => pair.tab?.isPinned === wanted, 500);
			await new Promise(resolve => setTimeout(resolve, 50));
		} finally {
			pair.applyingPin = false;
			this.markingCommand = false;
		}
		if (pair.tab?.isPinned === wanted) {
			// Taken: a later one that fails starts its count anew
			this.markFailures.delete(pair);
			pair.observedPin = wanted;
			if (pair.wantedPin === wanted) { pair.wantedPin = undefined; }
			// A Pin or Unpin asked while its command went on, which waited for it: its mark follows now
			if (pair.wantedPin !== undefined && pair.tab.isPinned !== pair.wantedPin) {
				this.markNow(pair);
			}
		} else {
			this.failedMark(pair, `did not take its ${wanted ? 'mark' : 'unmark'}`);
		}
		for (const other of editors) {
			const now = this.currentTab(other.tab);
			if (now && now.isPinned !== other.pinned && vscode.window.tabGroups.activeTabGroup.activeTab === now) {
				this.options.log(`The ${wanted ? 'mark' : 'unmark'} meant for ${pair.run} changed ${now.label}, which is undone`);
				this.markingCommand = true;
				try {
					await vscode.commands.executeCommand(other.pinned ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor').then(undefined, () => undefined);
				} finally {
					this.markingCommand = false;
				}
			}
		}
		for (const other of others) {
			if (other.pair.tab === other.tab && other.tab.isPinned !== other.pinned) {
				this.options.log(`The ${wanted ? 'mark' : 'unmark'} meant for ${pair.run} changed ${other.pair.run}'s tab, which is undone`);
				other.pair.wantedPin = other.pinned;
				this.markNow(other.pair);
			}
		}
		for (const other of unknown) {
			if (other.tab.isPinned !== other.pinned && !this.pairOfTab(other.tab)) {
				this.options.log(`The ${wanted ? 'mark' : 'unmark'} meant for ${pair.run} changed a tab not known yet, undone once it is`);
				this.wrongMarks.add(other.tab);
			}
		}
	}

	/** A mark that did not go on: tried again only once its tab is known anew, its Pin or Unpin asked again, or it is brought to the front. */
	private failedMark(pair: TerminalEntry, why: string): void {
		this.markFailures.set(pair, (this.markFailures.get(pair) ?? 0) + 1);
		this.options.log(`${pair.run}'s tab ${why}; its mark waits for its next showing`);
	}

	/** Facade holds the focus for a mark, or no longer: while it does, the person's keys reach no agent's CLI (LIFECYCLE-2.2, 3.4). */
	private borrow(on: boolean): void {
		this.borrowing = Math.max(0, this.borrowing + (on ? 1 : -1));
		for (const pair of this.entries.values()) {
			pair.pty.muteInput(this.borrowing > 0);
		}
	}

	/** Whether `tab` is `pair`'s, the one it is known by (LIFECYCLE-2.2). */
	private isPairTab(tab: vscode.Tab | undefined, pair: TerminalEntry): boolean {
		return !!tab && this.pairOfTab(tab) === pair;
	}

	/**
	 * Whether `pair`'s tab is the active group's front, as the editor has it now. A terminal tab Facade does not know is its tab only
	 * where its own is gone - the editor rebuilt its tabs as new objects - and its terminal is the active one; never while its own is
	 * there, as the editor sets the active terminal before it shows that terminal's tab (LIFECYCLE-2.2).
	 */
	private inFront(pair: TerminalEntry): boolean {
		const active = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!active || !(active.input instanceof vscode.TabInputTerminal)) {
			return false;
		}
		const holder = this.pairOfTab(active);
		if (holder) {
			return holder === pair;
		}
		// Its own tab still there: the active terminal alone, which the editor sets before it shows a tab, tells nothing of the one in front
		const own = pair.tab !== undefined && vscode.window.tabGroups.all.some(group => group.tabs.includes(pair.tab!));
		if (own || vscode.window.activeTerminal !== pair.terminal) {
			return false;
		}
		this.match(pair, active);
		return true;
	}

	/** `group`'s front as Facade can bring it back: a terminal no agent's with its terminal, which the active group's is. */
	private frontOf(group: vscode.TabGroup): Front | undefined {
		const tab = group.activeTab;
		if (!tab) {
			return undefined;
		}
		const terminal = tab.input instanceof vscode.TabInputTerminal && !this.pairOfTab(tab) && group.isActive
			? vscode.window.activeTerminal : undefined;
		return { tab, ...terminal && !this.pairOf(terminal) ? { terminal } : {} };
	}

	/**
	 * What a mark took the front from, given back: `ownFront`, its tab's group's front, without the focus; the person's group, `column`,
	 * active again with the focus and `before` in front; the focus to the panel where its card asked (LIFECYCLE-3.4).
	 */
	private async giveBack(pair: TerminalEntry, ownFront: Front | undefined, before: Front | undefined, column: number | undefined): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (ownFront && this.pairOfTab(ownFront.tab) !== pair) {
			await this.refront(ownFront, false);
		}
		// From its card: the person is at the panel, which takes the focus back at once - their group comes back without it, so that no key
		// typed meanwhile falls into the front they left there
		if (column !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn !== column) {
			await this.focusColumn(column);
		}
		if (before) {
			await this.refront(before, true);
		}
	}

	/**
	 * `tab` as the editor has it now: the same object, else - the editor may give its groups and tabs new ones - the tab of the same
	 * column and kind, with the same resource or, without one, the same label.
	 */
	private currentTab(tab: vscode.Tab): vscode.Tab | undefined {
		const groups = vscode.window.tabGroups.all;
		if (groups.some(group => group.tabs.includes(tab))) {
			return tab;
		}
		const uriOf = (each: vscode.Tab) => resourcesOf(each.input).join('\n') || undefined;
		const group = groups.find(each => each.viewColumn === tab.group?.viewColumn);
		// Its own group lists it still, where the editor tells no group of that number
		if (!group && tab.group?.tabs?.includes(tab)) {
			return tab;
		}
		return group?.tabs.find(each => (each.input as object | undefined)?.constructor === (tab.input as object | undefined)?.constructor
			&& (uriOf(tab) !== undefined ? uriOf(each) === uriOf(tab) : each.label === tab.label));
	}

	/**
	 * Makes `column`'s group the active one with the focus, as the editor's focus commands do: the first to eighth by their own, one
	 * past them from the eighth by the next group's, each step checked - no command where no such group is, as one would make it
	 * (LIFECYCLE-2.2, 3.4). Facade's own unless the person's `own` says otherwise; whether that group is the active one after.
	 */
	private async focusColumn(column: number, own = true, stepping = true): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const at = () => vscode.window.tabGroups.activeTabGroup.viewColumn;
		const columns = vscode.window.tabGroups.all.map(group => group.viewColumn);
		if (at() === column) {
			return true;
		}
		if (!columns.includes(column)) {
			return false;
		}
		/** One command, Facade's wherever it lands; whether it landed on `landing`, the group it was meant to reach. */
		const step = async (command: string, landing: number) => {
			if (this.disposed) {
				return false;
			}
			// What the group it is to land on shows in front is Facade's while the step goes on; a change to any other group is the person's,
			// in doubt theirs, and nothing is given back over it
			const withdraw = own ? [this.expect(landing, () => true)] : [];
			const from = at();
			const had = new Set(vscode.window.tabGroups.all);
			await vscode.commands.executeCommand(command).then(undefined, () => undefined);
			await this.settle(() => at() !== from, 1_000);
			withdraw.forEach(each => each());
			// A focus command made a group where the main window has fewer than its number - a floating window's group is the one numbered:
			// that one new, empty group goes again, whatever the others are numbered now
			const made = vscode.window.tabGroups.all.find(group => !had.has(group) && group.tabs.length === 0);
			if (vscode.window.tabGroups.all.length > had.size && made && typeof vscode.window.tabGroups.close === 'function') {
				this.options.log(`${command} made an editor group of its own, which is closed again`);
				await vscode.window.tabGroups.close(made, true).then(undefined, () => undefined);
				return false;
			}
			return at() === landing;
		};
		const first = Math.min(column, GROUP_FOCUS.length);
		if (!await step(GROUP_FOCUS[first - 1], first) || !stepping) {
			return at() === column;
		}
		// Past the eighth: on from there one group at a time, each step to the next group over - one landing elsewhere, as at a floating
		// window's group, which no focus command reaches, ends the steps there, the group not reached
		while (at() !== undefined && at() !== column) {
			const next = at()! < column;
			if (!await step(next ? FOCUS_NEXT_GROUP : FOCUS_PREVIOUS_GROUP, at()! + (next ? 1 : -1))) {
				break;
			}
		}
		return at() === column;
	}

	/**
	 * Brings `front` back in front of its group (LIFECYCLE-3.4, 3.5). In the active group with the focus, by its place among the group's
	 * tabs, the editor's own commands, which bring any kind back and its focus with it; else as the editor shows its kind again - a
	 * terminal by its terminal, a file by `vscode.open`, a text or notebook diff by `vscode.diff`, a notebook or custom editor by
	 * `vscode.openWith` - and, where that fails in the active group, by its place. One the editor opened instead of it, of the same
	 * resource but another kind, is closed again; a group made active by bringing a front back without the focus is the person's no
	 * longer, theirs active again - but where `keepActive` is false, as at a reload's end, which makes the person's group the active one
	 * itself and moves the keyboard's focus once at most, last: a focus command here would move it, and a later step that makes another
	 * group active without the focus would leave it there, with an agent's CLI perhaps (restoreFronts). Whether it is in front after.
	 */
	private async refront(front: Front, focus: boolean, keepActive = true): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const activeBefore = vscode.window.tabGroups.activeTabGroup.viewColumn;
		// An agent's tab by its terminal, as it is now
		const pair = this.pairOfTab(front.tab);
		if (pair?.terminal) {
			// In front already, and without the focus asked for: showing it again would only leave the focus nowhere
			if (!focus && pair.tab?.isActive) {
				return true;
			}
			// Shown in its group, which the editor may make the active one, with the focus or without
			const withdraw = this.expect(pair.tab?.group?.viewColumn, tab => this.isPairTab(tab, pair));
			pair.terminal.show(!focus);
			const back = await this.settle(() => !!pair.tab?.isActive && (!focus || vscode.window.tabGroups.activeTabGroup.viewColumn === pair.tab.group?.viewColumn), 500);
			withdraw();
			return back;
		}
		const tab = this.currentTab(front.tab);
		const column = tab?.group?.viewColumn;
		// No group of its number now: a command would make one
		const columns = vscode.window.tabGroups.all.map(group => group.viewColumn).filter(Number.isFinite);
		if (!tab || column === undefined || (columns.length && !columns.includes(column))) {
			return false;
		}
		const inFront = () => !!this.currentTab(tab)?.isActive && (!focus || vscode.window.tabGroups.activeTabGroup.viewColumn === column);
		if (inFront()) {
			return true;
		}
		const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args).then(() => true, err => {
			this.options.log(`Could not bring back ${tab.label} in front: ${messageOf(err)}`);
			return false;
		});
		const active = () => vscode.window.tabGroups.activeTabGroup.viewColumn === column;
		// By its place among the active group's tabs, whatever its kind: the editor's own commands, which take the focus there
		const byPlace = async () => {
			const now = this.currentTab(tab);
			const tabs = now ? now.group.tabs : [];
			const index = now ? tabs.indexOf(now) : -1;
			if (index >= 0 && index < 9) {
				await run(`workbench.action.openEditorAtIndex${index + 1}`);
			} else if (index >= 0 && index === tabs.length - 1) {
				await run('workbench.action.lastEditorInGroup');
			} else {
				return false;
			}
			return this.settle(inFront, 500);
		};
		// Shown in its group, which the editor makes the active one, with the focus or without; expected so until it ends
		const withdraw = this.expect(column, each => sameTab(each, tab));
		try {
			if (focus && active() && await byPlace()) {
				return true;
			}
			const groupOf = () => vscode.window.tabGroups.all.find(group => group.viewColumn === column);
			const had = new Set(groupOf()?.tabs ?? []);
			const input = tab.input;
			const options: vscode.TextDocumentShowOptions = { viewColumn: column, preserveFocus: !focus, preview: tab.isPreview };
			let shown = true;
			if (input instanceof vscode.TabInputTerminal) {
				const terminal = this.pairOfTab(tab)?.terminal ?? front.terminal;
				terminal?.show(!focus);
				shown = !!terminal;
			} else if (input instanceof vscode.TabInputText) {
				await run('vscode.open', input.uri, options);
			} else if (isInput(input, vscode.TabInputTextDiff) || isInput(input, vscode.TabInputNotebookDiff)) {
				await run('vscode.diff', input.original, input.modified, tab.label, options);
			} else if (isInput(input, vscode.TabInputNotebook)) {
				await run('vscode.openWith', input.uri, input.notebookType, options);
			} else if (isInput(input, vscode.TabInputCustom)) {
				await run('vscode.openWith', input.uri, input.viewType, options);
			} else if ((input as { readonly uri?: unknown } | undefined)?.uri !== undefined) {
				// A kind this build does not know that names its resource
				await run('vscode.open', (input as { readonly uri: unknown }).uri, options);
			} else {
				// A webview or Settings: no command shows it again by a resource, and none is waited for
				shown = false;
			}
			let back = shown && await this.settle(inFront, 500);
			// One the command opened instead of it, of the same resource but another kind, is Facade's mistake: closed again - only a tab that
			// was not there before, where the editor gave no others new objects meanwhile, and never one with unsaved changes
			const group = groupOf();
			const wanted = resourcesOf(input);
			const added = group ? group.tabs.filter(each => !had.has(each)) : [];
			const strays = !back && group && wanted.length && added.length === group.tabs.length - had.size
				? added.filter(each => !this.pairOfTab(each) && !each.isDirty && resourcesOf(each.input).some(resource => wanted.includes(resource))) : [];
			if (strays.length && typeof vscode.window.tabGroups.close === 'function') {
				this.options.log(`${tab.label} came back as another kind of editor, which is closed again`);
				await vscode.window.tabGroups.close(strays, true).then(undefined, () => undefined);
			}
			if (!back && active()) {
				back = await byPlace();
			}
			// Shown without the focus, its group may have become the active one while the focus stayed where the person has it: theirs is
			// the active one again, as the person's next command acts on the active group
			if (keepActive && !focus && activeBefore !== undefined && activeBefore !== column && vscode.window.tabGroups.activeTabGroup.viewColumn === column) {
				await this.focusColumn(activeBefore);
			}
			if (!back) {
				this.options.log(`${tab.label} could not be brought back in front of group ${column}`);
			}
			return back;
		} finally {
			withdraw();
		}
	}

	/**
	 * What Facade's own next step is to bring to the front of `column`'s group - any group's where none is said - should that be or become
	 * the active one: a change to it is Facade's while that step goes on. Expectations add up, each withdrawn as its action ends, three
	 * seconds at most.
	 */
	private expect(column: number | undefined, matches: (tab: vscode.Tab | undefined) => boolean): () => void {
		const now = Date.now();
		const entry: Expected = { column, matches, until: now + EXPECT_MS };
		this.expected = [...this.expected.filter(each => each.until > now), entry];
		// Its action over, what it did not bring to the active group's front is expected no more
		return () => { this.expected = this.expected.filter(each => each !== entry); };
	}

	/**
	 * Whether `tab` in front of `column`'s group, the active one, is what one of Facade's own actions under way brings there. Each
	 * expectation stands until its action ends, as the editor tells one change of the front in more than one event - the group first,
	 * its front tab after - and the person's bringing the same tab to the front after it is theirs.
	 */
	private expectedFront(column: number | undefined, tab: vscode.Tab | undefined): boolean {
		const now = Date.now();
		this.expected = this.expected.filter(each => each.until > now);
		return this.expected.some(each => (each.column === undefined || each.column === column) && each.matches(tab));
	}

	/**
	 * What is in front changed: the person's doing where Facade did nothing a moment before - a newer choice of theirs, which no front
	 * Facade would bring back overrides - and the runs' fronts are told as they are then; Facade's own changes tell none (LIFECYCLE-3.5).
	 */
	private noteFront(): void {
		const group = vscode.window.tabGroups.activeTabGroup;
		const seen = { column: group.viewColumn, tab: group.activeTab };
		const moved = seen.column !== this.seenFront.column || !sameTab(seen.tab, this.seenFront.tab);
		this.seenFront = seen;
		if (!moved || this.expectedFront(seen.column, seen.tab)) {
			return;
		}
		this.personMoves++;
		this.personLast = seen.column;
		if (seen.column !== undefined) {
			this.personColumns.add(seen.column);
			if (seen.tab) {
				this.personFronts.set(seen.column, seen.tab);
			} else {
				this.personFronts.delete(seen.column);
			}
		}
		// What they showed before is not what a mark waits for to come to the front any longer, the person elsewhere now - but for the
		// steps of their showing of one past the eighth, which pass other groups on its way
		for (const pair of this.entries.values()) {
			if (this.borrowing === 0 && pair.shownAt !== undefined && !sameTab(pair.tab, seen.tab)) {
				pair.shownAt = undefined;
			}
		}
		// Its tab in front, the person's doing: a mark that waited goes on there as it is (LIFECYCLE-3.4) - not for a tab a showing's steps
		// past the eighth only pass on their way
		const shown = seen.tab && this.pairOfTab(seen.tab);
		if (this.borrowing === 0 && shown && this.markFailures.delete(shown)) {
			this.applyPin(shown);
		}
		if (!this.restoring) {
			this.syncFronts();
		}
	}

	/**
	 * Whether each run's tab is its group's front, told where that changed: what a reload brings back in front (LIFECYCLE-3.5) - but in the
	 * groups of `missed`, whose fronts did not come back, the runs' as they were.
	 */
	private syncFronts(missed?: ReadonlySet<number>): void {
		for (const pair of this.entries.values()) {
			if (!pair.tab || pair.hiding || pair.placedColumn === undefined || missed?.has(pair.placedColumn)) {
				continue;
			}
			const front = pair.tab.isActive === true;
			if (front !== !!pair.placedFront) {
				pair.placedFront = front;
				this.place(pair, pair.placedColumn);
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
		// Closed for the run now rather than as the editor says so later: what the run writes meanwhile is answered by a stand-in where
		// its supervisor leaves its queries to the window, not lost to a terminal going (ARCHITECTURE-2.3)
		pair.pty.close();
		terminal.dispose();
		return true;
	}

	private applyPin(pair: TerminalEntry): void {
		if (pair.wantedPin === undefined || !pair.tab || pair.applyingPin) { return; }
		if (pair.tab.isPinned === pair.wantedPin) {
			pair.observedPin = pair.tab.isPinned; pair.wantedPin = undefined; return;
		}
		// Through the marks' queue, front tab or not, as no tab of Facade's opens: one opening would take the front tab the
		// editor pins, as a reload's do one after another
		this.markNow(pair);
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
	create(facts: Pick<PairFacts, 'run' | 'name' | 'cli' | 'pinned'> & { readonly cwd?: string }, reveal: boolean): AgentTerminal {
		const pty = new AgentPty(facts.name, line => this.options.log(line), () => this.still(), (osc, rgb) => this.options.colours?.learn(osc, rgb),
			() => this.options.colours?.current() ?? {});
		pty.muteInput(this.borrowing > 0);
		const covered = reveal ? undefined : vscode.window.tabGroups.activeTabGroup.activeTab;
		const pair: TerminalEntry = {
			run: facts.run, name: facts.name, cli: facts.cli, pty, terminal: undefined, lifetime: new AbortController(), ...facts.pinned ? { pinned: true } : {},
			// A pinned agent's tab is to show its mark from its first opening - a reload's comes before the Pins are settled
			...facts.pinned ? { wantedPin: true } : {},
			...facts.cwd ? { cwd: facts.cwd } : {},
			...reveal ? {} : { background: { since: Date.now(), ...covered ? { covered } : {} } }
		};
		this.entries.set(facts.run, pair);
		return {
			pty,
			open: (reveal, column, activeAt, front) => {
				if (column !== undefined) {
					pair.openIn = column;
				}
				if (activeAt !== undefined) {
					pair.activeAt ??= activeAt;
				}
				// Its group's front before the reload, which it is again at its end (LIFECYCLE-3.5)
				if (front) {
					pair.wasFront = true;
					pair.placedFront = true;
				}
				this.openPair(pair, reveal);
			},
			markOpened: () => this.markOpened(pair),
			reveal: preserveFocus => {
				if (this.entries.get(pair.run) !== pair) {
					return false;
				}
				if (!preserveFocus) {
					pair.shownAt = Date.now();
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
				// The editor shows an extension's terminal in its own group without making that group the active one, which the
				// focus does only at times: its group is made active too, as the person's next command acts on the active group's front tab
				const column = pair.tab?.group?.viewColumn;
				if (!preserveFocus && column !== undefined) {
					if (column <= GROUP_FOCUS.length) {
						void this.focusColumn(column, false, false);
					} else {
						// Past the eighth, group by group, each step checked: the fronts it passes take none of the person's keys meanwhile; its
						// tab reached, a mark of its that waited goes on there as it is
						this.borrow(true);
						void this.focusColumn(column, false).then(reached => reached, () => false).then(reached => {
							this.borrow(false);
							if (reached && this.markFailures.delete(pair)) {
								this.applyPin(pair);
							}
						});
					}
				}
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
			// Asked to be shown, its focus left where the person has it or not, as a registered opening is
			if (this.revealRequested?.pair === pair) {
				this.createQueuedTerminal(pair);
			} else {
				this.createTerminal(pair, reveal);
			}
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
		this.copyAt.set(terminal, Date.now());
		this.copies.push(terminal);
		void this.toShell(terminal).catch(err => this.options.log(`Could not put a terminal in the place of a copied agent tab: ${messageOf(err)}`))
			.finally(() => { this.copies = this.copies.filter(each => each !== terminal); });
	}

	/**
	 * A copy of an agent's tab - which the editor leaves with no process - becomes at once an ordinary terminal in its place, in
	 * the copied agent's folder, as the editor's own split of a terminal tab gives; each copy of several alike. The copy goes as that
	 * terminal is in front, not once its shell runs, so that its group is never left empty; the agent itself is untouched.
	 */
	private async toShell(copy: vscode.Terminal): Promise<void> {
		// Its group: its tab, which the editor tells about as it tells of the terminal, else the active group
		for (let waited = 0; !this.copyTabOf(copy) && waited < 300; waited += 10) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const column = this.copyTabOf(copy)?.group?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
		this.copyAt.delete(copy);
		this.copyTabs.delete(copy);
		// The folder of the agent its name tells, or the one all agents whose tabs bear that name share; else the editor's default
		const name = (copy.creationOptions as vscode.TerminalOptions).name;
		const folders = new Set([...this.entries.values()].filter(pair => pair.terminal && pair.pty.createdName() === name).map(pair => pair.cwd));
		const cwd = folders.size === 1 ? [...folders][0] : undefined;
		const shell = vscode.window.createTerminal({ ...cwd ? { cwd } : {}, location: { viewColumn: column, preserveFocus: false } });
		await new Promise<void>(resolve => {
			const timer = setTimeout(done, 1_500);
			const shown = vscode.window.onDidChangeActiveTerminal(terminal => { if (terminal === shell) { done(); } });
			void Promise.resolve(shell.processId).then(done, done);
			function done(): void {
				clearTimeout(timer);
				shown.dispose();
				resolve();
			}
		});
		copy.dispose();
	}

	/** A copy's tab: the one it became active with, else the one terminal tab no agent's that opened with it (LIFECYCLE-2.2). */
	private copyTabOf(copy: vscode.Terminal): vscode.Tab | undefined {
		const present = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
		const known = this.copyTabs.get(copy);
		if (known && present.has(known)) {
			return known;
		}
		const since = (this.copyAt.get(copy) ?? Date.now()) - COPIES_MS;
		const near = this.strayOpened.filter(each => each.at >= since && present.has(each.tab) && !this.pairOfTab(each.tab));
		return near.length === 1 ? near[0].tab : undefined;
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
		this.disposed = true;
		this.marks = [];
		clearTimeout(this.restoringTimer);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		for (const pair of this.entries.values()) {
			this.remove(pair);
		}
	}

	async finishRestore(): Promise<void> {
		try {
			const owner = this.options.terminalOwner;
			if (!owner) { return; }
			const restored = [...this.entries.values()];
			await this.creation;
			const runs = restored.filter(pair => this.entries.get(pair.run) === pair && pair.terminal).map(pair => pair.run);
			await vscode.commands.executeCommand(WINDOW_TERMINALS_COMMAND, { ...owner, kind: 'retire', runs });
		} finally {
			// The reload's tabs are open, its pinned ones marked as they opened: each group's last active tab is in front again, and
			// What the person had in front; marks that waited go on now, one after another
			clearTimeout(this.restoringTimer);
			await this.restoreFronts().catch(err => this.options.log(`Could not bring back the tabs in front: ${messageOf(err)}`));
			this.restoring = false;
			this.markQueue();
		}
	}

	/** Creates the native tab with the agent's name; later rename events apply once the terminal opens. */
	private createTerminal(pair: TerminalEntry, reveal: boolean): void {
		const { cli, pty } = pair;
		const covered = reveal ? undefined : vscode.window.tabGroups.activeTabGroup.activeTab;
		const coveredTerminal = covered && this.frontOf(vscode.window.tabGroups.activeTabGroup)?.terminal;
		pair.background = reveal ? undefined : { since: Date.now(), ...covered ? { covered } : {}, ...coveredTerminal ? { coveredTerminal } : {} };
		if (!reveal) {
			// Each group's front and the active group as a reload's first tab opens behind the person's work, before Facade changes any
			if (this.restoring && !this.capture) {
				this.capture = this.captureFronts();
			}
			// Its tab, opening in front of its group, is Facade's doing there, the active group or not, until it is known
			const column = this.columnFor(pair);
			const withdraw = this.expect(column === vscode.ViewColumn.Active ? vscode.window.tabGroups.activeTabGroup.viewColumn : column,
				tab => !!tab && tab.input instanceof vscode.TabInputTerminal && (!this.pairOfTab(tab) || this.pairOfTab(tab) === pair));
			pair.opensExpected = withdraw;
			setTimeout(() => { if (pair.opensExpected === withdraw) { pair.opensExpected = undefined; withdraw(); } }, OPENING_MS);
		}
		// The person's opening of an unpinned agent's tab where the group shows another: that one goes as this one opens on its screen,
		// one taking the other's place at once, not once this one is seen open (LIFECYCLE-2.2)
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

	/** Each group's front as the editor has it, by view column, and the active group: a reload's capture (LIFECYCLE-3.5). */
	private captureFronts(): Capture {
		const fronts = new Map<number, Front>();
		for (const group of vscode.window.tabGroups.all) {
			const front = this.frontOf(group);
			if (front && !this.pairOfTab(front.tab)) {
				fronts.set(group.viewColumn, front);
			}
		}
		// The groups the person brings something to the front in from now on, which keep theirs
		this.personColumns.clear();
		this.personFronts.clear();
		return { at: Date.now(), moves: this.personMoves, active: vscode.window.tabGroups.activeTabGroup.viewColumn, fronts };
	}

	/** The group `pair`'s tab opens in: the one it was in, the last one where that is gone, else the active one (LIFECYCLE-3.5). */
	private columnFor(pair: TerminalEntry): vscode.ViewColumn {
		if (pair.openIn === undefined) {
			// At a reload, the group that was the active one as it began: the others' openings make their groups active meanwhile
			return pair.background && this.capture?.active !== undefined ? this.capture.active : vscode.ViewColumn.Active;
		}
		return this.openingColumn(pair.openIn) ?? vscode.ViewColumn.Active;
	}

	/** Where a tab whose group was `column` opens: that group, else the last one where it is gone; none where no group is open. */
	private openingColumn(column: number): number | undefined {
		const columns = vscode.window.tabGroups.all.map(group => group.viewColumn).filter(Number.isFinite);
		return columns.length ? Math.min(column, Math.max(...columns)) : undefined;
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
		// What the editor shows in front now, seen before anything Facade does about it changes it again
		this.noteFront();
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
			this.match(pair, opened[0]);
			this.uncover(pair, opened[0]);
		} else if (opened.length === 1 && this.movedOut.length === 1 && !this.opening.length) {
			// One moved: the tab that opens is its (LIFECYCLE-2.2)
			const { pair } = this.movedOut.shift()!;
			this.match(pair, opened[0]);
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
		// What opened that is no agent's tab: a copy's among them (LIFECYCLE-2.2)
		this.strayOpened = [...this.strayOpened.filter(each => now - each.at <= 3 * COPIES_MS),
			...opened.filter(tab => !this.pairOfTab(tab)).map(tab => ({ tab, at: now }))];
		// A mark changed on a tab Facade cannot tell is the person's: kept with that tab until it is known (LIFECYCLE-3.4)
		for (const tab of [...event.opened, ...event.changed]) {
			if (tab.input instanceof vscode.TabInputTerminal && !this.pairOfTab(tab)) {
				const before = this.strayMarks.get(tab);
				// One a mark's command changed is Facade's mistake, undone once the tab is known
				if (this.markingCommand && before !== undefined && before.pinned !== tab.isPinned) {
					this.wrongMarks.add(tab);
				}
				this.strayMarks.set(tab, before === undefined || before.pinned === tab.isPinned || this.markingCommand ? { pinned: tab.isPinned, ...before?.changedAt !== undefined ? { changedAt: before.changedAt } : {} } : { pinned: tab.isPinned, changedAt: now });
			}
		}
		if (event.changed.some(tab => tab.isActive) || event.opened.some(tab => tab.isActive)) {
			this.tabActivatedAt = now;
			this.correlate();
		}
		for (const tab of event.changed) {
			const pair = this.pairOfTab(tab);
			if (!pair) { continue; }
			if (pair.wantedPin === undefined && !pair.applyingPin && !this.markingCommand && pair.observedPin !== tab.isPinned) {
				pair.observedPin = tab.isPinned;
				this.options.pinned?.(pair.run, tab.isPinned);
			}
			this.applyPin(pair);
		}
		// An agent's tab coming to its group's front or leaving it in a group Facade is doing nothing in: the person's, told as its front
		// fact - in another group than the active one too, where its close or a file opened there changes it (LIFECYCLE-3.5)
		const seenAt = Date.now();
		const busy = (column: number | undefined) => this.borrowing > 0 || this.restoring
			|| this.expected.some(each => each.until > seenAt && (each.column === undefined || each.column === column));
		for (const pair of this.entries.values()) {
			const front = pair.tab?.isActive === true;
			if (pair.tab && !pair.hiding && pair.placedColumn !== undefined && front !== !!pair.placedFront && !busy(pair.tab.group?.viewColumn)) {
				pair.placedFront = front;
				this.place(pair, pair.placedColumn);
			}
		}
		// A terminal's tab changes as its name does, which the editor has told its terminal by then
		this.observeNames();
		this.noteFront();
	}

	/** Where `pair`'s tab is, and whether it is its group's front, told for a reload to bring it back so (LIFECYCLE-3.5). */
	private place(pair: TerminalEntry, column: number | undefined): void {
		pair.placedColumn = column;
		this.options.placed?.(pair.run, column, pair.activeAt, column !== undefined ? pair.placedFront === true : undefined);
	}

	/**
	 * VS Code 1.105 can replace every Tab object in a group-model update without a tab-change event: VS Code rebuilds its whole model as
	 * a group is added or removed, its groups and tabs new objects then.
	 */
	private groupsChanged(event?: vscode.TabGroupChangeEvent): void {
		// What was in front of the active group as this change came: a rebuild's old object of it, the agent's, tells it again
		const before = this.seenFront;
		this.noteFront();
		const present = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
		// Groups number themselves anew as one closes, opens or moves (LIFECYCLE-3.5): a tab still known is in its group's number; one
		// the editor's new objects leave unknown follows the groups that closed - each in the number it had - and those that opened
		const closed = (event?.closed ?? []).map(group => group.viewColumn).filter(Number.isFinite).sort((a, b) => b - a);
		const opened = (event?.opened ?? []).map(group => group.viewColumn).filter(Number.isFinite).sort((a, b) => a - b);
		const shifted = (column: number) => opened.reduce((at, open) => at >= open ? at + 1 : at, closed.reduce((at, gone) => at > gone ? at - 1 : at, column));
		let dropped: { readonly pair: TerminalEntry; readonly tab: vscode.Tab } | undefined;
		for (const pair of this.entries.values()) {
			if (pair.tab && !present.has(pair.tab)) {
				if (pair.tab === before.tab) {
					dropped = { pair, tab: pair.tab };
				}
				pair.tab = undefined;
			}
			if (pair.placedColumn === undefined) {
				continue;
			}
			const column = pair.tab?.group?.viewColumn ?? shifted(pair.placedColumn);
			if (column !== pair.placedColumn) {
				this.place(pair, column);
			}
		}
		// The editor rebuilt its tabs as new objects, this change dropping the old object of the agent's tab that was the active group's
		// front, that group still the active one - its number shifted for the groups that closed and opened: the terminal tab no agent's in
		// front of it is that tab again, its terminal the active one. Any other unknown tab stays unknown until it next becomes active with
		// its terminal (LIFECYCLE-2.2)
		const front = vscode.window.tabGroups.activeTabGroup.activeTab;
		// That group survived this change and is the active one: a closed group's tabs, joined into another, are not its front there
		const still = before.column !== undefined && !closed.includes(before.column) && shifted(before.column) === vscode.window.tabGroups.activeTabGroup.viewColumn;
		if (dropped && still && !dropped.pair.hiding && vscode.window.activeTerminal === dropped.pair.terminal
			&& front?.input instanceof vscode.TabInputTerminal && !this.pairOfTab(front)) {
			this.match(dropped.pair, front);
		}
		this.tabActivatedAt = Date.now();
		this.correlate();
		const pair = vscode.window.activeTerminal && this.pairOf(vscode.window.activeTerminal);
		if (pair) { this.applyPin(pair); }
		this.noteFront();
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
		// A copy's tab, active with the copy's terminal: where the agent started in its place opens (LIFECYCLE-2.2)
		if (terminal && this.copies.includes(terminal) && tab?.input instanceof vscode.TabInputTerminal && !this.pairOfTab(tab)) {
			this.copyTabs.set(terminal, tab);
		}
		if (!pair || !tab || !(tab.input instanceof vscode.TabInputTerminal)) {
			return;
		}
		const holder = this.pairOfTab(tab);
		if ((!holder || holder === pair) && (!pair.tab || pair.tab === tab)) {
			const before = pair.activeAt;
			// Facade's own showing of it, for its mark, is not the person's: when they last had it active stands (LIFECYCLE-3.5)
			if (this.borrowing === 0 && !this.expectedFront(tab.group?.viewColumn, tab)) {
				pair.activeAt = Date.now();
			}
			this.match(pair, tab);
			if (before !== pair.activeAt && pair.tab === tab) {
				this.place(pair, tab.group?.viewColumn);
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
		// A reload's pinned tab is marked as it opens, in front: what it covered comes back after its mark (markOne)
		if (this.restoring && pair.pinned) {
			return;
		}
		const covered = pair.background?.covered;
		if (this.entries.get(pair.run) !== pair || !covered || !tab.isActive || !this.opensBehind(pair) || covered === tab) {
			return;
		}
		// A reload's tabs open one over another, each group's front last: another agent's tab is not shown again between them, nor a file
		// where an agent is that group's front - but in a group the person brought something to the front in since, theirs is (LIFECYCLE-3.5)
		const coveredColumn = covered.group?.viewColumn;
		const persons = coveredColumn !== undefined && this.personColumns.has(coveredColumn);
		if (this.restoring && !persons && (this.pairOfTab(covered) || this.recordedFronts.has(coveredColumn))) {
			pair.background = { since: pair.background!.since };
			return;
		}
		// Returning to the covered editor before xterm is ready can leave this terminal permanently unopened in VS Code: this opening's
		// open is waited for - not the first one's, which an agent opened before had long ago
		if (!pair.pty.isOpen) {
			void pair.pty.nextOpen().then(opened => { if (opened) { this.uncover(pair, tab); } });
			return;
		}
		const terminal = pair.background?.coveredTerminal;
		pair.background = { since: pair.background!.since };
		void this.refront({ tab: covered, ...terminal ? { terminal } : {} }, false)
			.catch(err => this.options.log(`Could not show the tab ${pair.run}'s terminal covered again: ${messageOf(err)}`));
	}

	private match(pair: TerminalEntry, tab: vscode.Tab): void {
		// Its tab known - often as its terminal becomes the active one, before the editor tells of the tab in front: what its opening
		// brings to the front stands a moment longer for that to be told, then is waited for no longer
		if (pair.opensExpected) {
			const withdraw = pair.opensExpected;
			pair.opensExpected = undefined;
			setTimeout(withdraw, OPENED_MS);
		}
		const placedBefore = pair.tab?.group?.viewColumn;
		if (pair.tab !== tab) {
			this.markFailures.delete(pair);
		}
		pair.tab = tab;
		if (placedBefore !== tab.group?.viewColumn) {
			this.place(pair, tab.group?.viewColumn);
		}
		// A mark the person changed while the tab was unknown wins where that change came after Facade's last Pin or Unpin of the agent,
		// however many changes there were - two that ended on the mark it showed before included; else Facade's Pin stands, its mark to
		// follow (LIFECYCLE-3.4)
		// A mark Facade put on this tab by mistake, before it knew it, is undone - never taken for the person's
		if (this.wrongMarks.has(tab)) {
			this.wrongMarks.delete(tab);
			this.strayMarks.delete(tab);
			pair.observedPin = tab.isPinned;
			pair.wantedPin = !!pair.pinned;
			this.options.log(`${pair.run}'s tab had a mark meant for another, which is undone`);
		}
		const stray = this.strayMarks.get(tab)?.changedAt;
		this.strayMarks.delete(tab);
		if (stray !== undefined && pair.wantedPin !== undefined && stray > (pair.pinnedAt ?? -Infinity)) {
			pair.wantedPin = undefined;
			pair.observedPin = tab.isPinned;
			if (!pair.applyingPin && tab.isPinned !== !!pair.pinned) { this.options.pinned?.(pair.run, tab.isPinned); }
		} else if (pair.observedPin !== tab.isPinned) {
			const changed = pair.observedPin !== undefined || tab.isPinned;
			pair.observedPin = tab.isPinned;
			if (changed && pair.wantedPin === undefined && !pair.applyingPin && !this.markingCommand) { this.options.pinned?.(pair.run, tab.isPinned); }
		}
		this.applyPin(pair);
		// A tab whose mark differs from its Pin - a reload's, opened behind the person's work - follows at once, not once it is next
		// active (LIFECYCLE-3.4)
		if (pair.wantedPin !== undefined && tab.isPinned !== pair.wantedPin) {
			this.markNow(pair);
		}
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

/** Whether `input` is of the editor's `kind`: a kind this editor's API does not have is none. */
function isInput<T>(input: unknown, kind: (abstract new (...args: never[]) => T) | undefined): input is T {
	return typeof kind === 'function' && input instanceof kind;
}

/** The resources a tab's input names, as text: a file's, a diff's two, a notebook's or a custom editor's. */
function resourcesOf(input: unknown): string[] {
	const each = input as { readonly uri?: unknown; readonly original?: unknown; readonly modified?: unknown } | undefined;
	return [each?.uri, each?.original, each?.modified].filter(resource => resource !== undefined && resource !== null).map(String);
}

/** Whether two tabs are one, as the editor may give a tab a new object: the same group, kind and label. */
function sameTab(a: vscode.Tab | undefined, b: vscode.Tab | undefined): boolean {
	return a === b || (!!a && !!b && a.group?.viewColumn === b.group?.viewColumn && a.label === b.label
		&& (a.input as object | undefined)?.constructor === (b.input as object | undefined)?.constructor);
}
