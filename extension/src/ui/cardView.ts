/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { titleText } from '../base/text';
import type { Catalog, Location, RunFacts, ToolsProblem, WorktreeCreationEffects } from '../core/ports';
import { dotOf } from '../core/status';
import type { AvatarColor, Card, CardMenu } from '../webview/protocol';

/** The words a card is said in, in the person's language. */
export interface CardWords {
	readonly agent: (value: string) => string;
	readonly title: (value: string) => string;
	readonly prompt: (value: string) => string;
	readonly status: (value: string) => string;
	readonly reason: (value: string) => string;
	readonly tools: (value: string) => string;
	readonly location: (value: string) => string;
	readonly path: (value: string) => string;

	readonly pinned?: string;
	readonly worktreeFailure: (reason: string, effects: WorktreeCreationEffects) => string;
	readonly starting: string;
	/** `Starting {0}...`, {0} the CLI's name: the startup stage while its process starts (LIFECYCLE-1.5). */
	readonly startingCli: (cli: string) => string;
	/** The startup stage while its new worktree is made (LIFECYCLE-1.5, WORKTREES-2.1). */
	readonly creatingWorktree: string;
	readonly working: string;
	readonly notWorking: string;
	/** `Error: {0}`, {0} the reason. */
	readonly error: (reason: string) => string;
	readonly activityUnavailable: string;
	readonly needsAttention: string;
	readonly toolsConnecting: string;
	readonly needsPermission: string;
	readonly needsSignIn: string;
	readonly hasQuestion: string;
	/** `Exited with code {0}` and `Terminated by signal {0}`: an abnormal exit, as Facade says it (RULES-3.3). */
	readonly exitedWithCode: (code: string) => string;
	readonly endedBySignal: (signal: string) => string;
	/** `Disconnected; exit cause unknown`: a run its supervisor no longer had, how it ended not known (LIFECYCLE-3.5). */
	readonly exitUnknown: string;
	/** `Window: {0}`, {0} the window's name: where the hover says the agent is (PANEL-1.5). */
	readonly window: (label: string) => string;
	/** Why an agent cannot work with other agents - its Facade tools are not there - in plain words; it runs on without them (PANEL-1.4). */
	readonly toolsUnavailable: (problem: ToolsProblem | undefined, file: string | undefined) => string;
	/** `Started by: {0}`, {0} the reference of the agent that started it (PANEL-1.5). */
	readonly startedBy: (creator: string) => string;
	/** `From: {0}`, {0} the agent that sent the message the second line says (PANEL-1.5). */
	readonly from: (sender: string) => string;
	/** `Source window: {0}`, {0} the sender's window, where that is another (PANEL-1.5). */
	readonly sourceWindow: (label: string) => string;
	/** What a screen reader hears of the second line, its source in words, not its mark (PANEL-1.5). */
	readonly saidByAgent: (sender: string, line: string) => string;
	readonly saidByPerson: (line: string) => string;
	readonly saidByFacade: (line: string) => string;
	/** The person's language, as a custom CLI's initial is uppercased in it (UX-2.1). */
	readonly locale: string;
}

/** Where a card's agent works, as the card says it (PANEL-1.3). */
export interface CardPlace {
	/** Branch or folder name. */
	readonly label: string;
	/** Its workspace folder's name, in a multi-folder window. */
	readonly folderPrefix?: string;
	/** The location with its workspace folder: what the accessible label says. */
	readonly qualified: string;
	/** The qualified location with its non-local environment, kept separate from its path. */
	readonly context: string;
	readonly path: string;
}

/**
 * The workspace folder's name a location is said after (PANEL-1.3): in a multi-folder window, where same-named branches need it -
 * not where the location is named that folder's name already, as a plain folder is (PANEL-1.3).
 */
export function folderPrefixOf(location: Pick<Location, 'label' | 'folders'>, catalog: Pick<Catalog, 'folders'>): string | undefined {
	const folder = location.folders[0];
	return catalog.folders.length > 1 && folder && folder.name !== location.label ? folder.name : undefined;
}

/** A location as the person reads it alone (PANEL-1.3): its label, after its workspace folder's name in a multi-folder window. */
/**
 * The window's one place to work, where it has one (LIFECYCLE-1.3): one folder whose only location is a plain folder - one Git found
 * no repository in, or is missing for - which goes without saying wherever a location would be said. A folder Git is still reading,
 * or failed to read, may be a repository, whose branch is said.
 */
export function onePlaceOf(catalog: Catalog): Location | undefined {
	const [only, ...others] = catalog.locations;
	return !catalog.pending && catalog.folders.length === 1 && only && !others.length && only.kind === 'folder'
		&& only.git !== 'pending' && only.git !== 'failed' ? only : undefined;
}

export function locationLabel(location: Pick<Location, 'label' | 'folders'>, catalog: Pick<Catalog, 'folders'>): string {
	const prefix = folderPrefixOf(location, catalog);
	return prefix ? `${prefix} · ${location.label}` : location.label;
}

