/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings a launch reads from Facade's settings file (CONFIGURATION-1.1, 1.4), in the execution environment it starts in:
// `yolo`, and the CLIs of `clis` the catalog reads. They are read on use and strictly: a file wrong as a whole stops every start,
// saying where, and nothing is replaced by a default without saying so.

import { FacadeError } from '../core/errors';
import type { FacadeSettings } from './facadeSettings';

/** The YOLO setting of RULES-4.3, as the settings file names it. */
export const YOLO_SETTING = 'yolo';
/** How long a start or a stop is waited for before it is answered `accepted`, in seconds: no setting changes it (MCP-1.3). */
export const WAIT_SECONDS = 120;

/**
 * The destination's YOLO for a launch being accepted (RULES-4.3): `yolo` in its settings file, true by default. Where the file stops
 * every start, the launch is refused before any effect, `configuration_invalid`, saying where (CONFIGURATION-4.1).
 */
export function yoloOf(settings: Pick<FacadeSettings, 'snapshot'>): () => boolean {
	return () => {
		const snapshot = settings.snapshot();
		if (snapshot.problems.length) {
			throw new FacadeError('UNAVAILABLE', 'configuration_invalid', snapshot.problems.map(each => each.text).join('; '), snapshot.problems[0].said);
		}
		return snapshot.yolo;
	};
}

/**
 * The names a blank agent name is filled in from (LIFECYCLE-2.1): `names` in the settings file, where it has them; none, the built-in
 * list. A file wrong as a whole has none: its starts are refused by `yoloOf` before a name matters.
 */
export function namesOf(settings: Pick<FacadeSettings, 'snapshot'>): () => readonly string[] | undefined {
	return () => settings.snapshot().names;
}
