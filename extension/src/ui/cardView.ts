/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clauseOf } from '../base/errors';
import type { ActivityUnknown, Catalog, Location, RunFacts, ToolsProblem } from '../core/ports';
import { dotOf } from '../core/status';
import type { AvatarColor, Card, CardMenu, DetailField, DetailId, PlaceKind } from '../webview/protocol';

/** The words a card is said in, in the person's language. */
export interface CardWords {
	/** `Title: {0}`, `Location: {0}` and `Path: {0}`: what a screen reader says of a card's details (PANEL-1.5). */
	readonly title: (value: string) => string;
	/**
	 * `No title yet` and `Title unavailable`: the details' first row where a run has no title - its CLI has not saved one yet, or
	 * Facade has no history reader for its CLI, so none can come (PANEL-1.5, CLIS-2.4).
	 */
	readonly untitledPending: string;
	readonly untitledUnreadable: string;
	readonly location: (value: string) => string;
	readonly path: (value: string) => string;

	readonly pinned?: string;
	readonly starting: string;
	/** `Starting {0}…`, {0} the CLI's name: the startup stage while its process starts (LIFECYCLE-1.5). */
	readonly startingCli: (cli: string) => string;
	/** The startup stage while its new worktree is made (LIFECYCLE-1.5, WORKTREES-2.1). */
	readonly creatingWorktree: string;
	/** `New conversation started` and `Conversation resumed`: how its run began - a new conversation, or one it resumed - before any message (PANEL-1.4). */
	readonly started: string;
	readonly resumed: string;
	readonly working: string;
	readonly notWorking: string;
	/** `Error · {0}`, {0} the reason: a red card's state, as its accessible label says it; its second line says the reason alone (PANEL-1.4). */
	readonly error: (reason: string) => string;
	readonly activityUnavailable: string;
	/** Why its activity is unknown, in the person's words; agents read the English its report keeps (PANEL-1.4, MCP-3.1). */
	readonly activityUnknown: (why: ActivityUnknown) => string;
	readonly needsAttention: string;
	readonly toolsConnecting: string;
	readonly needsPermission: string;
	readonly needsSignIn: string;
	readonly hasQuestion: string;
	/** `Process exited · code {0}` and `Process terminated · {0}`: an abnormal exit, as Facade says it (RULES-3.3). */
	readonly exitedWithCode: (code: string) => string;
	readonly endedBySignal: (signal: string) => string;
	/** `Process lost · reason unknown`: a run its supervisor no longer had, how it ended not known (LIFECYCLE-3.5). */
	readonly exitUnknown: string;
	/** `Start failed · {0}` and `Worktree failed · {0}`, {0} the failure's reason without its closing period (PANEL-1.4). */
	readonly startFailed: (reason: string) => string;
	readonly worktreeFailed: (reason: string) => string;
	/** Why an agent cannot work with other agents - its Facade tools are not there - in plain words; it runs on without them (PANEL-1.4). */
	readonly toolsUnavailable: (problem: ToolsProblem | undefined, file: string | undefined) => string;
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
	/** What it is, as Facade's location pickers show it: a main checkout, a worktree, or a folder. */
	readonly kind: PlaceKind;
}

/**
 * The workspace folder's name a location is said after (PANEL-1.3): in a multi-folder window, where same-named branches need it -
 * not where the location is named that folder's name already, as a plain folder is (PANEL-1.3).
 */
export function folderPrefixOf(location: Pick<Location, 'label' | 'folders'>, catalog: Pick<Catalog, 'folders'>): string | undefined {
	const folder = location.folders[0];
	return catalog.folders.length > 1 && folder && folder.name !== location.label ? folder.name : undefined;
}

/**
 * The window's one place to work, where it has one (LIFECYCLE-1.3): one folder whose only location is a plain folder - one Git found
 * no repository in, or is missing for - which goes without saying wherever a location would be said. A folder Git is still reading,
 * or failed to read, may be a repository, whose branch is said.
 */
