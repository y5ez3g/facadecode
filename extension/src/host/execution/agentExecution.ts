/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionIdentity } from './sessionIdentity';
import type { ConversationKey } from '../../core/ports';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { timeout } from '../../base/async';
import type { TerminalOwner } from '../../base/windowIdentity';
import { activityOf, cliTitle, interruptVerified } from '../../clis/activity';
import {
	ActivityReport, CleanupResult, Event, ExecutionPort, ExitReport, LaunchPlan, LiveRun, PairFacts, RunId, RunMeta
} from '../../core/ports';
import type { CallEvent, InputEffect, InputReading, Method, OwnerClaim, Requests, RunEvent, RunExit, RunInfo, RunStatus, ScreenRead } from '../../ptyd/protocol';
import type { ServedAnswer, ToolCall } from '../../schema/protocol';
import { failureAnswer, isToolAnswer } from '../../transport/failure';
import { McpServerLaunch, shimLaunch as launchShim } from '../../transport/launch';
import { AgentTerminals, type AgentTerminal } from './agentTerminals';
import { ExecutionSession, RECONCILE_MS } from './executionSession';
import { PtydClient, PtydGone, PtydLost, PtydNotSent, ptydSocketPath, within } from './ptydClient';
import { EARLIER_PROTOCOLS, PTYD_PROTOCOL } from '../../ptyd/protocol';

/** How long a CLI has to end on the hang-up before ptyd kills its process group (LIFECYCLE-4.2): no UI waits for it. */
const GRACE_MS = 3_000;

/** How long restoring waits for one terminal to open before it restores the next: VS Code can leave a terminal unopened. */
const OPEN_WAIT_MS = 10_000;

/** The size a run starts at where its terminal has not told its own yet: the CLI redraws as the terminal's arrives. */
const START_COLUMNS = 120;
const START_ROWS = 30;

/** How long after its process started a run is still starting while its CLI has shown no activity (CLIS-2.3, D81). */
const STARTUP_MS = 20_000;

/** How long after a run a ptyd lists was told as not shown it is told again, should showing it have failed meanwhile. */
const UNSHOWN_AGAIN_MS = 30_000;

/** What the composition root gives the execution port. */
export interface AgentExecutionOptions {
	/** The workspace key ptyd keeps this window's runs under: a reloaded window of it finds them again. */
	readonly owner: string;
	readonly claim?: OwnerClaim;
	/** ptyd's script, started detached by the first window that needs it. */
	readonly ptydScript: string;
	/** The execution environment's Facade data directory: ptyd's socket key and log (ARCHITECTURE-3.1). */
	readonly home: string;
	/** The extension's `media` folder, where the CLIs' logos are. */
	readonly media: vscode.Uri;
	/** One line of the agents log: no secrets, no terminal content (ARCHITECTURE-3.3). */
	readonly log: (line: string) => void;
	/** The local companion registers actual native objects under this activation claim. */
	readonly terminalOwner?: TerminalOwner & { readonly remote: boolean };
	/** The runs' MCP shim, which their CLIs start (MCP-6.1): `shim.js` beside ptyd's script where not given. */
	readonly shimScript?: string;
	/** How long a run is still starting while its CLI shows no activity: {@link STARTUP_MS}, or a test's. */
	readonly startupMs?: number;
}

/** What answers a tool call: told when this window read it, on this process's monotonic clock (RULES-1.2). */
export type ToolHandler = (call: ToolCall, receivedAt: number) => Promise<ServedAnswer>;

/**
 * Whether `value` is a tool call as a run's shim sends it: the window validates its arguments before any effect (MCP-1.1), and the
 * tool service its tool protocol (MCP-6.2).
 */
function isToolCall(value: unknown): value is ToolCall {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const { caller, tool, callId, elapsedMs } = value as { [key: string]: unknown };
	return typeof caller === 'string' && typeof tool === 'string' && typeof callId === 'string' && typeof elapsedMs === 'number' && Number.isFinite(elapsedMs);
}

/** One run's pair as this window shows it: its terminal, and its process once it has one. */
interface Pair {
	readonly run: RunId;
	/** The protocol of the ptyd that holds its process: this window's own, or an earlier one's (ARCHITECTURE-2.4). */
	protocol: number;
	facts: PairFacts;
	readonly terminal: AgentTerminal;
	readonly lifetime: AbortController;
	/** Spawn was sent, but its outcome is not known yet. Closure must reconcile it even before a PID is returned. */
	starting?: boolean;
	/** The CLI whose adapter reads its reports and exit. */
	cli: string;
	process?: { readonly pid: number; readonly startedAt: number };
	/** When its startup ends, by this window's monotonic clock (CLIS-2.3, D81); and whether it is told again then. */
	startupEnds?: number;
	startupCheck?: boolean;
	/** Whether its CLI has shown its activity to this window: its startup is then over for good (D81). */
	shown?: boolean;
	/** Whether the connection its run was heard by is lost: until it is claimed again, it is told as lost alone (RULES-3.1). */
	lost?: boolean;
	exited?: RunExit;
	status?: RunStatus;
	terminalTitle: string;
	/** How many status and title events it heard: a listing asked before the last of them is no newer than they are. */
	heard?: number;
	/** The last report told, to tell each change once. */
	told?: string;
	events?: { dispose(): void };
}

/** A minimal event emitter for the port's events, independent of the editor's disposal order. */
class Emitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event: Event<T> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
	clear(): void {
		this.listeners.clear();
	}
}

/** The name of a signal by its number, as an exit report gives it. */
function signalName(signal: number | undefined): string | undefined {
	if (!signal) {
		return undefined;
	}
	return Object.entries(os.constants.signals).find(([, number]) => number === signal)?.[0] ?? `signal ${signal}`;
}

/** Whether `value` is the meta this window stores with a run (RunMeta). */
function isRunMeta(value: { readonly [key: string]: unknown }): value is { readonly [key: string]: unknown } & RunMeta {
	const strings = ['alias', 'name', 'cli', 'displayName', 'command', 'location', 'cwd', 'environment'];
	return strings.every(key => typeof value[key] === 'string') && typeof value.yolo === 'boolean' && typeof value.createdAt === 'number';
}

