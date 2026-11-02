/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { displayLine } from '../base/text';
import type { InputEffects, MessageRecord } from './messagePorts';

type Data = { readonly [key: string]: unknown };
const object = (value: unknown): Data => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Data : {};
const messageId = (value: unknown): string => typeof value === 'string' ? value.replace(/^m-/, '#m') : '';

/** One line of metadata; message bodies never go through this display formatter. */
export function notificationName(party: MessageRecord['from']): string {
	if (party.run === '@human') { return 'the user'; }
	const id = party.alias ?? party.run;
	const name = party.name ? displayLine(party.name, 120) : '';
	return name ? `${name} (${id})` : id;
}

/** Input effects are independent of a failure reason: partial or uncertain input must never sound safe to replay. */
export function inputEffectText(effects: InputEffects | Data, beforeRetry = true): string {
	if (effects.outcome === 'none' || effects.text_written === 'none' && effects.enter_written === false) {
		return 'Nothing was entered in the terminal.';
	}
	const text = effects.text_written === 'partial' ? 'Only part of the message was entered.'
		: effects.text_written === 'full' ? 'The full message was entered.'
			: effects.text_written === 'none' ? 'No message text was entered.' : 'How much text was entered is unknown.';
	const enter = effects.enter_written === true ? 'Enter was pressed.'
		: effects.enter_written === false ? 'Enter was not pressed.' : 'Whether Enter was pressed is unknown.';
	return `${text} ${enter} ${beforeRetry ? 'Check the terminal before sending it again.' : 'Check the terminal for leftover input.'}`;
}

/** Delivery prose is derived from delivery facts, never parsed back into protocol state. */
export function deliveryText(original: MessageRecord, cli?: string): string {
	const who = notificationName(original.to);
	const { delivery } = original;
	if (delivery.status === 'success') {
		return `Your message ${original.alias} has been passed on to ${who}.`
			+ (delivery.via === 'read' ? ' It was read through read_messages.' : '')
			+ (delivery.via === 'read' && original.initialPrompt?.path !== 'native' && ['partial', 'unknown'].includes(delivery.effects.outcome)
				? ` ${inputEffectText(delivery.effects, false)}` : '');
	}
	const reason = delivery.reason;
	const untouched = delivery.effects.outcome === 'none';
	if (reason === 'window_unavailable') {
		return untouched ? `Your message ${original.alias} couldn't be sent to ${who}. The destination window couldn't be reached. Nothing was entered.`
			: `I couldn't get a reply from the destination window, so I can't confirm whether your message ${original.alias} reached ${who}.`
				+ (delivery.effects.text_written === 'partial' || delivery.effects.text_written === 'full' || delivery.effects.enter_written === true ? ` ${inputEffectText(delivery.effects)}` : '');
	}
	if (reason === 'not_found' && untouched) {
		return `Your message ${original.alias} couldn't be sent. ${who} is no longer available in the destination window.`;
	}
	if (reason === 'input_draft' && untouched) {
		return `Your message ${original.alias} couldn't be sent to ${who}. There was already a draft in the terminal, and it was left untouched.`;
	}
	const explanation = reason === 'ended' ? 'The session ended.'
		: reason === 'timeout' ? 'The delivery deadline passed.'
		: reason === 'unsupported' ? 'This CLI does not support message delivery.'
			: reason === 'input_unknown' ? `Facade couldn't recognize ${cli ? displayLine(cli, 160) + "'s" : 'the'} input box.`
				: reason === 'input_interaction' ? 'A question or menu is open in the terminal.'
					: reason === 'input_draft' ? 'The terminal contains a draft.'
						: reason === 'submission_unconfirmed' ? 'The CLI has not confirmed submission.'
							: reason === 'partial_input' ? 'Input stopped before the message was complete.'
								: reason === 'window_unavailable' ? 'The destination window could not be reached.'
									: `Delivery did not finish${reason ? ` (${displayLine(reason, 160)})` : ''}.`;
	return `Delivery of your message ${original.alias} to ${who} ${untouched ? 'failed' : "couldn't be confirmed"}. ${explanation} ${inputEffectText(delivery.effects)}`;
}

