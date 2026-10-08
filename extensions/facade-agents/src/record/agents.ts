/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isEqualPath, readLastNumber, replaceFile } from '../base/files';
import { Agent, Caller, Exit, ExitKind, isAgentName, isLive, LiveAgent, MadeWorktree, MAX_NAME_LENGTH, parentOf, PERSON, RESERVED_NAMES, WorkspaceState } from './events';
import { ClosedBy, LastClose, Ledger, LedgerOptions } from './ledger';
import { HUMAN, MessageRecord } from './messages';

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

/**
 * An agent's name as given - `@clamp` or `Clamp` - in its form: lower case, without the `@`. Throws with
 * why one is no name. `human` is the person's, as messages name them, though a ledger may have an agent of
 * it from before.
 */
export function agentName(text: string): string {
	const name = text.trim().replace(/^@/, '').toLowerCase();
	if (RESERVED_NAMES.has(name) || name === HUMAN) {
		throw new Error(`"${name}" is reserved: choose another name.`);
	}
	if (!isAgentName(name)) {
		throw new Error(`"${text}" is not a name: use up to ${MAX_NAME_LENGTH} letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	return name;
}

/** The name an agent gets from its worktree when it is given none: `feature/Clamp` gives `feature-clamp`. */
export function nameOfWorktree(worktree: string): string {
	const name = worktree.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, MAX_NAME_LENGTH).replace(/[^a-z0-9]+$/, '');
	return isAgentName(name) && name !== HUMAN ? name : 'agent';
}

/** Where a workspace's agents are recorded, and what tests replace of the ledger's. */
export interface AgentTableOptions extends LedgerOptions {
	/** The workspace's folder under `~/.facade/workspaces`. */
	readonly dir: string;
}

/** An agent to start: who it is, who starts it, and where it works. */
export interface NewAgent {
	readonly name: string;
	/** The agent that starts it; none for the person. */
	readonly parent?: number;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	/** Whether its CLI starts with full access: its YOLO, for good. */
	readonly yolo: boolean;
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

	private constructor(private readonly options: AgentTableOptions, private readonly ledger: Ledger, readonly messages: MessageRecord) { }

	/** Opens a workspace's ledger, making it the first time. */
	static open(options: AgentTableOptions): AgentTable {
		const ledger = Ledger.open(options.dir, options);
		let table: AgentTable;
		try {
			table = new AgentTable(options, ledger, new MessageRecord(options.dir, ledger));
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

	/** An agent's parent now: none, the person, once the agent that started it has exited. */
	parentOf(agent: Agent): number | undefined {
		return parentOf(this.state, agent);
	}

	/** The children of the agent `id` - of the person, for none - that have not exited, oldest first. */
	childrenOf(id: number | undefined): LiveAgent[] {
		return [...this.state.agents.values()].filter((agent): agent is LiveAgent => isLive(agent) && this.parentOf(agent) === id);
	}

	/**
	 * Records a new agent under the next number, and writes its token. Nothing is written once the ledger
	 * is closed or another window's: the number may be one that window gave.
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
		this.ledger.append({
			type: 'agent.started',
			id,
			name,
			...(agent.parent !== undefined ? { parent: agent.parent } : {}),
			cli: agent.cli,
			model: agent.model,
			effort: agent.effort,
			worktree: agent.worktree,
			folder: agent.folder,
			yolo: agent.yolo,
			tokenHash: hashToken(token)
		});
		const started = this.state.agents.get(id);
		if (!started) {
			throw new Error(`The ledger did not record #${id}.`);
		}
		return { agent: started, token, tokenFile };
	}

	/** Records that a starting agent is running: its MCP server said hello. */
	setRunning(id: number): void {
		if (this.state.agents.get(id)?.state === 'starting') {
			this.ledger.append({ type: 'agent.running', id });
		}
	}

	/**
	 * Records that the list starts again, as a window starts that is not a reload: the mailboxes of the
	 * agents that exited are emptied; numbers go on.
	 */
	clearList(): void {
		this.ledger.append({ type: 'list.cleared' });
	}

	/** Records how an agent exited, and removes its run files; answers with its exit, or undefined for one that had exited already. */
	setExited(id: number, kind: ExitKind, reason: string): Exit | undefined {
		if (!isLive(this.state.agents.get(id))) {
			return undefined;
		}
		this.ledger.append({ type: 'agent.exited', id, kind, reason });
		this.removeRunFiles(each => each === id);
		return this.state.agents.get(id)?.exit;
	}

	/** Records a worktree Facade made for a child. */
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
