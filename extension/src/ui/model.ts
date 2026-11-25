/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homeRelative } from '../base/files';
import type { Agents, Catalog, Disposable, Event, Location, LocationId, LocationPort, RunChange, RunFacts, RunId } from '../core/ports';
import { placeKindOf } from '../core/locations/catalog';
import { repeatedNames } from '../core/names';
import { canDismiss } from '../core/ports';
import type { CardMenu, DirectoryFilter, DisplayFilter, FilterChoice, PanelFilter, PanelState } from '../webview/protocol';
import { cardOf, CardPlace, CardWords, folderPrefixOf, frameworkStateOf, frameworkStateText, isAgentRunning, locationLabel, onePlaceOf } from './cardView';
import { agentFilter, arranged, atEnd, atStart, filterCategory, filterChoiceKey, FILTER_STATES, moved, PanelPrefs, withNew } from './order';

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
 * Where New Agent from the filtered empty panel starts (PANEL-4.3, PANEL-1.2): a location condition must identify
 * one destination. Earlier folder preferences still resolve to the folder's own location, else its first.
 */
export function locationOfFilter(filter: DisplayFilter | undefined, locations: readonly Location[]): LocationId | undefined {
	const choices = locationChoices(filter);
	if (!choices.length) { return undefined; }
	const destinations = new Set<LocationId>();
	for (const choice of choices) {
		if (choice.kind === 'directory') { return undefined; }
		const id = locationOfChoice(choice, locations);
		if (id === undefined) { return undefined; }
		destinations.add(id);
	}
	return destinations.size === 1 ? destinations.values().next().value : undefined;
}

function locationChoices(filter: DisplayFilter | undefined): readonly (PanelFilter | DirectoryFilter)[] {
	if (!filter) { return []; }
	return filter.kind === 'agents'
		? filter.choices.filter((choice): choice is PanelFilter | DirectoryFilter =>
			choice.kind === 'location' || choice.kind === 'folder' || choice.kind === 'directory')
		: [filter];
}

function locationOfChoice(choice: PanelFilter, locations: readonly Location[]): LocationId | undefined {
	const location = choice.kind === 'location' ? locations.find(each => each.id === choice.id)
		: locations.find(each => each.uri === choice.id) ?? locations.find(each => each.folders[0]?.uri === choice.id);
	// A folder inside a location starts nothing of its own: the location it is inside
	return location?.within ?? location?.id;
}

/** The exact destination selected outside the window's location catalog (PANEL-4.3). */
export function directoryOfFilter(filter: DisplayFilter | undefined): { readonly machineId: string; readonly folder: string } | undefined {
	const choices = locationChoices(filter);
	const only = choices[0];
	return choices.length === 1 && only?.kind === 'directory' ? { machineId: only.machineId, folder: only.folder } : undefined;
}

interface PanelModelDeps {
	readonly agents: Pick<Agents, 'list' | 'get' | 'onDidChange'> & Partial<Pick<Agents, 'pins' | 'reorderPins'>>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange' | 'onDidRemove' | 'removalOf'>;
	readonly prefs: PanelPrefs;
	readonly words: CardWords;
	readonly orchestrator?: boolean;
	readonly remote: boolean;
	/** Settles once this window's runs are reconciled: until then the panel is loading (PANEL-1.1). */
	readonly ready: Promise<unknown>;
	/** How a remote environment is named in a card's details (LIFECYCLE-1.1): as VS Code's remote indicator names it. */
	readonly environmentLabel?: (environment: string) => string;
	/** Whether Facade has a history reader for a CLI, so a run's title can come: a program has none (PANEL-1.5, CLIS-2.4). */
	readonly readsTitles?: (cli: string) => boolean;
	/** The icon each CLI shows, by its API ID, from one reading of the settings file (CONFIGURATION-2.4); none: each name's own. */
	readonly icons?: () => (cli: string) => string;
	readonly timers?: Timers;
}

/** The selected agent, as the palette's context keys say it (UX-3.1, 3.2). */
export interface SelectedAgent {
	readonly run: RunId;
	readonly ended: boolean;
	readonly running?: boolean;
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
	private readonly layoutKeys = new Map<RunId, string>();
	private readonly pinByRun = new Map<RunId, string | undefined>();
	private filter: DisplayFilter | undefined;
	private selectedRun: RunId | undefined;
	private pendingSelection: string | undefined;
	private loading = true;
	private reconciling: Promise<unknown> | undefined;
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
		this.pendingSelection = deps.prefs.selection();
		// A removal confirmed as the host restarted, before this panel listened, clears the filter it kept (PANEL-2.3, RULES-2.4)
		this.dropFilterLocations(choice => this.removedFor(choice));
		for (const run of [...deps.agents.list()].sort((a, b) => a.createdAt - b.createdAt)) {
			const key = deps.prefs.keyOf(run);
			this.layoutKeys.set(run.id, key);
			this.order = withNew(this.order, key);
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
		this.reconcile(deps.ready);
	}

