/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { withDeadline } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { callerOfRequest, FORWARDED_TOOLS, WINDOW_REQUESTS } from '../core/machine';
import { Caller, StoppedBy } from '../record/events';
import { isForeign } from '../record/messages';
import type { WindowFacts } from '../transport/endpoint';
import type { ResultListener } from '../transport/pipe';
import { Hello, McpTool, Progress, ToolResult, toolResultOf } from '../transport/protocol';
import { line, listAgentsTool } from './listAgents';
import { pressKeysTool } from './pressKeys';
import { instructionsFor } from './prompts';
import { readMessagesTool } from './readMessages';
import { readScreenTool } from './readScreen';
import { sendMessageTool } from './sendMessage';
import { startAgentTool } from './startAgent';
import { stopAgentTool } from './stopAgent';
import { typeTextTool } from './typeText';

/** A tool's input, as the JSON Schema its definition gives: an object, and its properties. */
export type ToolSchema = {
	readonly type: 'object';
	readonly properties: { readonly [name: string]: object };
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
};

/** A tool as `tools/list` shows it, with its schema as Facade writes one. */
export interface Tool extends McpTool {
	readonly title: string;
	readonly inputSchema: ToolSchema;
}

/**
 * How long a call that names the CLIs this machine has waits for them to be looked for again: a window
 * answers its questions in well under a second, even over a slow connection; one away from its remote
 * answers none, and the call goes on with those found last (REMOTE.md R2).
 */
const CLI_LOOK_WAIT_MS = 2_000;

/** One of the contract's tools: what the model is shown, and what a call does. */
export interface ContractTool {
	readonly definition: Tool;
	/** Whether its answer names the CLIs this machine has - those `list_agents` lists, those `start_agent` starts - which are looked for again first. */
	readonly findsClis?: boolean;
	/** Its definition as the model is shown it, where that depends on what this machine has. */
	describe?(facade: Facade): Tool;
	/**
	 * Runs it; `progress` tells the caller's client how a long call goes. A listener given to `whenWritten`
	 * hears whether its result went out to the caller: never so when the call fails.
	 */
	call(facade: Facade, caller: Caller, args: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void, forwarded?: ForwardedStart): Promise<ToolResult>;
}

/**
 * What a start another workspace hands this one carries beside its arguments (O3): the commit of the caller's checkout,
 * resolved there, for a new worktree of the same repository, and the caller's wait.
 */
export interface ForwardedStart {
	readonly head?: { readonly repository: string; readonly commit: string };
	readonly waitMs?: number;
}

const TOOLS: readonly ContractTool[] = [startAgentTool, listAgentsTool, stopAgentTool, sendMessageTool, readMessagesTool, readScreenTool, typeTextTool, pressKeysTool];

/**
 * The eight tools as an agent's MCP server lists them while the window does not answer (AGENT-LAUNCHER.md, L1;
 * AGENT-ORCHESTRATION.md, O8): each as its definition has it - start_agent's without the agents this machine can
 * start, which only the window knows.
 */
export function toolDefinitions(): readonly Tool[] {
	return TOOLS.map(tool => tool.definition);
}

/**
 * How often a call that runs on tells its caller's client that it does: the client takes a window silent for long as
 * gone, and a call that waited its turn behind the person's typing past that would be said to have done who knows
 * what - then go in all the same (AGENT-DEBUGGING.md, D3).
 */
const STILL_GOING_MS = 30_000;

/**
 * The tools of Facade's MCP server, `facade`, as the model sees them: `start_agent`, `list_agents` and
 * `stop_agent`; `send_message` and `read_messages` (AGENT-MESSAGES.md); and `read_screen`, `type_text` and
 * `press_keys` (AGENT-DEBUGGING.md). Each result is text the model reads whole, with the same facts as data;
 * messages come only from `read_messages`, never along with another tool's result. A failure is a result
 * too, marked as an error: it says what is wrong and what would be right, and its data carries one of five
 * codes, with what happened all the same where something did.
 */
export class Contract {

	constructor(private readonly facade: Facade) { }

	/** Answers a new MCP server's hello; for an agent, its hello is also the news that it is running, and which process its server is. */
	hello(caller: Caller, server: { readonly pid?: number } = {}): Hello {
		this.facade.connected(caller, server.pid);
		return { name: caller.name, tools: TOOLS.map(tool => tool.describe?.(this.facade) ?? tool.definition), instructions: instructionsFor(this.facade, caller) };
	}

