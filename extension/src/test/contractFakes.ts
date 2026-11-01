/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fakes of everything the tool service asks of the window, for the contract's tests.

import * as assert from 'assert';
import type { Directory, DirectoryAgent, DirectoryWindow, RouteResponse } from '../base/windowNetwork';
import type { NetworkPort, RouteOp } from '../contract/network';
import { createToolService, CliFacts, InputOutcome, ScreenSnapshot, TerminalPort, ToolServiceDeps } from '../contract/tools';
import { FacadeError } from '../core/errors';
import type { InboxPage, InboxQuery, MessageRecord, Messages, SendRequest, SendResult } from '../core/messagePorts';
import { formatMessage } from '../core/messages';
import type { Agents, CleanupResult, CliChoice, LaunchRequest, Location, RunFacts, RunId, StartOutcome } from '../core/ports';
import { ChoiceStore } from '../record/choices';
import { ServedAnswer, TOOL_PROTOCOL, ToolAnswer, ToolCall } from '../schema/protocol';
import { renderFacts } from '../schema/result';
import { codePoints } from '../schema/validate';
import { tempDir } from './util';

export function runId(n: number): string {
	return `run-${n.toString(16).padStart(32, '0')}`;
}

/** A run as the agent service records it: `n` gives its ID and `#aN`. */
export function runFacts(n: number, facts: Partial<RunFacts> = {}): RunFacts {
	return {
		id: runId(n), alias: `#a${n}`, name: `agent ${n}`, cli: 'claude', displayName: 'Claude Code', command: 'claude',
		location: 'loc-1', cwd: '/work/app', environment: 'local', yolo: false, root: runId(n), origin: 'human', createdAt: 1000 + n,
		lifecycle: 'running', phase: 'running', pid: 100 + n, startedAt: 2000 + n, activity: 'not_working', reporting: true,
		tools: 'available',
		...facts
	};
}

export const LOCATION: Location = {
	id: 'loc-1', path: '/work/app', uri: 'file:///work/app', environment: 'local', label: 'app', kind: 'checkout', opened: true, git: 'ok',
	branch: 'main', isMain: true, folders: [{ index: 0, name: 'app', uri: 'file:///work/app', path: '/work/app' }]
};

export const WORKTREE: Location = { ...LOCATION, id: 'loc-wt', path: '/work/app.worktrees/fix', uri: 'file:///work/app.worktrees/fix', label: 'fix', branch: 'fix', isMain: false, opened: false };

export const CLIS: readonly CliChoice[] = [
	{ id: 'claude', displayName: 'Claude Code', available: true },
	{ id: 'codex', displayName: 'Codex', available: true },
	// A CLI that is not installed here: listed, and refused at start with why
	{ id: 'qwen', displayName: 'Qwen Code', available: false, problem: 'qwen was not found on PATH.' }
];

export const FACTS: readonly CliFacts[] = [
	{
		cli: 'claude', takes: { model: true, effort: true },
		activity: { state: 'supported', reason: 'Its hooks report activity.' },
		initialPrompt: { mapping: ['--', '${prompt}'], capability: { state: 'unverified', reason: 'A positional prompt argument, not yet verified.' } },
		input: { adapter: 'claude-frame', capability: { state: 'supported', reason: 'claude-frame reads its input by its layout.' } },
		version: { version: '2.1.314', source: '/home/u/.local/share/claude/versions/2.1.314' }
	},
	{ cli: 'codex', takes: { model: true, effort: false }, initialPrompt: { capability: { state: 'unavailable', reason: 'It maps no prompt argument.' } } },
	{ cli: 'qwen' }
];

