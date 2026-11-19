/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { KeptWorkspaceState } from './workspaceState';
import type { LogPort, Pin, RustPin, RustPinStore } from '../core/ports';

const KEY = 'facade.pins';

/**
 * This workspace's Pins, in their saved order, in workspace storage (ARCHITECTURE-3.1, LIFECYCLE-3.4). A record of another shape - an
 * earlier development build's - is ignored, never translated, with one line in the agents log (ARCHITECTURE-4.2).
 */
export class WorkspacePins implements RustPinStore {
	private ignored = false;

	constructor(private readonly state: Pick<KeptWorkspaceState, 'get' | 'mutate'>, private readonly log?: LogPort, private readonly hideRustPins = false) { }

	list(): readonly Pin[] {
		const pins = this.read(this.state.get(KEY));
		return this.hideRustPins ? pins.filter(pin => this.visible(pin)) : pins;
	}

	/** On an old-engine window under auto, Pins tied to core wait for its records to be verified (RULES-4.2). */
	private visible(pin: Pin): boolean {
		return !this.hideRustPins || pin.machine_id === undefined;
	}

	private read(value: unknown): readonly Pin[] {
		if (value === undefined) {
			return [];
		}
		const pins = Array.isArray(value) ? value.filter(isPin) : [];
		if ((!Array.isArray(value) || pins.length !== value.length) && !this.ignored) {
			this.ignored = true;
			this.log?.event(`Ignored stored Pins (${KEY}) this build does not read, as from an earlier build`);
		}
		return pins;
	}

	save(pin: Pin): void {
		this.edit(pins => {
			const existing = pins.find(each => each.id === pin.id);
			if (!existing) { return [...pins, pin]; }
			return this.visible(existing) ? pins.map(each => each === existing ? pin : each) : pins;
		});
	}

	pinAgent(pin: RustPin): Pin {
		let saved: Pin = pin;
		this.edit(pins => {
			const existing = pins.find(each => each.machine_id === pin.machine_id && each.agent === pin.agent)
				?? pins.find(each => !each.agent && pin.conversation.sessionId
					&& each.conversation.environment === pin.conversation.environment
					&& each.conversation.cli === pin.conversation.cli
					&& each.conversation.sessionId === pin.conversation.sessionId);
			if (!existing) { return [...pins, pin]; }
			saved = { ...pin, id: existing.id };
			return pins.map(each => each === existing ? saved : each);
		});
		return saved;
	}

	updatePin(before: RustPin, after: RustPin): void {
		this.edit(pins => {
			const existing = pins.find(pin => pin.id === before.id && pin.machine_id === before.machine_id
				&& pin.agent === before.agent);
			if (!existing) { return pins; }
			const next = { ...existing, conversation: { ...existing.conversation } };
			for (const key of ['name', 'location', 'cwd'] as const) {
				if (before[key] !== after[key]) { Object.assign(next, { [key]: after[key] }); }
			}
			for (const key of ['environment', 'cli', 'sessionId', 'builtIn'] as const) {
				if (before.conversation[key] !== after.conversation[key]) {
					Object.assign(next.conversation, { [key]: after.conversation[key] });
				}
			}
			return pins.map(pin => pin === existing ? next : pin);
		});
	}

	remove(id: string): void {
		this.edit(pins => pins.filter(each => each.id !== id || !this.visible(each)));
	}

	removeAgentPins(machineId: string, agent: string): void {
		this.edit(pins => {
			const kept = pins.filter(pin => pin.machine_id !== machineId || pin.agent !== agent);
			return kept.length === pins.length ? pins : kept;
		});
	}

	private edit(change: (pins: readonly Pin[]) => readonly Pin[]): void {
		this.state.mutate<unknown>(KEY, value => {
			const pins = this.read(value);
			const next = change(pins);
			return next === pins ? value : next;
		});
	}

	reorder(ids: readonly string[]): void {
		this.edit(stored => {
			const pins = stored.filter(pin => this.visible(pin));
			const ordered = [...new Set(ids)].map(id => pins.find(pin => pin.id === id)).filter((pin): pin is Pin => !!pin);
			ordered.push(...pins.filter(pin => !ids.includes(pin.id)));
			let next = 0;
			return stored.map(pin => this.visible(pin) ? ordered[next++] : pin);
		});
	}
}

function isPin(value: unknown): value is Pin {
	const pin = value as Partial<Pin> | null;
	const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
	return !!pin && identity(pin.id) && typeof pin.name === 'string' && identity(pin.cwd) && identity(pin.location)
		&& !!pin.conversation && identity(pin.conversation.environment) && identity(pin.conversation.cli)
		&& ((pin.agent === undefined && pin.machine_id === undefined) || (identity(pin.agent) && identity(pin.machine_id)))
		// A Pin made before its CLI named a conversation has none yet (LIFECYCLE-3.4); one an earlier build made names no built-in
		&& (pin.conversation.sessionId === undefined || identity(pin.conversation.sessionId))
		&& (pin.conversation.builtIn === undefined || identity(pin.conversation.builtIn));
}
