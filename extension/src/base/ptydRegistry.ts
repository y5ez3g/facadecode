/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The ptyds listening for one Facade data directory, each by the build it runs from (ARCHITECTURE-2.4). A ptyd records itself
// once it listens and removes its record as it exits, so that a window of another build finds the runs it holds there and starts
// none of its own there. A record whose ptyd is gone stays until a window finds nothing listening at its socket.

import * as path from 'path';

/** Registry used by the published TypeScript supervisor. */
export function ptydRecords(ptydFolder: string): string {
	return path.join(ptydFolder, 'sockets');
}
