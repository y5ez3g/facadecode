/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import type { KeptWorkspaceState } from './workspaceState';
import type { LogPort, Pin, PinStore } from '../core/ports';

const KEY = 'facade.pins';

/**
 * This workspace's Pins, in their saved order, in workspace storage (ARCHITECTURE-3.1, LIFECYCLE-3.4). A record of another shape - an
 * earlier development build's - is ignored, never translated, with one line in the agents log (ARCHITECTURE-4.2).
 */
export class WorkspacePins implements PinStore {
	private ignored = false;

	constructor(private readonly state: Pick<KeptWorkspaceState, 'get' | 'keep'>, private readonly log?: LogPort, private readonly hideRustPins = false) { }

	list(): readonly Pin[] {
		const pins = this.read();
		return this.hideRustPins ? pins.filter(pin => this.visible(pin)) : pins;
	}

	/** On an old-engine window under auto, Pins tied to core wait for its records to be verified (RULES-4.2). */
	private visible(pin: Pin): boolean {
		return !this.hideRustPins || typeof pin.home !== 'string' || typeof pin.agent !== 'string';
	}

	private read(): readonly Pin[] {
		const value = this.state.get<unknown>(KEY);
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
		const pins = this.read();
		const at = pins.findIndex(each => each.id === pin.id);
		// A new Pin goes last among the Pins (PANEL-2.1)
		if (at === -1) {
			this.write([...pins, pin]);
		} else if (this.visible(pins[at])) {
			this.write(pins.map(each => each.id === pin.id ? pin : each));
		}
	}

	remove(id: string): void {
		this.write(this.read().filter(each => each.id !== id || !this.visible(each)));
	}

	private write(value: readonly Pin[]): void {
		void Promise.resolve(this.state.keep(KEY, value)).catch(err => this.log?.event(`Could not save pinned conversations in editor storage: ${messageOf(err)}`));
	}

	reorder(ids: readonly string[]): void {
		const stored = this.read();
		const pins = this.hideRustPins ? stored.filter(pin => this.visible(pin)) : stored;
		const ordered = [...new Set(ids)].map(id => pins.find(pin => pin.id === id)).filter((pin): pin is Pin => !!pin);
		ordered.push(...pins.filter(pin => !ids.includes(pin.id)));
		let next = 0;
		this.write(this.hideRustPins ? stored.map(pin => this.visible(pin) ? ordered[next++] : pin) : ordered);
	}
}

function isPin(value: unknown): value is Pin {
	const pin = value as Partial<Pin> | null;
	const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
	return !!pin && identity(pin.id) && typeof pin.name === 'string' && identity(pin.cwd) && identity(pin.location)
		&& !!pin.conversation && identity(pin.conversation.environment) && identity(pin.conversation.cli)
		// A Pin made before its CLI named a conversation has none yet (LIFECYCLE-3.4); one an earlier build made names no built-in
		&& (pin.conversation.sessionId === undefined || identity(pin.conversation.sessionId))
		&& (pin.conversation.builtIn === undefined || identity(pin.conversation.builtIn));
}