/**
 * The execution port (ARCHITECTURE-2.3, LIFECYCLE-1.5, 2.2, 3.1): each run's process is held by ptyd - not by the window - and shown
 * in one editor terminal of its own, which exists from the accepted launch on. Runs go on as the window reloads; a reloaded window
 * claims and shows them again. Closing an agent's tab is the person's close, and renaming it their rename of the agent; disposing it
 * is the port's alone.
 */
export class AgentExecution implements ExecutionPort, vscode.Disposable {

	private readonly pairs = new Map<RunId, Pair>();
	/** The protocol of the ptyd each run listed in one of an earlier protocol is held by, until it is forgotten (ARCHITECTURE-2.4). */
	private readonly where = new Map<RunId, number>();
	/** Each run's cleanup, started once by whichever of removePair and terminate comes first (LIFECYCLE-3.1). */
	private readonly cleanups = new Map<RunId, Promise<CleanupResult>>();
	private readonly pendingCleanup = new Set<RunId>();
	/** Runs whose ptyd was not told to forget them yet: told again at each check, so that none stays listed for good. */
	private readonly pendingForget = new Set<RunId>();
	/** The ptyds a check is listing now, each by its protocol: one that does not answer is not asked again meanwhile. */
	private readonly listing = new Set<number>();
	/** Whether the first restore is over: runs a ptyd lists that no pair shows are told from then on. */
	private restored = false;
	/** When each run a ptyd lists and no pair shows was last told, to tell it once a while. */
	private readonly unshownTold = new Map<RunId, number>();
	private readonly finds = new Emitter<void>();
	private readonly reports = new Emitter<ActivityReport>();
	private readonly exits = new Emitter<ExitReport>();
	private readonly activations = new Emitter<RunId | undefined>();
	private readonly closes = new Emitter<RunId>();
	private readonly tabRenames = new Emitter<{ readonly run: RunId; readonly name: string }>();
	private readonly identities = new Emitter<{ readonly run: RunId; readonly sessionId: string | null; readonly cwd?: string }>();
	private readonly tabPins = new Emitter<{ readonly run: RunId; readonly pinned: boolean }>();
	readonly onDidIdentify = this.identities.event;
	readonly onDidPinTab = this.tabPins.event;
	private readonly transfers = new Emitter<void>();
	private readonly toolConnections = new Emitter<RunId>();
	private toolHandler: ToolHandler | undefined;
	readonly onDidReport = this.reports.event;
	readonly onDidExit = this.exits.event;
	readonly onDidActivate = this.activations.event;
	readonly onDidClosePair = this.closes.event;
	readonly onDidRenameTab = this.tabRenames.event;
	readonly onDidLoseOwnership = this.transfers.event;
	readonly onDidConnectTools = this.toolConnections.event;
	/**
	 * After the first restore, a ptyd lists runs of this window that it shows no pair of - one of an earlier protocol found late, or
	 * one whose reattach failed: the composition root restores again, so that none is left out (RULES-4.1, D86).
	 */
	readonly onDidFindRuns = this.finds.event;
	private readonly terminals: AgentTerminals;
	private readonly session: ExecutionSession;
	private readonly identity: SessionIdentity;

	constructor(private readonly options: AgentExecutionOptions) {
		this.identity = new SessionIdentity(options.home, (run, sessionId, cwd) => this.identities.fire({ run, sessionId, cwd }), options.log);
		// Acquire the activation claim before subscribing any editor resources.
		this.session = new ExecutionSession({
			...options,
			connectionLost: protocol => this.connectionLost(protocol),
			// A ptyd of an earlier protocol is not let go while a run of it is being closed or forgotten through it
			busy: protocol => [...this.cleanups.keys(), ...this.pendingCleanup, ...this.pendingForget].some(run => this.protocolOf(run) === protocol),
			transferred: () => this.transferred(),
			reconnect: () => this.reclaim(),
			reconcile: () => this.reconcile(),
			connected: client => client.onCall((event, receivedAt) => void this.answerCall(client, event, receivedAt))
		});
		try {
			this.terminals = new AgentTerminals({
				media: options.media, log: options.log, terminalOwner: options.terminalOwner,
				activated: run => this.activations.fire(run),
				closed: run => this.closes.fire(run),
				renamed: (run, name) => this.tabRenames.fire({ run, name }),
			pinned: (run, pinned) => this.tabPins.fire({ run, pinned })
			});
		} catch (err) {
			this.session.dispose();
			throw err;
		}
	}

	pinTab(run: RunId, pinned: boolean): void { this.terminals.pin(run, pinned); }
	async conversations(): Promise<readonly ConversationKey[]> {
		return (await this.allRuns()).flatMap(run => {
			const meta = run.meta;
			return !run.exited && typeof meta.sessionId === 'string' && typeof meta.cli === 'string' && typeof meta.environment === 'string'
				? [{ sessionId: meta.sessionId, cli: meta.cli, environment: meta.environment }] : [];
		});
	}

	openPair(facts: PairFacts, options: { readonly reveal: boolean }): void {
		if (this.pairs.has(facts.run)) {
			return;
		}
		this.create(facts, options.reveal);
	}

	/** The initial restoration batch is complete; a recreated local registry may retire its predecessor's UI resources. */
	async finishRestore(): Promise<void> {
		try {
			await this.terminals.finishRestore();
		} finally {
			this.restored = true;
		}
	}

	note(run: RunId, text: string): void {
		this.pairs.get(run)?.terminal.pty.note(text);
	}

	/** Serves this window's runs' tool calls with `handler` (MCP-6.1); until then, and after it is disposed, calls are refused. */
	serveTools(handler: ToolHandler): vscode.Disposable {
		this.toolHandler = handler;
		return new vscode.Disposable(() => {
			if (this.toolHandler === handler) {
				this.toolHandler = undefined;
			}
		});
	}

