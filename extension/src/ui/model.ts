/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homeRelative } from '../base/files';
import type { Agents, Catalog, Disposable, Event, Location, LocationId, LocationPort, RunChange, RunFacts, RunId } from '../core/ports';
import type { CardMenu, PanelState } from '../webview/protocol';
import { cardOf, CardPlace, CardWords, folderPrefixOf } from './cardView';
import { arranged, moved, PanelPrefs, withNew } from './order';

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

interface PanelModelDeps {
	readonly agents: Pick<Agents, 'list' | 'get' | 'onDidChange'>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange' | 'onDidRemove'>;
	readonly prefs: PanelPrefs;
	readonly words: CardWords;
	readonly remote: boolean;
	/** This window's name, as the hover says where an agent is (PANEL-1.5). */
	readonly window?: string;
	/** Settles once this window's runs are reconciled: until then the panel is loading (PANEL-1.1). */
	readonly ready: Promise<unknown>;
	/** How a remote environment is named in a hover (LIFECYCLE-1.1): as VS Code's remote indicator names it. */
	readonly environmentLabel?: (environment: string) => string;
	readonly timers?: Timers;
}

/** The selected agent, as the palette's context keys say it (UX-3.1, 3.2). */
export interface SelectedAgent {
	readonly run: RunId;
	readonly ended: boolean;
}

/**
 * The panel's one state (PANEL-3.1): this window's runs in the manual stack's order (PANEL-2.1), the selection, and every card
 * already decided (PANEL-1.3-1.5). Whatever changes in one moment goes out as one state at the end of the
 * microtask; a CLI's reported text and activity at most once per {@link REPORT_COALESCE_MS}.
 */
export class PanelModel implements Disposable {
	private readonly timers: Timers;
	private readonly subscriptions: Disposable[] = [];
	private readonly listeners = new Set<(state: PanelState) => void>();
	private order: string[];
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
		for (const run of [...deps.agents.list()].sort((a, b) => a.createdAt - b.createdAt)) {
			this.order = withNew(this.order, run.id);
		}
		const { state, selection } = this.compute(1);
		this.current = state;
		this.selection = selection;
		this.said = this.fingerprint(state, selection);
		this.subscriptions.push(
			deps.agents.onDidChange(change => this.changed(change)),
			deps.locations.onDidChange(() => this.schedule()),
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

	/** This window's runs, in the panel's order. */
	ordered(): RunFacts[] {
		const runs = this.deps.agents.list();
		const byId = new Map(runs.map(run => [run.id, run]));
		return this.arrangedIds(runs).map(id => byId.get(id)!);
	}

	/** Moves a card one place up or down (PANEL-2.1). Answers whether it moved. */
	move(run: RunId, by: -1 | 1): boolean {
		const next = moved(this.arrangedIds(this.deps.agents.list()), run, by);
		if (!next) {
			return false;
		}
		this.setOrder(next);
		this.schedule();
		return true;
	}

	/** Where a run works, as its card says it (PANEL-1.3): its location's label, after its folder's name in a multi-folder window. */
	placeOf(facts: RunFacts, catalog: Catalog = this.deps.locations.snapshot()): CardPlace {
		const location = this.known.get(facts.location) ?? catalog.locations.find(each => each.id === facts.location);
		const label = location?.label ?? baseName(facts.cwd);
		const folderPrefix = location ? folderPrefixOf(location, catalog) : undefined;
		const qualified = folderPrefix ? `${folderPrefix} · ${label}` : label;
		const environment = facts.environment !== 'local' ? this.deps.environmentLabel?.(facts.environment) ?? facts.environment : undefined;
		// A fact a line (PANEL-1.5, D74): where it works, then its folder - the home folder as ~, not on Windows - which the editor's
		// tooltip then never breaks mid-line
		const full = `${[qualified, environment].filter(Boolean).join(' · ')}\n${homeRelative(location?.path ?? facts.cwd)}`;
		return { label, ...(folderPrefix ? { folderPrefix } : {}), qualified, full };
	}

	private changed(change: RunChange): void {
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

	/** Confirmed location removal: its runs are closed by the lifecycle (RULES-2.4). */
	private removed(ids: readonly LocationId[]): void {
		for (const id of ids) {
			this.known.delete(id);
		}
		this.schedule();
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
		const cards = ids.map(id => {
			const facts = byId.get(id)!;
			const menu: CardMenu = {
				moveUp: moved(ids, id, -1) !== undefined,
				moveDown: moved(ids, id, 1) !== undefined
			};
			return cardOf(facts, { place: this.placeOf(facts, catalog), selected: id === this.selectedRun, menu, words: this.deps.words, ...this.deps.window ? { window: this.deps.window } : {} });
		});
		const exited = [...this.exited];
		this.exited.clear();
		const empty: PanelState['empty'] = this.loading || cards.length ? undefined : catalog.folders.length ? 'noAgents' : 'noFolder';
		const selected = this.selectedRun === undefined ? undefined : byId.get(this.selectedRun);
		return {
			state: {
				revision,
				loading: this.loading,
				cards,
				cardCount: runs.length,
				...(empty ? { empty } : {}),
				capabilities: { remote: this.deps.remote },
				...(exited.length ? { exited } : {})
			},
			...(selected ? { selection: { run: selected.id, ended: selected.lifecycle === 'ended' } } : {})
		};
	}

	private learn(catalog: Catalog): void {
		for (const location of catalog.locations) {
			this.known.set(location.id, location);
		}
	}

	/** The run IDs of `runs` as the panel lists them: by the stack, any it does not know yet first, newest first (PANEL-2.1). */
	private arrangedIds(runs: readonly RunFacts[]): string[] {
		return arranged(this.order, [...runs].sort((a, b) => b.createdAt - a.createdAt).map(run => run.id));
	}
}

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((each, at) => each === b[at]);
}

/** The last name of a path in any environment's separators. */
function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