class Deferred<T> {
	resolve!: (value: T) => void;
	readonly promise = new Promise<T>(resolve => this.resolve = resolve);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class FakeAgents implements Pick<Agents, 'launch' | 'started' | 'warmedUp' | 'close' | 'list' | 'get' | 'requested'> {
	now: () => number = Date.now;
	requested(from: RunId, requestId: string): RunFacts | undefined {
		return this.list().find(run => run.creator === from && run.requestId === requestId && run.createdAt > this.now() - 60 * 60_000);
	}
	readonly runs = new Map<RunId, RunFacts>();
	readonly launched: LaunchRequest[] = [];
	readonly closed: RunId[] = [];
	private readonly starts = new Map<RunId, Deferred<StartOutcome>>();
	private next = 100;
	launchError: Error | undefined;
	/** What each start comes to at once; undefined leaves it starting until {@link settle}. */
	startWith: StartOutcome | undefined = { state: 'running' };
	closeWith: CleanupResult | 'already_ended' | Promise<CleanupResult | 'already_ended'> = 'terminated';

	add(...runs: RunFacts[]): void {
		for (const run of runs) {
			this.runs.set(run.id, run);
		}
	}

	launch(request: LaunchRequest): RunId {
		if (this.launchError) {
			throw this.launchError;
		}
		this.launched.push(request);
		const n = this.next++;
		const facts = runFacts(n, {
			name: request.name.trim(), cli: request.cli, location: request.location, origin: request.origin, creator: request.creator?.run,
			root: request.creator?.root ?? runId(n), yolo: true, lifecycle: 'starting', phase: request.worktree ? 'creating_worktree' : 'launching_cli',
			pid: undefined, startedAt: undefined, tools: 'connecting', activity: 'unknown', reporting: false,
			...request.model !== undefined ? { model: request.model } : {}, ...request.effort !== undefined ? { effort: request.effort } : {},
			...request.requestId !== undefined ? { requestId: request.requestId } : {}
		});
		this.runs.set(facts.id, facts);
		this.starts.set(facts.id, new Deferred());
		if (this.startWith) {
			this.settle(facts.id, this.startWith);
		}
		return facts.id;
	}

	/** The start of `run` comes to `outcome`, its facts changed as they would be. */
	settle(run: RunId, outcome: StartOutcome, changes: Partial<RunFacts> = {}): void {
		const facts = this.runs.get(run);
		if (facts) {
			const next: Mutable<RunFacts> = { ...facts, ...changes };
			if (outcome.state === 'running') {
				Object.assign(next, { lifecycle: 'running', phase: 'running', pid: 4242, startedAt: 5000 });
			} else if (outcome.state === 'failed') {
				Object.assign(next, { lifecycle: 'ended', end: { kind: 'failed', at: 5000 }, error: { reason: outcome.error ?? 'failed', source: next.error?.source ?? 'launch', at: 5000 } });
			} else {
				this.runs.delete(run);
			}
			if (outcome.state !== 'closed') {
				this.runs.set(run, next);
			}
		}
		this.starts.get(run)?.resolve(outcome);
	}

	started(run: RunId): Promise<StartOutcome> {
		return this.starts.get(run)?.promise ?? Promise.resolve({ state: 'closed' });
	}

	/** What a start types before its first turn: held per run until a test settles it, settled at once otherwise. */
	readonly warmUps = new Map<RunId, Promise<void>>();

	warmedUp(run: RunId): Promise<void> {
		return this.warmUps.get(run) ?? Promise.resolve();
	}

	async close(run: RunId): Promise<CleanupResult | 'already_ended'> {
		if (!this.runs.has(run)) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${run} in this window.`);
		}
		this.closed.push(run);
		this.runs.delete(run);
		return this.closeWith;
	}

	list(): readonly RunFacts[] {
		return [...this.runs.values()];
	}

	get(run: RunId): RunFacts | undefined {
		return this.runs.get(run);
	}
}

/** The first response a send gets, by default success. */
export type SendResponse = Pick<SendResult, 'status' | 'reason' | 'obstacle'> & { readonly delivery?: MessageRecord['delivery'] };

export class FakeMessages implements Pick<Messages, 'send' | 'allocate' | 'recordPrompt' | 'report' | 'inbox' | 'markDelivered' | 'keepSent' | 'history' | 'findRequest'> {
	now: () => number = Date.now;
	readonly records: MessageRecord[] = [];
	readonly sent: SendRequest[] = [];
	readonly allocated: string[] = [];
	/** What recording a prompt throws, where it is to fail. */
	recordError: Error | undefined;
	readonly prompts: { readonly request: Omit<SendRequest, 'elapsedMs'>; readonly delivery: MessageRecord['delivery'] }[] = [];
	readonly reports: { readonly to: RunId; readonly callId?: string; readonly agent?: RunId; readonly text: string }[] = [];
	/** Each markDelivered: the read IDs a handed-back read_messages delivered (COLLABORATION-3.1). */
	readonly delivered: { readonly run: RunId; readonly ids: readonly string[] }[] = [];
	respond: (request: SendRequest) => SendResponse = () => ({ status: 'success' });
	private n = 0;

	constructor(private readonly agents: FakeAgents) { }

	private who(run: RunId | '@human' | 'facade') {
		const facts = run === '@human' || run === 'facade' ? undefined : this.agents.get(run);
		return { run, ...facts ? { alias: facts.alias, name: facts.name } : {} };
	}

	private recordOf(request: Omit<SendRequest, 'elapsedMs'>, delivery: MessageRecord['delivery'], kind: MessageRecord['kind'] = 'message'): MessageRecord {
		const n = request.id !== undefined ? Number(request.id.slice(2)) : ++this.n;
		return {
			id: `m-${n}`, alias: `#m${n}`, kind, from: this.who(kind === 'result' ? 'facade' : request.from), to: this.who(request.to), window: 'win-1', environment: 'local',
			at: 3000 + n, ...request.replyTo ? { replyTo: request.replyTo } : {}, ...request.callId ? { callId: request.callId } : {}, text: request.text, length: codePoints(request.text), delivery,
			...request.requestId !== undefined ? { requestId: request.requestId } : {}
		};
	}