/** What a card's dot says and its second line (RULES-3.2, PANEL-1.4); `reason` is what the state's words leave unsaid. */
export interface CardStatus {
	readonly dot: Card['dot'];
	readonly stateText: string;
	readonly line: string;
	readonly reason?: string;
	/** What the second line says where that is what was last sent, and who sent it. */
	readonly said?: CardSaid;
}

/** What was last sent to a run, as its card says it (`line`) and in itself (`text`), and its source (PANEL-1.4, 1.5). */
export interface CardSaid {
	readonly line: string;
	readonly text: string;
	readonly kind: 'agent' | 'person' | 'facade';
	readonly sender?: string;
	readonly window?: string;
}

/**
 * What a card says of its run (RULES-3.2, PANEL-1.4): its dot by {@link dotOf}; its second line the last message sent
 * to it - before any, its CLI title's words, else its startup stage or state - unless the dot is red, when it says why, or the CLI
 * waits for the person, when it says what for. The state in words is the hover's. Never a completion claim.
 */
export function statusOf(facts: RunFacts, words: CardWords): CardStatus {
	const dot = dotOf(facts);
	if (facts.error || facts.lifecycle === 'ended') {
		const reason = errorReasonOf(facts, words);
		const text = words.error(reason);
		return { dot, stateText: text, line: text };
	}
	if (facts.blocker) {
		const kind = facts.blocker.kind === 'permission' ? words.needsPermission : facts.blocker.kind === 'auth' ? words.needsSignIn
			: facts.blocker.kind === 'question' ? words.hasQuestion : words.needsAttention;
		const detail = facts.blocker.text?.trim();
		const said = detail && detail !== kind ? `${kind} · ${detail}` : kind;
		return { dot, stateText: kind, line: said, ...detail && detail !== kind ? { reason: detail } : {} };
	}
	// Facade tools it cannot use, or a start that did not become ready: red, the second line saying why (RULES-3.2)
	if (dot === 'error') {
		const why = facts.tools === 'unavailable' ? words.toolsUnavailable(facts.toolsProblem, facts.toolsFile)
			: facts.tools === 'connecting' ? words.toolsConnecting : facts.activityReason?.trim() || words.activityUnavailable;
		return { dot, stateText: why, line: why };
	}
	const starting = facts.lifecycle === 'starting' || !!facts.awaitingActivity;
	const working = facts.lifecycle === 'running' && facts.reporting && facts.activity === 'working';
	const idle = facts.reporting && facts.activity === 'not_working';
	const stateText = working ? words.working : starting ? words.starting : idle ? words.notWorking : words.activityUnavailable;
	const reason = !working && !starting && !idle ? facts.activityReason?.trim() : undefined;
	// The last message sent to it - the task it was started with being the first - else its CLI's title without the state symbol
	// before its words (PANEL-1.4)
	const fallback = working ? words.working : starting ? (facts.phase === 'creating_worktree' ? words.creatingWorktree : words.startingCli(facts.displayName)) : stateText;
	const said = saidOf(facts);
	return { dot, stateText, line: said?.line ?? (titleText(facts.title) || fallback), ...said ? { said } : {}, ...reason && reason !== stateText ? { reason } : {} };
}

/**
 * What was last sent to the run and by whom (PANEL-1.4): another agent's message - the task an agent-started run was started with
 * among them - marked `📨`, from who its record says sent it, never from its text; a Facade result, or the person's input, as it is.
 */
