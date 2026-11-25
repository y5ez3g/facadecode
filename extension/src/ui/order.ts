/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import type { LogPort, RunFacts } from '../core/ports';
import type { AgentFilter, DisplayFilter, FilterChoice } from '../webview/protocol';

/** What the panel keeps in workspace storage (ARCHITECTURE-3.1): `vscode.Memento`'s shape. */
export interface Storage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

const ORDER = 'facade.panel.order';
const FILTER = 'facade.panel.filter';
const SELECTION = 'facade.panel.selection';

export const FILTER_STATES = ['starting', 'working', 'waiting_for_you', 'just_done', 'idle', 'error', 'ended', 'unknown'] as const;

export function filterCategory(choice: FilterChoice): 'location' | 'machine' | 'cli' | 'state' | 'pin' {
	return choice.kind === 'folder' || choice.kind === 'directory' ? 'location' : choice.kind;
}

export function filterChoiceKey(choice: FilterChoice): string {
	return choice.kind === 'directory' ? JSON.stringify([choice.kind, choice.machineId, choice.folder])
		: JSON.stringify([choice.kind, choice.id]);
}

export function agentFilter(choices: readonly FilterChoice[]): AgentFilter | undefined {
	const unique = new Map(choices.map(choice => [filterChoiceKey(choice), choice]));
	return unique.size ? { kind: 'agents', choices: [...unique.keys()].sort().map(key => unique.get(key)!) } : undefined;
}

function readChoice(value: unknown): FilterChoice | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { kind, id, label, machineId, folder } = value as Record<string, unknown>;
	if (typeof label !== 'string') {
		return undefined;
	}
	if (kind === 'directory' && typeof machineId === 'string' && machineId && typeof folder === 'string' && folder) {
		return { kind, machineId, folder, label };
	}
	if (typeof id !== 'string' || !id) {
		return undefined;
	}
	if (kind === 'location' || kind === 'folder' || kind === 'machine' || kind === 'cli'
		|| (kind === 'state' && FILTER_STATES.some(state => state === id))
		|| (kind === 'pin' && (id === 'pinned' || id === 'unpinned'))) {
		return { kind, id, label };
	}
	return undefined;
}

/** Run IDs as RULES-2.2 makes them. */
const RUN_ID = /^run-[0-9a-f]{32}$/;
const AGENT_ID = /^a\d+$/;
const AGENT_REF = /^[^/]+\/a\d+$/;

function frameworkRunId(run: string): boolean {
	return AGENT_REF.test(run) || AGENT_ID.test(run);
}

/**
 * The panel's workspace preferences: card order by run ID or AgentRef, and the display filter's stable values and last labels
 * (PANEL-2.1, PANEL-4.3). An unsupported shape is ignored with one line in the agents log (ARCHITECTURE-4.2).
 */
export class PanelPrefs {
	/** The keys whose stored value was ignored already: each is logged once. */
	private readonly ignored = new Set<string>();

	constructor(private readonly storage: Storage, private readonly log?: LogPort, private readonly logicalWindow = false) { }

	/** A workspace AgentRef survives reopening and distinguishes equal numbers on different machines (RULES-6.1). */
	keyOf(run: RunFacts): string {
		const reference = run.orchestrator?.reference;
		if (reference) {
			return `${reference.machine_id}/${reference.agent_id}`;
		}
		return this.logicalWindow && run.alias ? run.alias.slice(1) : run.id;
	}

	order(): string[] {
		const value = this.storage.get<unknown>(ORDER);
		if (value === undefined) {
			return [];
		}
		const valid = this.logicalWindow ? frameworkRunId : (run: string) => RUN_ID.test(run);
		const runs = Array.isArray(value) ? value.filter((run): run is string => typeof run === 'string' && valid(run)) : [];
		if (!Array.isArray(value) || runs.length !== value.length) {
			this.ignore(ORDER, 'card order');
		}
		return runs;
	}

	setOrder(order: readonly string[]): void {
		// The current panel order remains usable when workspace storage cannot persist it.
		this.save(ORDER, this.logicalWindow ? order.filter(frameworkRunId) : [...order], 'card order');
	}

	selection(): string | undefined {
		if (!this.logicalWindow) { return undefined; }
		const value = this.storage.get<unknown>(SELECTION);
		return typeof value === 'string' && frameworkRunId(value) ? value : undefined;
	}

	setSelection(run: string | undefined): void {
		if (this.logicalWindow) {
			this.save(SELECTION, run && frameworkRunId(run) ? run : undefined, 'card selection');
		}
	}

	filter(): DisplayFilter | undefined {
		const value = this.storage.get<unknown>(FILTER);
		if (value === undefined) {
			return undefined;
		}
		if (this.logicalWindow && typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'agents'
			&& 'choices' in value && Array.isArray(value.choices)) {
			const choices = value.choices.map(readChoice).filter((choice): choice is FilterChoice => choice !== undefined);
			if (choices.length !== value.choices.length) { this.ignore(FILTER, 'filter'); }
			return agentFilter(choices);
		}
		const choice = readChoice(value);
		if (choice?.kind === 'location' || choice?.kind === 'folder') {
			return choice;
		}
		this.ignore(FILTER, 'filter');
		return undefined;
	}

	setFilter(filter: DisplayFilter | undefined): void {
		// The filter shown remains in effect when workspace storage cannot persist it.
		this.save(FILTER, filter, 'filter');
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

// The panel's two queues, Pins first (PANEL-2.1): state changes never move a card; a new card goes last among the others,
// a new Pin last among the Pins, an unpinned card first among the others - just below the Pins it left, as an editor tab unpinned goes
// right after the pinned tabs - and Move Up/Down moves it.

/** The stack with `run` last, where a new card goes (PANEL-2.1); one already in it stays where it is. */
export function withNew(order: readonly string[], run: string): string[] {
	return order.includes(run) ? [...order] : [...order, run];
}

/** The stack with `run` moved last: where a card goes as it enters the Pins (PANEL-2.1). */
export function atEnd(order: readonly string[], run: string): string[] {
	return [...order.filter(each => each !== run), run];
}

/** The stack with `run` moved first: where a card goes as it leaves the Pins, first below them (PANEL-2.1). */
export function atStart(order: readonly string[], run: string): string[] {
	return [run, ...order.filter(each => each !== run)];
}

/** The runs of `present` in the stack's order; any the stack does not know yet go last, oldest first as `present` lists them. */
export function arranged(order: readonly string[], present: readonly string[]): string[] {
	const known = new Set(present);
	const placed = order.filter(run => known.has(run));
	const listed = new Set(placed);
	return [...placed, ...present.filter(run => !listed.has(run))];
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
