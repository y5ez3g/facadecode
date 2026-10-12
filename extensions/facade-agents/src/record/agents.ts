/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isEqualPath, readLastNumber, replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { Agent, agentRef, Caller, describe, End, EndKind, Ignored, isAgentName, isLive, LedgerEventBody, LiveAgent, MadeWorktree, MAX_NAME_LENGTH, PERSON, RESERVED_NAMES, SandboxState, StartPhase, StoppedBy, WorkspaceState } from './events';
import { ClosedBy, LastClose, Ledger, LEDGER_FILE, LedgerOptions } from './ledger';
import { AgentLog, LoggedLaunch } from './log';
import { LAST_MESSAGE_FILES, MessageRecord } from './messages';

/** The person's token, in the workspace's folder: scripts that hold it act as the person. */
const YOU_TOKEN_FILE = 'you.token';
/**
 * The highest number the workspace gave, beside its ledger: a ledger moved aside - by Facade, being
 * another version's, or by the person - and begun anew counts on from it, so that no number is given twice.
 */
const LAST_ID_FILE = 'last-id';
/** What `last-id` was called before agents had numbers, the person none: read where there is no `last-id`. */
const LAST_PID_FILE = 'last-pid';
const RUNS_DIR = 'runs';
/** A file of an agent's run: `<number>.<anything>`. */
const RUN_FILE = /^(?<id>\d+)\./;

