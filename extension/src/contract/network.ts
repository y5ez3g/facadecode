/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The tool service's view of the client network (RULES-2.1, 4.3, COLLABORATION-1.1): every open Facade window on this computer
// and its agents, and requests carried to another window and back. The caller's window answers each tool call; an effect on another
// window's agent is that window's to make, so the call goes there with the caller as its own window knows it.

import type { Directory, DirectoryAgent, RouteResponse } from '../base/windowNetwork';
import type { MessageRecord } from '../core/messagePorts';
import type { RunFacts, RunId } from '../core/ports';

/** What one window asks of another. */
export type RouteOp =
	/** A tool call for that window's agents or locations, made there for a caller of this one: start, stop, screen and input. */
	| 'call'
	/** That window as list_start_options lists it, with its working locations (MCP-2.1). */
	| 'summary'
	/** That window's agents as list_agents lists them, within the caller's reach (MCP-3.1). */
	| 'agents'
	/** A message for one of its agents, delivered there under that window's input rules (RULES-1.4, 1.5). */
	| 'deliver'
	/** A Facade result for one of its agents: the outcome of something it asked of another window (RULES-1.7). */
	| 'result';

export interface NetworkPort {
	/** This window's address on the client network. */
	readonly self: string;
	/** Every open window with its agents, and those found but unreachable. */
	directory(): Promise<Directory>;
	/** Carries `op` to `window` and back within `deadlineMs`, or says why it could not and whether it may have acted there. */
	route(window: string, op: RouteOp, args: unknown, deadlineMs: number): Promise<RouteResponse>;
}

/** A caller from another window, as its window knows it: enough for reach, references and its tree, and where its results go. */
export interface GuestCaller {
	readonly id: RunId;
	readonly alias: string;
	readonly name: string;
	readonly root: RunId;
	readonly yolo: boolean;
	readonly window: string;
	/** Its window's label, which a message header names (COLLABORATION-2.1). */
	readonly windowLabel?: string;
}

/** A tool call routed here from the caller's window. `inline` asks for a long screen's text in the answer, not a file here. */
export interface RoutedCall {
	readonly tool: string;
	readonly arguments: unknown;
	readonly caller: GuestCaller;
	readonly callId: string;
	readonly elapsedMs: number;
	readonly inline?: boolean;
}

/** A message for an agent of the window it is routed to, its ID and header taken in the sender's window (RULES-1.1). */
export interface RoutedDelivery {
	readonly id: string;
	readonly from: GuestCaller;
	readonly to: RunId;
	readonly text: string;
	readonly replyTo?: string;
	readonly callId?: string;
	/** The send's request ID, kept with the message where it is recorded, for a retry to find it (D110). */
	readonly requestId?: string;
	readonly elapsedMs: number;
}

/** A Facade result for one of the receiving window's agents: about a message of its own, or another operation's outcome. */
export interface RoutedResult {
	readonly to: RunId;
	readonly text: string;
	readonly callId?: string;
	/** The message it reports on, as the delivering window recorded it: the sender's copy is brought up to date with it. */
	readonly about?: MessageRecord;
	/** The agent the operation was on, as its window names it. */
	readonly agent?: { readonly run: RunId; readonly alias?: string; readonly name?: string };
}

/** A run of any window as references and reach read it (RULES-2.3, 4.3). */
export interface Reachable {
	readonly id: RunId;
	readonly alias: string;
	readonly name: string;
	readonly root: RunId;
	readonly yolo: boolean;
	readonly lifecycle: RunFacts['lifecycle'];
	/** The window that holds it. */
	readonly window: string;
}

export function reachableOf(agent: DirectoryAgent, window: string): Reachable {
	return { id: agent.run, alias: agent.alias, name: agent.name, root: agent.root, yolo: agent.yolo, lifecycle: agent.lifecycle, window };
}

export function directoryAgentOf(run: RunFacts): DirectoryAgent {
	return {
		run: run.id,
		alias: run.alias,
		name: run.name,
		root: run.root,
		...run.creator !== undefined ? { creator: run.creator } : {},
		yolo: run.yolo,
		cli: run.cli,
		lifecycle: run.lifecycle
	};
}

export function isGuestCaller(value: unknown): value is GuestCaller {
	const caller = value as Partial<GuestCaller> | null;
	return !!caller && typeof caller === 'object' && ['id', 'alias', 'name', 'root', 'window'].every(key => typeof (caller as { [key: string]: unknown })[key] === 'string')
		&& typeof caller.yolo === 'boolean';
}