	/** How `run`'s CLI starts the run's MCP shim (MCP-6.1): this extension host's runtime as Node, the bundled shim, ptyd's socket. */
	shimLaunch(run: RunId): McpServerLaunch {
		return launchShim({
			runtime: process.execPath,
			script: this.options.shimScript ?? path.join(path.dirname(this.options.ptydScript), 'shim.js'),
			socket: ptydSocketPath(this.options.home),
			run
		});
	}

	/**
	 * The runs with a live process that ptyd holds in this execution environment, of every window and workspace: those whose
	 * injected files may still be in use (CLIS-2.2). Rejects where ptyd cannot be reached - never an empty list for an unknown one.
	 */
	async allRunIds(): Promise<readonly string[]> {
		return (await this.allRuns()).filter(run => !run.exited).map(run => run.run);
	}

	/** Global discovery also sees the previous release's live runs; observing another workspace never claims it. */
	private async allRuns(): Promise<readonly RunInfo[]> {
		const runs = [...await this.ask('list', {})];
		for (const protocol of EARLIER_PROTOCOLS.filter(value => value >= 9)) {
			const client = await PtydClient.join(ptydSocketPath(this.options.home, protocol), protocol);
			if (!client) { continue; }
			try { runs.push(...await within(client.request('list', {}))); }
			finally { client.dispose(); }
		}
		return runs;
	}

	/** The bottom `lines` logical lines of `run`'s screen (MCP-5.1). */
	readScreen(run: RunId, lines: number): Promise<ScreenRead> {
		return this.ask('read', { run, lines });
	}

	/**
	 * Pastes `text` into `run`'s terminal, then Enter where asked, in turn with its other automated input (MCP-5.2), `lead` typed
	 * before it where given (D108). Rejects with {@link PtydNotSent} where nothing reached ptyd, {@link PtydLost} where its answer was
	 * lost and the effects are not known.
	 */
	typeText(run: RunId, text: string, enter: boolean, lead?: string): Promise<InputEffect> {
		return this.ask('type', { run, text, enter, ...lead !== undefined ? { lead } : {} });
	}

	/** Presses `keys`, already validated names, in `run`'s terminal, in turn with its other automated input (MCP-5.2). */
	pressKeys(run: RunId, keys: readonly string[]): Promise<InputEffect> {
		return this.ask('keys', { run, keys });
	}

	/** `run`'s ordinary-message input as the input reader `adapter` reads it from ptyd's screen of the run (CLIS-2.1, RULES-1.4). */
	inspectInput(run: RunId, adapter: string): Promise<InputReading> {
		return this.ask('inspect', { run, adapter });
	}

	/** Asks ptyd `method`, connecting where this window is not: rejects plainly where ptyd cannot be reached, nothing asked. */
	private async ask<M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> {
		const run = 'run' in params && typeof params.run === 'string' ? params.run : undefined;
		const protocol = run === undefined ? PTYD_PROTOCOL : this.protocolOf(run);
		// Protocol 9 added MCP input/screen requests. An earlier run remains usable in its existing terminal; never
		// send these requests to the window's newer ptyd, which does not own it, or to an older ptyd that cannot serve them.
		if (protocol < 9 && ['read', 'type', 'keys', 'inspect'].includes(method)) {
			throw new PtydNotSent(`This agent's runtime uses protocol ${protocol}, which does not support MCP screen or input requests. Its existing terminal remains usable; no request was sent.`);
		}
		let client: PtydClient;
		try {
			client = await this.session.client(protocol);
		} catch (err) {
			throw err instanceof PtydNotSent ? err : new PtydNotSent(`The agent runtime (ptyd) cannot be reached: ${messageOf(err)}`);
		}
		return client.request(method, params);
	}

	/**
	 * Answers a tool call ptyd carried from a run's shim: with the handler's answer, else a failure saying what is known. What follows
	 * the answer's handing back happens once ptyd says the shim has it; an answer it could not hand back is handed back to nobody.
	 */
	private async answerCall(client: PtydClient, event: CallEvent, receivedAt: number): Promise<void> {
		const { answer, delivered } = await this.answerOf(event.call, receivedAt);
		try {
			await client.request('answer', { id: event.id, answer });
		} catch (err) {
			this.options.log(`Could not answer a tool call of ${String(event.call.caller)}: ${messageOf(err)}`);
			return;
		}
		try {
			delivered?.();
		} catch (err) {
			this.options.log(`Could not complete a tool call of ${String(event.call.caller)} after its answer: ${messageOf(err)}`);
		}
	}

	private async answerOf(call: unknown, receivedAt: number): Promise<ServedAnswer> {
		if (!isToolCall(call)) {
			return { answer: failureAnswer('INVALID', 'invalid_argument', 'The tool call reached the Facade Code window incomplete: it had no effect.', 'none') };
		}
		const handler = this.toolHandler;
		if (!handler) {
			return { answer: failureAnswer('UNAVAILABLE', 'window_unavailable', 'The Facade Code window does not take tool calls now: the call had no effect.', 'none') };
		}
		let served: ServedAnswer;
		try {
			served = await handler(call, receivedAt);
		} catch (err) {
			this.options.log(`The tool call ${call.callId} (${call.tool}) of ${call.caller} failed: ${messageOf(err)}`);
			return { answer: failureAnswer('FAILED', 'internal_error', `The Facade Code window could not complete ${call.tool}: ${messageOf(err)}. Whether it took effect is not known.`, 'unknown') };
		}
		return isToolAnswer(served?.answer) ? served
			: { answer: failureAnswer('FAILED', 'internal_error', `The Facade Code window gave no answer to ${call.tool}. Whether it took effect is not known.`, 'unknown') };
	}