/** An agent's name, as it is given, trimmed: `clamp`. Throws with why one is no name - `@clamp` and `Clamp` among them. */
export function agentName(text: string): string {
	// Taken as it is given: one that is no name is refused, rather than made one
	const name = text.trim();
	if (RESERVED_NAMES.has(name)) {
		throw new Error(`"${name}" is reserved: choose another name.`);
	}
	if (!isAgentName(name)) {
		throw new Error(`"${text}" is not a name: use up to ${MAX_NAME_LENGTH} lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	return name;
}

/** The name an agent gets from its worktree when it is given none: `feature/Clamp` gives `feature-clamp`. */
export function nameOfWorktree(worktree: string): string {
	const name = worktree.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, MAX_NAME_LENGTH).replace(/[^a-z0-9]+$/, '');
	return isAgentName(name) ? name : 'agent';
}

/** Where a workspace's agents are recorded, and what tests replace of the ledger's. */
export interface AgentTableOptions extends LedgerOptions {
	/** The workspace's folder under `~/.facade/workspaces`. */
	readonly dir: string;
}

/** An agent to start: who it is, who starts it, how, where it works, and its task. */
export interface NewAgent {
	readonly name: string;
	/** The agent that starts it; none for the person. */
	readonly creator?: number;
	readonly cli: string;
	readonly custom: boolean;
	/** As its creator asked for them; none where it asked for none. */
	readonly model?: string;
	readonly effort?: string;
	/** What it was asked for that its launch has no group for. */
	readonly ignored: readonly Ignored[];
	readonly yolo: boolean;
	/** Started through `start_agent`, where nobody may be watching it (L4). */
	readonly unattended?: boolean;
	readonly sandbox: SandboxState;
	readonly integration: boolean;
	readonly worktree: string;
	/** Its folder is in no Git repository (N-05). */
	readonly outsideGit?: boolean;
	readonly folder: string;
	/** Where its start begins: making its worktree, or launching its CLI. */
	readonly phase?: StartPhase;
}

/** An agent just started, and the token it calls Facade with. */
export interface StartedAgent {
	readonly agent: Agent;
	readonly token: string;
	/** The file its MCP server reads the token from. */
	readonly tokenFile: string;
}

/**
 * A workspace's agents as its ledger records them, and the tokens they call Facade with. Each agent's
 * token is in a file of its run, which its MCP server reads; the ledger keeps only its hash. The
 * person's token is in `you.token`. Every file is readable by the user only.
 */
export class AgentTable {

	private personToken = '';
	/** The highest number given, as `last-id` says it: a ledger begun anew counts on from it. */
	private lastId = 0;
	/** The person's history: each start and each end. */
	private readonly log: AgentLog;
	/** The workspace's messages, which its ledger records too (AGENT-MESSAGES.md). */
	readonly messages: MessageRecord;

	/** Hears each change of the record as it is written: an agent starting, moving on, or ending. */
	onDidChange(listener: () => void): { dispose(): void } {
		return this.ledger.onDidAppend(() => listener());
	}

	private constructor(private readonly options: AgentTableOptions, private readonly ledger: Ledger) {
		this.log = AgentLog.of(options.dir);
		this.messages = new MessageRecord(options.dir, ledger);
	}

	/** Opens a workspace's ledger, making it the first time. */
	static open(options: AgentTableOptions): AgentTable {
		const ledger = Ledger.open(options.dir, options);
		let table: AgentTable;
		try {
			table = new AgentTable(options, ledger);
			table.personToken = readOrCreateToken(path.join(options.dir, YOU_TOKEN_FILE));
			table.lastId = readLastNumber(path.join(options.dir, LAST_ID_FILE)) || readLastNumber(path.join(options.dir, LAST_PID_FILE));
		} catch (err) {
			ledger.close('facade');
			throw err;
		}
		table.removeRunFiles(id => !isLive(table.state.agents.get(id)));
		return table;
	}

	/** What the ledger says now. */
	get state(): WorkspaceState {
		return this.ledger.state;
	}

	/**
	 * How the window that had the workspace's ledger before let go of it - as it went: quit, closed or
	 * reloaded; or as Facade let go of its agents while it stayed - and which window that was; undefined
	 * after a crash, or the first time.
	 */
	get lastClose(): LastClose | undefined {
		return this.ledger.lastClose;
	}

	/** The workspace's folder under `~/.facade/workspaces`. */
	get dir(): string {
		return this.options.dir;
	}

	/** Where each agent's token and launch files go. */
	get runsDir(): string {
		return path.join(this.options.dir, RUNS_DIR);
	}

	/** The person's history of the workspace's agents. */
	get logFile(): string {
		return this.log.file;
	}

	/** Who started or stopped an agent, as Facade's words name them: `@lead #a1`, `@human`; a number alone for one the list no longer has. */
	whoIs(who: StoppedBy | undefined): string {
		if (who === undefined || who === 'human') {
			return describe(PERSON);
		}
		const agent = this.state.agents.get(who);
		return agent ? describe(agent) : agentRef(who);
	}

	/**
	 * Closes the ledger, for this window's reload or the next window to open it: as the window goes, or as
	 * Facade lets go of its agents while the window stays.
	 */
	dispose(by: ClosedBy = 'window'): void {
		this.ledger.close(by);
	}

	/** The person, or the agent that has not exited, that a token belongs to. */
	authenticate(token: string): Caller | undefined {
		if (token === this.personToken) {
			return PERSON;
		}
		const id = this.state.tokens.get(hashToken(token));
		const agent = id === undefined ? undefined : this.state.agents.get(id);
		return isLive(agent) ? { id: agent.id, name: agent.name } : undefined;
	}

	/** The agent numbered `id`, exited or not. */
	get(id: number): Agent | undefined {
		return this.state.agents.get(id);
	}

	/** The agents that have not exited and are called `name`. */
	liveNamed(name: string): LiveAgent[] {
		return [...this.state.agents.values()].filter((agent): agent is LiveAgent => isLive(agent) && agent.name === name);
	}

	/** The agents the agent `id` started - the person, for none - that have not ended, oldest first. */
	childrenOf(id: number | undefined): LiveAgent[] {
		return [...this.state.agents.values()].filter((agent): agent is LiveAgent => isLive(agent) && agent.creator === id);
	}

	/** The agents that have not ended and are called `name` among `agents`, ended ones being taken by number. */
	static liveNamedIn(agents: readonly Agent[], name: string): LiveAgent[] {
		return agents.filter((agent): agent is LiveAgent => isLive(agent) && agent.name === name);
	}

	/** The file the plan of the launch of the agent `id` is in: what its terminal runs, and its delays. */
	launchFileOf(id: number): string {
		return path.join(this.runsDir, `${id}.launch.json`);
	}

	/**
	 * Records a new agent under the next number, and writes its token. Nothing is written once the ledger is
	 * closed or another window's: the number may be one that window gave. Its task is a message, sent once it
	 * is recorded (AGENT-MESSAGES.md, M7).
	 */
	start(agent: NewAgent): StartedAgent {
		const name = agentName(agent.name);
		this.ledger.assertOpen();
		const id = Math.max(this.state.lastId, this.lastId) + 1;
		// Given before it is recorded: a number the ledger missed is never given again either
		replaceFile(path.join(this.options.dir, LAST_ID_FILE), String(id));
		this.lastId = id;
		const token = crypto.randomBytes(32).toString('base64url');
		const tokenFile = path.join(this.runsDir, `${id}.token`);
		fs.mkdirSync(this.runsDir, { recursive: true });
		fs.writeFileSync(tokenFile, token, { mode: 0o600 });
		const creator = agent.creator === undefined ? undefined : this.state.agents.get(agent.creator);
		const event: LedgerEventBody = {
			type: 'agent.started',
			id,
			name,
			...(agent.creator !== undefined ? { creator: agent.creator, root: creator?.root ?? agent.creator } : {}),
			cli: agent.cli,
			...(agent.custom ? { custom: true } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
			...(agent.effort !== undefined ? { effort: agent.effort } : {}),
			...(agent.ignored.length ? { ignored: agent.ignored } : {}),
			yolo: agent.yolo,
			...(agent.unattended ? { unattended: true as const } : {}),
			sandbox: agent.sandbox,
			integration: agent.integration,
			// Never empty: a ledger before this build read an empty one as no event (X-13)
			worktree: agent.worktree || path.basename(agent.folder) || agent.folder,
			...(agent.outsideGit ? { outsideGit: true as const } : {}),
			folder: agent.folder,
			tokenHash: hashToken(token),
			...(agent.phase !== undefined ? { phase: agent.phase } : {})
		};
		try {
			this.ledger.append(event);
		} catch (err) {
			// Not recorded: its token goes too, rather than lie about for a number nobody has (X-75)
			fs.rmSync(tokenFile, { force: true });
			throw err;
		}
		const started = this.state.agents.get(id);
		if (!started) {
			throw new Error(`The ledger did not record ${agentRef(id)}.`);
		}
		this.log.started(started, this.whoIs(started.creator));
		return { agent: started, token, tokenFile };
	}

	/** Writes into the person's history what goes into an agent's terminal, and what went in (AGENT-DEBUGGING.md, D9). */
	auditInput(what: string): void {
		this.log.input(Date.now(), what);
	}

	/** Records that a starting agent's start moved on: to `phase`, its worktree made in `folder` where one was. */
	phase(id: number, phase: StartPhase, folder?: string): void {
		if (this.state.agents.get(id)?.state === 'starting') {
			this.ledger.append({ type: 'agent.phase', id, phase, ...(folder !== undefined ? { folder } : {}) });
		}
	}

	/** Writes into the person's history what agent `id`'s terminal is to run, as its launch has it (UI-14). */
	launching(id: number, launch: LoggedLaunch): void {
		const agent = this.state.agents.get(id);
		if (agent) {
			this.log.launched(agent, launch, Date.now());
		}
	}

	/** Records the process of an agent's CLI, once its terminal runs it. */
	launched(id: number, processId: number): void {
		if (isLive(this.state.agents.get(id))) {
			this.ledger.append({ type: 'agent.launched', id, processId });
		}
	}

	/** Records that an agent's MCP server said hello to Facade. */
	connected(id: number): void {
		const agent = this.state.agents.get(id);
		if (isLive(agent) && !agent.connected) {
			this.ledger.append({ type: 'agent.connected', id });
			this.log.connected(agent, Date.now());
		}
	}

	/** Records that a starting agent has started, and runs. */
	running(id: number): void {
		const agent = this.state.agents.get(id);
		if (agent?.state === 'starting') {
			this.ledger.append({ type: 'agent.running', id });
			this.log.running(agent, Date.now());
		}
	}

	/** Records that Facade set out to stop an agent - by whom, and why - until its process has ended. */
	stopping(id: number, reason: string, by?: StoppedBy): void {
		const agent = this.state.agents.get(id);
		if (agent?.state === 'starting' || agent?.state === 'running') {
			this.ledger.append({ type: 'agent.stopping', id, ...(by !== undefined ? { by } : {}), reason });
		}
	}

	/**
	 * Records how an agent ended - by whom, where someone stopped it, and with its CLI's exit code where it
	 * is known - and removes its run files; answers with its end, or undefined for one that had ended already.
	 */
	end(id: number, kind: EndKind, reason: string, details: { readonly by?: StoppedBy; readonly exitCode?: number } = {}): End | undefined {
		if (!isLive(this.state.agents.get(id))) {
			return undefined;
		}
		this.ledger.append({ type: 'agent.ended', id, kind, ...(details.by !== undefined ? { by: details.by } : {}), reason, ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}) });
		this.removeRunFiles(each => each === id);
		const agent = this.state.agents.get(id);
		if (agent?.end) {
			this.log.ended(agent, agent.end, agent.end.by === undefined ? undefined : this.whoIs(agent.end.by));
		}
		return agent?.end;
	}

	/**
	 * Begins a new list, as a window starts that is not a reload: the agents that ended leave it, but for the
	 * creators of agents that have not, and their mailboxes are emptied; numbers go on.
	 */
	clearList(): void {
		this.ledger.append({ type: 'list.cleared' });
	}

	/** Records a worktree Facade made for an agent. */
	recordWorktree(worktree: MadeWorktree): void {
		this.ledger.append({ type: 'worktree.made', ...worktree });
	}

	/** Records that a worktree Facade made is gone; nothing for a folder Facade did not make. */
	forgetWorktree(folder: string): void {
		if ([...this.state.worktrees.keys()].some(made => isEqualPath(made, folder))) {
			this.ledger.append({ type: 'worktree.gone', folder });
		}
	}

	/** The worktree Facade made at `folder`, if it did. */
	madeWorktree(folder: string): MadeWorktree | undefined {
		return [...this.state.worktrees.values()].find(made => isEqualPath(made.folder, folder));
	}

	/** Removes the run files of the agents `exited` names; a file that is in use stays for the next opening. */
	private removeRunFiles(exited: (id: number) => boolean): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.runsDir);
		} catch {
			return;
		}
		for (const name of names) {
			const id = RUN_FILE.exec(name)?.groups?.id;
			if (id !== undefined && exited(Number(id))) {
				try {
					fs.rmSync(path.join(this.runsDir, name), { recursive: true, force: true });
				} catch {
					// Held open for a moment on Windows.
				}
			}
		}
	}
}