/** Final start/stop facts in the same voice as a delivery notice. Internal IDs stay in structured records. */
export function operationText(result: Data, party: NonNullable<MessageRecord['agent']>): string {
	const data = object(result.data), effects = object(result.effects), error = object(result.error);
	const who = notificationName(party);
	const diagnostic = (value: unknown): string => typeof value === 'string' ? value.replaceAll(party.run, party.alias ?? 'the agent') : '';
	const lines: string[] = [];
	if (data.cleanup !== undefined) {
		lines.push(data.cleanup === 'terminated' ? `${who} has stopped.`
			: data.cleanup === 'already_ended' || data.cleanup === 'already_exited' ? `${who} had already stopped. The card and terminal are closed.`
				: data.cleanup === 'not_started' ? `${who} was closed before its process started. It won't be started.`
					: data.cleanup === 'failed' ? `Facade couldn't stop ${who}. The card and terminal are closed, but the process may still be running.`
						: `${who} may still be running. The card and terminal are closed.`);
	} else {
		lines.push(data.process_state === 'running' ? `${who}'s session has started.`
			: data.closed === true ? `${who} was closed before startup finished. Whether the process stopped is unknown.`
				: `${who}'s session couldn't be started.`);
		if (data.tools_state === 'connecting') { lines.push('Its Facade tools are still connecting.'); }
		if (data.tools_state === 'unavailable' || data.tools_state === 'not_injected') {
			lines.push(`Its Facade tools are unavailable.${data.tools_reason ? ` ${diagnostic(data.tools_reason)}` : ''}`);
		}
		if (data.prompt) {
			const prompt = object(data.prompt), input = object(prompt.effects);
			const id = messageId(prompt.message_id);
			if (prompt.status === 'success') {
				lines.push(`Your initial message ${id} has been passed on${prompt.delivered_via === 'read' ? ' through read_messages' : prompt.path === 'native' ? ' with the launch' : ''}.`);
				if (prompt.delivered_via === 'read' && prompt.path !== 'native' && ['partial', 'unknown'].includes(String(input.outcome))) {
					lines.push(inputEffectText(input, false));
				}
			} else if (prompt.status === 'pending') {
				lines.push(`Your initial message ${id} is still being delivered. Its outcome will be reported separately.`);
				if (prompt.obstacle === 'input_draft') { lines.push('There is already a draft in the terminal; it will be left untouched.'); }
				else if (prompt.obstacle === 'input_interaction') { lines.push('A question or menu is open in the terminal.'); }
				else if (prompt.obstacle === 'input_unknown') { lines.push("Facade hasn't recognized the input box yet."); }
				else if (prompt.obstacle) { lines.push(`Delivery is waiting: ${diagnostic(prompt.obstacle)}.`); }
			} else if (prompt.path === 'native' && input.outcome === 'confirmed') {
				lines.push(`Your initial message ${id} was supplied at launch, but its delivery record couldn't be saved.`);
			} else if (prompt.path === 'native' && input.outcome === 'unknown') {
				lines.push(`Your initial message ${id} was supplied at launch, but acceptance couldn't be confirmed. It hasn't been sent again.`);
			} else {
				lines.push(input.outcome === 'none' ? `Your initial message ${id} couldn't be delivered. ${inputEffectText(input)}`
					: `Delivery of your initial message ${id} couldn't be confirmed. ${inputEffectText(input)}`);
			}
			if (prompt.message) { lines.push(diagnostic(prompt.message)); }
		}
	}
	if (error.message && !['ended', 'termination_unconfirmed', 'cleanup_failed'].includes(String(error.reason))) { lines.push(diagnostic(error.message)); }
	if (typeof effects.worktree_created === 'string') { lines.push(`The worktree was created at ${effects.worktree_created}.`); }
	return lines.join('\n');
}
