/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderFacts } from '../base/readableFacts';
import type { Result } from '../schema/result';

/** Readable text stored with a record; never an MCP answer or protocol adapter. */
export function receiptTextOf(result: Result, headline?: string): string {
	return `${headline ?? headlineOf(result)}\n\n${renderFacts(result).join('\n')}`;
}

function headlineOf(result: Result): string {
	switch (result.status) {
		case 'success': return 'Succeeded.';
		case 'accepted': return 'Accepted: the operation continues, and a Facade result reports its outcome later.';
		case 'failure': return `Failed: ${result.error?.message ?? 'no reason was given.'}`;
	}
}

export { renderFacts } from '../base/readableFacts';