export function onePlaceOf(catalog: Catalog): Location | undefined {
	const [only, ...others] = catalog.locations.filter(location => !location.within);
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
	/** The second line, its mark first. */
	readonly line: string;
	/** What the state's words and the second line leave unsaid - why activity is unknown, tools still connecting - for the label. */
	readonly reason?: string;
	/** What the second line says where that is what was last sent, and who sent it. */
	readonly said?: CardSaid;
	/** What it says where that is Facade's own - a notable state, or how the run began - which carries no mark. */
	readonly notice?: string;
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
 * What a card says of its run (RULES-3.2, PANEL-1.4): its dot by {@link dotOf}; its second line one of three kinds - the person's input
 * `🧑‍💻`, another agent's message `📨`, or Facade's own, unmarked: a Facade result, or a notable state while it lasts - its start, over
 * any message; what its CLI waits for; why its dot is red - then the last message again; before any, how its run began,
 * `New conversation started` or `Conversation resumed`. Its state in words is the accessible label's, never the second line's, nor is a
 * title. Never a completion claim.
 */
export function statusOf(facts: RunFacts, words: CardWords): CardStatus {
	const dot = dotOf(facts);
	if (facts.error || facts.lifecycle === 'ended') {
		// Its second line says why without `Error · `, which its red dot says; its state, as a screen reader hears it, keeps it (PANEL-1.4)
		const reason = errorReasonOf(facts, words);
		return { dot, stateText: words.error(reason), ...noticeOf(reason) };
	}
	if (facts.blocker) {
		const kind = facts.blocker.kind === 'permission' ? words.needsPermission : facts.blocker.kind === 'auth' ? words.needsSignIn
			: facts.blocker.kind === 'question' ? words.hasQuestion : words.needsAttention;
		const detail = facts.blocker.text?.trim();
		const said = detail && detail !== kind ? `${kind} · ${detail}` : kind;
		return { dot, stateText: kind, ...noticeOf(said), ...detail && detail !== kind ? { reason: detail } : {} };
	}
	// Facade tools it cannot use, or a start that did not become ready: red, the second line saying why (RULES-3.2)
	if (dot === 'error') {
		const why = facts.tools === 'unavailable' ? words.toolsUnavailable(facts.toolsProblem, facts.toolsFile)
			: facts.tools === 'connecting' ? words.toolsConnecting : activityReasonOf(facts, words) || words.activityUnavailable;
		return { dot, stateText: why, ...noticeOf(why) };
	}
	const starting = facts.lifecycle === 'starting' || !!facts.awaitingActivity;
	const working = facts.lifecycle === 'running' && facts.reporting && facts.activity === 'working';
	const idle = facts.reporting && facts.activity === 'not_working';
	const stateText = working ? words.working : starting ? words.starting : idle ? words.notWorking : words.activityUnavailable;
	const activityReason = !working && !starting && !idle ? activityReasonOf(facts, words) : undefined;
	// Tools injected and not yet connected, while startup waits for them and after: the label says so until they connect (PANEL-1.4)
	const reason = [activityReason && activityReason !== stateText ? activityReason : undefined, facts.tools === 'connecting' ? words.toolsConnecting : undefined]
		.filter(Boolean).join(', ');
	const unsaid = reason ? { reason } : {};
	// Its start says its stage over any message, while it lasts (LIFECYCLE-1.5)
	if (starting) {
		return { dot, stateText, ...noticeOf(facts.phase === 'creating_worktree' ? words.creatingWorktree : words.startingCli(facts.displayName)), ...unsaid };
	}
	// The last message sent to it - the task it was started with being the first - else how its run began
	const said = saidOf(facts);
	return said ? { dot, stateText, line: said.line, said, ...unsaid } : { dot, stateText, ...noticeOf(facts.resumed ? words.resumed : words.started), ...unsaid };
}

/** The mark of the person's own input on its card: someone at a computer, as `📨` marks another agent's message (PANEL-1.4). */
export const PERSON_MARK = '\u{1F9D1}‍\u{1F4BB}';

/** The mark a Facade result begins with as it is typed to an agent; the card says the result without it (PANEL-1.4). */
const RESULT_MARK = /^\u{1F514}\s*/u;

/** Why its activity is unknown, in the person's words where its report says which reason it is (PANEL-1.4). */
function activityReasonOf(facts: RunFacts, words: CardWords): string | undefined {
	return facts.activityUnknown ? words.activityUnknown(facts.activityUnknown) : facts.activityReason?.trim();
}

/** `text`, Facade's own, as the second line says it: without any mark (PANEL-1.4). */
function noticeOf(text: string): Pick<CardStatus, 'line' | 'notice'> {
	return { line: text, notice: text };
}

/**
 * What was last sent to the run and by whom (PANEL-1.4): another agent's message - the task an agent-started run was started with
 * among them - marked `📨`, from who its record says sent it, never from its text; the person's input marked `🧑‍💻`; a Facade
 * result unmarked, without the `🔔` it is typed to its agent with.
 */
function saidOf(facts: RunFacts): CardSaid | undefined {
	if (facts.said) {
		const source = facts.saidSource;
		if (source?.kind === 'agent') {
			const sender = source.name ? `${source.name}${source.alias ? ` (${source.alias})` : ''}` : source.alias;
			return { line: `\u{1F4E8} ${facts.said}`, text: facts.said, kind: 'agent', ...sender ? { sender } : {}, ...source.window ? { window: source.window } : {} };
		}
		if (source?.kind === 'facade') {
			const result = facts.said.replace(RESULT_MARK, '');
			return { line: result, text: result, kind: 'facade' };
		}
		return { line: `${PERSON_MARK} ${facts.said}`, text: facts.said, kind: 'person' };
	}
	if (facts.promptLine) {
		const creator = facts.creatorLabel ?? facts.creator;
		// The label a start keeps is `name #aN`
		const sender = creator?.replace(/^(.+) (#a\d+)$/u, '$1 ($2)');
		return { line: `\u{1F4E8} ${facts.promptLine}`, text: facts.promptLine, kind: 'agent', ...sender ? { sender } : {} };
	}
	return undefined;
}

/**
 * Why a run is in error: an abnormal exit in the person's words, from how it ended (RULES-3.3); a failed start or worktree after
 * `Start failed` or `Worktree failed`, its reason without its closing period - its notification keeps its own sentence (PANEL-1.4,
 * WORKTREES-2.2); any other reason as it was given.
 */
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
	const reason = facts.error?.reason.trim();
	if (!reason) {
		return words.activityUnavailable;
	}
	return facts.error?.source === 'worktree' ? words.worktreeFailed(clauseOf(reason))
		: START_FAILURES.has(facts.error?.source ?? '') ? words.startFailed(clauseOf(reason)) : reason;
}

/** The sources of a start that failed before its process ran: its launch, or its working location gone (LIFECYCLE-1.5). */
const START_FAILURES = new Set(['launch', 'location']);

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
 * What a screen reader says before a value of a card's details, where the details show the value alone: its localized `Label: {0}`
 * template's words before the value, its colon among them (PANEL-1.5). Each such template keeps its value last, as l10n.test checks.
 */
export function labelOf(format: (value: string) => string): string {
	return format('');
}

/**
 * A run's card (PANEL-1.3-1.5): its dot and second line by {@link statusOf}; its details - its conversation's title, the agent that
 * started it, and where it works (the page adds when it started); and an accessible label of name, short run ID, state, location,
 * CLI and second line, its description the details' facts the label does not say.
 */
export function cardOf(facts: RunFacts, input: { readonly place: CardPlace; readonly repeated?: boolean; readonly selected: boolean; readonly menu: CardMenu; readonly words: CardWords; readonly readsTitles?: boolean }): Card {
	const { place, words } = input;
	const status = statusOf(facts, words);
	const field = (id: DetailId, format: (value: string) => string, value: string): DetailField => ({ id, label: labelOf(format), value });
	// Its conversation's complete title as its CLI stores it, where its CLI saved one; else why there is none - not yet, or never, for
	// a CLI Facade has no history reader for - after the same `Title: ` label (PANEL-1.5)
	const title = facts.title?.trim();
	const summary = title ? field('title', words.title, title) : undefined;
	const untitled = summary ? undefined : input.readsTitles === false ? words.untitledUnreadable : words.untitledPending;
	const creator = facts.origin === 'agent' ? facts.creatorLabel ?? facts.creator : undefined;
	// Where it works, always: its main checkout, worktree or folder, its icon saying which, then its path (PANEL-1.5)
	const location = { ...field('location', words.location, place.context), kind: place.kind };
	// The second line's source in words, not its mark: Facade's own words carry none
	const heard = status.said?.kind === 'agent' ? words.saidByAgent([status.said.sender, status.said.window].filter(Boolean).join(', '), status.said.text)
		: status.said?.kind === 'facade' ? words.saidByFacade(status.said.text)
			: status.said ? words.saidByPerson(status.said.text) : status.notice ?? status.line;
	// Said where it says what the state does not: a red card's reason is said once, in its state's `Error · {reason}` (PANEL-1.5)
	const restated = !status.said && (heard === status.stateText || words.error(heard) === status.stateText);
	// What the state and the second line leave unsaid - why activity is unknown, tools still connecting - once (PANEL-1.4, 1.5)
	const unsaid = status.reason && status.reason !== status.stateText && !heard.includes(status.reason) ? [status.reason] : [];
	const label = [facts.name, facts.alias, ...(facts.pin && words.pinned ? [words.pinned] : []), status.stateText, place.qualified, facts.displayName, ...restated ? [] : [heard], ...unsaid].filter(Boolean).join(', ');
	// The label says the state, the location and the second line: the description says what else the details do, in their order - its
	// title, then, after when it started, which the page says, where it works and its path
	const spoken = new Set([status.stateText, status.line, ...status.notice ? [status.notice] : [], ...status.said ? [status.said.text] : []]);
	const description = {
		title: summary ? spoken.has(summary.value) ? '' : words.title(summary.value) : words.title(untitled ?? ''),
		place: [...location.value !== place.qualified ? [words.location(location.value)] : [], words.path(place.path)].join(', ')
	};
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
		dot: status.dot,
		stateText: status.stateText,
		line: status.line,
		details: { ...summary ? { summary } : { untitled }, titleLabel: labelOf(words.title), ...creator ? { startedBy: creator } : {}, location, path: field('path', words.path, place.path), description },
		label,
		startedAt: facts.startedAt ?? facts.createdAt,
		menu: input.menu
	};
}
