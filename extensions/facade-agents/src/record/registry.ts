/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentState, Caller, DeliveryWay, LedgerEvent, MadeWorktree, Message, WorkspaceState, YOU } from './events';
import { Ledger } from './ledger';
import { agentName, MAX_NAME_CHARS, nameOfWorktree } from './names';

export const YOU_TOKEN_FILE = 'you.token';
/** Each incarnation's files: its token, and what its CLI's launch writes. */
const RUNS_DIR = 'runs';

/** The person, as a caller. */
export const PERSON: Caller = { name: YOU, incarnation: 0 };

export interface RegistryOptions {
	/** The workspace's folder under `~/.facade/workspaces`. */
	readonly dir: string;
	readonly now?: () => number;
	readonly isAlive?: (pid: number) => boolean;
}

export interface NewAgent {
	readonly name: string;
	/** The CLI, as `claude`. */
	readonly cli: string;
	readonly model: string;
	readonly worktree: string;
	readonly folder: string;
	readonly parent: string;
}

/** A new incarnation, as its launch needs it. */
export interface AddedAgent {
	readonly name: string;
	readonly incarnation: number;
	/** `<name>-<incarnation>`: names its files in the run folder. */
	readonly slug: string;
	readonly token: string;
	/** Where its MCP server reads the token. */
	readonly tokenFile: string;
}

/**
 * A workspace's agents as its ledger records them (WORKTREE-AGENTS.md, section 10), and the tokens
 * they call Facade with: one per incarnation, in a file of its run folder that its MCP server reads,
 * and its hash in the ledger, so that a reload keeps it. The person has a token too, in `you.token`:
 * with it a script acts as the person does. Every token file is readable only by the user.
 */
export class AgentRegistry {

	private youTokenValue = '';
	private disposed = false;

	private constructor(private readonly options: RegistryOptions, private readonly ledger: Ledger) { }

	/** Opens a workspace's ledger, making it the first time, and the person's token. */
	static open(options: RegistryOptions): AgentRegistry {
		const ledger = Ledger.open(options.dir, options.now ?? Date.now, options.isAlive);
		const registry = new AgentRegistry(options, ledger);
		try {
			registry.youTokenValue = readOrMakeToken(path.join(options.dir, YOU_TOKEN_FILE));
		} catch (err) {
			registry.dispose();
			throw err;
		}
		return registry;
	}

	get state(): WorkspaceState {
		return this.ledger.state;
	}

	get dir(): string {
		return this.options.dir;
	}

	get runsDir(): string {
		return path.join(this.options.dir, RUNS_DIR);
	}

	/** The person's token, for scripts that act as the person. */
	get youToken(): string {
		return this.youTokenValue;
	}

	onDidAppend(listener: (event: LedgerEvent) => void): { dispose(): void } {
		return this.ledger.onDidAppend(listener);
	}

	dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.ledger.close();
		}
	}

	/** Who holds a token, if it is still good. */
	authenticate(token: string): Caller | undefined {
		if (token === this.youTokenValue) {
			return PERSON;
		}
		return this.state.tokens.get(hashToken(token));
	}

	agent(name: string): Agent | undefined {
		return this.state.agents.get(name);
	}

	/**
	 * The name an agent started in a worktree takes: the worktree's own, then `<worktree>-2`, `-3`
	 * while the ones before run (WA-4.2). A name whose agent has stopped is taken again, by a new
	 * incarnation (WA-4.4).
	 */
	nameFor(worktree: string): string {
		const free = (name: string) => {
			const agent = this.state.agents.get(name);
			return !agent || agent.state === 'stopped' || agent.state === 'failed';
		};
		const base = nameOfWorktree(worktree);
		if (free(base)) {
			return base;
		}
		for (let i = 2; ; i++) {
			const suffix = `-${i}`;
			const name = `${base.slice(0, MAX_NAME_CHARS - suffix.length)}${suffix}`;
			if (free(name)) {
				return name;
			}
		}
	}

	/** Records a new incarnation of an agent, and writes the token its MCP server calls with. */
	add(agent: NewAgent): AddedAgent {
		const name = agentName(agent.name);
		const incarnation = (this.state.agents.get(name)?.incarnation ?? 0) + 1;
		const slug = `${name}-${incarnation}`;
		const token = newToken();
		const tokenFile = path.join(this.runsDir, `${slug}.token`);
		fs.mkdirSync(this.runsDir, { recursive: true });
		fs.writeFileSync(tokenFile, token, { mode: 0o600 });
		this.ledger.append({
			type: 'agent.started',
			name,
			incarnation,
			cli: agent.cli,
			model: agent.model,
			worktree: agent.worktree,
			folder: agent.folder,
			parent: agent.parent,
			tokenHash: hashToken(token)
		});
		return { name, incarnation, slug, token, tokenFile };
	}

	/** Records an agent's state. A stopped incarnation does not come back; a new one does. */
	setState(name: string, incarnation: number, state: AgentState, detail?: string): void {
		const agent = this.state.agents.get(name);
		if (!agent || agent.incarnation !== incarnation || (agent.state === state && agent.stateDetail === detail)) {
			return;
		}
		if ((agent.state === 'stopped' || agent.state === 'failed') && state !== 'stopped' && state !== 'failed') {
			return;
		}
		this.ledger.append({ type: 'agent.state', name, incarnation, state, detail });
	}

	/** The agents `name` started, each by its latest incarnation, running or not. */
	childrenOf(name: string): Agent[] {
		return [...this.state.agents.values()].filter(agent => agent.parent === name);
	}

	/** Records a worktree Facade made for a child (WA-3.3). */
	recordWorktree(worktree: MadeWorktree): void {
		this.ledger.append({ type: 'worktree.made', ...worktree });
	}

	/** Records a message sent; it waits until it is delivered (WA-6.2). */
	sendMessage(from: string, to: string, text: string): Message {
		const event = this.ledger.append({ type: 'message.sent', from, to, text });
		return this.state.pending.get(event.seq)!;
	}

	/** Records how a message went, which ends its wait. */
	markDelivered(message: Message, way: DeliveryWay): void {
		if (this.state.pending.has(message.seq)) {
			this.ledger.append({ type: 'message.delivered', message: message.seq, way });
		}
	}

	/** The messages waiting for `name`, oldest first. */
	pendingFor(name: string): Message[] {
		return [...this.state.pending.values()].filter(message => message.to === name);
	}
}

function newToken(): string {
	return crypto.randomBytes(32).toString('base64url');
}

/** What the ledger keeps of a token: never the token itself. */
function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

/** The token in `file`, made there first if there is none. */
function readOrMakeToken(file: string): string {
	try {
		const token = fs.readFileSync(file, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch {
		// Not made yet.
	}
	const token = newToken();
	fs.writeFileSync(file, token, { mode: 0o600 });
	return token;
}
