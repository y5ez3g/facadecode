/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { agentCli, cliName, InstalledCli } from '../clis';
import { AgentCli, McpLaunch, Skill } from '../clis/cli';
import { Agent, AgentState, Caller, Message, YOU } from '../record/events';
import { agentName } from '../record/names';
import { AgentRegistry } from '../record/registry';
import { Delivery, isRunning, renderMessages, terminalOf } from './delivery';
import { FacadeError } from './errors';
import { answerFirstRun } from './firstRun';
import { Disposable, FoundTerminal, Ports } from './ports';

/** Between text typed into an agent's terminal and the Enter that submits it. */
const SUBMIT_GAP_MS = 300;
/**
 * An agent named as `@name`. An agent's terminal's own name, `@name · Claude Code`, starts with `@`
 * too: it is a terminal's name, found like any other.
 */
const AGENT_ADDRESS = /^@[a-z0-9][a-z0-9._-]*$/i;

export interface FacadeOptions {
	readonly registry: AgentRegistry;
	readonly ports: Ports;
	/** The CLIs this machine has, looked for again at each start. */
	readonly clis: () => readonly InstalledCli[];
	/** How an agent's MCP server is started, given its token file: the shim, on this window's pipe. */
	readonly mcpServer: (tokenFile: string) => McpLaunch;
	/** The command an agent's hooks run, given its token file and its run (WA-7.1). */
	readonly hookCommand: (tokenFile: string, slug: string) => string;
	/** What every agent is handed at its launch (WA-12.5). */
	readonly skills: readonly Skill[];
	/** What an agent holds from every session start, whether it loads a skill or not (WA-7.4). */
	readonly opening: (agent: Agent) => string;
	readonly log?: (message: string) => void;
	/** How long the person's last keystroke keeps Facade from typing into a terminal (WA-6.4). */
	readonly quietMs?: number;
}

export interface SpawnRequest {
	/** The CLI, as `claude`. */
	readonly cli: string;
	readonly model: string;
	/** Its first message, if it is given one. */
	readonly prompt?: string;
	/** Omitted: the caller's own; `new`: a new one (WA-3.2); else a worktree of its repository, by name. */
	readonly worktree?: string;
	readonly name?: string;
	/** The person's worktree, the one on screen: the person has none of their own. */
	readonly folder?: string;
}

export interface Spawned {
	readonly name: string;
	readonly cli: string;
	readonly cliName: string;
	readonly model: string;
	readonly worktree: string;
	readonly folder: string;
	/** Set when its worktree was made for it, on this new branch. */
	readonly branch?: string;
	readonly madeWorktree: boolean;
}

/**
 * Facade, the hardware (WORKTREE-AGENTS.md): what it does for the person and for agents, and the
 * rules it keeps doing it. Every caller comes through here - the contract for an agent's tool calls
 * and hooks, Start Agent for the person - and it reaches the window only through its ports, so that
 * it runs in tests without one. A parent and its children talk to each other and nobody else; an
 * agent stops and types only into its own children.
 */
export class Facade implements Disposable {

	private readonly delivery: Delivery;
	private readonly disposables: Disposable[] = [];
	/** Terminals that end because an agent's parent said so, with why: the parent is told nothing of it. */
	private readonly endedByParent = new Map<string, string>();
	private disposed = false;

	constructor(private readonly options: FacadeOptions) {
		const { registry, ports } = options;
		this.delivery = new Delivery({ registry, terminals: ports.terminals, person: ports.person, log: message => this.log(message), quietMs: options.quietMs });
		this.disposables.push(this.delivery, ports.terminals.onDidEnd((terminal, exitCode) => this.terminalEnded(terminal, exitCode)));
	}