	/**
	 * Runs one tool for one caller. Whatever happens, the answer is a result the model reads. While the agent
	 * framework is off, every call answers at once that it is (AGENT-ORCHESTRATION.md, O7). Its listeners given
	 * to `whenWritten` hear whether it went out, as the pipe tells; those of a call that failed hear no.
	 */
	async call(caller: Caller, name: string, args: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void = () => undefined, forwarded?: ForwardedStart): Promise<ToolResult> {
		if (!this.facade.frameworkOn()) {
			return { text: 'Facade tools are disabled by facade.orchestration.enabled. This call had no effect; existing agents keep running.', isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
		}
		const listeners: ResultListener[] = [];
		let result: ToolResult;
		try {
			const tool = TOOLS.find(each => each.definition.name === name);
			if (!tool) {
				throw new FacadeError('INVALID', `Unknown tool '${name}'. Available tools: ${TOOLS.map(each => each.definition.name).join(', ')}.`);
			}
			// What this machine has now, as a terminal finds it - a CLI the person installed, or took away, since -
			// for a call that names them; asked of the window, which a call waits on only so long
			if (tool.findsClis) {
				await withDeadline(this.facade.refreshClis(), CLI_LOOK_WAIT_MS, () => undefined);
			}
			const going = setInterval(() => progress(`${name} is still running.`), STILL_GOING_MS);
			try {
				// An agent of another window: that window carries out the whole call, and its result comes back as it is (O5, O8; D1)
				const located = FORWARDED_TOOLS.has(name) && isJsonObject(args) && typeof args.agent === 'string' ? await this.facade.locate(caller, args.agent) : { here: true as const };
				result = located.here
					? await tool.call(this.facade, caller, args, progress, listener => listeners.push(listener), forwarded)
					: await this.forward(caller, located, name, { ...(args as object), agent: `#a${located.id}` }, progress);
			} finally {
				clearInterval(going);
			}
		} catch (err) {
			for (const listener of listeners) {
				listener(false);
			}
			return { text: messageOf(err), isError: true, data: { code: err instanceof FacadeError ? err.code : 'FAILED', ...(err instanceof FacadeError && err.outcome ? err.outcome : {}) } };
		}
		for (const listener of listeners) {
			whenWritten(listener);
		}
		return result;
	}

	/** Hands the call `name` with `args` to the window that has its agent, as the caller: its result, as that window gave it (O8). */
	private async forward(caller: Caller, located: { readonly window: string; readonly label: string }, name: string, args: object, progress: Progress): Promise<ToolResult> {
		const machine = this.facade.machine;
		if (!machine) {
			throw new FacadeError('UNAVAILABLE', `Cannot reach workspace ${located.label}: this workspace has no link to other workspaces.`);
		}
		const answer = await machine.call(located.window, WINDOW_REQUESTS.tool, { caller: this.facade.identityOf(caller), tool: name, args }, message => progress(message));
		const result = toolResultOf(answer);
		if (!result) {
			throw new FacadeError('FAILED', `Workspace ${located.label} answered ${name} with nothing that can be read. Its effects are unknown; inspect the agent before retrying.`, { outcome: 'unknown' });
		}
		return this.withOwnFiles(result);
	}

	/**
	 * A result another workspace gave, its files - a large screen snapshot, a final screen - copied under this workspace's
	 * record and named there, so that the caller reads them with the access its launch gave (O8; AGENT-DEBUGGING.md, D1).
	 */
	private withOwnFiles(result: ToolResult): ToolResult {
		const data = (result.data ?? {}) as { snapshot?: unknown; finalScreen?: unknown };
		let text = result.text;
		const copied: { [key: string]: string } = {};
		for (const key of ['snapshot', 'finalScreen'] as const) {
			const file = data[key];
			if (typeof file === 'string' && file) {
				const own = this.facade.adoptFile(file);
				if (own !== file) {
					copied[key] = own;
					text = text.split(file).join(own);
				}
			}
		}
		return Object.keys(copied).length ? { ...result, text, data: { ...data, ...copied } } : result;
	}

	/**
	 * Answers a hello from another window of the machine: who this window is - its record, version and commit, its
	 * workspace and first folder - and whether its agent framework is on (O8).
	 */
	windowHello(facts: WindowFacts): object {
		return { window: true, enabled: this.facade.frameworkOn(), ...facts };
	}

	/**
	 * Runs a request of another workspace of the machine (O8): a query of this workspace's agents, messages, folders or
	 * work in a folder; a whole call for one of its agents, or a start in one of its folders; a message for one of them;
	 * the stopping of a deletion's work; a message to the person to show, or an agent's terminal to reveal; a ring that its
	 * outbox has notices. Who calls is the caller that workspace names - one of this workspace's own, named back to it, as
	 * this workspace knows it. While the agent framework is off, only a deletion's question and stopping, and a ring, are
	 * answered: those protect the person's work, and keep what is owed to an agent here until the framework is on again
	 * (O5; AGENT-MESSAGES.md, M10).
	 */
	async windowCall(tool: string, input: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void, workbench: WindowWorkbench): Promise<unknown> {
		const args = isJsonObject(input) ? input : {};
		const self = this.facade.machine?.self.record ?? '';
		const callerOf = () => {
			const caller = callerOfRequest(args.caller);
			if (!caller) {
				throw new FacadeError('INVALID', 'The request names no caller of another workspace.');
			}
			// A caller of this workspace that another named back to it - a deletion it asked for, asked of every workspace
			// again there - is the one this workspace knows, not who that workspace says it is (O8)
			return caller.from?.window === self ? this.facade.ownCaller(caller) : caller;
		};
		const folderOf = () => {
			if (typeof args.folder !== 'string' || !args.folder) {
				throw new FacadeError('INVALID', 'The request names no folder.');
			}
			return args.folder;
		};
		switch (tool) {
			case WINDOW_REQUESTS.workIn: {
				const folder = folderOf();
				// Asked as that workspace, the person's deletion; or for an agent's call, as that agent
				const caller = args.caller === undefined ? undefined : callerOf();
				const [agents, there] = await Promise.all([this.facade.workIn(folder, caller), workbench.workIn(folder)]);
				return { agents, terminals: there.terminals, editors: there.editors };
			}
			case WINDOW_REQUESTS.workRelease: {
				const folder = folderOf();
				const caller = args.caller === undefined ? undefined : callerOf();
				const by: StoppedBy = caller?.id === undefined ? 'human' : caller.from ? { id: caller.id, name: caller.name, window: caller.from.window, label: caller.from.label } : caller.id;
				const stopping = await this.facade.releaseWorkIn(folder, by, caller);
				const left = await workbench.workRelease(folder, args.discard === true);
				return { stopping, left };
			}
			case WINDOW_REQUESTS.ring:
				this.facade.mail.takeNotices();
				return {};
		}
		if (!this.facade.frameworkOn()) {
			throw new FacadeError('UNAVAILABLE', 'The agent framework is turned off in this workspace (framework_disabled).');
		}
		switch (tool) {
			case WINDOW_REQUESTS.rows: {
				// Rows advertise this workspace's CLIs, but an unreachable window must not hold the machine's listing.
				await withDeadline(this.facade.refreshClis(), CLI_LOOK_WAIT_MS, () => undefined);
				const caller = callerOf();
				const listed = this.facade.listAgents(caller, true);
				const now = Date.now();
				// Beside the rows the caller reaches, the numbers this workspace holds: a caller refused one learns it is out of reach, as here (O1)
				return { agents: listed.agents.map(row => ({ id: row.id, name: row.name, state: row.state })), lines: listed.agents.map(row => line(this.facade, row, undefined, now)), clis: this.facade.startable().map(each => each.id), numbers: this.facade.agentNumbers() };
			}
			case WINDOW_REQUESTS.tool: {
				const caller = callerOf();
				if (typeof args.tool !== 'string' || !FORWARDED_TOOLS.has(args.tool)) {
					throw new FacadeError('INVALID', `Another workspace may hand this one ${[...FORWARDED_TOOLS].join(', ')} alone.`);
				}
				return this.call(caller, args.tool, args.args, progress, whenWritten);
			}
			case WINDOW_REQUESTS.start: {
				const caller = callerOf();
				const head = isJsonObject(args.head) && typeof args.head.repository === 'string' && typeof args.head.commit === 'string' ? { repository: args.head.repository, commit: args.head.commit } : undefined;
				return this.call(caller, 'start_agent', args.args, progress, whenWritten, { ...(head ? { head } : {}), ...(typeof args.waitMs === 'number' && args.waitMs > 0 ? { waitMs: args.waitMs } : {}) });
			}
			case WINDOW_REQUESTS.messages: {
				const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0) : [];
				return this.facade.mail.fetchForAfar(callerOf(), ids);
			}
			case WINDOW_REQUESTS.human:
				return this.facade.mail.humanForAfar(callerOf());
			case WINDOW_REQUESTS.tellHuman: {
				const { from, text, message } = args;
				if (!isForeign(from) || typeof text !== 'string' || typeof message !== 'number') {
					throw new FacadeError('INVALID', 'The request names no sender, text or message.');
				}
				this.facade.mail.tellThePersonFor(from, message, text);
				return {};
			}
			case WINDOW_REQUESTS.reveal: {
				const { agent } = args;
				if (typeof agent !== 'number') {
					throw new FacadeError('INVALID', 'The request names no agent.');
				}
				return { shown: await this.facade.mail.revealFor(agent) };
			}
			case WINDOW_REQUESTS.folders:
				return (await this.facade.windowFolders()).map(each => each.folder);
			case WINDOW_REQUESTS.deliver: {
				const { to, text, replyTo } = args;
				if (typeof to !== 'number' || typeof text !== 'string' || (replyTo !== undefined && typeof replyTo !== 'number')) {
					throw new FacadeError('INVALID', 'The delivery names no agent of this workspace, or no text.');
				}
				await this.facade.numbersReady();
				return this.facade.mail.receive(callerOf(), to, text, replyTo as number | undefined);
			}
		}
		throw new FacadeError('INVALID', `Unknown workspace request '${tool}'.`);
	}
}

/** What another workspace's requests need of this one's workbench (O5): its terminals and unsaved editors in a folder, and to stop and discard them. */
export interface WindowWorkbench {
	workIn(folder: string): Promise<{ readonly terminals: readonly string[]; readonly editors: readonly string[] }>;
	/** Stops the terminals working in `folder` and, `discard`, discards its unsaved editors there: what is left. */
	workRelease(folder: string, discard: boolean): Promise<readonly string[]>;
}
