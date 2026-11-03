/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How a message reads where the person opens it (COLLABORATION-2.3): the notification's Open Message shows one record whole.

import { renderFacts } from '../base/readableFacts';
import * as vscode from 'vscode';
import { displayLine, inertCommandLinks } from '../base/text';
import type { MessageRecord } from '../core/messagePorts';

type Party = MessageRecord['from'] | MessageRecord['to'];

/** A side as the person sees it: the agent's name and short ID, `you` for the person, Facade for its results. */
export function sideName(party: Party): string {
	if (party.run === '@human') {
		// The person reading this, as the sender or recipient of a message: one word, as a chat app names its own user
		return vscode.l10n.t("You");
	}
	if (party.run === 'facade') {
		return 'Facade';
	}
	const name = party.name !== undefined ? displayLine(party.name, 80) : undefined;
	return [name, party.alias ?? party.run].filter(Boolean).join(' ');
}

/** One record as a document shows it: its facts, a blank line, its whole text, then a rule. */
export function recordText(record: MessageRecord, language: string, results: readonly string[] = []): string {
	const time = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }).format(record.at);
	const lines = [
		`${record.alias} · ${time}`,
		vscode.l10n.t("From: {0}", sideName(record.from)),
		vscode.l10n.t("To: {0}", sideName(record.to)),
		...record.replyTo !== undefined ? [vscode.l10n.t("In reply to: {0}", aliasOf(record.replyTo))] : [],
		...record.about !== undefined ? [vscode.l10n.t("About message: {0}", aliasOf(record.about))] : [],
		...record.operation ? [vscode.l10n.t("Operation: {0}", record.operation.tool === 'start_agent' ? vscode.l10n.t("Start agent") : vscode.l10n.t("Stop agent")),
			...record.agent ? [vscode.l10n.t("Agent: {0}", sideName(record.agent))] : []] : [],
		// {0} is how its delivery went, in a phrase such as "Delivered to the agent"
		vscode.l10n.t("Delivery: {0}", outcomeOf(record, language)),
		// {0} lists the short IDs, such as #m3, of the notes that told the sender how its message went
		...results.length ? [vscode.l10n.t("Result reported in: {0}", new Intl.ListFormat(language, { type: 'conjunction', style: 'narrow' }).format(results))] : [],
		'',
		inertCommandLinks(record.text),
		...record.result || record.callId !== undefined || record.requestId !== undefined || record.operation || record.fromWindow ? ['', vscode.l10n.t("Technical details"),
			...renderFacts({ call_id: record.callId, request_id: record.requestId, window_id: record.window, from_window: record.fromWindow,
				operation: record.operation, agent_id: record.agent?.run, result: record.result }).map(inertCommandLinks)] : [],
		'',
		'─'.repeat(40),
		''
	];
	return lines.join('\n');
}

/** How a record's delivery went, in plain words (UX-2.4): never a reason code or input-effect field. */
function outcomeOf(record: MessageRecord, language: string): string {
	const { delivery } = record;
	if (delivery.status === 'unknown') {
		return vscode.l10n.t("Could not confirm that the agent received the message");
	}
	if (delivery.status === 'pending') {
		return delivery.deadline !== undefined
			// {0} is the time of day Facade gives up
			? vscode.l10n.t("Delivering; Facade stops trying at {0}", new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(delivery.deadline))
			: vscode.l10n.t("Being delivered");
	}
	if (delivery.status === 'success') {
		switch (delivery.via) {
			case 'notification': return vscode.l10n.t("Delivered as a notification");
			case 'read': return vscode.l10n.t("Delivered when the agent checked its messages");
			case 'launch': return vscode.l10n.t("Delivered as the agent's first task");
			default: return record.to.run === '@human' ? vscode.l10n.t("Delivered as a notification") : vscode.l10n.t("Delivered to the agent");
		}
	}
	// {0} is why, in a lowercase phrase such as "the time limit was reached"
	return vscode.l10n.t("Not delivered: {0}", failureOf(delivery.reason));
}

/** Why a message was not delivered, in plain words. */
function failureOf(reason: string | undefined): string {
	switch (reason) {
		case 'input_draft': return vscode.l10n.t("the terminal contained an unsent draft");
		case 'input_interaction': return vscode.l10n.t("the agent was waiting for an answer, permission, or sign-in");
		case 'input_unknown': return vscode.l10n.t("Facade could not determine if the agent was ready for input");
		case 'partial_input': return vscode.l10n.t("only part of the message reached the terminal");
		case 'submission_unconfirmed': return vscode.l10n.t("Could not confirm that the agent received the message");
		case 'timeout': return vscode.l10n.t("delivery timed out");
		case 'ended': return vscode.l10n.t("the agent was no longer running");
		case 'unsupported': return vscode.l10n.t("Facade cannot type messages into the agent's terminal");
		case 'window_unavailable': return vscode.l10n.t("agent window could not be reached");
		default: return vscode.l10n.t("unknown reason");
	}
}

function aliasOf(id: string): string {
	const match = /^(?:m-|#m)(\d+)$/.exec(id);
	return match ? `#m${match[1]}` : displayLine(id, 80);
}