	async spawn(run: RunId, plan: LaunchPlan, meta: RunMeta): Promise<{ readonly pid: number; readonly startedAt: number }> {
		if (plan.exactResume) { this.identity.track(run); }
		const pair = this.pairs.get(run);
		if (!pair) {
			throw new Error('The agent was closed before its CLI started.');
		}
		let client = await this.session.client();
		if (this.pairs.get(run) !== pair || this.session.closed) {
			throw new Error('The agent was closed before its CLI started.');
		}
		pair.cli = plan.cli;
		// Where it runs now - a new worktree's folder, not the one it was accepted in - and as what: the title rules read them (CLIS-2.3)
		pair.facts = { ...pair.facts, cwd: plan.cwd, displayName: plan.displayName, command: plan.command, cli: plan.cli };
		this.listen(pair, client);
		const size = pair.terminal.pty.dimensions;
		let info: RunInfo;
		let snapshot: { readonly screen: string; readonly seq: number } | undefined;
		pair.starting = true;
		try {
			info = await client.request('spawn', {
				run, owner: this.options.owner, file: plan.executable, args: plan.args, cwd: plan.cwd, env: plan.env,
				cols: size?.columns ?? START_COLUMNS, rows: size?.rows ?? START_ROWS, meta: { ...meta },
				...plan.screenStatus ? { screenStatus: plan.screenStatus } : {}
			});
		} catch (err) {
			if (!(err instanceof PtydLost)) {
				pair.starting = false;
				throw err;
			}
			// A lost reply never repeats spawn. Reconcile only this accepted run ID and attach its original process if it exists.
			const recovered = await this.recoverStart(pair);
			client = recovered.client;
			info = recovered.attached.info;
			snapshot = recovered.attached;
			// Claimed again through a connection of its own
			pair.lost = false;
		}
		if (this.pairs.get(run) !== pair) {
			// Closed while it started: it ends at once, unseen (RULES-5.2)
			void this.cleanup(run);
			throw new Error('The agent was closed before its CLI started.');
		}
		pair.process = { pid: info.pid, startedAt: info.startedAt };
		this.identity.process(run, info.pid);
		pair.startupEnds = this.startupEndOf(info.startedAt);
		pair.starting = false;
		pair.status = info.status;
		pair.terminalTitle = info.title;
		pair.terminal.pty.bind(this.binding(client, run), snapshot);
		this.tell(pair);
		if (info.exited) {
			this.ended(pair, info.exited);
		}
		return pair.process;
	}

	/** Keeps an accepted start visibly disconnected until its actual outcome is known; never replays the start request. */
	private async recoverStart(pair: Pair): Promise<{ readonly client: PtydClient; readonly attached: Requests['attach']['result'] }> {
		const reason = vscode.l10n.t("The connection to the agent's process was lost; reconnecting");
		pair.lost = true;
		this.reports.fire({ run: pair.run, activity: 'unknown', reporting: false, reason, disconnected: true });
		while (this.pairs.get(pair.run) === pair && !this.session.closed) {
			try {
				const client = await this.session.client();
				if (this.pairs.get(pair.run) !== pair || this.session.closed) {
					break;
				}
				const found = (await client.request('list', { owner: this.options.owner })).find(each => each.run === pair.run);
				if (this.pairs.get(pair.run) !== pair || this.session.closed) {
					break;
				}
				if (!found) {
					pair.starting = false;
					throw new Error('The accepted CLI start is no longer held by ptyd.');
				}
				this.listen(pair, client);
				pair.terminal.pty.expectScreen();
				const attached = await client.request('attach', { run: pair.run });
				return { client, attached };
			} catch (err) {
				pair.terminal.pty.abandonScreen();
				pair.events?.dispose();
				pair.events = undefined;
				if (!pair.starting || this.session.closed || this.pairs.get(pair.run) !== pair) {
					throw err;
				}
				this.options.log(`The start of ${pair.run} remains unconfirmed: ${messageOf(err)}`);
			}
			await timeout(RECONCILE_MS, pair.lifetime.signal);
		}
		throw new Error('The agent was closed before its CLI started.');
	}

	async attach(live: LiveRun, facts: PairFacts): Promise<void> {
		if (live.meta.exactResume) { this.identity.track(live.run); this.identity.process(live.run, live.pid); }
		// VS Code opens a background pseudoterminal lazily, ignoring name events until then. Its initial tab name must include
		// the restored CLI title, so create the native terminal after the attach snapshot has supplied it (LIFECYCLE-2.2).
		const pair = this.pairs.get(live.run) ?? this.create(facts, false, true);
		pair.cli = live.meta.cli;
		// Through the ptyd that holds it: this window's own, or one of an earlier protocol that still does (ARCHITECTURE-2.4)
		pair.protocol = this.where.get(live.run) ?? PTYD_PROTOCOL;
		let client: PtydClient;
		let attached: { readonly info: RunInfo; readonly screen: string; readonly seq: number };
		try {
			client = await this.session.client(pair.protocol);
			if (this.pairs.get(live.run) !== pair || this.session.closed) {
				throw new Error('The agent was closed while reattaching.');
			}
			this.listen(pair, client);
			// Claimed now, so that this window hears the run from here on; its screen is drawn as the terminal opens, and what it
			// writes before the answer comes after the screen
			pair.terminal.pty.expectScreen();
			attached = await client.request('attach', { run: live.run });
		} catch (err) {
			pair.terminal.pty.abandonScreen();
			if (err instanceof PtydGone && this.pairs.get(live.run) === pair && !this.session.closed) {
				// Its ptyd of an earlier protocol went as it was listed: it ended with it, how is not known - shown so, never left out
				// (RULES-3.3, 4.1)
				pair.process = { pid: live.pid, startedAt: live.startedAt };
				this.options.log(`${live.run} ended with its ptyd of protocol ${pair.protocol}: ${messageOf(err)}`);
				this.endedUnknown(pair);
				return this.openRestored(pair, live.run);
			}
			if ((err instanceof PtydLost || err instanceof PtydNotSent) && this.pairs.get(live.run) === pair && !this.session.closed) {
				// The connection went as it reattached: the run is kept, told as lost, and claimed again with the others once the
				// connection is back - never forgotten for a moment's loss (RULES-4.1, LIFECYCLE-3.5)
				pair.process = { pid: live.pid, startedAt: live.startedAt };
				pair.startupEnds = this.startupEndOf(live.startedAt);
				pair.lost = true;
				this.reports.fire({ run: live.run, activity: 'unknown', reporting: false, reason: vscode.l10n.t("The connection to the agent's process was lost; reconnecting"), disconnected: true });
				this.options.log(`${live.run} could not be claimed again yet: ${messageOf(err)}`);
				return this.openRestored(pair, live.run);
			}
			// Claimed by another window meanwhile, or gone: this window shows no pair of it
			this.detachPair(live.run);
			throw err;
		}
		const { info, screen, seq } = attached;
		if (this.pairs.get(live.run) !== pair) {
			if (!this.session.closed) {
				void this.cleanup(live.run);
			}
			throw new Error('The agent was closed while reattaching.');
		}
		pair.process = { pid: live.pid, startedAt: live.startedAt };
		pair.startupEnds = this.startupEndOf(live.startedAt);
		pair.lost = false;
		pair.exited = info.exited;
		pair.status = info.status;
		pair.terminalTitle = info.title;
		pair.terminal.pty.bind(this.binding(client, live.run), { screen, seq });
		if (info.exited) {
			pair.terminal.pty.exited(this.endLine(info.exited));
		}
		this.tell(pair);
		return this.openRestored(pair, live.run);
	}

