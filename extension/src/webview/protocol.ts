/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's wire contract (PANEL-3.1): plain types shared by the host (`src/ui`) and the page. The host applies every business
// rule - order, filter, dot, second line, details, menu - and the page only draws what it is sent and reports what the person did.

/** What a card's context menu offers beyond its fixed actions (PANEL-2.2): each only where it would do something now. */
export interface CardMenu {
	readonly pin?: boolean;
	readonly unpin?: boolean;
	readonly moveUp: boolean;
	readonly moveDown: boolean;
}

/** The `charts` colours a custom CLI's avatar can take: none that a status dot uses (UX-2.1). */
export type AvatarColor = 'blue' | 'orange' | 'purple';

/** Which fact a field of a card's details is (PANEL-1.5): stable whatever its words say, in every language. */
export type DetailId = 'title' | 'location' | 'path';

/**
 * One fact of a card's details: its value, and what a screen reader says before it - its label as the window's language says it,
 * its colon among it - where the details show the value alone.
 */
export interface DetailField {
	readonly id: DetailId;
	readonly label: string;
	readonly value: string;
}

/** What a location is, which its icon says as Facade's location pickers have it: a main checkout, a worktree, or a folder (PANEL-1.5). */
export type PlaceKind = 'repo' | 'worktree' | 'folder';

/**
 * A card's details (PANEL-1.5): what it works on - its conversation's title - who the agent is - its name and short ID, which the
 * card has - when it started, and where it works. When it started the page says, from the card's time.
 */
export interface CardDetails {
	/** Its conversation's complete title as its CLI stores it, where its CLI saved one; else the first row says `untitled`. */
	readonly summary?: DetailField;
	/** The first row's localized `Title: ` label, which a screen reader hears before it, title or not (PANEL-1.5). */
	readonly titleLabel: string;
	/**
	 * What the first row says where there is no title: `No title yet` while its CLI has not saved one, `Title unavailable` where Facade
	 * has no history reader for its CLI - a custom CLI - so none can come (PANEL-1.5, CLIS-2.4).
	 */
	readonly untitled?: string;
	/** The agent that started it, where an agent did: `name #aN`. */
	readonly startedBy?: string;
	/** Where it works, always: its main checkout, worktree or folder, its icon saying which - then, always, its path. */
	readonly location: DetailField & { readonly kind: PlaceKind };
	readonly path: DetailField;
	/**
	 * What a screen reader is told beyond the card's label, of the facts the label does not say already, in the details' order: its
	 * title, then - after when it started, which the page says - where it works and its path.
	 */
	readonly description: { readonly title: string; readonly place: string };
}

/** One card (PANEL-1.3-1.5), every text already in the person's language. */
export interface Card {
	readonly pinned?: boolean;
	readonly runId: string;
	readonly selected: boolean;
	readonly name: string;
	/** Its `#aN`: how a message names an agent whose name is empty (LIFECYCLE-3.1). */
	readonly alias: string;
	/** A built-in CLI's maker avatar in `media/agents`, or a custom CLI's initial on a theme colour; none for a name that shows nothing. */
	readonly avatar?: { readonly file: string } | { readonly initial: string; readonly color: AvatarColor };
	/** Its short ID shows beside its name: another card of this window has that name too (PANEL-1.3). */
	readonly repeated?: true;
	/** Green for work, red for an error, none for anything else (RULES-3.2). */
	readonly dot: 'working' | 'error' | 'none';
	/** The state in words, dot or none: startup, work, idle, the native blocker's kind, an error or unavailable activity. */
	readonly stateText: string;
	/** The second line (PANEL-1.4). */
	readonly line: string;
	/** Its details, its location among them: no card shows its location (PANEL-1.3, 1.5). */
	readonly details: CardDetails;
	/** The accessible label (PANEL-1.5). */
	readonly label: string;
	readonly startedAt?: number;
	readonly menu: CardMenu;
}

/**
 * The panel's display filter (PANEL-2.3): an environment-qualified location ID, or a workspace folder's URI, with the label the
 * view's description says.
 */
export interface PanelFilter {
	readonly kind: 'location' | 'folder';
	readonly id: string;
	readonly label: string;
}

