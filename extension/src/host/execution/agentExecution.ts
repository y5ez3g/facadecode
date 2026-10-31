/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { PtydClient, PtydLost, PtydNotSent, ptydSocketPath } from './ptydClient';

/** How long a CLI has to end on the hang-up before ptyd kills its process group (LIFECYCLE-4.2): no UI waits for it. */
const GRACE_MS = 3_000;

/** How long restoring waits for one terminal to open before it restores the next: VS Code can leave a terminal unopened. */
const OPEN_WAIT_MS = 10_000;

/** The size a run starts at where its terminal has not told its own yet: the CLI redraws as the terminal's arrives. */
const START_COLUMNS = 120;
const START_ROWS = 30;

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
	facts: PairFacts;
	readonly terminal: AgentTerminal;
	readonly lifetime: AbortController;
	/** Spawn was sent, but its outcome is not known yet. Closure must reconcile it even before a PID is returned. */
	starting?: boolean;
	/** The CLI whose adapter reads its reports and exit. */
	cli: string;
	process?: { readonly pid: number; readonly startedAt: number };
	exited?: RunExit;
	status?: RunStatus;
	terminalTitle: string;
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
	/** Each run's cleanup, started once by whichever of removePair and terminate comes first (LIFECYCLE-3.1). */
	private readonly cleanups = new Map<RunId, Promise<CleanupResult>>();
	private readonly pendingCleanup = new Set<RunId>();
	private readonly reports = new Emitter<ActivityReport>();
	private readonly exits = new Emitter<ExitReport>();
	private readonly activations = new Emitter<RunId | undefined>();
	private readonly closes = new Emitter<RunId>();
	private readonly tabRenames = new Emitter<{ readonly run: RunId; readonly name: string }>();
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
	private readonly terminals: AgentTerminals;
	private readonly session: ExecutionSession;

	constructor(private readonly options: AgentExecutionOptions) {
		// Acquire the activation claim before subscribing any editor resources.
		this.session = new ExecutionSession({
			...options,
			connectionLost: () => this.connectionLost(),
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
				renamed: (run, name) => this.tabRenames.fire({ run, name })
			});
		} catch (err) {
			this.session.dispose();
			throw err;
		}
	}

	openPair(facts: PairFacts, options: { readonly reveal: boolean }): void {
		if (this.pairs.has(facts.run)) {
			return;
		}
		this.create(facts, options.reveal);
	}

	/** The initial restoration batch is complete; a recreated local registry may retire its predecessor's UI resources. */
	finishRestore(): Promise<void> {
		return this.terminals.finishRestore();
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
		const runs = await this.ask('list', {});
		return runs.filter(run => !run.exited).map(run => run.run);
	}

	/** The bottom `lines` logical lines of `run`'s screen (MCP-5.1). */
	readScreen(run: RunId, lines: number): Promise<ScreenRead> {
		return this.ask('read', { run, lines });
	}

	/**
	 * Pastes `text` into `run`'s terminal, then Enter where asked, in turn with its other automated input (MCP-5.2). Rejects with
	 * {@link PtydNotSent} where nothing reached ptyd, {@link PtydLost} where its answer was lost and the effects are not known.
	 */
	typeText(run: RunId, text: string, enter: boolean): Promise<InputEffect> {
		return this.ask('type', { run, text, enter });
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
		let client: PtydClient;
		try {
			client = await this.session.client();
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
		const pair = this.pairs.get(run);
		if (!pair) {
			throw new Error('The agent was closed before its CLI started.');
		}
		let client = await this.session.client();
		if (this.pairs.get(run) !== pair || this.session.closed) {
			throw new Error('The agent was closed before its CLI started.');
		}
		pair.cli = plan.cli;
		this.listen(pair, client);
		const size = pair.terminal.pty.dimensions;
		let info: RunInfo;
		let snapshot: { readonly screen: string; readonly seq: number } | undefined;
		pair.starting = true;
		try {
			info = await client.request('spawn', {
				run, owner: this.options.owner, file: plan.executable, args: plan.args, cwd: plan.cwd, env: plan.env,
				cols: size?.columns ?? START_COLUMNS, rows: size?.rows ?? START_ROWS, meta: { ...meta }
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
		}
		if (this.pairs.get(run) !== pair) {
			// Closed while it started: it ends at once, unseen (RULES-5.2)
			void this.cleanup(run);
			throw new Error('The agent was closed before its CLI started.');
		}
		pair.process = { pid: info.pid, startedAt: info.startedAt };
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
				const attached = await client.request('attach', { run: pair.run });
				return { client, attached };
			} catch (err) {
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
		// VS Code opens a background pseudoterminal lazily, ignoring name events until then. Its initial tab name must include
		// the restored CLI title, so create the native terminal after the attach snapshot has supplied it (LIFECYCLE-2.2).
		const pair = this.pairs.get(live.run) ?? this.create(facts, false, true);
		pair.cli = live.meta.cli;
		let client: PtydClient;
		let attached: { readonly info: RunInfo; readonly screen: string; readonly seq: number };
		try {
			client = await this.session.client();
			if (this.pairs.get(live.run) !== pair || this.session.closed) {
				throw new Error('The agent was closed while reattaching.');
			}
			this.listen(pair, client);
			// Claimed now, so that this window hears the run from here on; its screen is drawn as the terminal opens
			attached = await client.request('attach', { run: live.run });
		} catch (err) {
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
		pair.exited = info.exited;
		pair.status = info.status;
		pair.terminalTitle = info.title;
		pair.terminal.pty.bind(this.binding(client, live.run), { screen, seq });
		if (info.exited) {
			pair.terminal.pty.exited(this.endLine(info.exited));
		}
		this.tell(pair);
		pair.terminal.open(false);
		// Opening another editor terminal before this one's xterm is ready can detach its container and prevent VS Code
		// from ever opening its pseudoterminal. Restore the next run only after this native terminal is ready.
		const opened = await Promise.race([pair.terminal.pty.ready, timeout(OPEN_WAIT_MS).then(() => undefined)]);
		if (opened === false || this.pairs.get(live.run) !== pair) {
			throw new Error('The agent was closed while reattaching.');
		}
		if (opened === undefined) {
			// Its card and process are kept; its terminal draws the run's screen once VS Code opens it
			this.options.log(`The terminal of ${live.run} did not open within ${OPEN_WAIT_MS / 1000} seconds; the agents after it are restored meanwhile.`);
		}
	}

	terminate(run: RunId): Promise<CleanupResult> {
		return this.cleanup(run);
	}

	removePair(run: RunId): void {
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
		void this.session.client().then(client => client.request('setMeta', { run, meta: { ...meta } })).catch(err => this.options.log(`Could not keep the new details of ${run} with its process: ${messageOf(err)}`));
	}

	async live(): Promise<readonly LiveRun[]> {
		const client = await this.session.client();
		const runs = await client.request('list', { owner: this.options.owner });
		return runs.filter(run => isRunMeta(run.meta)).map(run => ({
			run: run.run,
			meta: run.meta as unknown as RunMeta,
			pid: run.pid,
			startedAt: run.startedAt,
			...(run.exited ? { exited: this.exitOf(String(run.meta.cli), run.exited) } : {}),
			claimedElsewhere: run.claimedElsewhere
		}));
	}

	async endWindow(): Promise<void> {
		const client = await this.session.client();
		const ended = await client.request('endWindow', { owner: this.options.owner, graceMs: GRACE_MS });
		this.options.log(`Ending ${ended} agent processes: their window closed.`);
	}

	dispose(): void {
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
	}

	/** Each run owns its abort scope and a terminal resource; the native tab may wait for an attach snapshot. */
	private create(facts: PairFacts, reveal: boolean, deferTerminal = false): Pair {
		const terminal = this.terminals.create(facts, reveal);
		const pair: Pair = {
			run: facts.run, facts, terminal, lifetime: new AbortController(), cli: facts.cli, terminalTitle: ''
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
				this.tell(pair);
				break;
			case 'status':
				pair.status = event.status;
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
		if (!pair.process || pair.exited) {
			return;
		}
		const reason = facts.unknown === 'not_reporting'
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

	/** The title `pair`'s CLI gives its tab now (CLIS-2.3). */
	private titleOf(pair: Pair): string | undefined {
		return cliTitle(pair.cli, pair.facts.displayName, { reported: pair.status?.title, terminal: pair.terminalTitle }, { cwd: pair.facts.cwd, name: pair.facts.name });
	}

	/** Ends `run`'s process in the background, once, and forgets it: the actual result for whoever asks (LIFECYCLE-3.1, 4.2). */
	private cleanup(run: RunId): Promise<CleanupResult> {
		let cleanup = this.cleanups.get(run);
		if (!cleanup) {
			cleanup = this.session.client().then(
				client => client.request('terminate', { run, graceMs: GRACE_MS }).then(
					result => result,
					err => err instanceof PtydLost || err instanceof PtydNotSent ? 'unconfirmed' as const : /^No run /.test(messageOf(err)) ? 'already_exited' as const : 'failed' as const),
				() => 'unconfirmed' as const);
			cleanup = cleanup.then(result => {
				if (result === 'terminated' || result === 'already_exited') {
					this.pendingCleanup.delete(run);
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
			await (await this.session.client()).request('forget', { run });
		} catch (err) {
			this.options.log(`Could not let ptyd forget ${run}: ${messageOf(err)}`);
		}
	}

	private transferred(): void {
		this.pendingCleanup.clear();
		for (const run of [...this.pairs.keys()]) {
			this.detachPair(run);
		}
		this.options.log('This activation no longer owns the workspace: its UI detached without ending any process.');
		this.transfers.fire();
	}

	/**
	 * The connection to ptyd is lost: what each live run's CLI reports is not heard until it is claimed again, so its activity is not
	 * known meanwhile, and its card says why (RULES-3.1, 3.2).
	 */
	private connectionLost(): void {
		const reason = vscode.l10n.t("The connection to the agent's process was lost; reconnecting");
		for (const pair of this.pairs.values()) {
			if ((!pair.process && !pair.starting) || pair.exited) {
				continue;
			}
			const facts = activityOf(pair.status);
			const title = this.titleOf(pair);
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

	/** Capture the live runs before connecting, then restore that batch without replaying any starts. */
	private reclaim(): Promise<void> {
		const shown = [...this.pairs.values()].filter(pair => pair.process && !pair.exited);
		return this.session.recover(shown.length > 0, client => this.restore(shown, client));
	}

	private async restore(shown: readonly Pair[], client: PtydClient): Promise<boolean> {
		let complete = true;
		for (const pair of shown) {
			if (this.pairs.get(pair.run) !== pair || this.session.closed) {
				continue;
			}
			this.listen(pair, client);
			try {
				const { info, screen, seq } = await client.request('attach', { run: pair.run });
				if (this.pairs.get(pair.run) !== pair || this.session.closed) {
					continue;
				}
				pair.terminal.pty.bind(this.binding(client, pair.run), { screen, seq });
				if (info.exited) {
					this.ended(pair, info.exited);
				} else {
					pair.status = info.status;
					pair.terminalTitle = info.title;
					this.tell(pair);
				}
			} catch (err) {
				pair.events?.dispose();
				pair.events = undefined;
				this.options.log(`${pair.run} could not be shown again: ${messageOf(err)}`);
				// ptyd no longer has it: it ended with its ptyd, how is not known (LIFECYCLE-3.5)
				if (/^No run /.test(messageOf(err)) && this.pairs.get(pair.run) === pair) {
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
		this.terminals.observeNames();
		const shown = [...this.pairs.values()].filter(pair => pair.process && !pair.exited);
		if (!shown.length) {
			return;
		}
		const connection = this.session.current;
		if (!connection || this.session.needsRecovery) {
			// Lost, and not claimed again yet: tried again now
			if (this.session.needsRecovery && !this.session.closed) {
				void this.reclaim();
			}
			return;
		}
		try {
			const client = await connection;
			const runs = new Map((await client.request('list', { owner: this.options.owner })).map(run => [run.run, run]));
			for (const pair of shown) {
				const run = runs.get(pair.run);
				if (this.pairs.get(pair.run) !== pair) {
					continue;
				}
				if (!run) {
					this.endedUnknown(pair);
				} else if (run.exited) {
					this.ended(pair, run.exited);
				} else if (run.status?.at !== pair.status?.at || run.title !== pair.terminalTitle) {
					pair.status = run.status;
					pair.terminalTitle = run.title;
					this.tell(pair);
				}
			}
		} catch {
			// The connection is being replaced: its runs are claimed again
		}
	}
}