function saidOf(facts: RunFacts): CardSaid | undefined {
	if (facts.said) {
		const source = facts.saidSource;
		if (source?.kind === 'agent') {
			const sender = source.name ? `${source.name}${source.alias ? ` (${source.alias})` : ''}` : source.alias;
			return { line: `\u{1F4E8} ${facts.said}`, text: facts.said, kind: 'agent', ...sender ? { sender } : {}, ...source.window ? { window: source.window } : {} };
		}
		return { line: facts.said, text: facts.said, kind: source?.kind === 'facade' ? 'facade' : 'person' };
	}
	if (facts.promptLine) {
		const creator = facts.creatorLabel ?? facts.creator;
		// The label a start keeps is `name #aN`
		const sender = creator?.replace(/^(.+) (#a\d+)$/u, '$1 ($2)');
		return { line: `\u{1F4E8} ${facts.promptLine}`, text: facts.promptLine, kind: 'agent', ...sender ? { sender } : {} };
	}
	return undefined;
}

/** Why a run is in error: an abnormal exit in the person's words, from how it ended (RULES-3.3); any other reason as it was given. */
function errorReasonOf(facts: RunFacts, words: CardWords): string {
	if (facts.error?.source === 'exit' && facts.end) {
		if (facts.end.signal) {
			return words.endedBySignal(facts.end.signal);
		}
		if (facts.end.code !== undefined) {
			return words.exitedWithCode(String(facts.end.code));
		}
		return words.exitUnknown;
	}
	const reason = facts.error?.reason.trim() || words.activityUnavailable;
	return facts.error?.worktree ? words.worktreeFailure(reason, facts.error.worktree) : reason;
}

/** The maker avatars of the built-in CLIs, by API ID, in `media/agents` (PANEL-1.3). */
const AVATARS: { readonly [cli: string]: string } = {
	claude: 'avatar-claude.png',
	codex: 'avatar-codex.png',
	agy: 'avatar-antigravity.png',
	muse: 'avatar-muse.png',
	opencode: 'avatar-opencode.png',
	pi: 'avatar-pi.png'
};

/** How a name is cut into what a reader sees as characters: an accented letter or an emoji whole. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The `charts` colours a custom CLI's avatar can take: none that a status dot uses (UX-2.1). */
const AVATAR_COLORS: readonly AvatarColor[] = ['blue', 'orange', 'purple'];

/**
 * A card's avatar (PANEL-1.3, UX-2.1): a built-in's maker avatar; for another CLI - a custom one - the uppercased first grapheme of
 * its name in the `charts` colour a stable hash of its normalized name picks, the same for every agent of that CLI; none for a name
 * with nothing to show.
 */
export function avatarOf(cli: string, displayName: string, locale: string): Card['avatar'] {
	if (Object.hasOwn(AVATARS, cli)) {
		return { file: AVATARS[cli] };
	}
	const name = displayName.trim().normalize('NFC');
	const [first] = GRAPHEMES.segment(name);
	if (!first) {
		return undefined;
	}
	let hash = 0;
	for (const char of name.toLowerCase()) {
		hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
	}
	return { initial: upper(first.segment, locale), color: AVATAR_COLORS[hash % AVATAR_COLORS.length] };
}

/** `text` uppercased in `locale`, where the runtime knows it; else as the runtime's default does. */
function upper(text: string, locale: string): string {
	try {
		return text.toLocaleUpperCase(locale);
	} catch {
		return text.toUpperCase();
	}
}

/**
 * A run's card (PANEL-1.3-1.5): its dot and second line by {@link statusOf}; a hover of name, short run ID and CLI, the full title,
 * the state and its reason (the page adds the start time, and the qualified location with the window); and an accessible label of
 * name, short run ID, state, location, CLI and second line.
 */
export function cardOf(facts: RunFacts, input: { readonly place: CardPlace; readonly repeated?: boolean; readonly selected: boolean; readonly menu: CardMenu; readonly words: CardWords; readonly window?: string }): Card {
	const { place, words } = input;
	const status = statusOf(facts, words);
	const described = facts.title || facts.promptLine;
	// Its tools going as its process ended - its MCP server ends with its CLI - is no problem of an ended card's: the exit says it
	const gone = facts.lifecycle === 'ended' && facts.toolsProblem === 'disconnected';
	const tools = facts.tools === 'unavailable' && !gone ? words.toolsUnavailable(facts.toolsProblem, facts.toolsFile)
		: facts.tools === 'connecting' && facts.lifecycle !== 'ended' ? words.toolsConnecting : undefined;
	const tooltip = [
		words.agent([facts.name, facts.alias, facts.displayName].filter(Boolean).join(' · ')),
		...described ? [facts.title ? words.title(described) : words.prompt(described)] : [],
		words.status(status.stateText),
		...status.reason && status.reason !== described ? [words.reason(status.reason)] : [],
		// The card's row may cut this line short: the hover says it whole (PANEL-1.5)
		...tools ? [words.tools(tools)] : [],
		...status.said?.sender ? [words.from(status.said.sender)] : [],
		...status.said?.window ? [words.sourceWindow(status.said.window)] : [],
		...facts.origin === 'agent' && (facts.creatorLabel ?? facts.creator) ? [words.startedBy((facts.creatorLabel ?? facts.creator)!)] : []
	];
	const heard = status.said?.kind === 'agent' ? words.saidByAgent([status.said.sender, status.said.window].filter(Boolean).join(', '), status.said.text)
		: status.said?.kind === 'facade' ? words.saidByFacade(status.said.text)
			: status.said ? words.saidByPerson(status.said.text) : status.line;
	const label = [facts.name, facts.alias, ...(facts.pin && words.pinned ? [words.pinned] : []), status.stateText, place.qualified, facts.displayName, ...status.line !== status.stateText ? [heard] : []].filter(Boolean).join(', ');
	const avatar = avatarOf(facts.cli, facts.displayName, words.locale);
	return {
		runId: facts.id,
		...(facts.pin ? { pinned: true } : {}),
		selected: input.selected,
		name: facts.name,
		alias: facts.alias,
		// Its short ID beside a name another card of this window has too (PANEL-1.3)
		...(input.repeated && facts.name.trim() ? { repeated: true as const } : {}),
		...(avatar ? { avatar } : {}),
		location: { full: [words.location(place.context), words.path(place.path), ...input.window ? [words.window(input.window)] : []].join('\n') },
		dot: status.dot,
		stateText: status.stateText,
		line: status.line,
		tooltip,
		label,
		startedAt: facts.startedAt ?? facts.createdAt,
		...facts.activity === 'working' && facts.activitySince !== undefined ? { workingSince: facts.activitySince } : {},
		menu: input.menu
	};
}