export interface PanelState {
	/** Execution-clock reference sent with this snapshot; relative ages never subtract clocks from different machines. */
	readonly clockAt?: number;
	/** Which state this is: what the person acts on is said with it, and a later one supersedes it (PANEL-3.1). */
	readonly revision: number;
	/** Until this window's runs are reconciled: nothing is drawn, and the view shows native progress (PANEL-1.1). */
	readonly loading: boolean;
	/** The cards the filter shows, in the panel's order. */
	readonly cards: readonly Card[];
	/** Every card of this window, whatever the filter shows (PANEL-1.1). */
	readonly cardCount: number;
	readonly filter?: PanelFilter;
	/** Why no card is shown (PANEL-1.2): no folder, no agent, or none the filter shows. */
	readonly empty?: 'noFolder' | 'noAgents' | 'noMatch';
	/** `remote`: whether the window's workspace runs in a remote environment. */
	readonly capabilities: { readonly remote: boolean };
	/** Cards gone since the last state because their process ended normally: only these fade out (UX-2.2). */
	readonly exited?: readonly string[];
}

/** What the page asks the host to do, with the card's run ID where it is a card's (PANEL-3.1; PANEL-1.2's buttons; PANEL-1.3's Pin). */
export type Act = 'open' | 'new' | 'resume' | 'clearFilter' | 'openFolder' | 'rename' | 'pin' | 'unpin';

/** The host's answer to one action of the page that asked: `gone` (its card's run is gone) or `failed`. */
export interface Outcome {
	readonly action: string;
	readonly ok: boolean;
	readonly reason?: 'gone' | 'failed';
}

/** Native list scrolling and scrollbar appearance (PANEL-3.3): the person's settings and the window's zoom. */
export interface Scrolling {
	/** `workbench.list.mouseWheelScrollSensitivity`: what a wheel's movement is multiplied by. */
	readonly sensitivity: number;
	/** `workbench.list.fastScrollSensitivity`: by how much more with Alt held. */
	readonly fastSensitivity: number;
	/** `workbench.list.smoothScrolling`: whether a mouse wheel's scroll glides. */
	readonly smooth: boolean;
	/** `1.2 ^ window.zoomLevel`, which Chrome multiplies a wheel's movement by. */
	readonly zoomFactor: number;
	/** `workbench.list.scrollByPage`: track clicks page instead of centering; absent from older hosts, defaults to false. */
	readonly scrollByPage?: boolean;
	/** Effective `workbench.experimental.modernUI`; absent from older hosts, defaults to the traditional list appearance. */
	readonly modernUI?: boolean;
}

/** How long ago, as Resume Agent's list says it: one word for now, and for each unit its one and its many. */
export interface AgoWords {
	readonly now: string;
	readonly secs: string;
	readonly min: string;
	readonly mins: string;
	readonly hr: string;
	readonly hrs: string;
	readonly day: string;
	readonly days: string;
	readonly wk: string;
	readonly wks: string;
	readonly mo: string;
	readonly mos: string;
	readonly yr: string;
	readonly yrs: string;
}

/** The words the page draws itself; every card text comes with its card. */
export interface Strings {
	readonly agents: string;
	readonly newAgent: string;
	readonly resumeAgent?: string;
	readonly clearFilter: string;
	/** The empty panel's words (PANEL-1.2): why it is empty. */
	readonly noAgents: string;
	/** `No agents found in "{0}".`, {0} the filter's location. */
	readonly noAgentsIn: string;
	/** `{0} other agents are in this workspace.`, {0} how many cards the filter hides; and its form for one. */
	readonly otherAgents: string;
	readonly otherAgent: string;
	readonly noFolder: string;
	readonly openFolder: string;
	/** `Started {0}`, {0} how long ago as {@link ago} says it (PANEL-1.5). */
	readonly started: string;
	/** `Started {0} by {1}`, {0} as in `started`, {1} the agent that started it. */
	readonly startedBy: string;
	/** How long ago, in Resume Agent's words: `now`, `{0} secs ago`, `{0} min ago` and the rest, each `{0}` the count (LIFECYCLE-3.2). */
	readonly ago: AgoWords;
}
