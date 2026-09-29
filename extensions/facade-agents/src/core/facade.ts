/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { cliName, InstalledCli, terminalName } from '../clis';
import { McpLaunch } from '../clis/cli';
import { Agent, Caller, YOU } from '../record/events';
import { AgentRegistry } from '../record/registry';
import { FacadeError } from './errors';
import { Disposable, FoundTerminal, Ports } from './ports';

export interface FacadeOptions {
	readonly registry: AgentRegistry;
	readonly ports: Ports;
	/** The CLIs this machine has, looked for again at each start. */
	readonly clis: () => readonly InstalledCli[];
	/** How an agent's MCP server is started, given its token file: the shim, on this window's pipe. */
	readonly mcpServer: (tokenFile: string) => McpLaunch;
	readonly log?: (message: string) => void;
}

export interface StartAgent {
	/** The CLI, as `claude`. */
	readonly cli: string;
	readonly model: string;
	/** Its first message, if it is given one. */
	readonly prompt?: string;
	/** The folder it works in: a worktree's. */
	readonly folder: string;
}

/**
 * Facade, the hardware (WORKTREE-AGENTS.md): what it does for the person and for agents, and the
 * rules it keeps doing it. Every caller comes through here - the contract for an agent's tool calls,
 * Start Agent for the person - and it reaches the window only through its ports, so that it runs in
 * tests without one. M0 starts agents and gives them the IDE; spawn, send, stop and delivery come
 * with M1.
 */
export class Facade implements Disposable {

	private readonly disposables: Disposable[] = [];

	constructor(private readonly options: FacadeOptions) {
		this.disposables.push(options.ports.terminals.onDidEnd((terminal, exitCode) => this.terminalEnded(terminal, exitCode)));
	}

	dispose(): void {
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

	/**
	 * Starts an agent in its own UI, in a worktree's folder, as the caller's child: named after its
	 * worktree, in a terminal held under the worktree's row (WA-4.1 to WA-4.3).
	 */
	async startAgent(caller: Caller, request: StartAgent): Promise<Agent> {
		const { registry, ports } = this.options;
		const installed = this.options.clis();
		const found = installed.find(each => each.cli.id === request.cli);
		if (!found) {
			throw new FacadeError('UNAVAILABLE', installed.length
				? `Facade cannot start ${request.cli} here. It starts: ${installed.map(each => each.cli.id).join(', ')}.`
				: `Facade cannot start ${request.cli} here: none of the CLIs it starts is on this machine's PATH.`);
		}
		if (!request.model.trim()) {
			throw new FacadeError('INVALID', `model is required: one of ${found.cli.displayName}'s models, as ${found.cli.models[0]}.`);
		}
		const worktree = await ports.git.worktreeOf(request.folder);
		const added = registry.add({ name: registry.nameFor(worktree), cli: found.cli.id, model: request.model.trim(), worktree, folder: request.folder, parent: caller.name });
		const spec = found.cli.launch({
			folder: request.folder,
			prompt: request.prompt,
			model: request.model.trim(),
			mcp: this.options.mcpServer(added.tokenFile),
			runDir: registry.runsDir,
			slug: added.slug
		}, found.executable);
		for (const file of spec.files) {
			fs.writeFileSync(file.path, file.content, { mode: 0o600 });
		}
		const name = terminalName(added.name, added.incarnation, found.cli.id);
		this.log(`Starting ${name} in ${request.folder}, the worktree ${worktree}`);
		try {
			await ports.terminals.launch({ name, executable: spec.executable, args: spec.args, env: spec.env, cwd: spec.cwd });
		} catch (err) {
			registry.setState(added.name, added.incarnation, 'failed', (err as Error).message);
			throw new FacadeError('FAILED', (err as Error).message);
		}
		this.log(`${name} is running`);
		return registry.agent(added.name)!;
	}

	/** After a reload or a restart: the agents whose terminals are gone are stopped (WA-10.2). */
	async recover(): Promise<void> {
		const { registry, ports } = this.options;
		for (const agent of [...registry.state.agents.values()]) {
			if (agent.state === 'stopped' || agent.state === 'failed') {
				continue;
			}
			if (!await ports.terminals.isAlive(terminalName(agent.name, agent.incarnation, agent.cli))) {
				registry.setState(agent.name, agent.incarnation, 'stopped', 'its terminal is gone');
			}
		}
	}

	// The `ide` actions (WA-9.5). M0 hands each to the window; the rules of WA-9.6 come with M1.

	openFile(_caller: Caller, file: string, line: number | undefined): Promise<void> {
		return this.options.ports.ide.openFile(file, line);
	}

	/** Answers with the new terminal's name. */
	openTerminal(_caller: Caller, folder: string, name: string | undefined): Promise<string> {
		return this.options.ports.ide.openTerminal(folder, name);
	}

	async sendTerminal(_caller: Caller, name: string, text: string, enter: boolean): Promise<FoundTerminal> {
		return found(name, await this.options.ports.ide.sendTerminal(name, text, enter));
	}

	async readTerminal(_caller: Caller, name: string, lines: number): Promise<FoundTerminal & { readonly text?: string }> {
		return found(name, await this.options.ports.ide.readTerminal(name, lines));
	}

	runCommand(_caller: Caller, id: string, args: readonly unknown[]): Promise<unknown> {
		return this.options.ports.ide.runCommand(id, args);
	}

	/** An agent's terminal ended: it stopped, unless it was already over. */
	private terminalEnded(terminal: string, exitCode: number | undefined): void {
		const { registry } = this.options;
		const agent = [...registry.state.agents.values()].find(candidate => terminalName(candidate.name, candidate.incarnation, candidate.cli) === terminal);
		if (agent && agent.state !== 'stopped' && agent.state !== 'failed') {
			registry.setState(agent.name, agent.incarnation, 'stopped', exitCode !== undefined ? `its process exited with code ${exitCode}` : 'its terminal closed');
		}
	}

	private log(message: string): void {
		this.options.log?.(message);
	}
}

function found<T>(name: string, terminal: T | undefined): T {
	if (!terminal) {
		throw new FacadeError('NOT_FOUND', `No terminal is called ${name}.`);
	}
	return terminal;
}
