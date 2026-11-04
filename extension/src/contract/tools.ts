/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window's answers to the eight tools (MCP-2 to 5), for one window (M3): each call's arguments validated whole before any
// effect, its target resolved once within the caller's reach (RULES-2.3, 4.3), and an answer that states what actually happened
// (MCP-1.2). Errors go back to the calling agent alone: nothing here notifies the person (RULES-1.8).

import type { ScreenStyle } from '../base/screenStyle';
import { monotonic } from '../base/clock';
import { isJsonObject } from '../base/json';
import { messageOf as errorText } from '../base/errors';
import { FacadeError } from '../core/errors';
import { HOLD_MS, RESPONSE_BUDGET_MS, STAGE_MS } from '../core/messages';
import type { InputPort, MessageRecord, Messages, SendResult } from '../core/messagePorts';
import type { Agents, CliChoice, Clock, Location, LocationPort, RunFacts, RunId, StartOutcome } from '../core/ports';
import { reaches, referenceOf, resolveAgent, ResolveOptions, trailingId } from '../core/reach';
import { isWindowSnapshot, snapshotPage, WindowSnapshot, windowSnapshot } from './snapshot';
import type { RouteResponse, ServedRoute } from '../base/windowNetwork';
import { ServedAnswer, TOOL_PROTOCOL, ToolCall } from '../schema/protocol';
import { accepted, answerOf, codedOf, Effects, errorResult, failure, Result, resultErrorOf, success } from '../schema/result';
import { compactResult } from '../schema/compact';
import { screenText } from '../base/screenStyle';
import { withRecovery } from '../schema/recovery';
import { receiptTextOf } from './receiptText';
import { MESSAGE_LIMIT, QUERY_ROUTE_MS, QUERY_TOOLS, READ_ONLY_TOOLS, ToolName, TOOLS } from '../schema/tools';
import { ArgumentError, codePoints, ToolArguments, validateArguments } from '../schema/validate';
import { agentOf, CliFacts, StartCatalog, Data, defined, isoOf, messageFile, messageOf, sendFailureOf, ToolWindow } from './facts';
import { GuestCaller, isGuestCaller, NetworkPort, Reachable, reachableOf, RoutedCall, RoutedDelivery, RoutedResult } from './network';

export type { ToolWindow, CliFacts, StartCatalog } from './facts';

/** Keep the route's reason independent of whether an operation may already have acted. */
function routeError(response: Extract<RouteResponse, { ok: false }>): FacadeError {
	return new FacadeError(response.reason === 'failed' ? 'FAILED' : 'UNAVAILABLE', response.reason === 'failed' ? 'route_failed' : response.reason, response.message);
}

/** A screen as a read gives it: ptyd's `ScreenRead`, by its shape, as this layer does not import ptyd. */
export interface ScreenSnapshot {
	/** The bottom logical lines, inverse video marked `[[...]]` and dim `{{...}}`. */
	readonly lines: readonly string[];
	/** The same lines as plain text. */
	readonly text: readonly string[];
	readonly styles?: readonly ScreenStyle[];
	readonly buffer: 'normal' | 'alternate';
	readonly older: boolean;
	readonly trimmed: boolean;
	readonly capturedAt: number;
	readonly exited: boolean;
	/** With a normal-buffer read, the last frame a full-screen program drew on the alternate screen before it left it or ended (MCP-5.1). */
	readonly frame?: { readonly lines: readonly string[]; readonly text: readonly string[];
	readonly styles?: readonly ScreenStyle[]; readonly capturedAt: number };
}

/** What direct input did: ptyd's `InputEffect`, by its shape. */
export interface InputOutcome {
	readonly outcome: 'applied' | 'partial' | 'not_applied';
	readonly reason?: 'ended';
	readonly pasted?: boolean;
	readonly entered?: boolean;
	readonly keysSent?: number;
}

/** The run's terminal as the window passes it through to ptyd (MCP-5): reads and direct input, serialized there (RULES-1.10). */
export interface TerminalPort {
	/** The run's screen, or its retained final one; undefined where it has none. */
	readScreen(run: RunId, lines: number): Promise<ScreenSnapshot | undefined>;
	typeText(run: RunId, text: string, enter: boolean): Promise<InputOutcome>;
	/** Presses keys named as ptyd names them (`schema/keys.ts`). */
	pressKeys(run: RunId, keys: readonly string[]): Promise<InputOutcome>;
}

/** Writes a long read result as a file readable by the caller (COLLABORATION-4.2): `record/results.ts`. */
export type ResultWriter = (home: string, kind: 'messages' | 'screen', text: string, messageIds?: readonly string[]) =>
	{ readonly path: string; readonly size: number } | Promise<{ readonly path: string; readonly size: number }>;

export interface ToolServiceDeps {
	readonly window: ToolWindow;
	readonly agents: Pick<Agents, 'launch' | 'started' | 'warmedUp' | 'close' | 'list' | 'get' | 'requested' | 'creationPending' | 'creationSettled'>;
	readonly locations: Pick<LocationPort, 'snapshot' | 'resolve'>;
	readonly clis: StartCatalog;
	readonly messages: Pick<Messages, 'send' | 'allocate' | 'reserveResult' | 'recordPrompt' | 'report' | 'inbox' | 'markDelivered' | 'keepSent' | 'history' | 'findRequest'>;
	readonly terminal: TerminalPort;
	/** The execution environment's Facade directory, where long results are written. */
	readonly home: string;
	readonly writeResult: ResultWriter;
	/** Structured event log in this execution environment, for on-demand history. */
	readonly historyLog?: string;
	/** `facade.collaboration.waitSeconds`, in seconds: how long a start or stop is waited for before it is answered `accepted` (MCP-1.3). */
	readonly timeout: () => number;
	/** The destination's `facade.yolo`, which a start would launch with (RULES-4.3). */
	readonly yolo: () => boolean;
	/** A run's ordinary message input, where the message service has it. */
	readonly input?: Pick<InputPort, 'capability'>;
	/**
	 * Settles once the window found its runs again after a reload: a call of a caller not known yet waits for it, within the call's
	 * first two seconds, rather than fail for a run being reattached (RULES-1.9, 4.1).
	 */
	readonly ready?: Promise<unknown>;
	/** Every other open Facade window on this computer (COLLABORATION-1.1); none, and the tools reach this window alone. */
	readonly network?: NetworkPort;
	readonly clock?: Clock;
	/** This process's monotonic clock, which the time a call spends in the window is measured on (ARCHITECTURE-2.3). */
	readonly monotonic?: () => number;
	/** A line for Show Agents Log: no message text (ARCHITECTURE-3.3). */
	readonly log?: (text: string) => void;
	readonly recordEvent?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** How long from the shim's ingress a call of a caller not known yet waits for the window's runs to be found again (RULES-1.2). */
const CALLER_WAIT_MS = 2_000;

/** How long direct input to another window's agent may take there, its own waits included (MCP-5.2). */
const ROUTE_INPUT_MS = 30_000;

/**
 * The hops back from another window, charged to a message's two seconds before that window answers it: forwarding spends the same
 * allowance, and the answer comes within them (RULES-1.2). Half a second: a remote window's hops cross its SSH connection.
 */
const ROUTE_TRANSIT_MS = 500;

/** How a later outcome reaches the caller: what accepted texts say of it (MCP-1.3, RULES-1.7). */
const LATER = 'recorded later as a Facade result in your inbox, and typed into your terminal where your CLI\'s message input allows';

/** What a tool came to: its result, the sentence that heads its text, and what to do once its answer was handed back. */
interface Outcome {
	readonly result: Result;
	readonly headline?: string;
	readonly after?: () => void;
}

/** A call as a handler has it: with when the window read it, on this process's monotonic clock. */
interface Received extends ToolCall {
	readonly receivedAt: number;
	/** The caller, where another window routed its call here (COLLABORATION-1.1). */
	readonly guest?: GuestCaller;
	/** For a routed read_screen: a long screen comes back whole, for the caller's window to write where its agent can read it. */
	readonly inline?: boolean;
}

/** The calling agent: one of this window's runs, or another window's whose call was routed here, `window` naming that window. */
type Caller = Pick<RunFacts, 'id' | 'alias' | 'name' | 'root' | 'yolo'> & { readonly window?: string; readonly windowLabel?: string };

/** Where a reference led: an agent of this window, or another window's. */
type Located = { readonly here: RunFacts; readonly there?: undefined } | { readonly here?: undefined; readonly there: Reachable };

type Handler<T extends ToolName> = (args: ToolArguments[T], caller: Caller, call: Received) => Promise<Outcome>;

/**
 * The window's tool service: one call in - with when the window read it, on this process's monotonic clock - and its MCP answer
 * out, with what to do once that answer was handed back: read_messages marks what it returns fetched only then (MCP-4.2).
 */
export function createToolService(deps: ToolServiceDeps): (call: ToolCall, receivedAt?: number) => Promise<ServedAnswer> {
	const services = createToolServices(deps);
	return (call, receivedAt) => services.answer(call, receivedAt);
}

/** The window's tool service, and what it serves for other windows of this computer (COLLABORATION-1.1). */
export interface ToolServices {
	answer(call: ToolCall, receivedAt?: number): Promise<ServedAnswer>;
	/** Serves one request another window routed here. */
	serve(route: ServedRoute): Promise<unknown>;
}

export function createToolServices(deps: ToolServiceDeps): ToolServices {
	const service = new ToolService(deps);
	return { answer: (call, receivedAt) => service.answer(call, receivedAt), serve: route => service.serve(route) };
}

class ToolService {
	/** Overlapping keyed calls share the first invocation; durable retries are answered by run/message metadata. */
	private readonly pendingRequests = new Map<string, Promise<Outcome>>();
	private readonly handlers: { readonly [T in ToolName]: Handler<T> } = {
		start_agent: (args, caller, call) => this.startAgent(args, caller, call),
		list_agents: (args, caller, call) => this.listAgents(args, caller, call),
		stop_agent: (args, caller, call) => this.stopAgent(args, caller, call),
		send_message: (args, caller, call) => this.sendMessage(args, caller, call),
		read_messages: (args, caller) => this.readMessages(args, caller),
		read_screen: (args, caller, call) => this.readScreen(args, caller, call),
		type_text: (args, caller, call) => this.typeText(args, caller, call),
		press_keys: (args, caller, call) => this.pressKeys(args, caller, call)
	};

	constructor(private readonly deps: ToolServiceDeps) { }