	history(): readonly MessageRecord[] {
		return this.records;
	}

	findRequest(from: RunId, requestId: string): MessageRecord | undefined {
		return [...this.records, ...this.kept].find(record => record.kind === 'message' && record.from.run === from && record.requestId === requestId && record.at > this.now() - 60 * 60_000);
	}

	allocate(request: { readonly from: RunId; readonly text: string }): { readonly id: string; readonly text: string } {
		const n = ++this.n;
		this.allocated.push(`m-${n}`);
		return { id: `m-${n}`, text: formatMessage({ alias: `#m${n}`, from: this.who(request.from) as MessageRecord['from'], text: request.text }, 'Design') };
	}

	async send(request: SendRequest): Promise<SendResult> {
		this.sent.push(request);
		const response = this.respond(request);
		const delivery = response.delivery ?? (response.status === 'success'
			? { status: 'success' as const, effects: { outcome: 'confirmed' as const, text_written: 'full' as const, enter_written: true }, attempts: 1 }
			: response.status === 'accepted'
				? { status: 'pending' as const, effects: { outcome: 'pending' as const, text_written: 'none' as const, enter_written: false }, deadline: Date.UTC(2026, 9, 28, 23, 0, 15), attempts: 1 }
				: { status: 'failure' as const, ...response.reason ? { reason: response.reason } : {}, effects: { outcome: 'none' as const, text_written: 'none' as const, enter_written: false }, attempts: 0 });
		const record = this.recordOf(request, delivery);
		this.records.push(record);
		return { record, status: response.status, ...response.reason ? { reason: response.reason } : {}, ...response.obstacle ? { obstacle: response.obstacle } : {} };
	}

	recordPrompt(request: Omit<SendRequest, 'elapsedMs'>, delivery: MessageRecord['delivery']): MessageRecord {
		if (this.recordError) {
			throw this.recordError;
		}
		this.prompts.push({ request, delivery });
		const record = this.recordOf(request, delivery);
		this.records.push(record);
		return record;
	}

