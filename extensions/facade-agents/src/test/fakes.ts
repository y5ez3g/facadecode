/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { InstalledCli } from '../clis';
import { claudeCli } from '../clis/claude';
import { Facade } from '../core/facade';
import { Disposable, FoundTerminal, Git, Ide, TerminalLaunch, Terminals } from '../core/ports';
import { AgentRegistry } from '../record/registry';

class FakeTerminals implements Terminals {

	readonly launched: TerminalLaunch[] = [];
	readonly running = new Set<string>();
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

	/** As when a terminal closes, or its process exits. */
	end(name: string, exitCode?: number): void {
		this.running.delete(name);
		for (const listener of [...this.listeners]) {
			listener(name, exitCode);
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

	async sendTerminal(name: string, text: string, enter: boolean): Promise<FoundTerminal | undefined> {
		const found = this.find(name);
		if (found) {
			this.steps.push(`type ${JSON.stringify(text)}${enter ? ' and Enter' : ''} into ${found}`);
		}
		return found !== undefined ? { name: found } : undefined;
	}

	async readTerminal(name: string, lines: number): Promise<(FoundTerminal & { readonly text?: string }) | undefined> {
		const found = this.find(name);
		if (found === undefined) {
			return undefined;
		}
		this.steps.push(`read ${lines} lines of ${found}`);
		return { name: found, text: this.terminals.get(found) };
	}

	async runCommand(id: string, args: readonly unknown[]): Promise<unknown> {
		if (id === 'fail') {
			throw new Error('command \'fail\' failed.');
		}
		this.steps.push(`run ${id} ${JSON.stringify(args)}`);
		return id === 'nothing' ? undefined : { ran: id };
	}

	private find(name: string): string | undefined {
		const names = [...this.terminals.keys()];
		return names.find(each => each === name) ?? names.find(each => each.startsWith(name));
	}
}

class FakeGit implements Git {

	constructor(private readonly worktrees: { readonly [folder: string]: string } = {}) { }

	async worktreeOf(folder: string): Promise<string> {
		return this.worktrees[folder] ?? path.basename(folder);
	}
}

/** Claude on this machine, as far as the core can tell: its launch is only computed, never run. */
const CLAUDE: InstalledCli = { cli: claudeCli, executable: '/bin/claude' };

/**
 * The core over a workspace in `dir`, with a window in memory: each port records what it was asked
 * and answers as a test set it up.
 */
export function fakeWorld(dir: string, worktrees: { readonly [folder: string]: string } = {}, clis: readonly InstalledCli[] = [CLAUDE]) {
	const registry = AgentRegistry.open({ dir });
	const terminals = new FakeTerminals();
	const ide = new FakeIde();
	const facade = new Facade({
		registry,
		ports: { terminals, ide, git: new FakeGit(worktrees) },
		clis: () => clis,
		mcpServer: tokenFile => ({ command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' } })
	});
	return {
		registry,
		facade,
		terminals,
		ide,
		dispose(): void {
			facade.dispose();
			registry.dispose();
		}
	};
}
