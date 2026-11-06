/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homeRelative } from '../base/files';
import type { Agents, Catalog, Disposable, Event, Location, LocationId, LocationPort, RunChange, RunFacts, RunId } from '../core/ports';
import { repeatedNames } from '../core/names';
import type { CardMenu, PanelFilter, PanelState, PlaceKind } from '../webview/protocol';
import { cardOf, CardPlace, CardWords, folderPrefixOf, locationLabel, onePlaceOf } from './cardView';
import { arranged, atEnd, atStart, moved, PanelPrefs, withNew } from './order';

/** Reported text and activity reach the page at most this often; lifecycle changes and errors go at once (PANEL-3.1, UX-5.2). */
export const REPORT_COALESCE_MS = 300;

/** A monotonic clock and timers: real ones, or a test's. */
export interface Timers {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
	now: () => performance.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Where New Agent from the filtered empty panel starts (PANEL-1.2, LIFECYCLE-1.2): the filtered location, or a filtered folder's
 * own location, else its first; none without a filter or once it is gone.
 */
export function locationOfFilter(filter: PanelFilter | undefined, locations: readonly Location[]): LocationId | undefined {
	if (!filter) {
		return undefined;
	}
	const location = filter.kind === 'location' ? locations.find(each => each.id === filter.id)
		: locations.find(each => each.uri === filter.id) ?? locations.find(each => each.folders[0]?.uri === filter.id);
	// A folder inside a location starts nothing of its own: the location it is inside
	return location?.within ?? location?.id;
}

interface PanelModelDeps {
	readonly agents: Pick<Agents, 'list' | 'get' | 'onDidChange'> & Partial<Pick<Agents, 'pins' | 'reorderPins'>>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange' | 'onDidRemove' | 'removalOf'>;
	readonly prefs: PanelPrefs;
	readonly words: CardWords;
	readonly remote: boolean;
	/** Settles once this window's runs are reconciled: until then the panel is loading (PANEL-1.1). */
	readonly ready: Promise<unknown>;
	/** How a remote environment is named in a card's details (LIFECYCLE-1.1): as VS Code's remote indicator names it. */
	readonly environmentLabel?: (environment: string) => string;
	/** Whether Facade has a history reader for a CLI, so a run's title can come: a custom CLI has none (PANEL-1.5, CLIS-2.4). */
	readonly readsTitles?: (cli: string) => boolean;
	readonly timers?: Timers;
}

/** The selected agent, as the palette's context keys say it (UX-3.1, 3.2). */
export interface SelectedAgent {
	readonly run: RunId;
	readonly ended: boolean;
	readonly pinned?: boolean;
	readonly pinnable?: boolean;
}

/**
 * The panel's one state (PANEL-3.1): this window's runs in the manual stack's order (PANEL-2.1), the display filter (PANEL-2.3), the
 * selection, and every card already decided (PANEL-1.3-1.5). Whatever changes in one moment goes out as one state at the end of the
 * microtask; a CLI's reported text and activity at most once per {@link REPORT_COALESCE_MS}.
 */
export class PanelModel implements Disposable {
	private readonly timers: Timers;
	private readonly subscriptions: Disposable[] = [];
	private readonly listeners = new Set<(state: PanelState) => void>();
	private order: string[];
	private readonly pinByRun = new Map<RunId, string | undefined>();
	private filter: PanelFilter | undefined;
	private selectedRun: RunId | undefined;
	private loading = true;
	/** Every location seen, kept while it is only unavailable, gone on confirmed removal alone (PANEL-1.3, RULES-2.4). */
	private readonly known = new Map<LocationId, Location>();
	/** Runs removed by a normal exit since the last state: their cards may fade out (UX-2.2). */
	private readonly exited = new Set<RunId>();
	private current: PanelState;
	private selection: SelectedAgent | undefined;
	/** What the last state was made of, its revision aside: an equal one is not sent again. */
	private said = '';
	private queued = false;
	private reportTimer: unknown;
	private lastSent = Number.NEGATIVE_INFINITY;
	private disposed = false;