	dispose(): void {
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	/** The agent a caller is; undefined for the person. */
	agentOf(caller: Caller): Agent | undefined {
		return caller.name === YOU ? undefined : this.options.registry.agent(caller.name);
	}

	/** A CLI's name for people, as `Claude Code`. */
	cliName(id: string): string {
		return cliName(id);
	}

	/** The CLIs Facade can start on this machine. */
	clis(): readonly InstalledCli[] {
		return this.options.clis();
	}

	/** A tool call is a sign of life: an agent that makes one is in a turn (WA-4.5). */
	heard(caller: Caller): void {
		const agent = this.current(caller);
		if (agent && (agent.state === 'starting' || agent.state === 'idle' || agent.state === 'waiting')) {
			this.changeState(agent, 'working');
		}
	}

	/** The messages waiting for the caller, which the result of its tool call carries (WA-5.3). */
	messagesFor(caller: Caller): Message[] {
		return this.current(caller) ? this.delivery.withResult(caller.name) : [];
	}

	/**
	 * Starts a child of the caller in its own UI (WA-4.1 to WA-4.4): beside it, in a worktree of its
	 * repository, or in a new one branched from its worktree's HEAD (WA-3.2), named after its worktree
	 * unless it is given a name. A running agent under that name is stopped first when it is the
	 * caller's child, and refused otherwise.
	 */
	async spawn(caller: Caller, request: SpawnRequest): Promise<Spawned> {
		const { registry, ports } = this.options;
		const installed = this.options.clis();
		const found = installed.find(each => each.cli.id === request.cli);
		if (!found) {
			throw new FacadeError('UNAVAILABLE', installed.length
				? `Facade cannot start ${request.cli} here. It starts: ${installed.map(each => each.cli.id).join(', ')}.`
				: `Facade cannot start ${request.cli} here: none of the CLIs it starts is on this machine's PATH.`);
		}
		const model = request.model.trim();
		if (!model) {
			throw new FacadeError('INVALID', `model is required: one of ${found.cli.displayName}'s models, as ${found.cli.models[0]}.`);
		}
		let name = request.name === undefined ? undefined : this.nameOf(request.name);
		const parent = this.agentOf(caller);
		const home = parent?.folder ?? request.folder;
		if (!home) {
			throw new FacadeError('INVALID', 'The person has no worktree of their own: start an agent with Facade: Start Agent, in the worktree on screen.');
		}

		let folder = home;
		let worktree = parent?.worktree ?? await this.worktreeOf(home);
		let branch: string | undefined;
		if (request.worktree !== undefined) {
			const repository = await ports.git.repositoryOf(home);
			if (!repository) {
				throw new FacadeError('REFUSED', `${this.who(caller)} ${caller.name === YOU ? 'are' : 'runs'} in ${home}, which is no repository: children start beside ${caller.name === YOU ? 'you' : 'it'} (WA-3.6).`);
			}
			if (request.worktree === 'new') {
				if (!name) {
					throw new FacadeError('INVALID', 'name is required with worktree "new": the new worktree\'s branch is named after the child.');
				}
				this.checkRoomFor(caller, name);
				await this.askFirstRun(found.cli);
				try {
					folder = await ports.git.makeWorktree(repository.main, name, repository.head);
				} catch (err) {
					throw new FacadeError('FAILED', (err as Error).message);
				}
				registry.recordWorktree({ name, folder, repository: repository.main, parentWorktree: repository.worktree, madeBy: caller.name });
				worktree = branch = name;
			} else {
				const listed = await ports.git.worktreesOf(repository.main);
				const target = listed.find(each => each.name === request.worktree);
				if (!target) {
					throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} is called ${request.worktree}. Its worktrees: ${listed.map(each => each.name).join(', ')}.`);
				}
				folder = target.folder;
				worktree = target.name;
			}
		}

		name ??= registry.nameFor(worktree);
		this.checkRoomFor(caller, name);
		const madeByFacade = registry.state.worktrees.has(folder) || [...registry.state.worktrees.keys()].some(made => sameFolder(made, folder));
		if (madeByFacade && !branch) {
			await this.askFirstRun(found.cli);
		}
		const previous = registry.agent(name);
		if (isRunning(previous)) {
			this.endedByParent.set(terminalOf(previous), `replaced by a new @${name}`);
			this.changeState(previous, 'stopped', `replaced by a new @${name}`, false);
			await ports.terminals.stop(terminalOf(previous));
		}

		const agent = await this.launch(caller, found, name, model, request.prompt, worktree, folder);
		if (madeByFacade) {
			this.watchFirstRun(agent);
		}
		return { name: agent.name, cli: agent.cli, cliName: found.cli.displayName, model, worktree, folder, branch, madeWorktree: !!branch };
	}

	/** A message to the caller's parent or one of its children, one recipient per call (WA-5.6). */
	async send(caller: Caller, to: string, text: string): Promise<{ readonly to: string; readonly seq: number }> {
		const { registry } = this.options;
		const name = addressed(to);
		const self = this.agentOf(caller);
		const toParent = !!self && self.parent === name;
		const recipient = registry.agent(name);
		const toChild = recipient?.parent === caller.name;
		if (!toParent && !toChild) {
			throw new FacadeError('REFUSED', `${to} is not your parent or one of your children. ${this.contacts(caller)}`);
		}
		if (name !== YOU && !isRunning(recipient)) {
			throw new FacadeError('REFUSED', toParent
				? `Your parent @${name} has left: the message was not delivered. Say it in your own output, where the person sees it.`
				: `@${name} has stopped: the message was not delivered. spawn starts it again under its name.`);
		}
		const message = registry.sendMessage(caller.name, name, text);
		this.delivery.sent(message);
		return { to: name, seq: message.seq };
	}

	/** Stops one of the caller's children (WA-4.6); its worktree stays as it is. */
	async stop(caller: Caller, target: string): Promise<{ readonly name: string; readonly worktree: string; readonly wasRunning: boolean }> {
		const name = addressed(target);
		const agent = this.options.registry.agent(name);
		if (!agent) {
			throw new FacadeError('NOT_FOUND', `No agent is called @${name}. ${this.contacts(caller)}`);
		}
		if (agent.parent !== caller.name) {
			throw new FacadeError('REFUSED', `@${name} is not your child: an agent stops only its own children. ${this.contacts(caller)}`);
		}
		if (agent.state === 'stopped' || agent.state === 'failed') {
			return { name, worktree: agent.worktree, wasRunning: false };
		}
		this.endedByParent.set(terminalOf(agent), `stopped by ${this.who(caller)}`);
		this.changeState(agent, 'stopped', `stopped by ${this.who(caller)}`, false);
		await this.options.ports.terminals.stop(terminalOf(agent));
		return { name, worktree: agent.worktree, wasRunning: true };
	}

	/**
	 * Delete Worktree without its dialog (WA-3.5): one of the caller's repository's, not main and not
	 * the one it runs in, and with no agent in it but the caller's children, which go with it.
	 */
	async deleteWorktree(caller: Caller, name: string, force: boolean): Promise<{ readonly name: string; readonly folder: string; readonly stopped: readonly string[] }> {
		const { registry, ports } = this.options;
		const self = this.agentOf(caller);
		const repository = self && await ports.git.repositoryOf(self.folder);
		if (!self || !repository) {
			throw new FacadeError('REFUSED', self
				? `You run in ${self.folder}, which is no repository: it has no worktrees to delete.`
				: 'The person deletes a worktree from its row, with Delete Worktree.');
		}
		const listed = await ports.git.worktreesOf(repository.main);
		const target = listed.find(each => each.name === name);
		if (!target) {
			throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} is called ${name}. Its worktrees: ${listed.map(each => each.name).join(', ')}.`);
		}
		if (target.name === 'main') {
			throw new FacadeError('REFUSED', 'main is the repository\'s own checkout: it is not deleted.');
		}
		if (sameFolder(target.folder, self.folder)) {
			throw new FacadeError('REFUSED', `You run in ${name}: it is not yours to delete while you are there.`);
		}
		const inIt = [...registry.state.agents.values()].filter(agent => isRunning(agent) && sameFolder(agent.folder, target.folder));
		const others = inIt.filter(agent => agent.parent !== caller.name);
		if (others.length) {
			throw new FacadeError('REFUSED', `${others.map(agent => `@${agent.name}`).join(', ')} ${others.length === 1 ? 'runs' : 'run'} in ${name} and ${others.length === 1 ? 'is not your child' : 'are not your children'}: it is not yours to delete.`);
		}
		for (const agent of inIt) {
			this.endedByParent.set(terminalOf(agent), 'its worktree was deleted');
		}
		try {
			await ports.git.deleteWorktree(target.folder, force);
		} catch (err) {
			for (const agent of inIt) {
				this.endedByParent.delete(terminalOf(agent));
			}
			throw new FacadeError('FAILED', (err as Error).message);
		}
		// The window closed their terminals with everything else working inside it (WORKTREE.md section 10).
		for (const agent of inIt) {
			this.changeState(agent, 'stopped', 'its worktree was deleted', false);
		}
		return { name, folder: target.folder, stopped: inIt.map(agent => agent.name) };
	}

	/** What a CLI's hook reported; answers with what the hook prints to the CLI (WA-6.3). */
	hook(caller: Caller, event: string, payload: unknown): string {
		const agent = this.current(caller);
		const cli = agent && agentCli(agent.cli);
		const happened = cli?.readHook(event, payload);
		if (!agent || !cli || !happened) {
			return '';
		}
		switch (happened.kind) {
			case 'start':
				return cli.openWith(this.options.opening(agent));
			case 'prompt':
				this.changeState(agent, 'working');
				return '';
			case 'stop': {
				// Its turn goes on with what waits for it; with nothing, it ends. Blocking only while
				// messages wait, a Stop hook cannot loop (WA-6.7).
				const messages = this.delivery.atStop(agent.name);
				if (messages.length) {
					this.changeState(agent, 'working');
					return cli.continueWith(renderMessages(messages));
				}
				this.changeState(agent, 'idle');
				return '';
			}
			case 'waiting':
				this.changeState(agent, 'waiting', happened.what);
				return '';
			case 'idle':
				this.changeState(agent, 'idle');
				return '';
		}
	}

	/** After a reload or a restart (WA-10.2): the agents whose terminals are gone are stopped. */
	async recover(): Promise<void> {
		const { registry, ports } = this.options;
		for (const agent of [...registry.state.agents.values()]) {
			if (!isRunning(agent)) {
				continue;
			}
			if (!await ports.terminals.isAlive(terminalOf(agent))) {
				this.changeState(agent, 'stopped', 'its terminal is gone');
			} else if (agent.state === 'starting' && [...registry.state.worktrees.keys()].some(made => sameFolder(made, agent.folder))) {
				// The host before may have been watching for its first-run question (WA-8.3).
				this.watchFirstRun(agent);
			}
		}
		this.delivery.resume();
	}

	// The `ide` actions (WA-9.5).

	openFile(_caller: Caller, file: string, line: number | undefined): Promise<void> {
		return this.options.ports.ide.openFile(file, line);
	}

	/** Answers with the new terminal's name. */
	openTerminal(_caller: Caller, folder: string, name: string | undefined): Promise<string> {
		return this.options.ports.ide.openTerminal(folder, name);
	}

	/**
	 * Types into a terminal, `@name` for an agent's. An agent types only into its own children's
	 * terminals and terminals that are no agent's (WA-9.6); the person, anywhere.
	 */
	async sendTerminal(caller: Caller, name: string, text: string, enter: boolean): Promise<FoundTerminal> {
		const { ide, terminals } = this.options.ports;
		if (AGENT_ADDRESS.test(name)) {
			const agent = this.runningAgent(name);
			this.checkTypingInto(caller, agent);
			const terminal = terminalOf(agent);
			await terminals.type(terminal, text);
			if (enter) {
				await delay(SUBMIT_GAP_MS);
				await terminals.type(terminal, '\r');
			}
			return { name: terminal };
		}
		const found = await this.foundTerminal(name);
		const owner = [...this.options.registry.state.agents.values()].find(agent => isRunning(agent) && terminalOf(agent) === found.name);
		if (owner) {
			this.checkTypingInto(caller, owner);
		}
		await ide.sendTerminal(found.name, text, enter);
		return found;
	}

	/** The last lines a terminal shows, `@name` for an agent's. */
	async readTerminal(_caller: Caller, name: string, lines: number): Promise<FoundTerminal & { readonly text?: string }> {
		if (AGENT_ADDRESS.test(name)) {
			const terminal = terminalOf(this.runningAgent(name));
			return { name: terminal, text: await this.options.ports.terminals.read(terminal, lines) };
		}
		const found = await this.foundTerminal(name);
		return { name: found.name, text: await this.options.ports.ide.readTerminal(found.name, lines) };
	}

	runCommand(_caller: Caller, id: string, args: readonly unknown[]): Promise<unknown> {
		return this.options.ports.ide.runCommand(id, args);
	}

	/** Records an agent's state, and tells its parent when it stops, fails or waits (WA-6.11). */
	private changeState(agent: Agent, state: AgentState, detail?: string, tellParent = true): void {
		const { registry } = this.options;
		const current = registry.agent(agent.name);
		if (!current || current.incarnation !== agent.incarnation) {
			return;
		}
		const was = current.state;
		registry.setState(agent.name, agent.incarnation, state, detail);
		if (current.state === was) {
			return;
		}
		if (state === 'stopped' || state === 'failed') {
			this.delivery.drop(agent.name);
		}
		if (tellParent) {
			switch (state) {
				case 'stopped':
					this.delivery.notice(current, `@${agent.name} stopped${detail ? `: ${detail}` : '.'}`);
					break;
				case 'failed':
					this.delivery.notice(current, `@${agent.name} failed${detail ? `: ${detail}` : '.'}`);
					break;
				case 'waiting':
					this.delivery.notice(current, `@${agent.name} waits in its terminal${detail ? `: ${detail}` : '.'}`);
					break;
			}
		}
		if (state === 'idle') {
			this.delivery.schedule(agent.name, 0);
		}
	}

	private async launch(caller: Caller, installed: InstalledCli, name: string, model: string, prompt: string | undefined, worktree: string, folder: string): Promise<Agent> {
		const { registry, ports } = this.options;
		const added = registry.add({ name, cli: installed.cli.id, model, worktree, folder, parent: caller.name });
		const spec = installed.cli.launch({
			folder,
			prompt,
			model,
			mcp: this.options.mcpServer(added.tokenFile),
			hookCommand: this.options.hookCommand(added.tokenFile, added.slug),
			skills: this.options.skills,
			runDir: registry.runsDir,
			slug: added.slug
		}, installed.executable);
		for (const file of spec.files) {
			fs.mkdirSync(path.dirname(file.path), { recursive: true });
			fs.writeFileSync(file.path, file.content, { mode: 0o600 });
		}
		const agent = registry.agent(added.name)!;
		const terminal = terminalOf(agent);
		this.log(`Starting ${terminal} in ${folder}, the worktree ${worktree}`);
		try {
			await ports.terminals.launch({ name: terminal, executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd });
		} catch (err) {
			this.changeState(agent, 'failed', (err as Error).message);
			throw new FacadeError('FAILED', (err as Error).message);
		}
		this.log(`${terminal} is running`);
		return agent;
	}

	/** An agent's terminal ended: it stopped, unless it was over already. */
	private terminalEnded(terminal: string, exitCode: number | undefined): void {
		const byParent = this.endedByParent.get(terminal);
		this.endedByParent.delete(terminal);
		const agent = [...this.options.registry.state.agents.values()].find(candidate => terminalOf(candidate) === terminal);
		if (isRunning(agent)) {
			this.changeState(agent, 'stopped', byParent ?? (exitCode !== undefined ? `its process exited with code ${exitCode}` : 'its terminal closed'), !byParent);
		}
	}

	/** Asks the person, once per CLI, to let Facade answer its first-run question in its worktrees (WA-8.1). */
	private async askFirstRun(cli: AgentCli): Promise<void> {
		if (cli.firstRun && !await this.options.ports.person.allowsFirstRunAnswers(cli)) {
			throw new FacadeError('REFUSED', `The person did not let Facade answer ${cli.displayName}'s first-run question in the worktrees it makes, so ${cli.displayName} cannot start in one. Start the child beside you, or ask the person.`);
		}
	}

	private watchFirstRun(agent: Agent): void {
		const question = agentCli(agent.cli)?.firstRun;
		if (!question) {
			return;
		}
		void answerFirstRun({
			terminals: this.options.ports.terminals,
			terminal: terminalOf(agent),
			question,
			watching: () => {
				const current = this.options.registry.agent(agent.name);
				return !this.disposed && current?.incarnation === agent.incarnation && current.state === 'starting';
			},
			log: message => this.log(message)
		});
	}

	/** Refuses a name a running agent has that is not the caller's child (WA-4.4). */
	private checkRoomFor(caller: Caller, name: string): void {
		const agent = this.options.registry.agent(name);
		if (isRunning(agent) && agent.parent !== caller.name) {
			throw new FacadeError('REFUSED', `@${name} is running, and it is not your child: choose another name.`);
		}
	}

	private checkTypingInto(caller: Caller, agent: Agent): void {
		if (caller.name !== YOU && agent.parent !== caller.name) {
			throw new FacadeError('REFUSED', `@${agent.name}'s terminal is not yours to type into: an agent types only into its own children's terminals and terminals that are no agent's.`);
		}
	}

	private runningAgent(name: string): Agent {
		const agent = this.options.registry.agent(addressed(name));
		if (!isRunning(agent)) {
			throw new FacadeError('NOT_FOUND', agent ? `${name} has stopped: it has no terminal.` : `No agent is called ${name}.`);
		}
		return agent;
	}

	private async foundTerminal(name: string): Promise<FoundTerminal> {
		const found = await this.options.ports.ide.findTerminal(name);
		if (!found) {
			throw new FacadeError('NOT_FOUND', `No terminal is called ${name}.`);
		}
		return found;
	}

	/** The caller's current incarnation, while it runs; undefined for the person. */
	private current(caller: Caller): Agent | undefined {
		const agent = this.agentOf(caller);
		return isRunning(agent) && agent.incarnation === caller.incarnation ? agent : undefined;
	}

	/** Who the caller can message and stop, for a refusal to name (WA-5.5). */
	private contacts(caller: Caller): string {
		const parent = this.agentOf(caller)?.parent;
		const children = this.options.registry.childrenOf(caller.name).filter(isRunning).map(child => `@${child.name}`);
		const yours = [parent === YOU ? 'the person (@you), your parent' : parent ? `@${parent}, your parent` : undefined, ...children].filter(each => !!each);
		return yours.length ? `Yours: ${yours.join(', ')}.` : 'You have no parent or children to reach.';
	}

	private who(caller: Caller): string {
		return caller.name === YOU ? 'the person' : `@${caller.name}`;
	}

	private nameOf(text: string): string {
		try {
			return agentName(text);
		} catch (err) {
			throw new FacadeError('INVALID', (err as Error).message);
		}
	}

	private async worktreeOf(folder: string): Promise<string> {
		return (await this.options.ports.git.repositoryOf(folder))?.worktree ?? path.basename(folder);
	}

	private log(message: string): void {
		this.options.log?.(message);
	}
}

/** A name as a tool is given it: `@clamp`, `clamp` or `@you`. */
function addressed(text: string): string {
	return text.trim().replace(/^@/, '').toLowerCase();
}

function sameFolder(a: string, b: string): boolean {
	const normalize = (folder: string) => {
		const resolved = path.resolve(folder);
		return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
