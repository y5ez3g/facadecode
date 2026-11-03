/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This window's workspace extension on the client network (RULES-2.1, ARCHITECTURE-2.1): it reaches the other windows through its
// local window component's public commands, serves what they route here, tells the component which agents it holds, and takes the
// numbers of `#aN` and `#mN` aliases from this computer's counters so that no two windows give the same one.

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { expiredRoute, RouteExpired, withinRoute } from '../base/routeBudget';
import {
	AGENTS_ROUTE_COMMAND, Directory, isAllocation, isDirectory, isPublishStatus, isRouteResponse, isServedRoute, RouteResponse, ServedRoute,
	WINDOW_ALLOCATE_COMMAND, WINDOW_DIRECTORY_COMMAND, WINDOW_PUBLISH_COMMAND, WINDOW_ROUTE_COMMAND, WORKSPACE_REPUBLISH_COMMAND
} from '../base/windowNetwork';
import { directoryAgentOf, NetworkPort, RouteOp } from '../contract/network';
import { FacadeError } from '../core/errors';
import type { Agents, AliasPort, Disposable } from '../core/ports';

/** How long after an agent changes its window's published list follows: changes that come together are told once. */
const PUBLISH_DELAY_MS = 150;

/**
 * How many alias numbers are taken at a time, and how few may be left before more are taken. A local window's pool may run dry, as it
 * can read this computer's counter itself; a remote window's may not, as it cannot, so it keeps more at hand than one burst can use
 * before the next numbers arrive.
 */
export const LOCAL_POOL = { size: 16, low: 8 } as const;
export const REMOTE_POOL = { size: 32, low: 16 } as const;

/** Reaches the other windows through this window's component: none answers, and the network is unavailable. */
export class ClientNetwork implements NetworkPort {
	constructor(readonly self: string, private readonly session: string = vscode.env.sessionId) { }

	async directory(): Promise<Directory> {
		const directory = await vscode.commands.executeCommand<unknown>(WINDOW_DIRECTORY_COMMAND, this.session);
		if (!isDirectory(directory)) {
			throw new Error('the Facade Code Window Component did not list the open windows');
		}
		return directory;
	}

	async route(window: string, op: RouteOp, args: unknown, deadlineMs: number): Promise<RouteResponse> {
		if (deadlineMs <= 0) { return expiredRoute(false); }
		let response: unknown;
		try {
			response = await withinRoute(vscode.commands.executeCommand<unknown>(WINDOW_ROUTE_COMMAND, this.session, { to: window, op, args, deadlineMs }), deadlineMs);
		} catch (err) {
			if (err instanceof RouteExpired) { return expiredRoute(true); }
			const missing = messageOf(err).includes(`'${WINDOW_ROUTE_COMMAND}' not found`);
			return { ok: false, reason: 'window_unavailable', message: `The Facade Code Window Component could not return an answer: ${messageOf(err)}. ${missing ? 'The request had no effect.' : 'Whether the request took effect is unknown.'}`, effects: missing ? 'none' : 'unknown' };
		}
		return isRouteResponse(response) ? response
			: { ok: false, reason: 'failed', message: 'The Facade Code Window Component returned an unreadable answer. Whether the request took effect is unknown.', effects: 'unknown' };
	}
}

/**
 * What a window component too old for the client network leaves its window (ARCHITECTURE-4.3, RULES-2.2): no other window - each one
 * unavailable, never taken for none (RULES-2.3, MCP-3.1) - and no number for an agent or a message, so no start or send.
 */
export const OUTDATED_COMPONENT = 'this window\'s Facade Code Window Component is too old to reach other windows or to number agents and messages. Update "Facade Code Window Component" on this computer, then reload the window';

/** The network such a window has: none of the other windows can be listed or reached, as protocol_incompatible. */
export class OutdatedComponent implements NetworkPort {
	constructor(readonly self: string) { }

	async directory(): Promise<Directory> {
		throw new FacadeError('UNAVAILABLE', 'protocol_incompatible', OUTDATED_COMPONENT);
	}

	async route(): Promise<RouteResponse> {
		return { ok: false, reason: 'protocol_incompatible', message: `The request was not carried: ${OUTDATED_COMPONENT}. It had no effect.`, effects: 'none' };
	}
}

/** A start or send such a window refuses before any effect, saying what to do (RULES-2.2, UX-2.4). */
export function componentOutdated(): FacadeError {
	return new FacadeError('UNAVAILABLE', 'unavailable', `Nothing was started or sent: ${OUTDATED_COMPONENT}.`, { kind: 'component_outdated', values: [] });
}

/** The agent and message numbers such a window has: none. */
export const NO_AGENT_NUMBERS: AliasPort = { next: () => { throw componentOutdated(); } };
export const NO_MESSAGE_NUMBERS: { next(): number } = { next: () => { throw componentOutdated(); } };

/**
 * A start or send that no number can be taken for now: refused before any effect, as no other counter may stand in for this
 * computer's - one number is never given twice (RULES-2.2).
 */
export function numbersUnavailable(kind: 'agent' | 'message', why: string): FacadeError {
	return new FacadeError('UNAVAILABLE', 'unavailable', `No ${kind} number could be taken from this computer's counter: ${why}. Nothing was started or sent; try again.`, { kind: 'numbers_unavailable', values: [] });
}

/**
 * This window's address on the network, from its component: none where the component is missing or too old to carry requests, and
 * the tools then reach this window alone (ARCHITECTURE-4.3). Only a component without the directory command is too old: any other
 * failure of the call - a registry read, a crossing between extension hosts - is tried again, `tries` times a second apart.
 */