	report(request: { readonly to: RunId; readonly callId?: string; readonly agent?: RunId; readonly text: string }): MessageRecord {
		this.reports.push(request);
		const base = this.recordOf({ from: 'facade', to: request.to, text: request.text, ...request.callId ? { callId: request.callId } : {} }, { status: 'pending', effects: { outcome: 'pending' }, attempts: 0 }, 'result');
		const record: MessageRecord = request.agent ? { ...base, agent: this.who(request.agent) as MessageRecord['to'] & { run: RunId } } : base;
		this.records.push(record);
		return record;
	}

	/** A message from `from` already in `to`'s inbox. */
	deliver(from: RunFacts, to: RunFacts, text: string): MessageRecord {
		const record = this.recordOf({ from: from.id, to: to.id, text }, { status: 'success', effects: { outcome: 'confirmed', text_written: 'full', enter_written: true }, attempts: 1, via: 'terminal', deliveredAt: 3500 });
		this.records.push(record);
		return record;
	}

	inbox(run: RunId, query: InboxQuery): InboxPage {
		const mine = this.records.filter(record => record.to.run === run);
		if (query.ids) {
			const records: MessageRecord[] = [];
			const missing: string[] = [];
			for (const id of query.ids) {
				const found = mine.find(record => record.id === id || record.alias === id);
				if (found) {
					records.push(found);
				} else {
					missing.push(id);
				}
			}
			return { records, missing };
		}
		// One state: without IDs or `all`, what has not reached the run yet (COLLABORATION-3.1)
		const pool = query.all ? mine : mine.filter(record => record.delivery.status !== 'success');
		const start = query.cursor ? Number(query.cursor) : 0;
		const end = start + query.limit;
		return { records: pool.slice(start, end), ...end < pool.length ? { nextCursor: String(end) } : {}, missing: [] };
	}

	/** Copies of messages sent to other windows' agents, as Message History keeps them. */
	readonly kept: MessageRecord[] = [];

	keepSent(record: MessageRecord): void {
		this.kept.push(record);
	}

	markDelivered(run: RunId, ids: readonly string[]): void {
		this.delivered.push({ run, ids: [...ids] });
		this.records.forEach((record, index) => {
			if (record.to.run === run && ids.includes(record.id) && record.delivery.status !== 'success') {
				this.records[index] = { ...record, delivery: { ...record.delivery, status: 'success', via: 'read', deliveredAt: 9000 } };
			}
		});
	}

	/** A message from `from` in `to`'s inbox that its terminal did not take: failed, or still pending. */
	undelivered(from: RunFacts, to: RunFacts, text: string, status: 'failure' | 'pending' = 'failure'): MessageRecord {
		const record = this.recordOf({ from: from.id, to: to.id, text }, status === 'failure'
			? { status, reason: 'input_draft', effects: { outcome: 'none', text_written: 'none', enter_written: false }, attempts: 5 }
			: { status, effects: { outcome: 'pending', text_written: 'none', enter_written: false }, deadline: Date.UTC(2026, 9, 28, 23, 0, 15), attempts: 1 });
		this.records.push(record);
		return record;
	}
}

export class FakeTerminal implements TerminalPort {
	screen: ScreenSnapshot | undefined;
	readonly reads: { readonly run: RunId; readonly lines: number }[] = [];
	readonly typed: { readonly run: RunId; readonly text: string; readonly enter: boolean }[] = [];
	readonly pressed: { readonly run: RunId; readonly keys: readonly string[] }[] = [];
	typeWith: InputOutcome | Error = { outcome: 'applied', pasted: true, entered: true };
	keysWith: InputOutcome | Error | undefined;

	async readScreen(run: RunId, lines: number): Promise<ScreenSnapshot | undefined> {
		this.reads.push({ run, lines });
		return this.screen;
	}

	async typeText(run: RunId, text: string, enter: boolean): Promise<InputOutcome> {
		this.typed.push({ run, text, enter });
		if (this.typeWith instanceof Error) {
			throw this.typeWith;
		}
		return { ...this.typeWith, ...this.typeWith.outcome === 'applied' ? { entered: enter } : {} };
	}