	/**
	 * Opens a reattached run's terminal. Opening another editor terminal before this one's xterm is ready can detach its container
	 * and prevent VS Code from ever opening its pseudoterminal: the next run is restored only after this native terminal is ready.
	 */
	private async openRestored(pair: Pair, run: RunId): Promise<void> {
		pair.terminal.open(false);
		const opened = await Promise.race([pair.terminal.pty.ready, timeout(OPEN_WAIT_MS).then(() => undefined)]);
		if (opened === false || this.pairs.get(run) !== pair) {
			throw new Error('The agent was closed while reattaching.');
		}
		if (opened === undefined) {
			// Its card and process are kept; its terminal draws the run's screen once VS Code opens it
			this.options.log(`The terminal of ${run} did not open within ${OPEN_WAIT_MS / 1000} seconds; the agents after it are restored meanwhile.`);
		}
	}

	terminate(run: RunId): Promise<CleanupResult> {
		return this.cleanup(run);
	}

	removePair(run: RunId): void {
		this.identity.untrack(run);
		const pair = this.detachPair(run);
		if (!pair || (!pair.process && !pair.starting) || this.session.ownershipLost) {
			return;
		}
		if (pair.exited) {
			void this.forget(run);
		} else {
			void this.cleanup(run);
		}
	}

	/** Removes only this UI's view. A transfer must never terminate or forget the process it transferred. */
	private detachPair(run: RunId): Pair | undefined {
		const pair = this.pairs.get(run);
		if (!pair) {
			return;
		}
		// Gone from the map first: disposing its terminal is no close of the person's
		this.pairs.delete(run);
		pair.lifetime.abort();
		pair.events?.dispose();
		pair.terminal.dispose();
		return pair;
	}

	async reveal(run: RunId, options: { readonly preserveFocus: boolean }): Promise<boolean> {
		return this.pairs.get(run)?.terminal.reveal(options.preserveFocus) ?? false;
	}

	/** The person kept a run whose tab they closed: the same pseudoterminal opens in a new tab, drawn from the run's screen. */
	reopen(run: RunId): void {
		this.pairs.get(run)?.terminal.open(false);
	}

	rename(run: RunId, name: string): void {
		const pair = this.pairs.get(run);
		if (pair) {
			pair.facts = { ...pair.facts, name };
			pair.terminal.rename(name);
			this.tell(pair);
		}
	}

	setMeta(run: RunId, meta: RunMeta): void {
		void this.session.client(this.protocolOf(run)).then(client => client.request('setMeta', { run, meta: { ...meta } })).catch(err => this.options.log(`Could not keep the new details of ${run} with its process: ${messageOf(err)}`));
	}

	/**
	 * This window's runs in its own ptyd and in each ptyd of an earlier protocol that holds runs of it (ARCHITECTURE-2.4), each
	 * shown and operated through the ptyd that holds it. One of those that does not answer now is listed by a later restore.
	 */
	async live(): Promise<readonly LiveRun[]> {
		const client = await this.session.client();
		const listed: (readonly [number, RunInfo])[] = (await client.request('list', { owner: this.options.owner })).map(run => [PTYD_PROTOCOL, run]);
		for (const [protocol, earlier] of await this.session.earlierClients()) {
			try {
				// One that does not answer now holds up no run of this window's own: its runs are shown by a later restore
				listed.push(...(await within(earlier.request('list', { owner: this.options.owner }))).map(run => [protocol, run] as const));
			} catch (err) {
				this.options.log(`Could not list the agents the ptyd of protocol ${protocol} holds for this window yet: ${messageOf(err)}`);
			}
		}
		const runs: LiveRun[] = [];
		for (const [protocol, run] of listed) {
			// One run ID is one run: this window's own ptyd first, as it starts no run in another
			if (!isRunMeta(run.meta) || runs.some(each => each.run === run.run)) {
				continue;
			}
			if (protocol !== PTYD_PROTOCOL) {
				this.where.set(run.run, protocol);
			}
			runs.push({
				run: run.run,
				meta: run.meta as unknown as RunMeta,
				pid: run.pid,
				startedAt: run.startedAt,
				...(run.exited ? { exited: this.exitOf(String(run.meta.cli), run.exited) } : {}),
				claimedElsewhere: run.claimedElsewhere
			});
		}
		return runs;
	}

	async endWindow(): Promise<void> {
		// Each ptyd told on its own: its own one not answering keeps no earlier one from ending this window's runs
		const own = await this.session.client().then(client => [[PTYD_PROTOCOL, client] as const], err => {
			this.options.log(`Could not end the agent processes of this window: ${messageOf(err)}`);
			return [];
		});
		const ptyds: readonly (readonly [number, PtydClient])[] = [...own, ...this.session.earlierHeld];
		for (const [protocol, client] of ptyds) {
			try {
				const ended = await client.request('endWindow', { owner: this.options.owner, graceMs: GRACE_MS });
				this.options.log(`Ending ${ended} agent processes${protocol === PTYD_PROTOCOL ? '' : ` in the ptyd of protocol ${protocol}`}: their window closed.`);
			} catch (err) {
				this.options.log(`Could not end the agent processes of this window${protocol === PTYD_PROTOCOL ? '' : ` in the ptyd of protocol ${protocol}`}: ${messageOf(err)}`);
			}
		}
	}