	async answer(call: ToolCall, receivedAt = this.mono()): Promise<ServedAnswer> {
		let outcome: Outcome;
		try {
			outcome = await this.handle({ ...call, receivedAt });
		} catch (err) {
			outcome = { result: err instanceof ArgumentError ? errorResult(err, { data: err.problems }) : errorResult(err, { readOnly: QUERY_TOOLS.has(call.tool) }) };
		}
		// Each call by its tool, caller and outcome, never its arguments: how agents use the tools shows in the log (ARCHITECTURE-3.3)
		const { status, error } = outcome.result;
		const tool = TOOLS.some(each => each.name === call.tool) ? call.tool : 'an unknown tool';
		const projected = withRecovery(call.tool, compactResult(call.tool, outcome.result, !!(call.arguments as { details?: boolean } | undefined)?.details), call.arguments);
		const data = isJsonObject(projected.data) ? projected.data : {};
		const request = isJsonObject(call.arguments) && typeof call.arguments.request_id === 'string' && codePoints(call.arguments.request_id) <= 200 ? call.arguments.request_id : undefined;
		this.deps.log?.(`Tool ${tool} by ${this.deps.agents.get(call.caller as RunId)?.alias ?? call.caller}: ${status}${error ? ` ${error.code} (${error.reason})` : ''} in ${Math.round(this.mono() - receivedAt)} ms; ${JSON.stringify({
			call_id: call.callId, request_id: request, window: this.deps.window.id, target_window: data.window_id,
			agent: data.agent_id ?? data.target, message: data.message_id, result_message: data.result_message_id, effects: projected.effects.outcome
		})}`);
		const requested = isJsonObject(call.arguments) ? call.arguments : {};
		const field = (key: string) => typeof requested[key] === 'string' && codePoints(requested[key]) <= 200 ? requested[key] : undefined;
		this.deps.recordEvent?.('tool_result', defined({
			tool, caller: call.caller, call_id: call.callId, request_id: request, status,
			target_window: data.window_id ?? field('window_id'), agent_id: data.agent_id ?? data.target,
			message_id: data.message_id, result_message_id: data.result_message_id,
			effects: projected.effects.outcome, reason: error?.reason, code: error?.code,
			...(tool === 'start_agent' ? { cli: field('cli'), location_id: field('location_id'),
				requested_model: field('model'), requested_effort: field('effort'), reason_text: error?.message } : {})
		}));
		const { after } = outcome;
		return {
			answer: answerOf(projected),
			...after ? {
				delivered: () => {
					try {
						after();
					} catch (err) {
						this.deps.log?.(`Could not complete ${call.tool} for ${call.caller}: ${errorText(err)}`);
					}
				}
			} : {}
		};
	}

	private async handle(call: Received): Promise<Outcome> {
		// Only the current tool protocol is accepted, without translation or downgrade (MCP-6.2).
		if (call.protocol !== TOOL_PROTOCOL) {
			const theirs = typeof call.protocol === 'number' ? `tool protocol ${call.protocol}` : 'no tool protocol';
			return { result: failure({ code: 'UNAVAILABLE', reason: 'protocol_incompatible', message: `This agent's Facade MCP server speaks ${theirs}, and its Facade Code window tool protocol ${TOOL_PROTOCOL}: the call had no effect.` }, {}) };
		}
		if (!TOOLS.some(each => each.name === call.tool)) {
			return { result: failure({ code: 'INVALID', reason: 'unsupported', message: `Facade has no tool ${JSON.stringify(call.tool)}.` }, {}) };
		}
		const tool = call.tool as ToolName;
		const args = validateArguments(tool, call.arguments);
		const caller: Caller = call.guest ?? await this.callerOf(call);
		const key = 'request_id' in args && typeof args.request_id === 'string' ? JSON.stringify([caller.id, tool, args.request_id]) : undefined;
		const pending = key !== undefined ? this.pendingRequests.get(key) : undefined;
		if (pending) {
			return pending;
		}
		const answer = (this.handlers[tool] as Handler<ToolName>)(args as never, caller, call);
		if (key === undefined) {
			return answer;
		}
		this.pendingRequests.set(key, answer);
		try {
			return await answer;
		} finally {
			this.pendingRequests.delete(key);
		}
	}

	/**
	 * Serves one request another window of this computer routed here (COLLABORATION-1.1): a tool call for this window's agents or
	 * locations, this window's summary or agents, a message for one of its agents, or a Facade result for one.
	 */
	async serve(route: ServedRoute): Promise<unknown> {
		const args = route.args as { readonly [key: string]: unknown } | undefined;
		switch (route.op) {
			case 'call': {
				const routed = args as unknown as RoutedCall;
				if (!routed || typeof routed.tool !== 'string' || typeof routed.callId !== 'string' || typeof routed.elapsedMs !== 'number' || !isGuestCaller(routed.caller)) {
					throw new Error('The routed tool call was incomplete: it had no effect.');
				}
				// The caller is the one its window says, of the window the route came from: an address, not a credential (MCP-6.1)
				const guest: GuestCaller = { ...routed.caller, window: route.from };
				let outcome: Outcome;
				try {
					outcome = await this.handle({
						protocol: routed.protocol, caller: guest.id, tool: routed.tool, arguments: routed.arguments, callId: routed.callId,
						elapsedMs: routed.elapsedMs, receivedAt: this.mono(), guest, ...routed.inline ? { inline: true } : {}
					});
				} catch (err) {
					outcome = { result: err instanceof ArgumentError ? errorResult(err, { data: err.problems }) : errorResult(err, { readOnly: QUERY_TOOLS.has(routed.tool) }) };
				}
				return { result: outcome.result, ...outcome.headline !== undefined ? { headline: outcome.headline } : {} };
			}
			case 'agents': {
				if (!isGuestCaller(args?.caller)) {
					throw new Error('The routed agent list names no caller.');
				}
				return this.localSnapshot(args!.caller as GuestCaller, typeof args!.agent === 'string' ? args!.agent : undefined,
					typeof args!.location_id === 'string' ? args!.location_id : undefined, args!.details === true);
			}
			case 'deliver':
				return this.deliver(args as unknown as RoutedDelivery, route.from);
			case 'result':
				return this.receiveResult(args as unknown as RoutedResult);
			default:
				throw new Error(`This window serves no ${JSON.stringify(route.op)}.`);
		}
	}

	/**
	 * The calling run. One this window does not know yet may be one it is finding again after a reload, ptyd giving its waiting call
	 * as the window claims it: the call waits for that, within its first two seconds (RULES-1.9, 4.1).
	 */
	private async callerOf(call: Received): Promise<RunFacts> {
		let caller = this.deps.agents.get(call.caller);
		if (!caller && this.deps.ready) {
			await within(this.deps.ready, CALLER_WAIT_MS - this.elapsed(call));
			caller = this.deps.agents.get(call.caller);
		}
		if (!caller) {
			throw new FacadeError('NOT_FOUND', 'not_found', `The calling agent ${call.caller} is not known in this window.`);
		}
		return caller;
	}

	private now(): number {
		return this.deps.clock?.now() ?? Date.now();
	}

	private mono(): number {
		return (this.deps.monotonic ?? monotonic)();
	}

	/** How long `call` has been under way since the shim had it: the hops before the window, and its time here (RULES-1.2). */
	private elapsed(call: Received): number {
		return Math.max(0, call.elapsedMs) + Math.max(0, this.mono() - call.receivedAt);
	}

