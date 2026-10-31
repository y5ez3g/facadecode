/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import type { LogPort } from '../core/ports';
import type { PanelFilter } from '../webview/protocol';

/** What the panel keeps in workspace storage (ARCHITECTURE-3.1): `vscode.Memento`'s shape. */
export interface Storage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const ORDER = 'facade.panel.order';
const FILTER = 'facade.panel.filter';

/** Run IDs as RULES-2.2 makes them. */
const RUN_ID = /^run-[0-9a-f]{32}$/;

/**
 * The panel's preferences in this workspace: the manual card order by run ID (PANEL-2.1), and the display filter by its
 * environment-qualified location ID or folder URI, with its last label (PANEL-2.3). A value of another shape - an earlier
 * development build's - is ignored, never translated, with one line in the agents log (ARCHITECTURE-4.2).
 */
export class PanelPrefs {
	/** The keys whose stored value was ignored already: each is logged once. */
	private readonly ignored = new Set<string>();

	constructor(private readonly storage: Storage, private readonly log?: LogPort) { }

	order(): string[] {
		const value = this.storage.get<unknown>(ORDER);
		if (value === undefined) {
			return [];
		}
		const runs = Array.isArray(value) ? value.filter((run): run is string => typeof run === 'string' && RUN_ID.test(run)) : [];
		if (!Array.isArray(value) || runs.length !== value.length) {
			this.ignore(ORDER, 'card order');
		}
		return runs;
	}

	setOrder(order: readonly string[]): void {
		// The current panel order remains usable when workspace storage cannot persist it.
		this.save(ORDER, [...order], 'card order');
	}

	filter(): PanelFilter | undefined {
		const value = this.storage.get<unknown>(FILTER);
		if (value === undefined) {
			return undefined;
		}
		const { kind, id, label } = (value && typeof value === 'object' ? value : {}) as { kind?: unknown; id?: unknown; label?: unknown };
		if ((kind === 'location' || kind === 'folder') && typeof id === 'string' && id && typeof label === 'string') {
			return { kind, id, label };
		}
		this.ignore(FILTER, 'filter');
		return undefined;
	}

	setFilter(filter: PanelFilter | undefined): void {
		// The filter shown remains in effect when workspace storage cannot persist it.
		this.save(FILTER, filter ? { kind: filter.kind, id: filter.id, label: filter.label } : undefined, 'filter');
	}

	private save(key: string, value: unknown, what: string): void {
		const failed = (err: unknown) => this.log?.event(`Could not save the ${what}: ${messageOf(err)}`);
		try {
			void Promise.resolve(this.storage.update(key, value)).catch(failed);
		} catch (err) {
			failed(err);
		}
	}

	private ignore(key: string, what: string): void {
		if (!this.ignored.has(key)) {
			this.ignored.add(key);
			this.log?.event(`Ignored a stored panel ${what} (${key}) this build does not read, as from an earlier build`);
		}
	}
}

// The panel's manual stack (PANEL-2.1): state changes never move a card; only a new card, and Move Up/Down, do.

/** The stack with `run` first, where a new card goes (PANEL-2.1); one already in it stays where it is. */
export function withNew(order: readonly string[], run: string): string[] {
	return order.includes(run) ? [...order] : [run, ...order];
}

/** The runs of `present` in the stack's order; any the stack does not know yet go first, newest first as `present` lists them. */
export function arranged(order: readonly string[], present: readonly string[]): string[] {
	const known = new Set(present);
	const placed = order.filter(run => known.has(run));
	const listed = new Set(placed);
	return [...present.filter(run => !listed.has(run)), ...placed];
}

/**
 * The stack with `run` moved one place among the cards `visible` says are shown - every card unless a filter hides some (PANEL-2.1,
 * 2.3): it trades places with the next shown card up (`-1`) or down (`1`), and every hidden card keeps its slot. None where it
 * cannot move: not shown, or already at that end.
 */
export function moved(order: readonly string[], run: string, by: -1 | 1, visible: (run: string) => boolean = () => true): string[] | undefined {
	const at = order.indexOf(run);
	if (at < 0 || !visible(run)) {
		return undefined;
	}
	for (let other = at + by; other >= 0 && other < order.length; other += by) {
		if (visible(order[other])) {
			const next = [...order];
			[next[at], next[other]] = [next[other], next[at]];
			return next;
		}
	}
	return undefined;
}