	async pressKeys(run: RunId, keys: readonly string[]): Promise<InputOutcome> {
		this.pressed.push({ run, keys });
		if (this.keysWith instanceof Error) {
			throw this.keysWith;
		}
		return this.keysWith ?? { outcome: 'applied', keysSent: keys.length };
	}
}

/** A call as a test makes it: the shim's protocol and a call ID unless given. */
type TestCall = Omit<ToolCall, 'protocol' | 'elapsedMs' | 'callId'> & { readonly protocol?: unknown; readonly elapsedMs?: number; readonly callId?: string };

export interface Setup {
	/** A call's answer as handed back, what follows its handing back done. */
	readonly service: (call: TestCall, receivedAt?: number) => Promise<ToolAnswer>;
	/** A call's answer and what follows its handing back, not done yet. */
	readonly serve: (call: TestCall, receivedAt?: number) => Promise<ServedAnswer>;
	readonly call: (caller: RunFacts | RunId, tool: string, args?: unknown) => Promise<ToolAnswer>;
	readonly agents: FakeAgents;
	readonly messages: FakeMessages;
	readonly terminal: FakeTerminal;
	readonly choices: ChoiceStore;
	readonly written: { readonly home: string; readonly kind: 'messages' | 'screen'; readonly text: string; readonly ids?: readonly string[] }[];
	readonly log: string[];
	readonly dispose: () => void;
	/** The deps given, to change for one test. */
	readonly deps: { -readonly [K in keyof ToolServiceDeps]: ToolServiceDeps[K] };
	locations: readonly Location[];
	timeout: number;
}

export function setUp(): Setup {
	const agents = new FakeAgents();
	const messages = new FakeMessages(agents);
	const terminal = new FakeTerminal();
	const temp = tempDir('facade-code-contract-');
	const choices = new ChoiceStore(temp.dir);
	const written: Setup['written'][number][] = [];
	const log: string[] = [];
	let calls = 0;
	const setup = {} as { -readonly [K in keyof Setup]: Setup[K] };
	setup.locations = [LOCATION, WORKTREE];
	setup.timeout = 120;
	const deps: Setup['deps'] = {
		window: { id: 'win-1', label: 'Design', environment: 'local' },
		agents,
		locations: {
			snapshot: () => ({ locations: setup.locations, folders: LOCATION.folders, pending: false }),
			resolve: id => setup.locations.find(each => each.id === id)
		},
		clis: { list: async () => ({ clis: CLIS, problems: [] }), describe: () => ({ launches: FACTS }) },
		messages,
		terminal,
		home: temp.dir,
		writeResult: (home, kind, text, ids) => {
			written.push({ home, kind, text, ...ids ? { ids } : {} });
			return { path: `${home}/results/${kind}-${written.length}.txt`, size: Buffer.byteLength(text) };
		},
		choices,
		timeout: () => setup.timeout,
		yolo: () => true,
		clock: { now: () => Date.UTC(2026, 9, 28, 22, 0, 0) },
		// The window's own time is none unless a test moves it
		monotonic: () => 0,
		log: text => log.push(text)
	};
	agents.now = messages.now = () => deps.clock?.now() ?? Date.now();
	const service = createToolService(deps);
	const serve = (call: TestCall, receivedAt?: number) => service({ protocol: TOOL_PROTOCOL, elapsedMs: 0, callId: `call-${++calls}`, ...call } as ToolCall, receivedAt);
	const handedBack = async (served: Promise<ServedAnswer>) => {
		const { answer, delivered } = await served;
		delivered?.();
		return answer;
	};
	Object.assign(setup, {
		serve,
		service: (call: TestCall, receivedAt?: number) => handedBack(serve(call, receivedAt)),
		call: (caller: RunFacts | RunId, tool: string, args?: unknown) =>
			handedBack(serve({ caller: typeof caller === 'string' ? caller : caller.id, tool, arguments: args, elapsedMs: 7 })),
		agents, messages, terminal, choices, written, log, deps,
		dispose: temp.remove
	});
	return setup;
}

