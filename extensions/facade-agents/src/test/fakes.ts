/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { InstalledCli } from '../clis';
import { claudeCli } from '../clis/claude';
import { Facade } from '../core/facade';
import { Disposable, FoundTerminal, Git, Ide, ListedWorktree, Person, Repository, TerminalLaunch, Terminals } from '../core/ports';
import { AgentRegistry } from '../record/registry';

class FakeTerminals implements Terminals {

	readonly launched: TerminalLaunch[] = [];
	readonly running = new Set<string>();
	/** What was typed into each terminal, piece by piece, and which were closed. */
	readonly typed: string[] = [];
	/** What each terminal shows. */
	readonly screens = new Map<string, string>();
	/** When the person last typed into each terminal. */
	readonly lastInput = new Map<string, number>();
	/** The next launch fails with this. */
	failNext: string | undefined;
	private readonly listeners = new Set<(name: string, exitCode: number | undefined) => void>();

	async launch(launch: TerminalLaunch): Promise<void> {
		const failure = this.failNext;
		this.failNext = undefined;
		if (failure) {
			throw new Error(failure);
		}
		this.launched.push(launch);
		this.running.add(launch.name);
	}

	async isAlive(name: string): Promise<boolean> {
		return this.running.has(name);
	}

	onDidEnd(listener: (name: string, exitCode: number | undefined) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async stop(name: string): Promise<void> {
		this.typed.push(`${name}: [closed]`);
		this.end(name);
	}

	async type(name: string, text: string): Promise<boolean> {
		if (!this.running.has(name)) {
			return false;
		}
		this.typed.push(`${name}: ${JSON.stringify(text)}`);
		return true;
	}

	async read(name: string): Promise<string | undefined> {
		return this.screens.get(name);
	}

	async lastInputAt(name: string): Promise<number | undefined> {
		return this.lastInput.get(name);
	}

	async reveal(name: string): Promise<boolean> {
		return this.running.has(name);
	}

	/** As when a terminal closes, or its process exits. */
	end(name: string, exitCode?: number): void {
		if (this.running.delete(name)) {
			for (const listener of [...this.listeners]) {
				listener(name, exitCode);
			}
		}
	}
}

class FakeIde implements Ide {

	readonly steps: string[] = [];
	/** Its terminals, by name, with what each shows: nothing yet when undefined. */
	readonly terminals = new Map<string, string | undefined>();

	async openFile(file: string, line: number | undefined): Promise<void> {
		this.steps.push(`open ${file}${line !== undefined ? ` at ${line}` : ''}`);
	}

	async openTerminal(folder: string, name: string | undefined): Promise<string> {
		const opened = name ?? 'pwsh';
		this.terminals.set(opened, undefined);
		this.steps.push(`terminal ${opened} in ${folder}`);
		return opened;
	}

	async findTerminal(name: string): Promise<FoundTerminal | undefined> {
		const names = [...this.terminals.keys()];
		const found = names.find(each => each === name) ?? names.find(each => each.startsWith(name));
		return found === undefined ? undefined : { name: found };
	}

	async sendTerminal(name: string, text: string, enter: boolean): Promise<void> {
		this.steps.push(`type ${JSON.stringify(text)}${enter ? ' and Enter' : ''} into ${name}`);
	}

	async readTerminal(name: string, lines: number): Promise<string | undefined> {
		this.steps.push(`read ${lines} lines of ${name}`);
		return this.terminals.get(name);
	}

	async runCommand(id: string, args: readonly unknown[]): Promise<unknown> {
		if (id === 'fail') {
			throw new Error('command \'fail\' failed.');
		}
		this.steps.push(`run ${id} ${JSON.stringify(args)}`);
		return id === 'nothing' ? undefined : { ran: id };
	}
}

/** Repositories by their main checkout: git's record of their worktrees, all at one HEAD. */
class FakeGit implements Git {