	readonly onDidChange: Event<PanelState> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	constructor(private readonly deps: PanelModelDeps) {
		this.timers = deps.timers ?? REAL_TIMERS;
		this.order = deps.prefs.order();
		this.filter = deps.prefs.filter();
		// A removal confirmed as the host restarted, before this panel listened, clears the filter it kept (PANEL-2.3, RULES-2.4)
		if (this.filter && this.removedFor(this.filter)) {
			this.setFilter(undefined);
		}
		for (const run of [...deps.agents.list()].sort((a, b) => a.createdAt - b.createdAt)) {
			this.order = withNew(this.order, run.id);
			this.pinByRun.set(run.id, run.pin);
		}
		const { state, selection } = this.compute(1);
		this.current = state;
		this.selection = selection;
		this.said = this.fingerprint(state, selection);
		this.subscriptions.push(
			deps.agents.onDidChange(change => this.changed(change)),
			deps.locations.onDidChange(() => this.locationsChanged()),
			deps.locations.onDidRemove(({ ids }) => this.removed(ids))
		);
		const settled = () => {
			this.loading = false;
			// Runs that ended while the window was closed leave the stack; those found again keep their places
			const present = new Set(deps.agents.list().map(run => run.id));
			this.setOrder(this.order.filter(run => present.has(run)));
			this.schedule();
		};
		void deps.ready.then(settled, settled);
	}

	dispose(): void {
		this.disposed = true;
		this.timers.clearTimeout(this.reportTimer);
		this.subscriptions.forEach(each => each.dispose());
		this.listeners.clear();
	}

	/** The state sent last. */
	state(): PanelState {
		return this.current;
	}

	/** The selected agent, as of the state sent last: what a palette command without a target is about (UX-3.1). */
	selectedAgent(): SelectedAgent | undefined {
		return this.selection;
	}

	/** Selects a card: a click, Go to Agent, a person's own launch (PANEL-2.1). */
	select(run: RunId): void {
		if (this.deps.agents.get(run)) {
			this.selectedRun = run;
			this.schedule();
		}
	}

	/**
	 * The editor's active terminal changed: selection follows an owned agent's terminal and survives a file or an unrelated terminal in
	 * front (PANEL-2.1); `undefined` is such a one.
	 */
	activated(run: RunId | undefined): void {
		if (run !== undefined) {
			this.selectedRun = run;
		}
		this.schedule();
	}

	/** This window's runs, every one whatever the filter shows, in the panel's order. */
	ordered(): RunFacts[] {
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(run => [run.id, run]));
		return this.arrangedIds(runs).map(id => byId.get(id)!);
	}

	currentFilter(): PanelFilter | undefined {
		return this.filter;
	}

	/** Shows the cards `filter` matches, or every card; kept in workspace storage (PANEL-2.3). */
	setFilter(filter: PanelFilter | undefined): void {
		this.filter = filter;
		this.deps.prefs.setFilter(filter);
		this.schedule();
	}

	/** How many of this window's cards `filter` shows - every card without one - starting and failed cards included (PANEL-2.3). */
	count(filter: PanelFilter | undefined): number {
		this.learn(this.deps.locations.snapshot());
		return this.deps.agents.list().filter(run => this.matches(run, filter)).length;
	}