/** The answer's text heads the facts with a sentence, then lists exactly the structured result's fields (MCP-6.2). */
export function assertSameFacts(answer: ToolAnswer): void {
	const listing = renderFacts(answer.structured).join('\n');
	assert.ok(answer.text.endsWith(`\n\n${listing}`), `the text does not end in the structured facts:\n${answer.text}`);
	const headline = answer.text.slice(0, answer.text.length - listing.length - 2);
	assert.ok(headline.trim().length > 0 && !headline.includes('\n'), `the headline is one paragraph: ${JSON.stringify(headline)}`);
	const walk = (value: unknown, key: string) => {
		if (value === undefined) {
			return;
		}
		if (key) {
			assert.ok(listing.includes(`${key}:`), `${key} is not in the text`);
		}
		if (Array.isArray(value)) {
			value.forEach(each => walk(each, ''));
		} else if (value !== null && typeof value === 'object') {
			Object.entries(value).forEach(([name, each]) => walk(each, name));
		} else if (typeof value === 'string') {
			const shown = value.includes('\n') ? value.split('\n').every(line => listing.includes(line)) : listing.includes(value) || listing.includes(JSON.stringify(value));
			assert.ok(shown, `${JSON.stringify(value)} is not in the text`);
		} else {
			assert.ok(listing.includes(String(value)), `${String(value)} is not in the text`);
		}
	};
	walk(answer.structured, '');
	assert.strictEqual(answer.isError, answer.structured.status === 'failure');
}

/** The structured result of an answer, its facts checked to be the same as its text. */
export function resultOf(answer: ToolAnswer): { status: string; data: any; error?: { code: string; reason: string; message: string }; effects: any } { // eslint-disable-line @typescript-eslint/no-explicit-any
	assertSameFacts(answer);
	return answer.structured as never;
}

/** An agent of another window as its window publishes it: `n` gives its ID and `#aN`. */
export function remoteAgent(n: number, agent: Partial<DirectoryAgent> = {}): DirectoryAgent {
	return { run: runId(n), alias: `#a${n}`, name: `agent ${n}`, root: runId(n), yolo: false, cli: 'claude', lifecycle: 'running', ...agent };
}

/** A route as the fake network saw it. */
export interface Routed {
	readonly window: string;
	readonly op: RouteOp;
	readonly args: any; // eslint-disable-line @typescript-eslint/no-explicit-any
	readonly deadlineMs: number;
}

/**
 * The client network as the tool service of window `win-1` sees it: the other windows it lists, with their agents, and what each route
 * answers - by default that nothing answers.
 */
export class FakeNetwork implements NetworkPort {
	readonly self = 'win-1';
	windows: DirectoryWindow[] = [];
	unavailable: Directory['unavailable'] = [];
	directoryError: Error | undefined;
	readonly routed: Routed[] = [];
	respond: (route: Routed) => RouteResponse | Promise<RouteResponse> = () => ({ ok: false, reason: 'window_unavailable', message: 'Nothing answers in this test.', effects: 'none' });

	/** Another window, `win-N`, with `agents`. */
	window(n: number, label: string, agents: readonly DirectoryAgent[] = [], environment = 'local'): DirectoryWindow {
		const window: DirectoryWindow = { window: `win-${n}`, label, environment, agents };
		this.windows.push(window);
		return window;
	}

	async directory(): Promise<Directory> {
		if (this.directoryError) {
			throw this.directoryError;
		}
		// This window lists itself first, as its component does; its own agents are its tool service's to know
		return { self: this.self, windows: [{ window: this.self, label: 'Design', environment: 'local', agents: [] }, ...this.windows], unavailable: this.unavailable };
	}

	async route(window: string, op: RouteOp, args: unknown, deadlineMs: number): Promise<RouteResponse> {
		const route: Routed = { window, op, args, deadlineMs };
		this.routed.push(route);
		return this.respond(route);
	}
}