	readonly steps: string[] = [];
	private readonly worktrees = new Map<string, ListedWorktree[]>();

	constructor(repositories: { readonly [main: string]: readonly string[] }, private readonly head = 'a'.repeat(40)) {
		for (const [main, names] of Object.entries(repositories)) {
			this.worktrees.set(main, [{ name: 'main', folder: main }, ...names.map(name => ({ name, folder: worktreeFolder(main, name) }))]);
		}
	}

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		for (const [main, worktrees] of this.worktrees) {
			const worktree = worktrees.find(each => each.folder === folder);
			if (worktree) {
				return { main, worktree: worktree.name, head: this.head };
			}
		}
		return undefined;
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		return this.worktrees.get(main) ?? [];
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<string> {
		const worktrees = this.worktrees.get(main)!;
		if (worktrees.some(each => each.name === branch)) {
			throw new Error(`A branch named ${branch} already exists. Choose another name.`);
		}
		this.steps.push(`make ${branch} from ${startPoint.slice(0, 7)} in ${main}`);
		const folder = worktreeFolder(main, branch);
		worktrees.push({ name: branch, folder });
		return folder;
	}

	async deleteWorktree(folder: string, force: boolean): Promise<void> {
		this.steps.push(`delete ${folder}${force ? ' with force' : ''}`);
		for (const worktrees of this.worktrees.values()) {
			const at = worktrees.findIndex(each => each.folder === folder);
			if (at >= 0) {
				worktrees.splice(at, 1);
			}
		}
	}
}

class FakePerson implements Person {

	readonly notifications: string[] = [];
	/** The person's answer to the first-run question, per CLI: yes unless set. */
	readonly firstRunAnswers = new Map<string, boolean>();
	readonly asked: string[] = [];

	notify(from: string, text: string, terminal: string | undefined): void {
		this.notifications.push(`${from}: ${text}${terminal ? ` (${terminal})` : ''}`);
	}

	async allowsFirstRunAnswers(cli: { readonly id: string }): Promise<boolean> {
		this.asked.push(cli.id);
		return this.firstRunAnswers.get(cli.id) ?? true;
	}
}

/** Where a fake repository's worktree lives. */
export function worktreeFolder(main: string, name: string): string {
	return path.join(`${main}-worktrees`, name);
}

/** Claude on this machine, as far as the core can tell: its launch is only computed, never run. */
const CLAUDE: InstalledCli = { cli: claudeCli, executable: '/bin/claude' };

export interface WorldOptions {
	/** Repositories by their main checkout, with the names of their worktrees. */
	readonly repositories?: { readonly [main: string]: readonly string[] };
	readonly clis?: readonly InstalledCli[];
	/** The command agents' hooks run, when a test runs them; a path that is never run otherwise. */
	readonly hookCommand?: (tokenFile: string, run: string) => string;
}

/**
 * The core over a workspace in `dir`, with a window in memory: each port records what it was asked
 * and answers as a test set it up.
 */
export function fakeWorld(dir: string, options: WorldOptions = {}) {
	const registry = AgentRegistry.open({ dir });
	const terminals = new FakeTerminals();
	const ide = new FakeIde();
	const git = new FakeGit(options.repositories ?? {});
	const person = new FakePerson();
	const facade = new Facade({
		registry,
		ports: { terminals, ide, git, person },
		clis: () => options.clis ?? [CLAUDE],
		mcpServer: tokenFile => ({ command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' } }),
		hookCommand: options.hookCommand ?? ((_tokenFile, run) => `/facade/hooks/${run}.cmd`),
		skills: [{ name: 'facade', description: 'How to work in Facade Code.', body: '# Working in Facade Code' }],
		opening: agent => `You are @${agent.name}; your parent is @${agent.parent}.`,
		quietMs: 50
	});
	return {
		registry,
		facade,
		terminals,
		ide,
		git,
		person,
		dispose(): void {
			facade.dispose();
			registry.dispose();
		}
	};
}
