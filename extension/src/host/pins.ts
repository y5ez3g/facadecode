/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Pin } from '../core/ports';

export function isPin(value: unknown): value is Pin {
	const pin = value as Partial<Pin> | null;
	const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
	return !!pin && identity(pin.id) && typeof pin.name === 'string' && identity(pin.cwd) && identity(pin.location)
		&& !!pin.conversation && identity(pin.conversation.environment) && identity(pin.conversation.cli)
		&& ((pin.agent === undefined && pin.machine_id === undefined) || (identity(pin.agent) && identity(pin.machine_id)))
		// A Pin made before its CLI named a conversation has none yet (LIFECYCLE-3.4); one an earlier build made names no built-in
		&& (pin.conversation.sessionId === undefined || identity(pin.conversation.sessionId))
		&& (pin.conversation.builtIn === undefined || identity(pin.conversation.builtIn));
}