	/** Loads the presentation of a newly bound logical window while core reconciles its members. */
	rebind(ready: Promise<unknown>): void {
		this.order = this.deps.prefs.order();
		this.filter = this.deps.prefs.filter();
		this.dropFilterLocations(choice => this.removedFor(choice));
		this.selectedRun = undefined;
		this.pendingSelection = this.deps.prefs.selection();
		this.known.clear();
		this.exited.clear();
		this.pinByRun.clear();
		this.layoutKeys.clear();
		this.reconcile(ready);
		this.schedule();
	}

	private reconcile(ready: Promise<unknown>): void {
		this.reconciling = ready;
		this.loading = true;
		const settled = () => {
			if (this.disposed || this.reconciling !== ready) { return; }
			this.loading = false;
			// Runs that ended while the window was closed leave the stack; those found again keep their places.
			const present = new Set(this.deps.agents.list().map(run => this.deps.prefs.keyOf(run)));
			this.setOrder(this.order.filter(run => present.has(run)));
			this.schedule();
		};
		void ready.then(settled, settled);
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

	/** The cards drawn again: the settings file changed, and with it the icons they show (CONFIGURATION-2.4). */
	refresh(): void {
		this.schedule();
	}

	/** The selected agent, as of the state sent last: what a palette command without a target is about (UX-3.1). */
	selectedAgent(): SelectedAgent | undefined {
		return this.selection;
	}

	usesOrchestrator(): boolean {
		return this.deps.orchestrator === true;
	}

	runFacts(run: RunId): RunFacts | undefined {
		return this.deps.agents.get(run);
	}

	/** Selects a card: a click, Go to Agent, a person's own launch (PANEL-2.1). */
	select(run: RunId): RunFacts | undefined {
		const facts = this.runFacts(run);
		if (facts) {
			this.choose(run);
			this.schedule();
		}
		return facts;
	}

	/**
	 * The editor's active terminal changed: selection follows an owned agent's terminal and survives a file or an unrelated terminal in
	 * front (PANEL-2.1); `undefined` is such a one.
	 */
	activated(run: RunId | undefined): void {
		if (run !== undefined) {
			this.choose(run);
		}
		this.schedule();
	}

	private choose(run: RunId | undefined): void {
		if (run === this.selectedRun) { return; }
		this.pendingSelection = undefined;
		this.selectedRun = run;
		this.deps.prefs.setSelection(run === undefined ? undefined : this.layoutKeys.get(run) ?? run);
	}

	/** This window's runs, every one whatever the filter shows, in the panel's order. */
	ordered(): RunFacts[] {
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(run => [run.id, run]));
		return this.arrangedIds(runs).map(id => byId.get(id)!);
	}

	currentFilter(): DisplayFilter | undefined {
		return this.filter;
	}

	/** Shows the cards `filter` matches, or every card; kept in workspace storage (PANEL-2.3). */
	setFilter(filter: DisplayFilter | undefined): void {
		this.filter = filter?.kind === 'agents' ? agentFilter(filter.choices) : filter;
		this.deps.prefs.setFilter(this.filter);
		this.schedule();
	}

	/** Options come from the whole workspace so one choice never hides alternatives in another category. */
	filterChoices(catalog: Catalog): readonly FilterChoice[] {
		this.learn(catalog);
		const choices = new Map<string, FilterChoice>();
		const add = (choice: FilterChoice) => choices.set(filterChoiceKey(choice), choice);
		const machines = new Map<string, string>();
		for (const facts of this.deps.agents.list()) {
			if (!facts.orchestrator) { continue; }
			const { reference, machine } = facts.orchestrator;
			machines.set(reference.machine_id, machine ?? reference.machine_id);
			add({ kind: 'cli', id: facts.cli, label: facts.displayName });
			const location = this.known.get(this.anchorOf(facts));
			if (location) {
				add({ kind: 'location', id: location.id, label: locationLabel(location, catalog) });
			} else if (facts.cwd) {
				add({ kind: 'directory', machineId: reference.machine_id, folder: facts.cwd, label: facts.cwd });
			}
		}
		const repeated = repeatedNames([...machines.values()].map(name => ({ name })));
		for (const [id, name] of machines) {
			add({ kind: 'machine', id, label: repeated.has(name.trim()) ? `${name} (${id})` : name });
		}
		for (const state of FILTER_STATES) {
			add({ kind: 'state', id: state, label: frameworkStateText(state, this.deps.words) });
		}
		return [...choices.values()];
	}

