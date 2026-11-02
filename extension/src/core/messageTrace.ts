/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MessageRecord } from './messagePorts';

/** Body-free, single-line correlation. Only explicit identity and outcome fields enter routine diagnostics. */
export function messageTrace(record: MessageRecord): string {
	return `Message ${record.alias} ${JSON.stringify({
		kind: record.kind, from: record.from.alias ?? record.from.run, to: record.to.alias ?? record.to.run,
		window: record.window, from_window: record.fromWindow, call_id: record.callId, request_id: record.requestId,
		about: record.about?.replace(/^m-/, '#m'), reply_to: record.replyTo?.replace(/^m-/, '#m'),
		operation: record.operation ? { tool: record.operation.tool, window: record.operation.window } : undefined, agent: record.agent?.alias ?? record.agent?.run,
		delivery: record.delivery.status, reason: record.delivery.reason, effects: { outcome: record.delivery.effects.outcome,
			text_written: record.delivery.effects.text_written, enter_written: record.delivery.effects.enter_written },
		operation_status: typeof record.result?.status === 'string' ? record.result.status : undefined
	})}`;
}