	dispose(): void {
		this.identity.dispose();
		this.identities.clear();
		this.tabPins.clear();
		this.session.dispose();
		for (const pair of this.pairs.values()) {
			pair.lifetime.abort();
			pair.events?.dispose();
		}
		// Stop editor listeners before native resource disposal can emit close or activation events.
		this.terminals.dispose();
		this.pairs.clear();
		this.reports.clear();
		this.exits.clear();
		this.activations.clear();
		this.closes.clear();
		this.tabRenames.clear();
		this.transfers.clear();
		this.finds.clear();
	}

	/** The protocol of the ptyd that holds `run`: its pair's, else the one it was listed in, else this window's own. */
	private protocolOf(run: RunId): number {
		return this.pairs.get(run)?.protocol ?? this.where.get(run) ?? PTYD_PROTOCOL;
	}

	/** Each run owns its abort scope and a terminal resource; the native tab may wait for an attach snapshot. */
	private create(facts: PairFacts, reveal: boolean, deferTerminal = false): Pair {
		const terminal = this.terminals.create(facts, reveal);
		const pair: Pair = {
			run: facts.run, protocol: PTYD_PROTOCOL, facts, terminal, lifetime: new AbortController(), cli: facts.cli, terminalTitle: ''
		};
		this.pairs.set(facts.run, pair);
		if (!deferTerminal) {
			terminal.open(reveal);
		}
		return pair;
	}

	/** How a run's terminal shows its process through `client`. */
	private binding(client: PtydClient, run: RunId) {
		return {
			snapshot: async () => {
				const { screen, seq } = await client.request('attach', { run });
				return { screen, seq };
			},
			input: (data: string) => void client.request('input', { run, data }).catch(err => this.options.log(`Could not type into ${run}: ${messageOf(err)}`)),
			resize: (columns: number, rows: number) => void client.request('resize', { run, cols: columns, rows }).catch(() => undefined)
		};
	}

	/** Hears what ptyd tells of `pair`'s run through `client`. */
	private listen(pair: Pair, client: PtydClient): void {
		pair.events?.dispose();
		pair.events = client.onRunEvent(pair.run, event => this.heard(pair, event));
	}

	private heard(pair: Pair, event: RunEvent): void {
		if (this.pairs.get(pair.run) !== pair) {
			return;
		}
		switch (event.event) {
			case 'output':
				pair.terminal.pty.output(event.seq, event.data);
				break;
			case 'title':
				pair.terminalTitle = event.title;
				pair.heard = (pair.heard ?? 0) + 1;
				this.tell(pair);
				break;
			case 'status':
				pair.status = event.status;
				pair.heard = (pair.heard ?? 0) + 1;
				this.tell(pair);
				break;
			case 'exit': {
				const { event: _event, run: _run, ...exit } = event;
				this.ended(pair, exit);
				break;
			}
			case 'tools':
				this.toolConnections.fire(pair.run);
				break;
		}
	}

	/** `pair`'s process ended: its terminal says how, and the core hears it once (RULES-3.3). */
	private ended(pair: Pair, exit: RunExit): void {
		if (pair.exited) {
			return;
		}
		pair.exited = exit;
		pair.terminal.pty.exited(this.endLine(exit));
		this.exits.fire({ run: pair.run, ...this.exitOf(pair.cli, exit) });
	}

	private exitOf(cli: string, exit: RunExit): { readonly code?: number; readonly signal?: string; readonly interruptVerified: boolean } {
		const signal = signalName(exit.signal);
		return { code: exit.exitCode, ...(signal ? { signal } : {}), interruptVerified: interruptVerified(cli, { code: exit.exitCode, ...(signal ? { signal } : {}), ctrlC: !!exit.ctrlC }) };
	}

	private endLine(exit: RunExit): string {
		const signal = signalName(exit.signal);
		return signal
			? vscode.l10n.t("[Agent process terminated by signal {0}]", signal)
			: vscode.l10n.t("[Agent process exited with code {0}]", exit.exitCode);
	}

	/** Tells the core what `pair`'s CLI reports now, and its tab its title: each change once (CLIS-2.3). */
	private tell(pair: Pair): void {
		const facts = activityOf(pair.status);
		const title = this.titleOf(pair);
		pair.terminal.pty.setTitle(title);
		// What it showed before its connection was lost is no news: claimed again, it is told what it shows then
		if (!pair.process || pair.exited || pair.lost) {
			return;
		}
		// No report yet - none at all, or a probe answered and none since: still starting until its bound, unless it showed its
		// activity before (CLIS-2.3, D81)
		const unshown = facts.unknown === 'not_reporting' || facts.unknown === 'waiting';
		if (!unshown) {
			pair.shown = true;
		}
		const left = unshown && !pair.shown ? (pair.startupEnds ?? 0) - performance.now() : 0;
		const awaiting = left > 0;
		if (awaiting && !pair.startupCheck) {
			pair.startupCheck = true;
			void timeout(Math.ceil(left), pair.lifetime.signal).then(() => {
				pair.startupCheck = false;
				if (this.pairs.get(pair.run) === pair) {
					this.tell(pair);
				}
			}, () => undefined);
		}
		const reason = awaiting
			? undefined
			: facts.unknown === 'not_reporting'
				? vscode.l10n.t("The CLI has not reported its activity")
				: facts.unknown === 'waiting'
					? vscode.l10n.t("Waiting for the CLI's first activity report")
					: facts.unknown === 'cleared'
						? vscode.l10n.t("The CLI cleared its activity report")
						: undefined;
		const report: ActivityReport = {
			run: pair.run,
			activity: facts.activity,
			reporting: facts.reporting,
			...(awaiting ? { awaitingActivity: true } : {}),
			...(facts.blocker ? { blocker: facts.blocker } : {}),
			...(reason ? { reason } : {}),
			...(facts.error ? { error: facts.error.text ?? vscode.l10n.t("The CLI reported an error") } : {}),
			...(title ? { title } : {})
		};
		const told = JSON.stringify(report);
		if (told !== pair.told) {
			pair.told = told;
			this.reports.fire(report);
		}
	}

