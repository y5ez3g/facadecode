/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's wire contract (PANEL-3.1): plain types shared by the host (`src/ui`) and the page. The host applies every business
// rule - order, filter, dot, second line, hover, menu - and the page only draws what it is sent and reports what the person did.

/** What a card's context menu offers beyond its fixed actions (PANEL-2.2): each only where it would do something now. */
export interface CardMenu {
	readonly moveUp: boolean;
	readonly moveDown: boolean;
	/** Filter by This Location and Filter by This Folder: each only where it would show another set of cards (PANEL-2.3). */
	readonly filterLocation: boolean;
	readonly filterFolder: boolean;
	readonly clearFilter: boolean;
}

/** The `charts` colours a custom CLI's avatar can take: none that a status dot uses (UX-2.1). */
export type AvatarColor = 'blue' | 'orange' | 'purple';

/** One card (PANEL-1.3-1.5), every text already in the person's language. */
export interface Card {
	readonly runId: string;
	readonly selected: boolean;
	readonly name: string;
	/** A built-in CLI's maker avatar in `media/agents`, or a custom CLI's initial on a theme colour; none for a name that shows nothing. */
	readonly avatar?: { readonly file: string } | { readonly initial: string; readonly color: AvatarColor };
	/**
	 * `label` is the alias/branch/folder name; `folderPrefix` names its workspace folder in a multi-folder window; `full` qualifies it
	 * and names the window.
	 */
	readonly location: { readonly label: string; readonly folderPrefix?: string; readonly full: string };
	/** Green, yellow or red (RULES-3.2): unknown activity is `error`. */
	readonly dot: 'working' | 'idle' | 'error';
	/** The dot in words: `Starting`, `Working`, `Not working`, `Error: {reason}` or `Activity unavailable`. */
	readonly stateText: string;
	/** The second line (PANEL-1.4). */
	readonly line: string;
	/** The hover's lines before its start time and location (PANEL-1.5). */
	readonly tooltip: readonly string[];
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

/** What the page asks the host to do, with the card's run ID where it is a card's (PANEL-3.1; PANEL-1.2's buttons). */
export type Act = 'open' | 'new' | 'clearFilter' | 'openFolder';

/** The host's answer to one action of the page that asked: `gone` (its card's run is gone) or `failed`. */
export interface Outcome {
	readonly action: string;
	readonly ok: boolean;
	readonly reason?: 'gone' | 'failed';
}

/** The words the page draws itself; every card text comes with its card. */
export interface Strings {
	readonly agents: string;
	readonly newAgent: string;
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
	/** `Started {0}`, {0} a relative time. */
	readonly started: string;
}