export async function networkAddress(session: string = vscode.env.sessionId, tries = 5, pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<string | undefined> {
	for (let attempt = 1; ; attempt++) {
		try {
			const directory = await vscode.commands.executeCommand<unknown>(WINDOW_DIRECTORY_COMMAND, session);
			return isDirectory(directory) ? directory.self : undefined;
		} catch (err) {
			if (messageOf(err).includes(`'${WINDOW_DIRECTORY_COMMAND}' not found`) || attempt >= tries) {
				return undefined;
			}
		}
		await pause(1_000);
	}
}

/** Serves what other windows route to this one, through `serve`, for as long as it is registered. */
export function serveRoutes(serve: (route: ServedRoute) => Promise<unknown>): vscode.Disposable {
	return vscode.commands.registerCommand(AGENTS_ROUTE_COMMAND, (route: unknown) => {
		if (!isServedRoute(route)) {
			throw new Error('The routed request was incomplete: it had no effect.');
		}
		return serve(route);
	});
}

/**
 * Tells this window's component which agents the window holds - who they are and their trees, never what they do - whenever that
 * changes, so that other windows resolve references to them without asking (RULES-2.3); and the window's name, `label`, as this
 * extension's tools give it, which in a remote window only this extension has.
 */
export function publishAgents(agents: Pick<Agents, 'list' | 'onDidChange'>, label: string, log: (line: string) => void, session: string = vscode.env.sessionId): Disposable {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	/** Why other windows cannot reach this one, as its component said last: said in the log as it changes. */
	let unreachable: string | undefined;
	const publish = () => {
		clearTimeout(timer);
		timer = undefined;
		if (disposed) {
			return;
		}
		void Promise.resolve(vscode.commands.executeCommand<unknown>(WINDOW_PUBLISH_COMMAND, session, agents.list().map(directoryAgentOf), label)).then(status => {
			// The component listens, or says why other windows cannot reach this one (ARCHITECTURE-2.1)
			const now = isPublishStatus(status) && !status.listening ? status.problem ?? 'its window component does not listen' : undefined;
			if (now !== unreachable && !disposed) {
				log(now !== undefined ? `Other Facade windows cannot reach this window now: ${now}` : 'Other Facade windows can reach this window again.');
			}
			unreachable = now;
		}, err => log(`Could not tell the other Facade windows about this window's agents: ${messageOf(err)}`));
	};
	const subscription = agents.onDidChange(change => {
		// What it is doing stays here: only who it is, its tree and its lifecycle are told
		if (change.kind !== 'reported') {
			timer ??= setTimeout(publish, PUBLISH_DELAY_MS);
		}
	});
	// A window component that started again - its extension host restarted while this one went on - asks for them (ARCHITECTURE-2.1)
	const republish = vscode.commands.registerCommand(WORKSPACE_REPUBLISH_COMMAND, (asked: unknown) => {
		if (asked === session) {
			publish();
		}
	});
	publish();
	return {
		dispose: () => {
			disposed = true;
			clearTimeout(timer);
			subscription.dispose();
			republish.dispose();
		}
	};
}

/**
 * Alias numbers for one kind - `#aN` agents or `#mN` messages - unique on this computer (RULES-1.1, 2.2): taken from the window
 * component's counter a few at a time, ahead of need, so that a start or a send takes one at once. Numbers left when the window goes
 * are never given again; a gap is no reuse. Should the pool be empty, a local window takes one from this computer's counter itself,
 * `direct`; a remote window, whose component is out of its reach, has none to take. No other counter stands in: the start or send is
 * refused before any effect.
 */
export class AliasPool {
	private numbers: number[] = [];
	private refilling: Promise<void> | undefined;

	constructor(
		private readonly kind: 'agent' | 'message',
		private readonly direct: (() => number) | undefined,
		private readonly log: (line: string) => void,
		private readonly session: string = vscode.env.sessionId,
		private readonly pool: { readonly size: number; readonly low: number } = REMOTE_POOL,
		/** What its numbers go past besides those it holds: a remote window's environment counters, which its component cannot read. */
		private readonly floor?: () => number
	) { }

	/** Takes the first numbers; resolves whether the component gave them. */
	async prime(): Promise<boolean> {
		await this.refill();
		return this.numbers.length > 0;
	}

	next(): number {
		const number = this.numbers.shift();
		if (this.numbers.length < this.pool.low) {
			void this.refill();
		}
		if (number !== undefined) {
			return number;
		}
		if (!this.direct) {
			throw numbersUnavailable(this.kind, 'this window has none left from its component yet');
		}
		try {
			return this.direct();
		} catch (err) {
			throw numbersUnavailable(this.kind, messageOf(err));
		}
	}

	private refill(): Promise<void> {
		this.refilling ??= (async () => {
			try {
				// Past those it holds, and those an earlier build's counter of its environment gave (RULES-2.2)
				const floor = Math.max(this.numbers.length ? this.numbers[this.numbers.length - 1] : 0, this.floor?.() ?? 0);
				const allocation = await vscode.commands.executeCommand<unknown>(WINDOW_ALLOCATE_COMMAND, this.session, this.kind, this.pool.size, floor);
				if (isAllocation(allocation)) {
					for (let n = allocation.first; n < allocation.first + allocation.count; n++) {
						this.numbers.push(n);
					}
				}
			} catch (err) {
				this.log(`Could not take ${this.kind} numbers from this computer's counter: ${messageOf(err)}`);
			} finally {
				this.refilling = undefined;
			}
		})();
		return this.refilling;
	}
}

/** `#aN` aliases from an agent number pool. */
export function agentAliases(pool: AliasPool): AliasPort {
	return { next: () => `#a${pool.next()}` };
}
