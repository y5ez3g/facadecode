/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Card } from '../../webview/protocol';

/** Identify the serving engine from the exact card the integration test exercised. */
export function observeAcceptanceEngine(context: Mocha.Context, card: Card): void {
	if (!process.env.FACADE_IT_EXPECT_TESTS) { return; }
	if (card.orchestrator) {
		assert.match(card.alias, /^a\d+$/u);
		context.acceptanceEngine = 'rust';
	} else {
		assert.match(card.alias, /^#a\d+$/u);
		context.acceptanceEngine = 'old';
	}
}
