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

	constructor(private readonly state: Pick<KeptWorkspaceState, 'get' | 'keep'>, private readonly log?: LogPort) { }

	list(): readonly Pin[] {
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
		const pins = this.list();
		const at = pins.findIndex(each => each.id === pin.id);
		// A new Pin goes to the very top (PANEL-2.1)
		this.write(at === -1 ? [pin, ...pins] : pins.map(each => each.id === pin.id ? pin : each));
	}

	remove(id: string): void {
		this.write(this.list().filter(each => each.id !== id));
	}

	private write(value: readonly Pin[]): void {
		void Promise.resolve(this.state.keep(KEY, value)).catch(err => this.log?.event(`Could not save pinned conversations in editor storage: ${messageOf(err)}`));
	}

	reorder(ids: readonly string[]): void {
		const pins = this.list();
		const ordered = [...new Set(ids)].map(id => pins.find(pin => pin.id === id)).filter((pin): pin is Pin => !!pin);
		ordered.push(...pins.filter(pin => !ids.includes(pin.id)));
		this.write(ordered);
	}
}

function isPin(value: unknown): value is Pin {
	const pin = value as Partial<Pin> | null;
	const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
	return !!pin && identity(pin.id) && typeof pin.name === 'string' && identity(pin.cwd) && identity(pin.location)
		&& !!pin.conversation && identity(pin.conversation.environment) && identity(pin.conversation.sessionId) && identity(pin.conversation.cli);
}
