/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Disposable, Event, WindowLifetimePort } from '../core/ports';

/**
 * True window closure evidence (RULES-4.1, ARCHITECTURE-2.2, gate G2). No public editor API distinguishes closing a window from
 * reloading it, and earlier probes rejected hidden-terminal death and the shutdown reason as detectors, so this reports closure
 * only when demonstrated evidence exists - today never. Independently, ptyd applies the owner's explicit five-minute policy
 * after the current extension-host connection is gone. That timeout is cleanup policy, not evidence of a human window close.
 */
export class WindowLifetime implements WindowLifetimePort {
	readonly onDidClose: Event<void> = () => ({ dispose() { /* no closure evidence source */ } } as Disposable);
}