	/** How many of this window's cards `filter` shows - every card without one - starting and failed cards included (PANEL-2.3). */
	count(filter: DisplayFilter | undefined): number {
		this.learn(this.deps.locations.snapshot());
		return this.deps.agents.list().filter(this.matching(filter)).length;
	}

	/** Moves a shown card one place up or down, hidden cards keeping theirs (PANEL-2.1). Answers whether it moved. */
	move(run: RunId, by: -1 | 1): boolean {
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(each => [each.id, each]));
		this.learn(this.deps.locations.snapshot());
		const matches = this.matching(this.filter);
		const next = moved(this.arrangedIds(runs), run, by, id => matches(byId.get(id)) && !!byId.get(id)?.pin === !!byId.get(run)?.pin);
		if (!next) {
			return false;
		}
		this.deps.agents.reorderPins?.(next.flatMap(id => byId.get(id)?.pin ? [byId.get(id)!.pin!] : []));
		this.setOrder(next.map(id => this.layoutKeys.get(id) ?? id));
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
		if (facts.remoteMachine !== undefined) {
			const label = baseName(facts.cwd);
			return { label, qualified: label, context: label, path: facts.cwd, kind: 'folder' };
		}
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
		const facts = this.deps.agents.get(change.run);
		const pin = facts?.pin;
		const previous = this.layoutKeys.get(change.run) ?? change.run;
		const key = facts ? this.deps.prefs.keyOf(facts) : previous;
		if (change.kind === 'removed') {
			this.layoutKeys.delete(change.run);
		} else {
			this.layoutKeys.set(change.run, key);
			if (previous !== key) {
				this.setOrder(this.order.map(id => id === previous ? key : id));
				if (this.selectedRun === change.run) { this.deps.prefs.setSelection(key); }
			}
		}
		if (change.kind !== 'removed' && this.pinByRun.get(change.run) !== pin) {
			// Pinned, it goes last among the Pins; unpinned, first among the other cards, just below the Pins it left (PANEL-2.1)
			this.setOrder(pin ? atEnd(this.order, key) : atStart(this.order, key));
		}
		if (change.kind === 'removed') { this.pinByRun.delete(change.run); } else { this.pinByRun.set(change.run, pin); }
		if (change.kind === 'added') {
			this.setOrder(withNew(this.order, key));
		} else if (change.kind === 'removed') {
			if (change.cause === 'exit') {
				this.exited.add(change.run);
			}
			this.setOrder(this.order.filter(run => run !== key));
			if (this.selectedRun === change.run) {
				this.choose(undefined);
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
		this.dropFilterLocations(choice => choice.kind === 'location' ? ids.includes(choice.id) : this.removedFor(choice));
		this.schedule();
	}

	/**
	 * The catalog changed. The editor's own folder list is the workspace's: a folder filter whose folder it no longer has clears,
	 * though the folder's locations may stay listed under another folder and so report no removal (PANEL-2.3, RULES-2.4).
	 */
	private locationsChanged(): void {
		this.dropFilterLocations(choice => choice.kind === 'folder' && this.removedFor(choice));
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

	private dropFilterLocations(removed: (choice: PanelFilter) => boolean): void {
		const filter = this.filter;
		if (!filter) { return; }
		if (filter.kind !== 'agents') {
			if (removed(filter)) { this.setFilter(undefined); }
			return;
		}
		const remaining = filter.choices.filter(choice => (choice.kind !== 'location' && choice.kind !== 'folder') || !removed(choice));
		if (remaining.length !== filter.choices.length) { this.setFilter(agentFilter(remaining)); }
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
		if (this.pendingSelection !== undefined) {
			const restored = runs.find(run => this.deps.prefs.keyOf(run) === this.pendingSelection);
			if (restored) {
				this.selectedRun = restored.id;
			}
			if (restored || !this.loading) {
				this.pendingSelection = undefined;
			}
		}
		const byId = new Map(runs.map(run => [run.id, run]));
		const ids = this.arrangedIds(runs);
		const filter = this.filter && this.labeled(this.filter, catalog);
		const matches = this.matching(this.filter);
		const shown = ids.filter(id => matches(byId.get(id)));
		const shownSet = new Set(shown);
		// Counted among all of this window's cards, those the filter hides too (PANEL-1.3)
		const repeated = repeatedNames(runs);
		const icon = this.deps.icons?.();
		const orchestrator = this.usesOrchestrator();
		const visible = (id: string) => shownSet.has(id);
		const cards = shown.map(id => {
			const facts = byId.get(id)!;
			const canPin = orchestrator || facts.remoteMachine === undefined;
			const withinArea = (other: string) => visible(other) && !!byId.get(other)?.pin === !!facts.pin;
			const menu: CardMenu = {
				...(!orchestrator && canDismiss(facts) ? { dismiss: true } : {}),
				...(canPin && facts.pinnable && !facts.pin ? { pin: true } : {}),
				...(canPin && facts.pin ? { unpin: true } : {}),
				moveUp: moved(ids, id, -1, withinArea) !== undefined,
				moveDown: moved(ids, id, 1, withinArea) !== undefined
			};
			return cardOf(facts, { place: this.placeOf(facts, catalog), repeated: repeated.has(facts.name.trim()), selected: id === this.selectedRun, menu, words: this.deps.words, ...this.deps.readsTitles ? { readsTitles: this.deps.readsTitles(facts.builtIn ?? facts.cli) } : {}, ...icon ? { icon: icon(facts.cli) } : {} });
		});
		const exited = [...this.exited];
		this.exited.clear();
		const empty: PanelState['empty'] = this.loading || cards.length ? undefined : filter ? 'noMatch' : catalog.folders.length ? 'noAgents' : 'noFolder';
		const selected = this.selectedRun === undefined ? undefined : byId.get(this.selectedRun);
		const canPinSelected = orchestrator || selected?.remoteMachine === undefined;
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
			...(selected ? { selection: { run: selected.id, ended: canDismiss(selected), ...(orchestrator ? { running: isAgentRunning(selected) } : {}), ...(canPinSelected && selected.pin ? { pinned: true } : {}), ...(canPinSelected && selected.pinnable ? { pinnable: true } : {}) } } : {})
		};
	}

	private learn(catalog: Catalog): void {
		for (const location of catalog.locations) {
			this.known.set(location.id, location);
		}
	}

	/** The run IDs of `runs` as the panel lists them: by the stack, any it does not know yet last, oldest first (PANEL-2.1). */
	private arrangedIds(runs: readonly RunFacts[]): string[] {
		const orderedByAge = [...runs].sort((a, b) => a.createdAt - b.createdAt);
		const byKey = new Map(orderedByAge.map(run => [this.deps.prefs.keyOf(run), run.id]));
		const order = arranged(this.order, [...byKey.keys()]).map(key => byKey.get(key)!);
		const byId = new Map(runs.map(run => [run.id, run]));
		const pins = this.deps.agents.pins?.().map(pin => pin.id) ?? [];
		const pinned = order.filter(id => byId.get(id)?.pin);
		pinned.sort((a, b) => pins.indexOf(byId.get(a)!.pin!) - pins.indexOf(byId.get(b)!.pin!));
		return [...pinned, ...order.filter(id => !byId.get(id)?.pin)];
	}

	/** The filter as the view names it now: a location's current label, a folder's name; the label kept where neither is known. */
	private labeled(filter: DisplayFilter, catalog: Catalog): NonNullable<PanelState['filter']> {
		if (filter.kind === 'agents') {
			return { kind: 'agents', id: JSON.stringify(filter.choices.map(filterChoiceKey)), label: filter.choices.map(choice => choice.label).join(', ') };
		}
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
		return { ...filter, label };
	}

	/** Every selected category must have a matching choice (PANEL-4.3). */
	private matching(filter: DisplayFilter | undefined): (facts: RunFacts | undefined) => boolean {
		if (!filter) { return facts => facts !== undefined; }
		if (filter.kind !== 'agents') { return facts => !!facts && this.matchesChoice(facts, filter); }
		const groups = new Map<ReturnType<typeof filterCategory>, FilterChoice[]>();
		for (const choice of filter.choices) {
			const category = filterCategory(choice);
			const group = groups.get(category);
			if (group) { group.push(choice); } else { groups.set(category, [choice]); }
		}
		const required = [...groups.values()];
		return facts => !!facts && required.every(group => group.some(choice => this.matchesChoice(facts, choice)));
	}

	private matchesChoice(facts: RunFacts, choice: FilterChoice): boolean {
		switch (choice.kind) {
			case 'machine': return facts.orchestrator?.reference.machine_id === choice.id;
			case 'directory': return facts.orchestrator?.reference.machine_id === choice.machineId && facts.cwd === choice.folder;
			case 'cli': return facts.cli === choice.id;
			case 'state': return facts.orchestrator !== undefined && frameworkStateOf(facts.orchestrator.state, facts) === choice.id;
			case 'pin': return (facts.pin ? 'pinned' : 'unpinned') === choice.id;
			case 'location': return facts.remoteMachine === undefined && this.anchorOf(facts) === this.locationOf(choice.id);
			case 'folder': return facts.remoteMachine === undefined
				&& ((this.known.get(facts.location) ?? (facts.within !== undefined ? this.known.get(facts.within) : undefined))
					?.folders.some(folder => folder.uri === choice.id) ?? false);
		}
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
