/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Catalog, Location, RunFacts, WorktreeCreationEffects } from '../core/ports';
import type { AvatarColor, Card, CardMenu } from '../webview/protocol';

/** The words a card is said in, in the person's language. */
export interface CardWords {
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
	readonly readyForInput: string;
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
	/** The qualified location with its environment and path: the hover's last line. */
	readonly full: string;
}

/**
 * The workspace folder's name a location is said after (PANEL-1.3): in a multi-folder window, where same-named branches need it -
 * not where the location is named that folder's name already, as a plain folder is (D66).
 */
export function folderPrefixOf(location: Pick<Location, 'label' | 'folders'>, catalog: Pick<Catalog, 'folders'>): string | undefined {
	const folder = location.folders[0];
	return catalog.folders.length > 1 && folder && folder.name !== location.label ? folder.name : undefined;
}

/** A location as the person reads it alone (PANEL-1.3): its label, after its workspace folder's name in a multi-folder window. */
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
}

/**
 * What is known of a run, in RULES-3.2's precedence and PANEL-1.4's second-line priority: an unresolved error is red with its
 * reason; a native blocker is yellow in the CLI's words, leading the second line, red beside unknown activity; startup - until
 * its CLI first shows its activity (CLIS-2.3, D81) - is green with its stage; reliable activity is green or yellow over the CLI
 * title or a fallback; without reliable activity the dot is red and the second line says why. Never a completion claim.
 */
export function statusOf(facts: RunFacts, words: CardWords): CardStatus {
	if (facts.error || facts.lifecycle === 'ended') {
		const reason = errorReasonOf(facts, words);
		return { dot: 'error', stateText: words.error(reason), line: reason };
	}
	if (facts.blocker) {
		const said = facts.blocker.text?.trim() || (facts.blocker.kind === 'permission' ? words.needsPermission : facts.blocker.kind === 'auth' ? words.needsSignIn : words.hasQuestion);
		if (facts.reporting || facts.lifecycle === 'starting') {
			return { dot: 'idle', stateText: words.notWorking, line: said, reason: said };
		}
		// Unknown activity stays red; the blocker leads and the status explanation is kept (PANEL-1.4)
		const unknown = facts.activityReason?.trim() || words.activityUnavailable;
		return { dot: 'error', stateText: words.activityUnavailable, line: `${said} · ${unknown}`, reason: said };
	}
	if (facts.lifecycle === 'starting' || facts.awaitingActivity) {
		return { dot: 'working', stateText: words.starting, line: facts.phase === 'creating_worktree' ? words.creatingWorktree : words.startingCli(facts.displayName) };
	}
	if (facts.reporting && facts.activity === 'working') {
		return { dot: 'working', stateText: words.working, line: facts.title || words.working };
	}
	if (facts.reporting && facts.activity === 'not_working') {
		return { dot: 'idle', stateText: words.notWorking, line: facts.title || words.readyForInput };
	}
	const reason = facts.activityReason?.trim() || words.activityUnavailable;
	return { dot: 'error', stateText: words.activityUnavailable, line: reason, ...(reason !== words.activityUnavailable ? { reason } : {}) };
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

/** A run's reference, as a message names it (LIFECYCLE-2.1): `@name #aN`, the ID deciding. */
export function referenceOf(facts: Pick<RunFacts, 'name' | 'alias'>): string {
	return `@${facts.name} ${facts.alias}`;
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
export function cardOf(facts: RunFacts, input: { readonly place: CardPlace; readonly selected: boolean; readonly menu: CardMenu; readonly words: CardWords; readonly window?: string }): Card {
	const { place, words } = input;
	const status = statusOf(facts, words);
	const tooltip = [
		// An empty name is left out, not said as an empty part (LIFECYCLE-2.1)
		[facts.name, facts.alias, facts.displayName].filter(Boolean).join(' · '),
		...facts.title ? [facts.title] : [],
		status.stateText,
		...status.reason && status.reason !== facts.title ? [status.reason] : []
	];
	const label = [facts.name, facts.alias, ...(facts.pin && words.pinned ? [words.pinned] : []), status.stateText, place.qualified, facts.displayName, ...status.line !== status.stateText ? [status.line] : []].filter(Boolean).join(', ');
	const avatar = avatarOf(facts.cli, facts.displayName, words.locale);
	return {
		runId: facts.id,
		...(facts.pin ? { pinned: true } : {}),
		selected: input.selected,
		name: facts.name,
		alias: facts.alias,
		...(avatar ? { avatar } : {}),
		location: { label: place.label, ...(place.folderPrefix ? { folderPrefix: place.folderPrefix } : {}), full: input.window ? `${place.full}\n${words.window(input.window)}` : place.full },
		dot: status.dot,
		stateText: status.stateText,
		line: status.line,
		tooltip,
		label,
		startedAt: facts.startedAt ?? facts.createdAt,
		menu: input.menu
	};
}
