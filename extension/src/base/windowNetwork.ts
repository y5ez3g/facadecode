/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The client network (RULES-2.1, ARCHITECTURE-1.1, 2.1): what a window's workspace extension and its local window component say to
// each other through public commands, and what window components say to each other over their local sockets. Plain data alone
// crosses: IDs are addresses, never credentials, and nothing here authenticates a caller.

import { isJsonObject } from './json';

/** The window components' network protocol, raised whenever a message between them changes shape. */
export const WINDOW_NETWORK_PROTOCOL = 1;

/** The workspace extension asks its window component: this window's network address and every open window's agents. */
export const WINDOW_DIRECTORY_COMMAND = 'facade.window.directory';
/** The workspace extension asks its window component to carry one request to another window and back. */
export const WINDOW_ROUTE_COMMAND = 'facade.window.route';
/**
 * The workspace extension tells its window component the agents this window holds, for every other window to resolve; the component
 * answers whether other windows can reach this one (`PublishStatus`).
 */
export const WINDOW_PUBLISH_COMMAND = 'facade.window.publish';
/**
 * A window component that starts asks its window's workspace extension to publish the agents it holds again: its extension host may
 * have restarted while the workspace extension went on, which publishes only as its agents change.
 */
export const WORKSPACE_REPUBLISH_COMMAND = 'facade.workspace.republish';
/** The workspace extension takes numbers for `#aN` and `#mN` aliases, unique on this computer (RULES-1.1, 2.2). */
export const WINDOW_ALLOCATE_COMMAND = 'facade.window.allocate';
/** A window component asks its own window's workspace extension to serve a request another window routed to it. */
export const AGENTS_ROUTE_COMMAND = 'facade.agents.route';

/** An agent as other windows see it before they ask its window: who it is and where its tree is, never what it is doing. */
export interface DirectoryAgent {
	readonly run: string;
	readonly alias: string;
	readonly name: string;
	readonly root: string;
	readonly creator?: string;
	readonly yolo: boolean;
	readonly cli: string;
	readonly lifecycle: 'starting' | 'running' | 'ended';
}

/** An open Facade window on this computer: its address, label and execution environment, and its agents. */
export interface DirectoryWindow {
	readonly window: string;
	readonly label: string;
	/** Its execution environment as the editor names it: `local`, or the remote authority's name. */
	readonly environment: string;
	readonly agents: readonly DirectoryAgent[];
}

/** Every open Facade window the window component finds, this window first; those it found but cannot reach are listed apart. */
export interface Directory {
	readonly self: string;
	readonly windows: readonly DirectoryWindow[];
	readonly unavailable: readonly { readonly window: string; readonly label: string; readonly reason: string }[];
}

/** One request for another window: the operation, its plain-data arguments and how long is left for its answer. */
export interface RouteRequest {
	readonly to: string;
	readonly op: string;
	readonly args: unknown;
	readonly deadlineMs: number;
}

/** A request another window routed here, as the window component gives it to its workspace extension. */
export interface ServedRoute {
	readonly from: string;
	readonly op: string;
	readonly args: unknown;
	readonly deadlineMs: number;
}

/** Why a route carried no answer: the window went or never answered, speaks another protocol, or failed while serving it. */
export type RouteFailure = 'window_unavailable' | 'protocol_incompatible' | 'timeout' | 'failed';

/** A route's answer: the other window's result, or why there is none, and whether the request may have acted there. */
export type RouteResponse =
	| { readonly ok: true; readonly result: unknown }
	| { readonly ok: false; readonly reason: RouteFailure; readonly message: string; readonly effects: 'none' | 'unknown' };

/** Whether other windows can reach this one through its component - it listens - and why not where they cannot. */
export interface PublishStatus {
	readonly listening: boolean;
	readonly problem?: string;
}

export function isPublishStatus(value: unknown): value is PublishStatus {
	return isJsonObject(value) && typeof value.listening === 'boolean' && (value.problem === undefined || typeof value.problem === 'string');
}

/** Numbers taken for aliases: `count` of them from `first` on, none ever given again. */
export interface Allocation {
	readonly first: number;
	readonly count: number;
}

export function isDirectoryAgent(value: unknown): value is DirectoryAgent {
	return isJsonObject(value) && ['run', 'alias', 'name', 'root', 'cli'].every(key => typeof value[key] === 'string')
		&& (value.creator === undefined || typeof value.creator === 'string') && typeof value.yolo === 'boolean'
		&& (value.lifecycle === 'starting' || value.lifecycle === 'running' || value.lifecycle === 'ended');
}

export function isDirectoryWindow(value: unknown): value is DirectoryWindow {
	return isJsonObject(value) && typeof value.window === 'string' && !!value.window && typeof value.label === 'string'
		&& typeof value.environment === 'string' && Array.isArray(value.agents) && value.agents.every(isDirectoryAgent);
}

export function isDirectory(value: unknown): value is Directory {
	return isJsonObject(value) && typeof value.self === 'string' && Array.isArray(value.windows) && value.windows.every(isDirectoryWindow)
		&& Array.isArray(value.unavailable) && value.unavailable.every(each => isJsonObject(each) && typeof each.window === 'string'
			&& typeof each.label === 'string' && typeof each.reason === 'string');
}

export function isRouteRequest(value: unknown): value is RouteRequest {
	return isJsonObject(value) && typeof value.to === 'string' && !!value.to && typeof value.op === 'string' && !!value.op
		&& typeof value.deadlineMs === 'number' && Number.isFinite(value.deadlineMs);
}

export function isServedRoute(value: unknown): value is ServedRoute {
	return isJsonObject(value) && typeof value.from === 'string' && !!value.from && typeof value.op === 'string' && !!value.op
		&& typeof value.deadlineMs === 'number' && Number.isFinite(value.deadlineMs);
}

export function isRouteResponse(value: unknown): value is RouteResponse {
	if (!isJsonObject(value)) {
		return false;
	}
	return value.ok === true
		|| (value.ok === false && typeof value.message === 'string' && (value.effects === 'none' || value.effects === 'unknown')
			&& ['window_unavailable', 'protocol_incompatible', 'timeout', 'failed'].includes(value.reason as string));
}

export function isAllocation(value: unknown): value is Allocation {
	return isJsonObject(value) && Number.isSafeInteger(value.first) && (value.first as number) >= 1
		&& Number.isSafeInteger(value.count) && (value.count as number) >= 1;
}