	/**
	 * When the startup of a run whose process started at `startedAt`, by ptyd's clock, ends by this window's monotonic one: what is
	 * left of its bound now - never more than all of it, however the clocks differ - so that no later clock change moves it.
	 */
	private startupEndOf(startedAt: number): number {
		const bound = this.options.startupMs ?? STARTUP_MS;
		return performance.now() + Math.max(0, Math.min(bound, startedAt + bound - Date.now()));
	}

	/** The title `pair`'s CLI gives its tab now (CLIS-2.3). */
	private titleOf(pair: Pair): string | undefined {
		return cliTitle({ reported: pair.status?.title, terminal: pair.terminalTitle });
	}

	/** Ends `run`'s process in the background, once, and forgets it: the actual result for whoever asks (LIFECYCLE-3.1, 4.2). */
	private cleanup(run: RunId): Promise<CleanupResult> {
		let cleanup = this.cleanups.get(run);
		if (!cleanup) {
			// Through the ptyd that holds it; one of an earlier protocol that went took it with it
			cleanup = this.session.client(this.protocolOf(run)).then(
				client => client.request('terminate', { run, graceMs: GRACE_MS }).then(
					result => result,
					err => err instanceof PtydLost || err instanceof PtydNotSent ? 'unconfirmed' as const : /^No run /.test(messageOf(err)) ? 'already_exited' as const : 'failed' as const),
				err => err instanceof PtydGone ? 'already_exited' as const : 'unconfirmed' as const);
			cleanup = cleanup.then(result => {
				if (result === 'terminated' || result === 'already_exited') {
					this.pendingCleanup.delete(run);
					this.identity.forget(run);
				} else if (!this.session.closed) {
					this.pendingCleanup.add(run);
				}
				if (!this.pairs.has(run) && (result === 'terminated' || result === 'already_exited')) {
					void this.forget(run);
				}
				this.options.log(`Ending the process of ${run}: ${result}`);
				return result;
			});
			this.cleanups.set(run, cleanup);
			void cleanup.finally(() => {
				if (this.pendingCleanup.has(run)) {
					this.cleanups.delete(run);
				} else {
					setTimeout(() => this.cleanups.delete(run), 60_000).unref?.();
				}
			});
		}
		return cleanup;
	}

	private async forget(run: RunId): Promise<void> {
		try {
			await (await this.session.client(this.protocolOf(run))).request('forget', { run });
		} catch (err) {
			if (!(err instanceof PtydGone)) {
				// Told again at the next check: a run its ptyd keeps listing would keep that ptyd held, and be found unshown
				if (!this.pendingForget.has(run) && !this.session.closed) {
					this.options.log(`Could not let ptyd forget ${run}, trying again: ${messageOf(err)}`);
				}
				if (!this.session.closed) {
					this.pendingForget.add(run);
				}
				return;
			}
		}
		this.pendingForget.delete(run);
		this.where.delete(run);
	}

	private transferred(): void {
		this.pendingCleanup.clear();
		this.pendingForget.clear();
		for (const run of [...this.pairs.keys()]) {
			this.detachPair(run);
		}
		this.options.log('This activation no longer owns the workspace: its UI detached without ending any process.');
		this.transfers.fire();
	}

	/**
	 * The connection to the ptyd of `protocol` is lost: what each live run's CLI there reports is not heard until it is claimed again,
	 * so its activity is not known meanwhile, and its card says why (RULES-3.1, 3.2).
	 */
	private connectionLost(protocol: number): void {
		const reason = vscode.l10n.t("The connection to the agent's process was lost; reconnecting");
		for (const pair of this.pairs.values()) {
			if ((!pair.process && !pair.starting) || pair.exited || pair.protocol !== protocol) {
				continue;
			}
			const facts = activityOf(pair.status);
			const title = this.titleOf(pair);
			pair.lost = true;
			const report: ActivityReport = {
				run: pair.run,
				activity: 'unknown',
				reporting: facts.reporting,
				reason,
				disconnected: true,
				...(facts.error ? { error: facts.error.text ?? vscode.l10n.t("The CLI reported an error") } : {}),
				...(title ? { title } : {})
			};
			// Told as the last report, so that the same report as before the loss is told again once the run is claimed
			pair.told = JSON.stringify(report);
			this.reports.fire(report);
		}
	}

	/**
	 * Capture the live runs whose connection was lost before connecting, then restore that batch without replaying any starts: those
	 * of a ptyd whose connection was kept stay as they are.
	 */
	private reclaim(): Promise<void> {
		const shown = [...this.pairs.values()].filter(pair => pair.process && !pair.exited && pair.lost);
		return this.session.recover(shown.length > 0, client => this.restore(shown, client));
	}

	/** Claims each of `shown` again, through `client` - this window's own ptyd - or the ptyd of an earlier protocol that holds it. */
	private async restore(shown: readonly Pair[], client: PtydClient): Promise<boolean> {
		let complete = true;
		for (const pair of shown) {
			if (this.pairs.get(pair.run) !== pair || this.session.closed) {
				continue;
			}
			try {
				const holder = pair.protocol === PTYD_PROTOCOL ? client : await this.session.client(pair.protocol);
				if (this.pairs.get(pair.run) !== pair || this.session.closed) {
					continue;
				}
				this.listen(pair, holder);
				// What it writes before the answer is drawn after the screen, not over or under it
				pair.terminal.pty.expectScreen();
				const { info, screen, seq } = await holder.request('attach', { run: pair.run });
				if (this.pairs.get(pair.run) !== pair || this.session.closed) {
					pair.terminal.pty.abandonScreen();
					continue;
				}
				pair.lost = false;
				pair.terminal.pty.bind(this.binding(holder, pair.run), { screen, seq });
				if (info.exited) {
					this.ended(pair, info.exited);
				} else {
					pair.status = info.status;
					pair.terminalTitle = info.title;
					this.tell(pair);
				}
			} catch (err) {
				pair.terminal.pty.abandonScreen();
				pair.events?.dispose();
				pair.events = undefined;
				this.options.log(`${pair.run} could not be shown again: ${messageOf(err)}`);
				// ptyd no longer has it - or, of an earlier protocol, went: it ended with its ptyd, how is not known (LIFECYCLE-3.5)
				if ((err instanceof PtydGone || /^No run /.test(messageOf(err))) && this.pairs.get(pair.run) === pair) {
					this.endedUnknown(pair);
				} else if (!this.session.closed) {
					complete = false;
				}
			}
		}
		return complete;
	}

