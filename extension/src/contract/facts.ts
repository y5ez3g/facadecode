/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The facts the tools return about runs, locations and messages, as MCP names them (MCP-2.1, 3.1, 4.2): snake_case data, times in
// UTC ISO 8601, nothing a run does not actually record.

import type { MessageRecord } from '../core/messagePorts';
import { headerText } from '../core/messages';
import type { CapabilityState, CliChoice, Location, RunFacts } from '../core/ports';
import { referenceOf } from '../core/reach';
import type { ErrorCode } from '../schema/result';

export type Data = { readonly [key: string]: unknown };

/** The window the tools answer for. In M3 the only one a run knows; its ID may change on reload (D45). */
export interface ToolWindow {
	readonly id: string;
	readonly label: string;
	readonly environment: string;
}

export function isoOf(ms: number): string {
	return new Date(ms).toISOString();
}

/** `value` without its undefined fields, so that the structured result and its text list the same fields. */
export function defined<T extends Data>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

export function locationOf(location: Location, full: boolean): Data {
	if (!full) {
		return { location_id: location.id, label: location.label, path: location.path };
	}
	return defined({
		location_id: location.id,
		label: location.label,
		path: location.path,
		environment: location.environment,
		kind: location.kind,
		folder: location.folders[0]?.name,
		opened: location.opened,
		branch: location.branch,
		main: location.isMain,
		detached: location.detached || undefined,
		git: location.git
	});
}

export function cliOf(choice: CliChoice): Data {
	return defined({
		cli: choice.id,
		display_name: choice.displayName,
		available: choice.available,
		problem: choice.problem
	});
}

/**
 * A run as list_agents and the other tools describe it (MCP-3.1): its identity, place, CLI, tree, YOLO, process, activity, tools,
 * input, title and error or exit, observed when - no task or delegation fields, nor any the contract does not list.
 */
export function agentOf(run: RunFacts, window: ToolWindow, now: number, input?: CapabilityState): Data {
	return defined({
		agent_id: run.id,
		alias: run.alias,
		reference: referenceOf(run),
		name: run.name,
		window_id: window.id,
		window: window.label,
		environment: run.environment,
		location_id: run.location,
		cwd: run.cwd,
		cli: run.cli,
		creator: run.creator ?? (run.origin === 'human' ? '#human' : undefined),
		root: run.root,
		yolo: run.yolo,
		created_at: isoOf(run.createdAt),
		process: run.lifecycle,
		activity: run.activity,
		activity_reason: run.activityReason,
		blocker: run.blocker ? defined({ kind: run.blocker.kind, text: run.blocker.text }) : undefined,
		tools: run.tools,
		message_input: input ? { state: input.state, reason: input.reason } : undefined,
		title: run.title,
		error: run.error ? { reason: run.error.reason, source: run.error.source, at: isoOf(run.error.at) } : undefined,
		exit: run.end ? defined({ kind: run.end.kind, code: run.end.code, signal: run.end.signal, at: isoOf(run.end.at) }) : undefined,
		observed_at: isoOf(now),
		stale: false
	});
}

/** A message record as read_messages returns it (MCP-4.2), with its fetch state before this read; `text` left out for a file. */
export function messageOf(record: MessageRecord, withText: boolean): Data {
	return defined({
		message_id: record.id,
		alias: record.alias,
		kind: record.kind,
		from: record.from.run,
		from_reference: participant(record.from),
		to: record.to.run,
		to_reference: participant(record.to),
		at: isoOf(record.at),
		window: record.window,
		environment: record.environment,
		reply_to: record.replyTo,
		about: record.about,
		// A Facade result completing an accepted call names that call and the agent it was on (MCP-1.3)
		call_id: record.callId,
		agent: record.agent?.run,
		agent_reference: record.agent ? participant(record.agent) : undefined,
		length: record.length,
		text: withText ? record.text : undefined,
		delivery: defined({
			status: record.delivery.status,
			reason: record.delivery.reason,
			effects: defined({ ...record.delivery.effects }),
			deadline: record.delivery.deadline !== undefined ? isoOf(record.delivery.deadline) : undefined,
			attempts: record.delivery.attempts,
			// One state: delivered by its terminal, read_messages, its launch or a notification, or not yet (COLLABORATION-3.1)
			delivered_via: record.delivery.status === 'success' ? record.delivery.via : undefined,
			delivered_at: record.delivery.deliveredAt !== undefined ? isoOf(record.delivery.deliveredAt) : undefined
		})
	});
}

function participant(who: MessageRecord['from'] | MessageRecord['to'] | NonNullable<MessageRecord['agent']>): string | undefined {
	if (who.run === '@human' || who.run === 'facade') {
		return who.run === '@human' ? '#human' : undefined;
	}
	return who.alias ? (who.name !== undefined ? `@${who.name} ${who.alias}` : who.alias) : undefined;
}

/** The messages of a long read as one file (COLLABORATION-4.2): each between headers naming it, its body exactly as it is. */
export function messageFile(records: readonly MessageRecord[]): string {
	return records.map(record => {
		const kind = record.kind === 'result' ? 'Facade result' : 'Facade message';
		const fields = [
			`${kind} ${record.alias}`,
			`from ${participant(record.from) ?? record.from.run}`,
			`to ${participant(record.to) ?? record.to.run}`,
			isoOf(record.at),
			...record.replyTo ? [`reply to ${record.replyTo}`] : [],
			...record.about ? [`about ${record.about}`] : [],
			...record.agent ? [`agent ${participant(record.agent) ?? record.agent.run}`] : [],
			...record.callId ? [`call ${headerText(record.callId)}`] : [],
			`${record.length} code points`
		];
		return `[${fields.join(' | ')}]\n${record.text}\n[/${kind} ${record.alias}]`;
	}).join('\n\n') + '\n';
}

/** A send's failure reason as MCP-1.2 codes it, and in words. */
const SEND_FAILURES: { readonly [reason: string]: readonly [ErrorCode, string] } = {
	ended: ['UNAVAILABLE', 'The recipient has ended.'],
	window_unavailable: ['UNAVAILABLE', 'The recipient\'s window is not available.'],
	input_draft: ['FAILED', 'The recipient\'s input held a draft, which is never typed over.'],
	input_interaction: ['FAILED', 'The recipient\'s CLI was showing a menu, login or permission question.'],
	input_unknown: ['FAILED', 'The recipient\'s input state could not be established.'],
	timeout: ['FAILED', 'The delivery deadline passed before the recipient\'s CLI accepted the message.'],
	submission_unconfirmed: ['FAILED', 'The text went in, but its submission was not confirmed.'],
	partial_input: ['FAILED', 'Only part of the message went in.'],
	// Another window refused it before recording it: its agent gone, or out of the sender's reach (MCP-1.2)
	not_found: ['NOT_FOUND', 'The recipient was not found.'],
	// No input reader for the recipient's CLI: a permanent obstacle, failed at once (MCP-1.2, D89)
	unsupported: ['UNAVAILABLE', 'Facade cannot type messages into the recipient\'s CLI; type_text still reaches its terminal.']
};

export function sendFailureOf(reason: string | undefined): { readonly code: ErrorCode; readonly reason: string; readonly message: string } {
	const known = reason !== undefined ? SEND_FAILURES[reason] : undefined;
	return known ? { code: known[0], reason: reason!, message: known[1] } : { code: 'FAILED', reason: reason ?? 'failed', message: `The message was not delivered${reason ? ` (${reason})` : ''}.` };
}