/** The ledger keeps a token's hash, never the token. */
function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The person's token: made the first time, and written in one step. One that cannot be read is not
 * replaced - the scripts that hold it would no longer be the person's - and opening fails with why.
 */
function readOrCreateToken(file: string): string {
	try {
		const token = fs.readFileSync(file, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch (err) {
		if (codeOf(err) !== 'ENOENT') {
			throw err;
		}
	}
	const token = crypto.randomBytes(32).toString('base64url');
	replaceFile(file, token);
	return token;
}

/** The highest numbers a record gave: of its agents, and of its messages. */
export interface NumberedUpTo {
	readonly agents: number;
	readonly messages: number;
}

/**
 * The highest numbers the record in `dir` gave: of its agents, by its `last-id` - or `last-pid` - or its
 * ledger, where that says more; of its messages, by its `last-message` - or the file of the build before
 * messages - or its ledger. 0 for none.
 */
export function numberedUpTo(dir: string): NumberedUpTo {
	let agents = Math.max(readLastNumber(path.join(dir, LAST_ID_FILE)), readLastNumber(path.join(dir, LAST_PID_FILE)));
	let messages = Math.max(...LAST_MESSAGE_FILES.map(file => readLastNumber(path.join(dir, file))));
	let text = '';
	try {
		text = fs.readFileSync(path.join(dir, LEDGER_FILE), 'utf8');
	} catch {
		// No ledger: the files say it all
	}
	const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
	for (const line of text.split('\n')) {
		try {
			const event: unknown = JSON.parse(line);
			if (!isJsonObject(event) || typeof event.type !== 'string') {
				continue;
			}
			if (event.type.startsWith('agent.') && isNumber(event.id)) {
				agents = Math.max(agents, event.id);
			}
			if (event.type === 'message.sent' && isNumber(event.id)) {
				messages = Math.max(messages, event.id);
			}
			if (event.type === 'agent.started' && isNumber(event.taskMessage)) {
				messages = Math.max(messages, event.taskMessage);
			}
		} catch {
			// A line cut short, or none: nothing to count
		}
	}
	return { agents, messages };
}

/**
 * Has the record in `dir` count on from `reached`: no number up to it is given again - of an agent
 * (AGENT-LAUNCHER.md, L2; X-49), nor of a message (AGENT-MESSAGES.md, M10).
 */
export function countOnFrom(dir: string, reached: NumberedUpTo): void {
	if (reached.agents > readLastNumber(path.join(dir, LAST_ID_FILE))) {
		fs.mkdirSync(dir, { recursive: true });
		replaceFile(path.join(dir, LAST_ID_FILE), String(reached.agents));
	}
	if (reached.messages > readLastNumber(path.join(dir, LAST_MESSAGE_FILES[0]))) {
		fs.mkdirSync(dir, { recursive: true });
		replaceFile(path.join(dir, LAST_MESSAGE_FILES[0]), String(reached.messages));
	}
}