	private checkWindow(id: string | undefined): void {
		if (id !== undefined && id !== this.deps.window.id) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No open window ${JSON.stringify(id)} was found.`);
		}
	}

	private location(id: string): Location {
		const location = this.deps.locations.resolve(id);
		if (!location) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No working location ${JSON.stringify(id)} is in window ${this.deps.window.label}.`);
		}
		return location;
	}

	/** The run `reference` names within the caller's reach (RULES-2.3, 4.3). */
	/**
	 * Whether `reference` names the person (RULES-2.3): `#human` always; `@human` or `human` unless an agent the caller reaches is
	 * named `human`, when it is ambiguous like any repeated name and resolving it as an agent says so.
	 */
	private async isHuman(reference: string, caller: Caller): Promise<boolean> {
		const text = reference.trim();
		if (/^#human$/i.test(text)) {
			return true;
		}
		if (!/^@?human$/i.test(text)) {
			return false;
		}
		const named = this.deps.agents.list().filter(run => reaches(caller, run) && /^human$/i.test(run.name));
		if (this.deps.network && caller.window === undefined) {
			let directory;
			try {
				directory = await this.deps.network.directory();
			} catch {
				throw new FacadeError('UNAVAILABLE', 'window_unavailable', 'The other windows could not be checked for an agent named human. Use #human for the person.');
			}
			const others = directory.windows.flatMap(window => window.agents).filter(run => reaches(caller, run) && /^human$/i.test(run.name));
			if (named.length || others.length) {
				throw new FacadeError('INVALID', 'ambiguous_reference', '@human names the person and an agent named human. Use #human for the person, or the agent ID.');
			}
			if (directory.unavailable.length) {
				throw new FacadeError('UNAVAILABLE', 'window_unavailable', 'Some windows could not be checked for an agent named human. Use #human for the person.');
			}
		}
		if (named.length) {
			resolveAgent(reference, named);
		}
		return true;
	}

	private target(reference: string, caller: Caller, eligible?: ResolveOptions['eligible']): RunFacts {
		const all = this.deps.agents.list();
		return resolveAgent(reference, all.filter(run => reaches(caller, run)), { outside: all.filter(run => !reaches(caller, run)), ...eligible ? { eligible } : {} });
	}

	/**
	 * The agent `reference` names within the caller's reach, in this window or another of this computer (RULES-2.3, 4.3): an exact ID
	 * or `#aN` of this window's needs no other window; a name is resolved among every window's agents, so that one name in two windows
	 * is ambiguous as it is in one. A call another window routed here names its target exactly, and stays in this window.
	 */
	private async locate(reference: string, caller: Caller, eligible?: (run: Reachable) => boolean): Promise<Located> {
		const self = this.deps.window.id;
		const here = this.deps.agents.list().map(run => ({ facts: run, reachable: { id: run.id, alias: run.alias, name: run.name, root: run.root, yolo: run.yolo, lifecycle: run.lifecycle, window: self } }));
		const id = trailingId(reference) ?? reference.trim();
		const exact = here.find(each => each.facts.id === id || each.facts.alias === id);
		const network = this.deps.network;
		if (exact || !network || caller.window !== undefined) {
			return { here: this.target(reference, caller, eligible ? (run: RunFacts) => eligible({ ...run, window: self }) : undefined) };
		}
		let others: Reachable[] = [];
		let incomplete = false;
		try {
			const directory = await network.directory();
			others = directory.windows.filter(window => window.window !== self).flatMap(window => window.agents.map(agent => reachableOf(agent, window.window, window.environment)));
			incomplete = directory.unavailable.length > 0;
		} catch (err) {
			this.deps.log?.(`Could not read the other Facade windows' agents: ${errorText(err)}`);
			incomplete = true;
		}
		const all: Reachable[] = [...here.map(each => each.reachable), ...others];
		if (incomplete && !all.some(run => run.id === id || run.alias === id)) {
			throw new FacadeError('UNAVAILABLE', 'window_unavailable', 'Some Facade windows could not be listed, so this reference cannot be resolved without guessing. Use an agent ID from an available window.');
		}
		const found = resolveAgent(reference, all.filter(run => reaches(caller, run)), { outside: all.filter(run => !reaches(caller, run)), ...eligible ? { eligible } : {} });
		const facts = found.window === self ? this.deps.agents.get(found.id) : undefined;
		return facts ? { here: facts } : { there: found };
	}

	/**
	 * Refuses a window no component lists as open on this computer: not found, as for this window's own address, before anything is
	 * routed - a known absence, unlike a window listed but unreachable (MCP-2.1). Where the list itself cannot be read, the route says why.
	 */
	private async knownWindow(window: string): Promise<void> {
		let directory;
		try {
			directory = await this.deps.network!.directory();
		} catch {
			return;
		}
		if (!directory.windows.some(each => each.window === window) && !directory.unavailable.some(each => each.window === window)) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No open window ${JSON.stringify(window)} was found.`);
		}
	}

	/** The caller as another window is told it: its own window's address where it is a run of this one. */
	private guestOf(caller: Caller): GuestCaller {
		return {
			id: caller.id, alias: caller.alias, name: caller.name, root: caller.root, yolo: caller.yolo,
			window: caller.window ?? this.deps.window.id, windowLabel: caller.windowLabel ?? this.deps.window.label
		};
	}

	/**
	 * Makes a tool call in `window` for this window's caller (COLLABORATION-1.1): that window validates and acts on its own agents, its
	 * answer coming back as it gave it. A route that carried no answer says why, and whether the call may have acted there.
	 */
	private async routeCall(window: string, tool: ToolName, args: object, caller: Caller, call: Received, deadlineMs: number, inline = false): Promise<Outcome> {
		const routed: RoutedCall = { tool, arguments: args, caller: this.guestOf(caller), callId: call.callId, elapsedMs: this.elapsed(call), protocol: call.protocol, ...inline ? { inline } : {} };
		this.deps.log?.(`Route ${JSON.stringify({ phase: 'requested', call_id: call.callId, tool, from: this.deps.window.id, to: window, caller: caller.alias, deadline_ms: Math.round(deadlineMs) })}`);
		const response = await this.deps.network!.route(window, 'call', routed, deadlineMs);
		this.deps.log?.(`Route ${JSON.stringify({ phase: response.ok ? 'answered' : 'reply_unavailable', call_id: call.callId, tool, from: this.deps.window.id, to: window, ...!response.ok ? { reason: response.reason, effects: response.effects } : {} })}`);
		const data = { window_id: window, ...'agent' in args && typeof args.agent === 'string' ? { agent_id: args.agent } : {} };
		if (!response.ok) {
			const unknown = response.effects === 'unknown' && !READ_ONLY_TOOLS.has(tool);
			return {
				result: failure(routeError(response), data, unknown ? { outcome: 'unknown' } : { outcome: 'none' })
			};
		}
		const answer = response.result as { readonly result?: Result; readonly headline?: string } | undefined;
		if (!answer || typeof answer !== 'object' || !answer.result || typeof answer.result.status !== 'string') {
			return { result: failure({ code: 'FAILED', reason: 'invalid_response', message: `The Facade window ${window} returned an unreadable answer to ${tool}.` }, data, { outcome: READ_ONLY_TOOLS.has(tool) ? 'none' : 'unknown' }) };
		}
		return { result: answer.result, ...answer.headline !== undefined ? { headline: answer.headline } : {} };
	}

	/**
	 * Gives the caller a Facade result about something it asked that finished later (RULES-1.7): in its terminal where it is this
	 * window's, else in its own window, routed there; nobody else hears of it going astray.
	 */
	private reportTo(caller: Caller, report: { readonly id: string; readonly callId: string; readonly requestId?: string; readonly tool: 'start_agent' | 'stop_agent'; readonly agent: RunFacts; readonly text: string; readonly result?: Data }): void {
		const agent = { run: report.agent.id, alias: report.agent.alias, name: report.agent.name };
		const operation = { tool: report.tool, window: this.deps.window.id };
		this.deps.log?.(`Receipt ${JSON.stringify({ message: report.id.replace(/^m-/, '#m'), call_id: report.callId, request_id: report.requestId, agent: agent.alias, operation, to: caller.alias, to_window: caller.window ?? this.deps.window.id, status: report.result?.status })}`);
		if (caller.window === undefined || caller.window === this.deps.window.id) {
			this.deps.messages.report({ id: report.id, to: caller.id, callId: report.callId, ...report.requestId !== undefined ? { requestId: report.requestId } : {}, operation, agent: report.agent.id, agentParty: agent, text: report.text, ...report.result !== undefined ? { result: report.result } : {} });
			return;
		}
		const result: RoutedResult = { id: report.id, to: caller.id, text: report.text, ...report.result !== undefined ? { result: report.result } : {}, callId: report.callId, ...report.requestId !== undefined ? { requestId: report.requestId } : {}, operation, agent };
		void this.deps.network?.route(caller.window, 'result', result, STAGE_MS).then(response => {
			if (!response.ok) {
				this.deps.log?.(`Receipt ${report.id.replace(/^m-/, '#m')} for ${caller.alias} could not reach its window ${caller.window}: ${response.message}`);
			}
		}, err => this.deps.log?.(`A Facade result for ${caller.alias} could not reach its window ${caller.window}: ${errorText(err)}`));
	}


	// -----------------------------------------------------------------------------------------------------------------------
	// The client network (COLLABORATION-1.1)

	/** How long a query waits for other windows: its route deadline from the shim's ingress (MCP-1.3). */
	private queryDeadline(call: Received): number {
		return Math.max(0, QUERY_ROUTE_MS - this.elapsed(call));
	}

	/**
	 * Asks every other open window - or `only` that one - for its part of a query, each within the route deadline; a window that
	 * cannot be read or does not answer in time is listed apart, never taken for an empty answer (MCP-1.3).
	 */
	private async everyWindow<T>(ask: (window: string) => Promise<T>, only?: string): Promise<{ readonly windows: T[]; readonly unavailable: Data[] }> {
		const network = this.deps.network;
		if (!network || only === this.deps.window.id) {
			return { windows: [], unavailable: [] };
		}
		let directory;
		try {
			directory = await network.directory();
		} catch (err) {
			// A window component too old for the client network says so: protocol_incompatible (ARCHITECTURE-4.3)
			return { windows: [], unavailable: [{ window_id: only ?? '*', reason: err instanceof FacadeError ? err.reason : 'window_unavailable', message: `The other Facade windows cannot be listed now: ${errorText(err)}` }] };
		}
		const unavailable: Data[] = directory.unavailable
			.filter(each => only === undefined || each.window === only)
			.map(each => ({ window_id: each.window, label: each.label, reason: each.reason }));
		const others = directory.windows.filter(window => window.window !== this.deps.window.id && (only === undefined || window.window === only));
		if (only !== undefined && !others.length && !unavailable.length) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No open window ${JSON.stringify(only)} was found.`);
		}
		const answers = await Promise.all(others.map(async window => {
			try {
				return { window, value: await ask(window.window) };
			} catch (err) {
				unavailable.push({ window_id: window.window, label: window.label, reason: err instanceof FacadeError ? err.reason : 'window_unavailable', message: errorText(err) });
				return undefined;
			}
		}));
		return { windows: answers.filter((each): each is { window: typeof others[number]; value: Awaited<T> } => !!each).map(each => each.value as T), unavailable };
	}

	private async localSnapshot(caller: Caller, selected?: string, locationId?: string, details = false): Promise<{ window: WindowSnapshot; agents: Data[] }> {
		if (locationId !== undefined) { this.location(locationId); }
		const agents = this.agentsFor(caller, selected !== undefined)
			.filter(agent => (selected === undefined || agent.agent_id === selected) && (locationId === undefined || agent.location_id === locationId));
		// A facade.yolo neither true nor false is one of this window's configuration problems: the snapshot is still given (UX-4.1)
		let yolo = true;
		let yoloProblem: string | undefined;
		try { yolo = this.deps.yolo(); } catch (err) { yoloProblem = errorText(err); }
		const window = await windowSnapshot({ window: this.deps.window, catalog: this.deps.locations.snapshot(), clis: this.deps.clis,
			yolo, now: () => this.now(), agentCount: agents.length, location: locationId ?? (selected !== undefined ? String(agents[0]?.location_id ?? '') : undefined), targeted: selected !== undefined, details,
			logFile: this.deps.historyLog });
		return { agents, window: yoloProblem === undefined ? window : { ...window, problems: [{ setting: 'facade.yolo', problem: yoloProblem }, ...window.problems as readonly Data[]] } };
	}

	/** This window's agents that `caller` reaches, as list_agents describes them (MCP-3.1). */
	private agentsFor(caller: Caller, includeEnded: boolean): Data[] {
		const now = this.now();
		return this.deps.agents.list()
			.filter(run => reaches(caller, run) && (includeEnded || run.lifecycle !== 'ended'))
			.map(run => agentOf(run, this.deps.window, now, this.deps.input?.capability(run.id)));
	}

	/** How a guest caller's message or prompt says who sent it, and where its result goes (RULES-1.7). */
	private senderOf(caller: Caller): { readonly sender?: { readonly party: MessageRecord['from']; readonly window: string; readonly label?: string } } {
		return caller.window !== undefined && caller.window !== this.deps.window.id
			? { sender: { party: { run: caller.id, alias: caller.alias, name: caller.name }, window: caller.window, ...caller.windowLabel !== undefined ? { label: caller.windowLabel } : {} } }
			: {};
	}

	/**
	 * A message another window's agent sent to one of this window's (RULES-1.4, 1.5): delivered here under this window's input rules,
	 * within what is left of its two seconds, its later outcome going back to the sender's window (RULES-1.7).
	 */
	private async deliver(delivery: RoutedDelivery, from: string): Promise<Data> {
		if (!delivery || typeof delivery.id !== 'string' || typeof delivery.to !== 'string' || typeof delivery.text !== 'string' || !isGuestCaller(delivery.from)
			|| typeof delivery.elapsedMs !== 'number' || !Number.isFinite(delivery.elapsedMs)) {
			throw new Error('The routed message was incomplete: it had no effect.');
		}
		const sender: GuestCaller = { ...delivery.from, window: from };
		const earlier = typeof delivery.requestId === 'string' ? this.deps.messages.findRequest(sender.id, delivery.requestId) : undefined;
		if (earlier) {
			return defined({ status: earlier.delivery.status === 'pending' ? 'accepted' : earlier.delivery.status, reason: earlier.delivery.reason, record: earlier });
		}
		const target = this.deps.agents.get(delivery.to);
		if (!target || !reaches(sender, target)) {
			// A refusal before any record or input, answered as one: thrown, the route could only say its effects are not known (MCP-1.2)
			return { status: 'failure', error: { code: 'NOT_FOUND', reason: 'not_found', message: `No agent ${delivery.to} that the sender reaches is in this window.` } };
		}
		const sent = await this.deps.messages.send({
			id: delivery.id, from: sender.id, sender: { party: { run: sender.id, alias: sender.alias, name: sender.name }, window: from, ...sender.windowLabel !== undefined ? { label: sender.windowLabel } : {} },
			to: target.id, text: delivery.text, ...delivery.replyTo !== undefined ? { replyTo: delivery.replyTo } : {},
			elapsedMs: delivery.elapsedMs, ...delivery.callId !== undefined ? { callId: delivery.callId } : {},
			// A request ID is the sender's words, kept as given where it is the shape a call's is (MCP-1.1)
			...typeof delivery.requestId === 'string' && codePoints(delivery.requestId) > 0 && codePoints(delivery.requestId) <= 200 ? { requestId: delivery.requestId } : {}
		});
		return defined({ status: sent.status, reason: sent.reason, obstacle: sent.obstacle, record: sent.record });
	}

	/** A Facade result another window sends for one of this window's agents (RULES-1.7): in its inbox, and its terminal where it can be. */
	private receiveResult(result: RoutedResult): Data {
		if (!result || typeof result.to !== 'string' || typeof result.text !== 'string' || (result.result !== undefined && !isJsonObject(result.result)) || (result.id !== undefined && !/^m-[1-9]\d*$/.test(result.id)) || !this.deps.agents.get(result.to)) {
			throw new Error('The routed Facade result names no agent of this window: it had no effect.');
		}
		if (result.operation !== undefined && (!isJsonObject(result.operation) || !['start_agent', 'stop_agent'].includes(result.operation.tool) || typeof result.operation.window !== 'string')) {
			throw new Error('The routed result has an invalid operation: it had no effect.');
		}
		if (result.about) {
			this.deps.messages.keepSent(result.about);
		}
		this.deps.messages.report({
			...result.id !== undefined ? { id: result.id } : {}, to: result.to, text: result.text, ...result.result !== undefined ? { result: result.result } : {}, ...result.callId !== undefined ? { callId: result.callId } : {},
			...result.operation !== undefined ? { operation: result.operation } : {},
			...(result.requestId ?? result.about?.requestId) !== undefined ? { requestId: result.requestId ?? result.about?.requestId } : {},
			...result.about ? { about: result.about.id } : {}, ...result.agent ? { agentParty: result.agent } : {}
		});
		return { taken: true };
	}

	/**
	 * A screen another window read for this window's caller: a long one came back whole, and is written here as a file the caller can
	 * read - an inaccessible remote path would be no successful read (COLLABORATION-4.2).
	 */
	private async screenHere(outcome: Outcome): Promise<Outcome> {
		const data = outcome.result.data as { [key: string]: unknown } | undefined;
		if (outcome.result.status !== 'success' || !data || typeof data.text !== 'string') {
			return outcome;
		}
		// The file is the caller's public screen object too, not an intermediate routing record with duplicate identities.
		const publicData = compactResult('read_screen', outcome.result).data as Data;
		const body = JSON.stringify(publicData);
		if (codePoints(body) <= MESSAGE_LIMIT) { return outcome; }
		const file = await this.deps.writeResult(this.deps.home, 'screen', body);
		const { text: _text, last_alternate_frame: _frame, ...rest } = publicData;
		return { result: success({ ...rest, file: { path: file.path, size: file.size, code_points: codePoints(body), format: 'json' } }) };
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Discover and start (MCP-2)

	private cliFacts(location: Location, cli: string): { readonly facts?: CliFacts; readonly problem?: string } {
		try {
			const facts = this.deps.clis.describe(location, this.deps.yolo()).launches.find(each => each.cli === cli);
			return facts ? { facts } : { problem: 'Its adapter states nothing for this location.' };
		} catch (err) {
			return { problem: `Its adapter's facts could not be read: ${errorText(err)}` };
		}
	}

	private async startAgent(args: ToolArguments['start_agent'], caller: Caller, call: Received): Promise<Outcome> {
		// A request ID the caller gave a start before: that start's agent, and no other (MCP-1.1)
		const earlier = args.request_id !== undefined ? this.deps.agents.requested(caller.id, args.request_id) : undefined;
		if (earlier) {
			return this.startedBefore(earlier, args);
		}
		if (args.window_id !== this.deps.window.id && this.deps.network && caller.window === undefined) {
			// The child starts in its window, joining the caller's tree (COLLABORATION-1.1, RULES-4.3)
			await this.knownWindow(args.window_id);
			return this.routeCall(args.window_id, 'start_agent', args, caller, call, this.deps.timeout() * 1000 + QUERY_ROUTE_MS);
		}
		// Everything that can be checked before acceptance is: a failure here creates no card or terminal (MCP-2.3, RULES-5.1)
		this.checkWindow(args.window_id);
		const location = this.location(args.location_id);
		const { clis: choices } = await this.deps.clis.list(location);
		// CLI discovery can yield while another call accepts this request. The check immediately before acceptance closes that race.
		const acceptedMeanwhile = args.request_id !== undefined ? this.deps.agents.requested(caller.id, args.request_id) : undefined;
		if (acceptedMeanwhile) {
			return this.startedBefore(acceptedMeanwhile, args);
		}
		const choice = cliChoiceOf(choices, args.cli, location, () => this.deps.clis.turnedOff?.(args.cli));
		if (!choice.available) {
			throw new FacadeError('UNAVAILABLE', 'unavailable', `${choice.displayName} cannot start at ${location.path}: ${choice.problem ?? 'it is not available.'}`);
		}
		// The YOLO it would start with, before anything is numbered: a facade.yolo neither true nor false refuses it (RULES-4.3, UX-4.1)
		this.deps.yolo();
		if (args.model !== undefined || args.effort !== undefined) {
			const { facts } = this.cliFacts(location, choice.id);
			for (const kind of ['model', 'effort'] as const) {
				if (args[kind] !== undefined && facts?.takes?.[kind] === false) {
					throw new FacadeError('INVALID', 'unsupported', `${choice.displayName} takes no explicit ${kind}; leave \`${kind}\` out to use its default.`);
				}
			}
		}
		// The prompt is the caller's first ordinary message to the child: its ID taken now, so that the native path gives the CLI the
		// same headed message its record keeps, and the post-start path sends it under that ID (COLLABORATION-2.1, 2.2)
		const label = this.senderOf(caller).sender?.label;
		const prompt = args.prompt !== undefined ? this.deps.messages.allocate({ from: caller.id, text: args.prompt, party: { run: caller.id, alias: caller.alias, name: caller.name }, ...label !== undefined ? { label } : {} }) : undefined;
		const resultMessageId = this.deps.messages.reserveResult();
		const run = this.deps.agents.launch({
			name: args.name,
			location: location.id,
			cli: choice.id,
			...args.model !== undefined ? { model: args.model } : {},
			...args.effort !== undefined ? { effort: args.effort } : {},
			...args.worktree ? { worktree: { branch: args.worktree.branch, baseRef: args.worktree.base_ref } } : {},
			...prompt ? { promptId: prompt.id, prompt: prompt.text, promptLine: args.prompt!.split(/\r\n?|\n/).find(line => line.trim()) ?? args.prompt! } : {},
			origin: 'agent',
			startCallId: call.callId, resultMessageId,
			creator: { run: caller.id, root: caller.root, label: [caller.name, caller.alias].filter(Boolean).join(' ') },
			...args.request_id !== undefined ? { requestId: args.request_id } : {}
		});
		const launched = this.deps.agents.get(run);
		const start: Start = { resultMessageId, run, args, caller, call, location, ...launched ? { identity: { alias: launched.alias, name: launched.name } } : {},
			...prompt ? { promptId: prompt.id } : {}, answerBy: Date.now() + this.deps.timeout() * 1000 };
		const settled = this.deps.agents.started(run);
		let outcome: { readonly value: StartOutcome } | undefined;
		try {
			outcome = await within(settled, this.deps.timeout() * 1000);
		} catch (err) {
			// Accepted already: the pair exists, whatever came of its start
			return { result: errorResult(err, { data: this.startData(start, this.deps.agents.get(run), 'starting'), effects: { outcome: 'unknown', agent_id: run } }) };
		}
		if (outcome) {
			return this.finishStart(start, outcome.value);
		}
		// Still starting: accepted now, its outcome reported to the caller under this call's ID once it settles (MCP-1.3)
		void settled.then(async late => {
			const final = await this.finishStart({ ...start, answerBy: Infinity }, late);
			const facts = this.deps.agents.get(run) ?? launched;
			if (facts) {
				this.reportTo(caller, { id: resultMessageId, callId: call.callId, requestId: args.request_id, tool: 'start_agent', agent: facts, text: receiptTextOf(final.result, final.headline),
					result: answerOf(withRecovery('start_agent', compactResult('start_agent', final.result), args)).structured });
			}
		}).catch(err => this.deps.log?.(`Could not report the start of ${run} to ${caller.alias}: ${errorText(err)}`));
		const facts = this.deps.agents.get(run) ?? launched;
		return {
			result: accepted(this.startData(start, facts, 'starting'), { outcome: 'pending', agent_id: run }),
			headline: `Accepted ${facts ? referenceOf(facts) : args.name} (${run}): its process is still starting. The start's outcome is ${LATER}.`
		};
	}

	/**
	 * A start whose request ID started `facts` already: its agent as it is now, nothing started again (MCP-1.1) - answered as the
	 * start went: still starting, failed, or started (RULES-1.5).
	 */
	private startedBefore(facts: RunFacts, args: ToolArguments['start_agent']): Outcome {
		const present = this.deps.agents.get(facts.id);
		const prompt = facts.promptId !== undefined ? this.originalPrompt(facts) : undefined;
		// Its later result is still to come while it starts, or while its prompt is pending after it started (MCP-2.3)
		const later = facts.lifecycle === 'starting' || prompt?.status === 'pending';
		const data = defined({ ...agentOf(facts, this.deps.window, this.now(), this.deps.input?.capability(facts.id)), request_id: args.request_id, repeated: true,
			...prompt ? { prompt } : {}, result_message_id: later ? facts.resultMessageId : undefined, call_id: later ? facts.startCallId : undefined });
		const before = `Request ${args.request_id} started ${referenceOf(facts)} (${facts.id}) already, at ${isoOf(facts.createdAt)}: nothing was started again.`;
		const effects: Effects = { outcome: 'none', agent_id: facts.id };
		if (!present && facts.lifecycle !== 'ended') {
			return { result: failure({ code: 'UNAVAILABLE', reason: 'window_unavailable', message: `${before} The window reloaded before the start's outcome was recorded; its effects are not known.` }, data, { ...effects, outcome: 'unknown' }) };
		}
		if (facts.lifecycle === 'starting') {
			return { result: accepted(data, { ...effects, outcome: 'pending' }), headline: `${before} Its process is still starting. The start's outcome is ${LATER}.` };
		}
		if (facts.end?.kind === 'failed') {
			const message = `${before} It could not start: ${facts.error?.english ?? facts.error?.reason ?? 'its launch failed.'}`;
			return { result: failure({ code: 'FAILED', reason: facts.error?.source === 'worktree' ? 'worktree_failed' : 'launch_failed', message }, data, effects), headline: message };
		}
		if (!present && !facts.end) {
			// Removing a card can precede process cleanup, including cleanup that failed. Retention proves the start, not termination.
			return { result: success({ ...data, process: 'unknown' }, effects), headline: `${before} Its card and terminal are closed; its process state is no longer observed here.` };
		}
		return { result: success(data, effects), headline: `${before} Its process is ${facts.lifecycle}.` };
	}

	private async finishStart(start: Start, outcome: StartOutcome): Promise<Outcome> {
		const { run, args } = start;
		const facts = this.deps.agents.get(run);
		const shown = facts || start.identity ? `${referenceOf(facts ?? start.identity!)} (${run})` : `${JSON.stringify(args.name.trim())} (${run})`;
		const created = outcome.worktreeCreated ?? (args.worktree && facts && facts.location !== args.location_id ? facts.cwd : undefined);
		const effects = (outcome: Effects['outcome']): Effects => defined({ outcome, agent_id: run, worktree_created: created });
		if (outcome.state === 'running') {
			const started = `Started ${shown} with ${args.cli} in ${facts?.cwd ?? start.location.path}: its process is running.`;
			const ran = (prompt: { readonly data: Data; readonly headline: string } | undefined, pending = false): Outcome => ({
				result: success({ ...this.startData(start, facts, 'running', pending), ...prompt ? { prompt: prompt.data } : {} }, effects('confirmed')),
				headline: `${started}${prompt ? ` ${prompt.headline}` : ''}`
			});
			if (args.prompt === undefined) {
				return ran(undefined);
			}
			if ((outcome.prompt?.path ?? 'post_start') === 'native') {
				return ran(this.nativePrompt(start, args.prompt, outcome));
			}
			// The prompt goes after the process runs - its preparation first - and the start answers now, not waiting on it: one later
			// result reports it, under this call's result_message_id (MCP-2.3, COLLABORATION-2.2)
			const delivery = this.postStartPrompt(start, args.prompt, outcome).finally(() => this.deps.agents.creationSettled?.(run));
			if (start.answerBy === Infinity) {
				// This is already that later result, for a start accepted while it was still starting: it waits for the prompt too
				return ran(await delivery);
			}
			void delivery.then(prompt => {
				const final = ran(prompt);
				const now = this.deps.agents.get(run) ?? facts;
				if (now) {
					this.reportTo(start.caller, { id: start.resultMessageId, callId: start.call.callId, requestId: args.request_id, tool: 'start_agent', agent: now, text: receiptTextOf(final.result, final.headline),
						result: answerOf(withRecovery('start_agent', compactResult('start_agent', final.result), args)).structured });
				}
			}).catch(err => this.deps.log?.(`Could not report the prompt of ${run} to ${start.caller.alias}: ${errorText(err)}`));
			return ran(this.pendingPrompt(start, outcome), true);
		}
		if (outcome.state === 'failed') {
			const reason = facts?.error?.source === 'worktree' ? 'worktree_failed' : 'launch_failed';
			const message = outcome.error ?? 'The CLI launch failed.';
			return {
				result: failure({ code: 'FAILED', reason, message }, this.startData(start, facts, 'failed'), effects('partial')),
				headline: `${message} Its card stays, red, until it is closed.`
			};
		}
		const message = `${shown} was closed before startup completed.`;
		return { result: failure({ code: 'FAILED', reason: 'ended', message }, this.startData(start, facts, 'closed'), effects('unknown')) };
	}

	/** A retry observes the original prompt, including its later inbox delivery, without replaying or replacing it. */
	private originalPrompt(facts: RunFacts): Data {
		const record = this.deps.messages.inbox(facts.id, { ids: [facts.promptId!], limit: 1 }).records[0];
		if (!record && this.deps.agents.creationPending?.(facts.id)) {
			// Still behind what its start types before its first turn: nothing of it typed yet (COLLABORATION-2.2)
			return { message_id: facts.promptId, status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false } };
		}
		if (!record || record.from.run !== facts.creator || !record.initialPrompt) {
			return { message_id: facts.promptId, status: 'unknown', reason: 'prompt_unrecorded', effects: { outcome: 'unknown' } };
		}
		const { delivery } = record;
		const error = delivery.status === 'failure' ? sendFailureOf(delivery.reason) : undefined;
		return defined({
			message_id: record.id, ...record.initialPrompt, status: delivery.status,
			delivered_via: delivery.status === 'success' ? delivery.via : undefined,
			reason: error?.reason ?? (delivery.status === 'unknown' ? delivery.reason : undefined), message: error?.message,
			obstacle: delivery.status === 'pending' ? delivery.reason : undefined,
			deadline: delivery.status === 'pending' && delivery.deadline !== undefined ? isoOf(delivery.deadline) : undefined,
			effects: delivery.effects
		});
	}

	/**
	 * The start's facts (MCP-2.3): identity, place, the CLI that started - no other is substituted (MCP-2.2) - tree, YOLO, process and
	 * tools, and what model and effort were asked for.
	 */
	private startData(start: Start, facts: RunFacts | undefined, state: 'starting' | 'running' | 'failed' | 'closed', promptPending = false): Data {
		const { run, args, caller, location } = start;
		const { window } = this.deps;
		return defined({
			agent_id: run,
			reference: facts || start.identity ? referenceOf(facts ?? start.identity!) : undefined,
			alias: facts?.alias ?? start.identity?.alias,
			name: facts?.name ?? start.identity?.name ?? args.name.trim(),
			window_id: window.id,
			window: window.label,
			environment: facts?.environment ?? location.environment,
			location_id: facts?.location ?? location.id,
			cwd: facts?.cwd,
			cli: args.cli,
			creator: caller.id,
			root: facts?.root ?? caller.root,
			yolo: facts?.yolo,
			process_state: state === 'closed' ? 'unknown' : state,
			closed: state === 'closed' ? true : undefined,
			call_id: state === 'starting' || promptPending ? facts?.startCallId ?? start.call.callId : undefined,
			result_message_id: state === 'starting' || promptPending ? facts?.resultMessageId ?? start.resultMessageId : undefined,
			tools_state: facts?.tools,
			tools_reason: facts?.toolsReason,
			requested_model: args.model,
			requested_effort: args.effort
		});
	}

	/** How the creation prompt goes, as its start planned it (MCP-2.3): its path and the native path's capability. */
	private promptPath(outcome: StartOutcome): { readonly path: 'native' | 'post_start'; readonly capability: { readonly state: 'supported' | 'unverified' | 'unavailable'; readonly reason: string } } {
		const capability = outcome.prompt?.capability ?? { state: 'unavailable', reason: 'The launch has no native prompt argument, so the prompt goes as the first message after startup.' };
		return { path: outcome.prompt?.path ?? 'post_start', capability: { state: capability.state, reason: capability.reason } };
	}

	/**
	 * The creation prompt the CLI was given with its start (COLLABORATION-2.2), recorded with what that path can tell: acceptance where
	 * its mapping is supported, an unknown outcome while it is used unverified. A record that cannot be kept leaves the start standing.
	 */
	private nativePrompt(start: Start, text: string, outcome: StartOutcome): { readonly data: Data; readonly headline: string } {
		const { run, caller, call, promptId } = start;
		const base = this.promptPath(outcome);
		const id = promptId !== undefined ? { id: promptId } : {};
		const alias = promptId !== undefined ? `#m${promptId.slice(2)}` : undefined;
		const verified = base.capability.state === 'supported';
		const effects: Effects = { outcome: verified ? 'confirmed' : 'unknown' };
		let record: MessageRecord;
		try {
			record = this.deps.messages.recordPrompt({ ...id, from: caller.id, ...this.senderOf(caller), to: run, text, callId: call.callId, initialPrompt: base },
				{ status: verified ? 'success' : 'unknown', effects, attempts: 0, via: 'launch', ...verified ? { deliveredAt: this.now() } : { reason: 'submission_unconfirmed' } });
		} catch (err) {
			// The CLI has its prompt; only its record is missing, and the start stands (MCP-2.3)
			const failed = errorResult(err);
			return {
				data: defined({ message_id: promptId, alias, ...base, status: 'failure', reason: failed.error!.reason, message: failed.error!.message, effects }),
				headline: `Its prompt${alias ? ` ${alias}` : ''} went in with the CLI's native start argument, but it could not be recorded: ${failed.error!.message} The agent keeps running.`
			};
		}
		return {
			data: { message_id: record.id, alias: record.alias, ...base, status: verified ? 'success' : 'unknown', effects },
			headline: verified
				? `Its prompt ${record.alias} went in with the CLI's native start argument, which its adapter verified.`
				: `Its prompt ${record.alias} went in with the CLI's native start argument; that mapping is ${base.capability.state}, so whether the CLI accepted the prompt is not known.`
		};
	}

	/** A post-start creation prompt as its start answers, before it went in: pending, nothing typed yet (MCP-2.3). */
	private pendingPrompt(start: Start, outcome: StartOutcome): { readonly data: Data; readonly headline: string } {
		const alias = start.promptId !== undefined ? `#m${start.promptId.slice(2)}` : undefined;
		return {
			data: defined({ message_id: start.promptId, alias, ...this.promptPath(outcome), status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false } }),
			headline: `Its prompt${alias ? ` ${alias}` : ''} goes in after startup, as its first message; its outcome is ${LATER}.`
		};
	}

	/**
	 * The creation prompt that goes after the process started (COLLABORATION-2.2): after what its start types before its first turn,
	 * as the caller's first ordinary message, its budget starting there. Settles with its final outcome - the send's later outcome comes
	 * here rather than as a result of its own (MCP-2.3). A failure leaves the agent running.
	 */
	private async postStartPrompt(start: Start, text: string, outcome: StartOutcome): Promise<{ readonly data: Data; readonly headline: string }> {
		const { run, caller, call, promptId } = start;
		const base = this.promptPath(outcome);
		const id = promptId !== undefined ? { id: promptId } : {};
		const alias = promptId !== undefined ? `#m${promptId.slice(2)}` : undefined;
		let record: MessageRecord;
		try {
			await this.deps.agents.warmedUp(run);
			let settled!: (final: MessageRecord) => void;
			const later = new Promise<MessageRecord>(resolve => settled = resolve);
			const sent = await this.deps.messages.send({ ...id, from: caller.id, ...this.senderOf(caller), to: run, text, elapsedMs: 0, callId: call.callId, initialPrompt: base, settled });
			record = sent.status === 'accepted' ? await later : sent.record;
		} catch (err) {
			const failed = errorResult(err, { effects: { outcome: 'unknown' } });
			return {
				data: defined({ message_id: promptId, alias, ...base, status: 'failure', reason: failed.error!.reason, message: failed.error!.message, effects: failed.effects }),
				headline: `Its prompt${alias ? ` ${alias}` : ''} could not be sent: ${failed.error!.message} The agent keeps running.`
			};
		}
		const { delivery } = record;
		const failedWith = delivery.status === 'failure' ? sendFailureOf(delivery.reason) : undefined;
		const data = defined({
			message_id: record.id,
			alias: record.alias,
			...base,
			status: delivery.status,
			reason: failedWith?.reason ?? (delivery.status === 'unknown' ? delivery.reason : undefined),
			message: failedWith?.message,
			delivered_via: delivery.status === 'success' ? delivery.via : undefined,
			effects: defined({ ...delivery.effects })
		});
		const headline = delivery.status === 'success'
			? delivery.via === 'read' ? `Its prompt ${record.alias} was delivered through read_messages after startup.` : `Its prompt ${record.alias} was submitted to its CLI after startup.`
			: delivery.status === 'unknown' ? `Whether its prompt ${record.alias} went in after startup is not known. The agent keeps running.`
				: `Its prompt ${record.alias} was not delivered: ${failedWith?.message ?? 'its delivery did not finish.'} The agent keeps running.`;
		return { data, headline };
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Inspect and stop (MCP-3)

	private async listAgents(args: ToolArguments['list_agents'], caller: Caller, call: Received): Promise<Outcome> {
		const self = this.deps.window.id;
		let selected: string | undefined;
		let windowId = args.window_id;
		if (args.agent !== undefined) {
			const located = await this.locate(args.agent, caller);
			selected = located.here?.id ?? located.there!.id;
			const actualWindow = located.there?.window ?? self;
			if (windowId !== undefined && windowId !== actualWindow) { throw new FacadeError('INVALID', 'invalid_argument', 'The selected agent is not in window_id.'); }
			windowId = actualWindow;
		}
		if (windowId !== undefined && windowId !== self) {
			if (!this.deps.network) { this.checkWindow(windowId); }
			await this.knownWindow(windowId);
			// A selected destination validates its own filters. Preserve not-found/invalid errors across the route,
			// instead of turning a removed location into an unavailable window in a global snapshot.
			return this.routeCall(windowId, 'list_agents', defined({ ...args, window_id: windowId, agent: selected }), caller, call, this.queryDeadline(call));
		}
		const selection = JSON.stringify([windowId ?? null, args.location_id ?? null, args.limit, caller.id, caller.yolo, caller.root, selected ?? null]);
		const local = windowId === undefined || windowId === self ? await this.localSnapshot(caller, selected, args.location_id, args.details) : undefined;
		const { windows: remote, unavailable } = await this.everyWindow(async other => {
			const response = await this.deps.network!.route(other, 'agents', defined({ caller: this.guestOf(caller), agent: selected,
				location_id: args.location_id, details: args.details }), this.queryDeadline(call));
			if (!response.ok) { throw routeError(response); }
			const result = response.result;
			if (!isJsonObject(result) || !isWindowSnapshot(result.window, other) || !Array.isArray(result.agents)
				|| !result.agents.every(agent => isJsonObject(agent) && typeof agent.agent_id === 'string' && agent.window_id === other)) {
				throw new FacadeError('FAILED', 'invalid_response', `The Facade window ${other} returned an unreadable snapshot.`);
			}
			return { window: result.window, agents: result.agents as Data[] };
		}, windowId);
		const snapshots = [...local ? [local] : [], ...remote];
		const agents = snapshots.flatMap(each => each.agents).filter(agent => selected === undefined || agent.agent_id === selected);
		if (selected !== undefined && args.location_id !== undefined && !unavailable.length && !agents.length) {
			throw new FacadeError('INVALID', 'invalid_argument', 'The selected agent is not in location_id.');
		}
		const windows = snapshots.map(each => each.window);
		const page = snapshotPage(windows, agents, args.limit, selection, args.cursor);
		const complete = !unavailable.length && windows.every(window => window.complete);
		const sum = (key: 'folders' | 'locations' | 'worktrees') => windows.reduce((total, window) => total + window.counts[key], 0);
		return { result: success({ ...page, counts: { known_windows: windows.length + unavailable.filter(each => each.window_id !== '*').length,
			responding_windows: windows.length, folders: sum('folders'), locations: sum('locations'), worktrees: sum('worktrees'), agents: agents.length },
			complete, unavailable_windows: unavailable, scope: caller.yolo ? 'all' : 'creation_tree' }),
			headline: `${windows.length} responding window${windows.length === 1 ? '' : 's'}, ${agents.length} agent${agents.length === 1 ? '' : 's'} within your reach.${complete ? '' : ' Some current facts are unavailable.'}` };
	}

	private async stopAgent(args: ToolArguments['stop_agent'], caller: Caller, call: Received): Promise<Outcome> {
		const located = await this.locate(args.agent, caller);
		if (located.there) {
			return this.routeCall(located.there.window, 'stop_agent', { agent: located.there.id }, caller, call, this.deps.timeout() * 1000 + QUERY_ROUTE_MS);
		}
		const target = located.here;
		const shown = `${referenceOf(target)} (${target.id})`;
		// The card and terminal go at once; only the process's end is waited for, its children untouched (MCP-3.2)
		const closing = this.deps.agents.close(target.id);
		const cleanup = await within(closing, this.deps.timeout() * 1000);
		if (cleanup) {
			return stopped(target, cleanup.value);
		}
		let resultMessageId: string;
		try {
			resultMessageId = this.deps.messages.reserveResult();
		} catch (err) {
			// No number for a later result can be taken now (RULES-2.2), and the card is gone already: the stop answers as still ending,
			// within its wait (MCP-3.2), and no later result comes: its end is not reported
			this.deps.log?.(`Could not number the later result of the stop of ${target.alias}; none will follow: ${errorText(err)}`);
			return {
				result: accepted({ agent_id: target.id, reference: referenceOf(target), call_id: call.callId, closed: true, process_state: 'stopping', cleanup: 'pending' }, { outcome: 'pending', agent_id: target.id }),
				headline: `Closed ${shown}'s card and terminal; its process is still being ended, and no later result can be numbered, so how its cleanup ends is not reported.`
			};
		}
		void closing.then(late => {
			const final = stopped(target, late);
			this.reportTo(caller, { id: resultMessageId, callId: call.callId, tool: 'stop_agent', agent: target, text: receiptTextOf(final.result, final.headline),
				result: answerOf(withRecovery('stop_agent', compactResult('stop_agent', final.result))).structured });
		}).catch(err => this.deps.log?.(`Could not report the stop of ${target.alias} to ${caller.alias}: ${errorText(err)}`));
		return {
			result: accepted({ agent_id: target.id, reference: referenceOf(target), result_message_id: resultMessageId, call_id: call.callId, closed: true, process_state: 'stopping', cleanup: 'pending' }, { outcome: 'pending', agent_id: target.id }),
			headline: `Closed ${shown}'s card and terminal; its process is still being ended, and that outcome is ${LATER}.`
		};
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Messages (MCP-4)

	private async sendMessage(args: ToolArguments['send_message'], caller: Caller, call: Received): Promise<Outcome> {
		// A request ID the caller gave a send before: that message as it stands, sent no second time (MCP-1.1)
		const earlier = args.request_id !== undefined ? this.deps.messages.findRequest(caller.id, args.request_id) : undefined;
		if (earlier && earlier.window !== this.deps.window.id && earlier.delivery.status === 'pending' && this.deps.network && caller.window === undefined) {
			// Another window holds it, its outcome not told here yet - its reply lost, or its result: asked there, where it stands, and
			// never sent to whoever its reference names now (MCP-1.1)
			return this.routeSend(earlier.window, { id: earlier.id, to: earlier.to, text: earlier.text, replyTo: earlier.replyTo, environment: earlier.environment }, args, caller, call, earlier);
		}
		if (earlier) {
			return this.sentBefore(earlier, args);
		}
		const human = await this.isHuman(args.to, caller);
		const located = human ? undefined : await this.locate(args.to, caller, run => run.lifecycle !== 'ended');
		if (located?.there) {
			if (located.there.lifecycle === 'ended') {
				throw new FacadeError('UNAVAILABLE', 'ended', `${referenceOf(located.there)} has ended, so it takes no message.`);
			}
			return this.sendThere(args, caller, call, located.there);
		}
		const target = located?.here;
		if (target?.lifecycle === 'ended') {
			throw new FacadeError('UNAVAILABLE', 'ended', `${referenceOf(target)} has ended, so it takes no message.`);
		}
		let replyTo: string | undefined;
		if (args.reply_to !== undefined) {
			replyTo = this.deps.messages.inbox(caller.id, { ids: [args.reply_to], limit: 1 }).records[0]?.id;
			if (replyTo === undefined) {
				throw new FacadeError('NOT_FOUND', 'not_found', `\`reply_to\` ${JSON.stringify(args.reply_to)} is not a message in your inbox.`);
			}
		}
		const to = target?.id ?? '@human';
		// The window's time so far comes off the same two seconds as the hops before it (RULES-1.2, 1.5)
		const sent = await this.deps.messages.send({ from: caller.id, to, text: args.text, ...replyTo ? { replyTo } : {}, elapsedMs: this.elapsed(call), callId: call.callId, ...args.request_id !== undefined ? { requestId: args.request_id } : {} });
		// A concurrent request may already have resolved this key to another target. Report its authoritative record.
		const { record } = sent;
		const actual = record.to.run === '@human' ? undefined : this.deps.agents.get(record.to.run);
		return sendOutcome(record, sent.status, { shown: actual ? referenceOf(actual) : shownOf(record.to), reason: sent.reason, obstacle: sent.obstacle });
	}

	/**
	 * A message to another window's agent (COLLABORATION-1.1, RULES-1.1-1.7): its ID taken here, delivered there within what is left
	 * of the two seconds, a copy of its record kept here, and its later outcome coming back here as a Facade result.
	 */
	private async sendThere(args: ToolArguments['send_message'], caller: Caller, call: Received, target: Reachable): Promise<Outcome> {
		let replyTo: string | undefined;
		if (args.reply_to !== undefined) {
			replyTo = this.deps.messages.inbox(caller.id, { ids: [args.reply_to], limit: 1 }).records[0]?.id;
			if (replyTo === undefined) {
				throw new FacadeError('NOT_FOUND', 'not_found', `\`reply_to\` ${JSON.stringify(args.reply_to)} is not a message in your inbox.`);
			}
		}
		const { id } = this.deps.messages.allocate({ from: caller.id, text: args.text });
		const to = { run: target.id, alias: target.alias, name: target.name };
		return this.routeSend(target.window, { id, to, text: args.text, ...replyTo ? { replyTo } : {}, ...target.environment !== undefined ? { environment: target.environment } : {} }, args, caller, call);
	}

	/**
	 * Delivers `message` in `window`, where its record is made under its ID, within what is left of the two seconds (RULES-1.2), and keeps
	 * a copy here: the window's answer, or - where the answer may have been lost after the message arrived - the message with its outcome
	 * not known, so that a retry with its request ID asks that window again, as `earlier` does (MCP-1.1).
	 */
	private async routeSend(window: string, message: { readonly id: string; readonly to: MessageRecord['to']; readonly text: string; readonly replyTo?: string; readonly environment?: string }, args: ToolArguments['send_message'], caller: Caller, call: Received, earlier?: MessageRecord): Promise<Outcome> {
		const { id, to, text, replyTo } = message;
		const alias = `#m${id.slice(2)}`;
		const shown = shownOf(to);
		const delivery: RoutedDelivery = {
			id, from: this.guestOf(caller), to: to.run as RunId, text, ...replyTo ? { replyTo } : {}, callId: call.callId,
			...args.request_id !== undefined ? { requestId: args.request_id } : {}, elapsedMs: this.elapsed(call) + ROUTE_TRANSIT_MS
		};
		// The two seconds hold across the hops: that window answers in time for its answer to come back within them (RULES-1.2)
		this.deps.log?.(`Route ${JSON.stringify({ phase: 'requested', call_id: call.callId, request_id: args.request_id, tool: 'send_message', message: alias, agent: to.alias ?? to.run, from: this.deps.window.id, to: window })}`);
		const response = await this.deps.network!.route(window, 'deliver', delivery, Math.max(0, RESPONSE_BUDGET_MS - this.elapsed(call)));
		this.deps.log?.(`Route ${JSON.stringify({ phase: response.ok ? 'answered' : 'reply_unavailable', call_id: call.callId, message: alias, from: this.deps.window.id, to: window, ...!response.ok ? { reason: response.reason, effects: response.effects } : {} })}`);
		const data = defined({
			message_id: id, alias, target: to.run, target_reference: shown, reply_to: replyTo, length: codePoints(text), window_id: window,
			...earlier ? { request_id: args.request_id, repeated: true } : {}
		});
		const unknown: Effects = { outcome: 'unknown', text_written: 'unknown', enter_written: null };
		const none: Effects = { outcome: 'none', text_written: 'none', enter_written: false };
		// What may have gone in there, kept here with its outcome not known (COLLABORATION-4.1)
		const keepUnknown = () => {
			if (!earlier) {
				const at = this.now();
				this.deps.messages.keepSent({
					id, alias, kind: 'message', from: { run: caller.id, alias: caller.alias, name: caller.name }, to, window, environment: message.environment ?? '',
					fromWindow: this.deps.window.id, at, ...replyTo ? { replyTo } : {}, ...args.request_id !== undefined ? { requestId: args.request_id } : {}, text, length: codePoints(text),
					delivery: { status: 'pending', effects: unknown, deadline: at + HOLD_MS, attempts: 0 }
				});
			}
		};
		if (!response.ok) {
			// An earlier attempt of it may have gone in: its effects stay unknown, whatever this route did
			const effects = response.effects === 'unknown' || earlier ? unknown : none;
			if (response.effects === 'unknown') {
				keepUnknown();
			}
			return { result: failure(routeError(response), data, effects), headline: `Message ${alias} to ${shown}: ${effects === unknown ? 'whether it was delivered is not known' : 'it was not delivered'}. ${response.message}` };
		}
		const answered = response.result as { readonly status?: SendResult['status']; readonly reason?: string; readonly obstacle?: string; readonly record?: MessageRecord; readonly error?: unknown } | undefined;
		const refused = resultErrorOf(answered?.error);
		if (refused && !answered?.record) {
			// A refusal proves this attempt did nothing. It cannot settle an earlier attempt whose original record is missing.
			if (earlier) {
				return { result: failure({ ...refused, message: `${refused.message} The earlier delivery still could not be confirmed.` }, data, unknown) };
			}
			return { result: failure(refused, data, none), headline: `Message ${alias} to ${shown} was not delivered: ${refused.message}` };
		}
		const record = answered?.record;
		if (!answered || !record || (answered.status !== 'success' && answered.status !== 'accepted' && answered.status !== 'failure')) {
			keepUnknown();
			return { result: failure({ code: 'FAILED', reason: 'invalid_response', message: `The Facade window of ${shown} returned an unreadable delivery answer.` }, data, unknown) };
		}
		this.deps.messages.keepSent(args.request_id !== undefined ? { ...record, requestId: args.request_id } : record);
		// The destination may have deduplicated a retry whose first reply was lost: its original ID, never the proposed new one.
		return sendOutcome(record, answered.status, { shown, reason: answered.reason, obstacle: answered.obstacle, window, ...earlier ? { requestId: args.request_id } : {} });
	}

	/** A send whose request ID sent `record` already: that message's delivery as it stands, nothing sent again (MCP-1.1). */
	private sentBefore(record: MessageRecord, args: ToolArguments['send_message']): Outcome {
		const status = record.delivery.status === 'pending' ? 'accepted' : record.delivery.status === 'unknown' ? 'failure' : record.delivery.status;
		return sendOutcome(record, status, { shown: shownOf(record.to), requestId: args.request_id });
	}

	private async readMessages(args: ToolArguments['read_messages'], caller: Caller): Promise<Outcome> {
		// The caller's own inbox and nothing else, even with YOLO and even by ID (MCP-4.2)
		const page = this.deps.messages.inbox(caller.id, {
			...args.ids ? { ids: args.ids } : { all: args.all, ...args.cursor !== undefined ? { cursor: args.cursor } : {} },
			limit: args.limit
		});
		const { records } = page;
		const missing = page.missing.length ? page.missing : undefined;
		if (args.ids && !records.length) {
			const message = `${args.ids.length === 1 ? 'That message is not' : 'None of those messages are'} in your inbox.`;
			return { result: failure({ code: 'NOT_FOUND', reason: 'not_found', message }, { not_found: page.missing }) };
		}
		const total = records.reduce((sum, record) => sum + (record.kind === 'result' && record.result ? codePoints(JSON.stringify(record.result)) : record.length), 0);
		const ids = records.map(record => record.id);
		const count = `${records.length} message${records.length === 1 ? '' : 's'}`;
		let data: Data;
		let headline: string;
		if (total > MESSAGE_LIMIT) {
			const file = await this.deps.writeResult(this.deps.home, 'messages', messageFile(records), ids);
			data = defined({ file: { path: file.path, size: file.size, code_points: total }, messages: records.map(record => messageOf(record, false)), next_cursor: page.nextCursor, not_found: missing });
			headline = `${count} from your inbox, oldest first. Their ${total} code points are more than ${MESSAGE_LIMIT.toLocaleString('en-US')}, so their complete text is in the file ${file.path} (${file.size} bytes); their details follow.`;
		} else {
			data = defined({ messages: records.map(record => messageOf(record, true)), next_cursor: page.nextCursor, not_found: missing,
				notice: !records.length ? 'New messages are delivered automatically, including after this turn ends. This read does not wait for them.' : undefined });
			headline = records.length ? `${count} from your inbox, oldest first.` : 'No incoming messages match this read.';
		}
		if (missing) {
			headline += ` Not in your inbox: ${missing.join(', ')}.`;
		}
		// Delivered once this answer was handed back, not before: one lost on its way is read again (MCP-4.2, COLLABORATION-3.1)
		return {
			result: success(data),
			headline,
			...ids.length ? { after: () => this.deps.messages.markDelivered(caller.id, ids) } : {}
		};
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Terminal operations (MCP-5)

	private async readScreen(args: ToolArguments['read_screen'], caller: Caller, call: Received): Promise<Outcome> {
		const located = await this.locate(args.agent, caller);
		if (located.there) {
			const routed = await this.routeCall(located.there.window, 'read_screen', { agent: located.there.id, lines: args.lines }, caller, call, this.queryDeadline(call), true);
			return this.screenHere(routed);
		}
		const target = located.here;
		const shown = `${referenceOf(target)} (${target.id})`;
		const screen = await this.deps.terminal.readScreen(target.id, args.lines);
		if (!screen) {
			const ended = target.lifecycle === 'ended';
			throw new FacadeError('UNAVAILABLE', ended ? 'ended' : 'unavailable', ended ? `${shown} has ended and no screen of it was retained.` : `${shown} has no screen to read yet.`);
		}
		const ended = screen.exited || target.lifecycle === 'ended';
		const text = screenText(screen.text.join('\n'), screen.styles);
		const base = defined({
			agent_id: target.id,
			reference: referenceOf(target),
			window_id: this.deps.window.id,
			observed_at: isoOf(screen.capturedAt),
			process_state: ended ? 'ended' : target.lifecycle,
			stale: ended,
			buffer: screen.buffer,
			text_format: 'facade-styled',
			line_count: screen.text.length,
			older_lines: screen.older,
			trimmed: screen.trimmed
		});
		const data = defined({ ...base, text, styles_unavailable: screen.styles === undefined ? true : undefined,
			last_alternate_frame: screen.frame ? defined({ captured_at: isoOf(screen.frame.capturedAt), line_count: screen.frame.text.length,
				text: screenText(screen.frame.text.join('\n'), screen.frame.styles), styles_unavailable: screen.frame.styles === undefined ? true : undefined }) : undefined });
		const outcome = { result: success(data) };
		return call.inline ? outcome : this.screenHere(outcome);
	}

	private async typeText(args: ToolArguments['type_text'], caller: Caller, call: Received): Promise<Outcome> {
		const located = await this.locate(args.agent, caller, run => run.lifecycle === 'running');
		if (located.there) {
			return this.routeCall(located.there.window, 'type_text', { agent: located.there.id, text: args.text, enter: args.enter }, caller, call, ROUTE_INPUT_MS);
		}
		const target = this.inputTarget(located.here.id, caller);
		const shown = `${referenceOf(target)} (${target.id})`;
		const data = { agent_id: target.id, reference: referenceOf(target), length: codePoints(args.text), enter: args.enter };
		let effect: InputOutcome;
		try {
			effect = await this.deps.terminal.typeText(target.id, args.text, args.enter);
		} catch (err) {
			// Not sent, nothing went in; otherwise what went in before it failed is not known, and raw input is never typed again on its
			// own (MCP-1.2, 5.2)
			const sent = !codedOf(err);
			return { result: errorResult(err, { data, effects: sent ? { outcome: 'unknown', text_written: 'unknown', enter_written: null } : { outcome: 'none', text_written: 'none', enter_written: false } }) };
		}
		const typed = args.text === '' ? 'none' : 'full';
		switch (effect.outcome) {
			case 'applied': {
				const entered = args.enter && effect.entered !== false;
				return {
					result: success(data, { outcome: 'confirmed', text_written: typed, enter_written: entered }),
					headline: args.text === '' ? `Pressed Enter in ${shown}'s terminal.` : `Typed ${data.length} code points into ${shown}'s terminal${entered ? ', then Enter' : ', without Enter'}.`
				};
			}
			case 'partial': {
				const written = effect.pasted ? typed : 'unknown';
				return {
					result: failure({ code: 'FAILED', reason: 'partial_input', message: `${shown} ended while its input went in: the text ${effect.pasted ? 'went in' : 'may have gone in in part'}, and Enter did not.` }, data, { outcome: 'partial', text_written: written, enter_written: false })
				};
			}
			case 'not_applied':
				return { result: failure({ code: 'UNAVAILABLE', reason: 'ended', message: `${shown} ended before its input went in: nothing was typed.` }, data, { outcome: 'none', text_written: 'none', enter_written: false }) };
		}
	}

	private async pressKeys(args: ToolArguments['press_keys'], caller: Caller, call: Received): Promise<Outcome> {
		const located = await this.locate(args.agent, caller, run => run.lifecycle === 'running');
		if (located.there) {
			return this.routeCall(located.there.window, 'press_keys', { agent: located.there.id, keys: args.keys }, caller, call, ROUTE_INPUT_MS);
		}
		const target = this.inputTarget(located.here.id, caller);
		const shown = `${referenceOf(target)} (${target.id})`;
		const data = { agent_id: target.id, reference: referenceOf(target), keys: args.keys };
		let effect: InputOutcome;
		try {
			effect = await this.deps.terminal.pressKeys(target.id, args.keys);
		} catch (err) {
			return { result: errorResult(err, { data, effects: codedOf(err) ? { outcome: 'none', keys_sent: 0 } : { outcome: 'unknown' } }) };
		}
		switch (effect.outcome) {
			case 'applied': {
				const sent = effect.keysSent ?? args.keys.length;
				return { result: success(data, { outcome: 'confirmed', keys_sent: sent }), headline: `Pressed ${sent} key${sent === 1 ? '' : 's'} in ${shown}'s terminal.` };
			}
			case 'partial':
				return {
					result: failure(
						{ code: 'FAILED', reason: 'partial_input', message: `${shown} ended while its keys went in: ${effect.keysSent !== undefined ? `the first ${effect.keysSent} of ${args.keys.length}` : 'some of them'} did.` },
						data,
						effect.keysSent !== undefined ? { outcome: 'partial', keys_sent: effect.keysSent } : { outcome: 'partial' }
					)
				};
			case 'not_applied':
				return { result: failure({ code: 'UNAVAILABLE', reason: 'ended', message: `${shown} ended before its keys went in: none was pressed.` }, data, { outcome: 'none', keys_sent: 0 }) };
		}
	}

	/** The live run direct input addresses: a name picks among live runs, an ended or not yet started one takes no input (MCP-5.2). */
	private inputTarget(reference: string, caller: Caller): RunFacts {
		const target = this.target(reference, caller, run => run.lifecycle === 'running');
		if (target.lifecycle === 'ended') {
			throw new FacadeError('UNAVAILABLE', 'ended', `${referenceOf(target)} has ended, so its terminal takes no input.`);
		}
		if (target.lifecycle !== 'running') {
			throw new FacadeError('UNAVAILABLE', 'not_started', `${referenceOf(target)}'s process has not started yet, so its terminal takes no input.`);
		}
		return target;
	}
}

interface Start {
	readonly resultMessageId: string;
	readonly identity?: Pick<RunFacts, 'alias' | 'name'>;
	readonly run: RunId;
	readonly args: ToolArguments['start_agent'];
	readonly caller: Caller;
	readonly call: Received;
	readonly location: Location;
	/** The creation prompt's message ID, taken before the launch. */
	readonly promptId?: string;
	/** When the call's own wait ends (MCP-1.3), by `Date.now()`: infinite for a start reported later, once its caller was answered. */
	readonly answerBy: number;
}

/** `promise`'s value, or undefined once `ms` passed first. */
function within<T>(promise: Promise<T>, ms: number): Promise<{ readonly value: T } | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), ms));
	return Promise.race([promise.then(value => ({ value })), late]).finally(() => clearTimeout(timer));
}