	/** `pair`'s process is gone without an exit ptyd saw: told as an exit with no code (RULES-3.3: never a guessed cause). */
	private endedUnknown(pair: Pair): void {
		if (pair.exited) {
			return;
		}
		pair.exited = { exitCode: -1 };
		pair.terminal.pty.exited(vscode.l10n.t("[Agent process disconnected; exit cause unknown]"));
		this.exits.fire({ run: pair.run, interruptVerified: false });
	}

	/**
	 * Checks the runs with live processes with ptyd, at most every {@link RECONCILE_MS}: an exit missed is told (UX-5.2). Their tabs'
	 * names are read too: a terminal a person moved into the panel has no tab whose change would say its name changed (LIFECYCLE-2.2).
	 */
	private async reconcile(): Promise<void> {
		if (this.session.closed) {
			return;
		}
		for (const run of this.pendingCleanup) {
			void this.cleanup(run);
		}
		for (const run of this.pendingForget) {
			void this.forget(run);
		}
		this.terminals.observeNames();
		// Lost, and not claimed again yet: tried again now - with no run shown too, as ptyd ends an owner's runs and its claim five
		// minutes after its window is gone, and this window is not gone (RULES-4.1, D75) - and every run told as lost, whichever
		// ptyd's connection it lost. The others are checked meanwhile: one ptyd not answering holds up no other's runs
		if (this.session.needsRecovery || [...this.pairs.values()].some(pair => pair.lost && pair.process && !pair.exited)) {
			void this.reclaim();
		}
		const shown = [...this.pairs.values()].filter(pair => pair.process && !pair.exited && !pair.lost);
		const connection = this.session.current;
		// Each ptyd holding runs this window shows: its own and those of earlier protocols; once restored, its own too where it shows
		// none of them, so that a run it lists and shows no pair of is shown after all (RULES-4.1)
		const ptyds: (readonly [number, Promise<PtydClient>])[] = [
			...connection && (this.restored || shown.some(pair => pair.protocol === PTYD_PROTOCOL)) ? [[PTYD_PROTOCOL, connection] as const] : [],
			...this.session.earlierHeld.map(([protocol, client]) => [protocol, Promise.resolve(client)] as const)
		];
		const unshown: RunId[] = [];
		const listed: number[] = [];
		for (const [protocol, holder] of ptyds) {
			if (this.listing.has(protocol)) {
				continue;
			}
			const mine = shown.filter(pair => pair.protocol === protocol);
			try {
				const client = await holder;
				// What each pair heard before it asked: an event heard since - before the answer, or in the same chunk after it, its
				// continuation coming later - is at least as new as the answer, which never puts an older status or title back
				const heard = new Map(mine.map(pair => [pair, pair.heard ?? 0]));
				// One listing at a time for each ptyd, until it is answered: one that does not answer is not asked again meanwhile
				const request = client.request('list', { owner: this.options.owner });
				this.listing.add(protocol);
				void request.catch(() => undefined).finally(() => this.listing.delete(protocol));
				const runs = new Map((await within(request, RECONCILE_MS)).map(run => [run.run, run]));
				listed.push(protocol);
				for (const pair of mine) {
					const run = runs.get(pair.run);
					if (this.pairs.get(pair.run) !== pair) {
						continue;
					}
					if (!run) {
						this.endedUnknown(pair);
					} else if (run.exited) {
						this.ended(pair, run.exited);
					} else if ((pair.heard ?? 0) === heard.get(pair) && (run.status?.at !== pair.status?.at || run.title !== pair.terminalTitle)) {
						pair.status = run.status;
						pair.terminalTitle = run.title;
						this.tell(pair);
					}
				}
				// Not those being closed or forgotten: the person ended them
				const ending = (run: RunId) => this.cleanups.has(run) || this.pendingCleanup.has(run) || this.pendingForget.has(run);
				unshown.push(...[...runs.values()].filter(run => !run.claimedElsewhere && !this.pairs.has(run.run) && !ending(run.run) && isRunMeta(run.meta)).map(run => {
					if (protocol !== PTYD_PROTOCOL) {
						this.where.set(run.run, protocol);
					}
					return run.run;
				}));
			} catch {
				// The connection is being replaced, or the ptyd does not answer now: its runs are claimed again, or checked again next
			}
		}
		this.tellUnshown(unshown, listed);
	}

	/**
	 * Tells the composition root of the runs a ptyd lists that this window shows no pair of, once the first restore is over, each at
	 * most once in {@link UNSHOWN_AGAIN_MS}: it restores again, which shows each the person neither closed nor saw end (RULES-4.1).
	 */
	private tellUnshown(runs: readonly RunId[], listed: readonly number[]): void {
		const now = performance.now();
		// Shown since, or gone, by the ptyds that answered: one not listed now keeps what was told of it
		for (const run of [...this.unshownTold.keys()]) {
			if (!runs.includes(run) && listed.includes(this.protocolOf(run))) {
				this.unshownTold.delete(run);
			}
		}
		if (!this.restored || this.session.closed) {
			return;
		}
		const due = runs.filter(run => now - (this.unshownTold.get(run) ?? -Infinity) >= UNSHOWN_AGAIN_MS);
		if (due.length) {
			for (const run of due) {
				this.unshownTold.set(run, now);
			}
			this.finds.fire();
		}
	}
}