	/** Moves a shown card one place up or down, hidden cards keeping theirs (PANEL-2.1). Answers whether it moved. */
	move(run: RunId, by: -1 | 1): boolean {
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(each => [each.id, each]));
		const next = moved(this.arrangedIds(runs), run, by, id => this.matches(byId.get(id), this.filter) && !!byId.get(id)?.pin === !!byId.get(run)?.pin);
		if (!next) {
			return false;
		}
		this.deps.agents.reorderPins?.(next.flatMap(id => byId.get(id)?.pin ? [byId.get(id)!.pin!] : []));
		this.setOrder(next);
		this.schedule();
		return true;
	}

	/**
	 * Whether the cards, and Go to Agent, say where each agent works (PANEL-1.3): not where every one works in the window's one place to
	 * work (LIFECYCLE-1.3), which goes without saying.
	 */
	placesShown(catalog: Catalog = this.deps.locations.snapshot()): boolean {
		const one = onePlaceOf(catalog);
		return !one || this.deps.agents.list().some(run => this.anchorOf(run) !== one.id);
	}

	/** Where a run works, as its card says it (PANEL-1.3): its location's label, after its folder's name in a multi-folder window. */
	placeOf(facts: RunFacts, catalog: Catalog = this.deps.locations.snapshot()): CardPlace {
		// A folder inside a main checkout, worktree or folder - a resumed conversation's own - shows as the location it is inside, with
		// its own path (WORKTREES-1.2)
		const own = this.known.get(facts.location) ?? catalog.locations.find(each => each.id === facts.location);
		// The catalog decides where it has the location; the anchor the run kept at acceptance only where it has none (WORKTREES-1.2)
		const anchor = own ? own.within : facts.within;
		const location = anchor !== undefined ? this.known.get(anchor) ?? catalog.locations.find(each => each.id === anchor) ?? own : own;
		const label = location?.label ?? baseName(facts.cwd);
		const folderPrefix = location ? folderPrefixOf(location, catalog) : undefined;
		const qualified = location ? locationLabel(location, catalog) : label;
		const environment = facts.environment !== 'local' ? this.deps.environmentLabel?.(facts.environment) ?? facts.environment : undefined;
		// Keep location context and path separate so the details never parse user-provided newlines (PANEL-1.5).
		const context = [qualified, environment].filter(Boolean).join(' · ');
		return { label, ...(folderPrefix ? { folderPrefix } : {}), qualified, context, path: homeRelative(own?.path ?? facts.cwd), kind: placeKindOf(location) };
	}

	private changed(change: RunChange): void {
		const pin = this.deps.agents.get(change.run)?.pin;
		if (change.kind !== 'removed' && this.pinByRun.get(change.run) !== pin) {
			// Pinned, it goes last among the Pins; unpinned, first among the other cards, just below the Pins it left (PANEL-2.1)
			this.setOrder(pin ? atEnd(this.order, change.run) : atStart(this.order, change.run));
		}
		if (change.kind === 'removed') { this.pinByRun.delete(change.run); } else { this.pinByRun.set(change.run, pin); }
		if (change.kind === 'added') {
			this.setOrder(withNew(this.order, change.run));
		} else if (change.kind === 'removed') {
			if (change.cause === 'exit') {
				this.exited.add(change.run);
			}
			this.setOrder(this.order.filter(run => run !== change.run));
			if (this.selectedRun === change.run) {
				this.selectedRun = undefined;
			}
		}
		if (change.kind === 'reported') {
			this.scheduleReport();
		} else {
			this.schedule();
		}
	}

	/** Confirmed location removal: its runs are closed by the lifecycle, and a filter of it clears (PANEL-2.3, RULES-2.4). */
	private removed(ids: readonly LocationId[]): void {
		for (const id of ids) {
			this.known.delete(id);
		}
		if (this.filter && (this.filter.kind === 'location' ? ids.includes(this.filter.id) : this.removedFor(this.filter))) {
			this.setFilter(undefined);
		}
		this.schedule();
	}

	/**
	 * The catalog changed. The editor's own folder list is the workspace's: a folder filter whose folder it no longer has clears,
	 * though the folder's locations may stay listed under another folder and so report no removal (PANEL-2.3, RULES-2.4).
	 */
	private locationsChanged(): void {
		if (this.filter?.kind === 'folder' && this.removedFor(this.filter)) {
			this.setFilter(undefined);
		}
		this.schedule();
	}

	/**
	 * Whether a filter's location or folder is confirmed removed: a location the location service reported removed, or a workspace
	 * folder the editor's own folder list no longer has - neither a Git read nor a remote observation (RULES-2.4).
	 */
	private removedFor(filter: PanelFilter): boolean {
		return filter.kind === 'location'
			? this.deps.locations.removalOf(filter.id) !== undefined
			: !this.deps.locations.snapshot().folders.some(folder => folder.uri === filter.id);
	}

	private setOrder(order: readonly string[]): void {
		if (!same(order, this.order)) {
			this.order = [...order];
			this.deps.prefs.setOrder(this.order);
		}
	}

	/** A change that goes at the end of this microtask. */
	private schedule(): void {
		if (this.queued || this.disposed) {
			return;
		}
		this.queued = true;
		queueMicrotask(() => this.send());
	}

	/** A reported change: at once after a quiet {@link REPORT_COALESCE_MS}, else at its end - unless a state goes before then. */
	private scheduleReport(): void {
		if (this.queued || this.reportTimer !== undefined || this.disposed) {
			return;
		}
		const wait = this.lastSent + REPORT_COALESCE_MS - this.timers.now();
		if (wait <= 0) {
			this.schedule();
			return;
		}
		this.reportTimer = this.timers.setTimeout(() => {
			this.reportTimer = undefined;
			this.schedule();
		}, wait);
	}

	private send(): void {
		this.queued = false;
		if (this.disposed) {
			return;
		}
		// What was reported meanwhile goes with this state: no state waits for the coalescer's end
		this.timers.clearTimeout(this.reportTimer);
		this.reportTimer = undefined;
		this.lastSent = this.timers.now();
		const { state, selection } = this.compute(this.current.revision + 1);
		const said = this.fingerprint(state, selection);
		if (said === this.said) {
			return;
		}
		this.said = said;
		this.current = state;
		this.selection = selection;
		for (const listener of [...this.listeners]) {
			listener(state);
		}
	}

	private fingerprint(state: PanelState, selection: SelectedAgent | undefined): string {
		return JSON.stringify([{ ...state, revision: 0 }, selection]);
	}

	private compute(revision: number): { readonly state: PanelState; readonly selection?: SelectedAgent } {
		const catalog = this.deps.locations.snapshot();
		this.learn(catalog);
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(run => [run.id, run]));
		const ids = this.arrangedIds(runs);
		const filter = this.filter && this.labeled(this.filter, catalog);
		const shown = ids.filter(id => this.matches(byId.get(id), filter));
		const shownSet = new Set(shown);
		// Counted among all of this window's cards, those the filter hides too (PANEL-1.3)
		const repeated = repeatedNames(runs);
		const visible = (id: string) => shownSet.has(id);
		const cards = shown.map(id => {
			const facts = byId.get(id)!;
			const withinArea = (other: string) => visible(other) && !!byId.get(other)?.pin === !!facts.pin;
			const menu: CardMenu = {
				...(facts.pinnable && !facts.pin ? { pin: true } : {}),
				...(facts.pin ? { unpin: true } : {}),
				moveUp: moved(ids, id, -1, withinArea) !== undefined,
				moveDown: moved(ids, id, 1, withinArea) !== undefined
			};
			return cardOf(facts, { place: this.placeOf(facts, catalog), repeated: repeated.has(facts.name.trim()), selected: id === this.selectedRun, menu, words: this.deps.words, ...this.deps.readsTitles ? { readsTitles: this.deps.readsTitles(facts.cli) } : {} });
		});
		const exited = [...this.exited];
		this.exited.clear();
		const empty: PanelState['empty'] = this.loading || cards.length ? undefined : filter ? 'noMatch' : catalog.folders.length ? 'noAgents' : 'noFolder';
		const selected = this.selectedRun === undefined ? undefined : byId.get(this.selectedRun);
		return {
			state: {
				revision,
				loading: this.loading,
				cards,
				cardCount: runs.length,
				...(filter ? { filter } : {}),
				...(empty ? { empty } : {}),
				capabilities: { remote: this.deps.remote },
				...(exited.length ? { exited } : {})
			},
			...(selected ? { selection: { run: selected.id, ended: selected.lifecycle === 'ended', ...(selected.pin ? { pinned: true } : {}), ...(selected.pinnable ? { pinnable: true } : {}) } } : {})
		};
	}

	private learn(catalog: Catalog): void {
		for (const location of catalog.locations) {
			this.known.set(location.id, location);
		}
	}

	/** The run IDs of `runs` as the panel lists them: by the stack, any it does not know yet last, oldest first (PANEL-2.1). */
	private arrangedIds(runs: readonly RunFacts[]): string[] {
		const order = arranged(this.order, [...runs].sort((a, b) => a.createdAt - b.createdAt).map(run => run.id));
		const byId = new Map(runs.map(run => [run.id, run]));
		const pins = this.deps.agents.pins?.().map(pin => pin.id) ?? [];
		const pinned = order.filter(id => byId.get(id)?.pin);
		pinned.sort((a, b) => pins.indexOf(byId.get(a)!.pin!) - pins.indexOf(byId.get(b)!.pin!));
		return [...pinned, ...order.filter(id => !byId.get(id)?.pin)];
	}

	/** The filter as the view names it now: a location's current label, a folder's name; the label kept where neither is known. */
	private labeled(filter: PanelFilter, catalog: Catalog): PanelFilter {
		let label = filter.label;
		if (filter.kind === 'folder') {
			label = catalog.folders.find(folder => folder.uri === filter.id)?.name ?? label;
		} else {
			const location = this.known.get(filter.id);
			if (location) {
				label = locationLabel(location, catalog);
			}
		}
		if (label !== filter.label) {
			this.filter = { ...filter, label };
			this.deps.prefs.setFilter(this.filter);
		}
		return this.filter!;
	}

	/** Whether `filter` shows the card of `facts`: its location's, or one of its location's workspace folders (PANEL-2.3). */
	private matches(facts: RunFacts | undefined, filter: Omit<PanelFilter, 'label'> | undefined): boolean {
		if (!facts) {
			return false;
		}
		if (!filter) {
			return true;
		}
		if (filter.kind === 'location') {
			return this.anchorOf(facts) === this.locationOf(filter.id);
		}
		return (this.known.get(facts.location) ?? (facts.within !== undefined ? this.known.get(facts.within) : undefined))?.folders.some(folder => folder.uri === filter.id) ?? false;
	}

	/** The location `id` counts as: the one it is inside, for a folder inside a main checkout, worktree or folder (WORKTREES-1.2). */
	private locationOf(id: LocationId): LocationId {
		return this.known.get(id)?.within ?? id;
	}

	/** The location a run counts as: also where the catalog has no record of its Resume cwd yet, or never will, its start having failed. */
	private anchorOf(facts: Pick<RunFacts, 'location' | 'within'>): LocationId {
		const known = this.known.get(facts.location);
		return known ? known.within ?? known.id : facts.within ?? facts.location;
	}
}

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((each, at) => each === b[at]);
}

/** The last name of a path in any environment's separators. */
function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * A location's kind as its icon says it (PANEL-1.5, WORKTREES-1.2): a checkout's root is a main checkout or a worktree; a folder - one
 * opened inside a checkout among them - is a folder. Resolve a Resume cwd to its anchor first.
 */
export function placeKindOf(location: Pick<Location, 'kind' | 'isMain' | 'subfolder'> | undefined): PlaceKind {
	return location?.kind !== 'checkout' || location.subfolder ? 'folder' : location.isMain ? 'repo' : 'worktree';
}