function cliChoiceOf(choices: readonly CliChoice[], cli: string, location: Location, turnedOff: () => string | undefined): CliChoice {
	const choice = choices.find(each => each.id === cli);
	if (!choice) {
		// A built-in its setting turns off is listed for no new start, and is refused for that reason (CLIS-1.1, RULES-5.1)
		const off = turnedOff();
		if (off) {
			throw new FacadeError('UNAVAILABLE', 'unavailable', `${off}.`);
		}
		throw new FacadeError('NOT_FOUND', 'not_found', `No CLI ${JSON.stringify(cli)} is configured at ${location.path}; the CLIs there are ${choices.map(each => each.id).join(', ') || 'none'}.`);
	}
	return choice;
}


/** A message's recipient as an answer names it: `#human`, or its reference as its record keeps it. */
function shownOf(party: MessageRecord['to']): string {
	return party.run === '@human' ? '#human' : party.alias ? referenceOf({ name: party.name ?? '', alias: party.alias }) : party.run;
}

/**
 * What a send came to, as its caller is answered (MCP-4.1): the message's facts and its delivery as it stands - success, accepted with
 * its deadline, or failure with why - and, for a repeated `requestId`, that nothing was sent again (MCP-1.1).
 */
function sendOutcome(record: MessageRecord, status: SendResult['status'], how: { readonly shown: string; readonly reason?: string; readonly obstacle?: string; readonly window?: string; readonly requestId?: string }): Outcome {
	const { shown } = how;
	const repeated = how.requestId !== undefined;
	const data = defined({
		message_id: record.id, alias: record.alias, target: record.to.run === '@human' ? '#human' : record.to.run, target_reference: shown, reply_to: record.replyTo,
		length: record.length, window_id: how.window, ...repeated ? { request_id: how.requestId, repeated: true } : {}
	});
	const effects = defined({ ...record.delivery.effects });
	const again = repeated ? `Request ${how.requestId} sent message ${record.alias} to ${shown} already: nothing was sent again. ` : '';
	switch (status) {
		case 'success':
			return {
				result: success({ ...data, disposition: record.delivery.via === 'read' ? 'read_messages' : record.to.run === '@human' ? 'notified' : 'submitted_to_cli' }, effects),
				headline: repeated ? `${again}It was delivered.` : record.delivery.via === 'read' ? `Message ${record.alias} was delivered to ${shown} through read_messages.`
					: record.to.run !== '@human' ? `Message ${record.alias} was submitted to ${shown}'s CLI.` : `Message ${record.alias} was handed to the person's notifications in this window.`
			};
		case 'accepted': {
			const deadline = record.delivery.deadline !== undefined ? isoOf(record.delivery.deadline) : undefined;
			return {
				result: accepted(defined({ ...data, deadline, obstacle: how.obstacle }), effects),
				headline: repeated ? `${again}It is still being delivered, and its outcome is ${LATER}.`
					: `Message ${record.alias} to ${shown} is accepted but not yet submitted${how.obstacle ? ` (${how.obstacle})` : ''}; delivery continues${deadline ? ` until ${deadline}` : ''}, and its outcome is ${LATER}.`
			};
		}
		case 'failure': {
			const error = sendFailureOf(how.reason ?? record.delivery.reason);
			return {
				result: failure(error, data, effects),
				headline: repeated ? `${again}It was not delivered: ${error.message} A new request_id sends it anew.` : `Message ${record.alias} to ${shown} was not delivered: ${error.message}`
			};
		}
	}
}

function stopped(target: RunFacts, cleanup: Awaited<ReturnType<Agents['close']>>): Outcome {
	const shown = `${referenceOf(target)} (${target.id})`;
	const data = (process: string) => ({ agent_id: target.id, reference: referenceOf(target), closed: true, process_state: process, cleanup });
	switch (cleanup) {
		case 'terminated':
			return { result: success(data('ended'), { outcome: 'confirmed', agent_id: target.id }), headline: `Stopped ${shown}: its card and terminal closed and its process ended. Its children keep running.` };
		case 'already_exited':
			return { result: success(data('ended'), { outcome: 'confirmed', agent_id: target.id }), headline: `Stopped ${shown}: its card and terminal closed; its process had already exited.` };
		case 'already_ended':
			return { result: success({ ...data('ended'), already_ended: true }, { outcome: 'confirmed', agent_id: target.id }), headline: `${shown} had already ended; its retained card and terminal were closed.` };
		case 'not_started':
			return { result: success(data('not_started'), { outcome: 'confirmed', agent_id: target.id }), headline: `Stopped ${shown} before its process started: its card and terminal closed and it will not start.` };
		case 'unconfirmed':
			return { result: failure({ code: 'FAILED', reason: 'termination_unconfirmed', message: 'The card and terminal closed, but process exit could not be confirmed.' }, data('unknown'), { outcome: 'partial', agent_id: target.id }), headline: `Closed ${shown}'s card and terminal; the end of its process could not be confirmed.` };
		case 'failed':
			return { result: failure({ code: 'FAILED', reason: 'cleanup_failed', message: `${shown}'s card and terminal closed, but its process could not be ended.` }, data('unknown'), { outcome: 'partial', agent_id: target.id }) };
	}
}
