/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { AgentCli, Environment, launchArgs, skillMarkdown } from '../clis/cli';
import { readCliConfig } from '../clis/config';
import { Facade, SpawnRequest, Spawned } from '../core/facade';
import { Disposable, Git, ListedWorktree, Person, Repository, TerminalEnd, TerminalLaunch, Terminals } from '../core/ports';
import { AgentTable } from '../record/agents';
import { Agent, Caller } from '../record/events';
import { ClosedBy } from '../record/ledger';
import { settled, until } from './clock';

/** The window's terminals, in memory: what was launched, typed and closed, and which run. */
export class FakeTerminals implements Terminals {

	readonly launched: TerminalLaunch[] = [];
	readonly running = new Set<string>();
	/** What was typed into each terminal, piece by piece, and which were closed. */
	readonly typed: string[] = [];
	/** The next launch fails with this. */
	failNext: string | undefined;
	private readonly listeners = new Set<(name: string, end: TerminalEnd) => void>();

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

	onDidEnd(listener: (name: string, end: TerminalEnd) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** As the window closes a terminal for the extension: it tells of the end as of any other. */
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

	/** As when a terminal closes, or its process exits. */
	end(name: string, end: TerminalEnd = { byThePerson: false }): void {
		if (this.running.delete(name)) {
			for (const listener of [...this.listeners]) {
				listener(name, end);
			}
		}
	}
}

/** Repositories by their main checkout: git's record of their worktrees, all at one HEAD. */
export class FakeGit implements Git {

	readonly steps: string[] = [];
	/** The files git tracks, by their full paths: none unless a test adds them. */
	readonly trackedFiles = new Set<string>();
	/** The files of the person's that git neither tracks nor ignores, by their full paths: none unless a test adds them. */
	readonly untrackedFiles = new Set<string>();
	/** While set, listing a repository's worktrees waits for it. */
	hold: Promise<void> | undefined;
	private readonly worktrees = new Map<string, ListedWorktree[]>();

	/** `gitDir` holds each repository's `info/exclude`, by its main checkout's name; `unborn` are those with no commit yet. */
	constructor(repositories: { readonly [main: string]: readonly string[] }, private readonly gitDir: string, private readonly unborn: readonly string[] = [], readonly head = 'a'.repeat(40)) {
		for (const [main, names] of Object.entries(repositories)) {
			this.worktrees.set(main, [{ name: 'main', folder: main }, ...names.map(name => ({ name, folder: worktreeFolder(main, name) }))]);
		}
	}

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		const found = this.worktreeAt(folder);
		return found && { main: found.main, worktree: found.worktree.name, head: this.unborn.includes(found.main) ? undefined : this.head };
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		await this.hold;
		return this.worktrees.get(main) ?? [];
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<string> {
		const worktrees = this.worktrees.get(main) ?? [];
		if (worktrees.some(each => each.name === branch)) {
			throw new Error(`A branch named ${branch} already exists. Choose another name.`);
		}
		this.steps.push(`make ${branch} from ${startPoint.slice(0, 7)} in ${main}`);
		const folder = worktreeFolder(main, branch);
		fs.mkdirSync(folder, { recursive: true });
		worktrees.push({ name: branch, folder });
		this.worktrees.set(main, worktrees);
		return folder;
	}

	async excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
		const found = this.worktreeAt(folder);
		return found && { file: path.join(this.gitDir, path.basename(found.main), 'info', 'exclude'), root: found.worktree.folder };
	}

	async tracks(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		return new Set(files.filter(file => this.trackedFiles.has(path.join(folder, file))));
	}

	/** The files every worktree of `folder`'s repository has untracked at that place from its root. */
	async untrackedAnywhere(folder: string, files: readonly string[]): Promise<ReadonlySet<string>> {
		const found = this.worktreeAt(folder);
		if (!found) {
			return new Set();
		}
		const worktrees = this.worktrees.get(found.main) ?? [];
		return new Set(files.filter(file => {
			const fromRoot = path.relative(found.worktree.folder, path.join(folder, file));
			return worktrees.some(worktree => this.untrackedFiles.has(path.join(worktree.folder, fromRoot)));
		}));
	}

	/** The worktree `folder` is in - its root, or a folder inside it - and its repository's main checkout. */
	private worktreeAt(folder: string): { readonly main: string; readonly worktree: ListedWorktree } | undefined {
		let found: { readonly main: string; readonly worktree: ListedWorktree } | undefined;
		for (const [main, worktrees] of this.worktrees) {
			for (const worktree of worktrees) {
				const inside = path.relative(worktree.folder, folder);
				const within = folder === worktree.folder || (inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside));
				if (within && (!found || worktree.folder.length > found.worktree.folder.length)) {
					found = { main, worktree };
				}
			}
		}
		return found;
	}
}

/** The person: what Facade told them. */
export class FakePerson implements Person {

	readonly told: string[] = [];

	tell(text: string, terminal: string | undefined): void {
		this.told.push(`${text}${terminal ? ` (${terminal})` : ''}`);
	}
}

/** Where a fake repository's worktree lives. */
export function worktreeFolder(main: string, name: string): string {
	return path.join(`${main}-worktrees`, name);
}

/** The caller an agent is, as its token says. */
export function callerOf(agent: Agent): Caller {
	return { id: agent.id, name: agent.name };
}

/**
 * A CLI that takes its task as an argument and keeps the person's trust in a file of its own,
 * `trust.json`, in the folder `ARG_HOME` names where its environment has it, else in `home`: its launch
 * computed, never run.
 */
export function argCli(home: string): AgentCli {
	const cli: AgentCli = {
		id: 'arg',
		displayName: 'Arg Code',
		section: 'arg',
		command: 'arg',
		defaults: {
			path: '',
			launch: {
				arguments: { connect: ['--config', '${config}'], model: ['--model', '${model}'], effort: ['--effort', '${effort}'], task: ['--', '${task}'] },
				environment: { ARG_QUIET: '1' },
				trust: { file: '${argHome}/trust.json', merge: { trusted: ['${repository}'] } },
				enterDelay: 300,
				taskDelay: 0
			}
		},
		trustValues: ({ repository }, env) => ({ argHome: env.ARG_HOME ?? home, repository }),
		task: 'argument',
		launch: (input, executable) => {
			const config = path.join(input.runDir, `${input.slug}.config.json`);
			return {
				executable,
				args: launchArgs(cli, input.config, { config, model: input.model, effort: input.effort, task: input.prompt ?? '' }, { trust: input.trusted, task: !!input.prompt }),
				env: input.config.launch.environment,
				cwd: input.folder,
				files: [{ path: config, content: JSON.stringify(input.mcp) }],
				injected: []
			};
		}
	};
	return cli;
}

/**
 * A CLI whose first conversation has no MCP tools - told of its task in its terminal - which reads one
 * server for all its agents, and its skills, from files in its folder, and is given the person's trust
 * in its arguments.
 */
export function toldCli(): AgentCli {
	const server = (input: { readonly mcp: { readonly command: string; readonly args: readonly string[] } }) => ({ command: input.mcp.command, args: input.mcp.args });
	const cli: AgentCli = {
		id: 'told',
		displayName: 'Told Code',
		section: 'told',
		command: 'told',
		defaults: {
			path: '',
			launch: {
				arguments: { model: ['--model', '${model}'], effort: ['--effort', '${effort}'] },
				environment: {},
				trust: { arguments: ['--trust-folder'] },
				// Typed at once, on a test's clock.
				enterDelay: 400,
				taskDelay: 0
			}
		},
		sharedServer: true,
		task: 'terminal',
		launch: (input, executable) => ({
			executable,
			args: launchArgs(cli, input.config, { model: input.model, effort: input.effort }, { trust: input.trusted }),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: [
				{
					path: '.mcp.json',
					content: JSON.stringify({ mcpServers: { facade: server(input) } }, undefined, '\t'),
					merge: theirs => {
						let file: { mcpServers?: { [name: string]: unknown } };
						try {
							file = JSON.parse(theirs);
						} catch {
							return undefined;
						}
						return file.mcpServers?.facade ? undefined : JSON.stringify({ ...file, mcpServers: { ...file.mcpServers, facade: server(input) } }, undefined, 2);
					}
				},
				...input.skills.map(skill => ({ path: `.told/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
			]
		})
	};
	return cli;
}

export interface WorldOptions {
	/** Repositories by their main checkout, with the names of their worktrees. */
	readonly repositories?: { readonly [main: string]: readonly string[] };
	/** The main checkouts of those repositories that have no commit yet. */
	readonly unborn?: readonly string[];
	/** The CLIs this machine has, by id: `arg` and `told` unless set. */
	readonly clis?: readonly string[];
	/** Where the repositories' `info/exclude` files are: in the world's own folder unless set. */
	readonly gitDir?: string;
	/** The record of what Facade put into folders: the world's own unless set, for windows that share one. */
	readonly injected?: string;
	/** How long a new agent may take to come up, where not two minutes. */
	readonly startTimeoutMs?: number;
	/** The environment the agents' terminals start with: none of the person's home folders. */
	readonly environment?: () => Environment;
	/** Whether a process the ledger's lock names runs, as the operating system says unless set. */
	readonly isRunning?: (pid: number) => boolean;
	/** Who opens the ledger: the workspace `lab`'s window unless set. */
	readonly owner?: string;
	/** The load of the window it opens in: a new one for each world unless set. */
	readonly session?: string;
}

/** How many worlds were made: each one a new load of the window. */
let loads = 0;

/**
 * The core over a workspace in `dir`, with a window in memory: each port records what it was asked
 * and answers as a test set it up. Its CLIs' launches are only computed, never run; a test changes the
 * person's settings of them as it goes, in `settings` - by a CLI's section, then a setting's name, each
 * as the window gives it, its default `{}` or `''` taking nothing away - and how long a new agent has
 * to come up, in `timing`. Arg Code keeps its trust in `<dir>/arg-home` where its environment does not
 * say.
 */
export function fakeWorld(dir: string, options: WorldOptions = {}) {
	const table = AgentTable.open({ dir, isRunning: options.isRunning, owner: options.owner ?? 'lab', session: options.session ?? `load-${++loads}` });
	const terminals = new FakeTerminals();
	const git = new FakeGit(options.repositories ?? {}, options.gitDir ?? path.join(dir, 'git'), options.unborn);
	const person = new FakePerson();
	const settings: { [section: string]: { [name: string]: unknown } } = {};
	const timing = { startTimeoutMs: options.startTimeoutMs ?? 120_000 };
	const known: readonly AgentCli[] = [argCli(path.join(dir, 'arg-home')), toldCli()];
	const configFor = (cli: AgentCli) => readCliConfig(cli, name => settings[cli.section]?.[name]);
	/** What the core wrote to its log, in order. */
	const logs: string[] = [];
	const facade = new Facade({
		table,
		ports: { terminals, git, person },
		clis: {
			known,
			installed: () => known.filter(cli => (options.clis ?? ['arg', 'told']).includes(cli.id)).map(cli => ({ cli, config: configFor(cli), executable: path.join(dir, 'bin', `${cli.id}.exe`) })),
			configOf: configFor,
			environment: options.environment ?? (() => ({}))
		},
		setup: {
			mcpServer: tokenFile => ({ command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' } }),
			sharedMcpServer: () => ({ command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--agent'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
			agentEnv: token => ({ FACADE_AGENTS_PIPE: 'pipe', FACADE_AGENTS_TOKEN: token }),
			skills: () => [{ name: 'facade', description: 'How to work in Facade Code.', body: '# Working in Facade Code' }],
			opening: (agent, parent) => `[facade] You are @${agent.name} #${agent.id}, ${agent.cliName}, started by @${parent.name}.`
		},
		timing: () => timing,
		log: message => logs.push(message),
		injected: options.injected ?? path.join(dir, 'injected.json')
	});
	return {
		table,
		facade,
		terminals,
		git,
		person,
		logs,
		settings,
		/** How long the core waits, as the person set it: a test changes it as it goes. */
		timing,
		/** The agent numbered `id`. */
		agent(id: number): Agent {
			const found = table.get(id);
			if (!found) {
				throw new Error(`no agent is #${id}`);
			}
			return found;
		},
		/** As the MCP server of agent `id` says hello: it is running. */
		hello(id: number): void {
			facade.connected(callerOf(this.agent(id)));
		},
		/**
		 * A spawn whose child's MCP server says hello once its terminal is launched, as a CLI's does: what
		 * the spawn answered, or its error. On a test's clock.
		 */
		async spawnUp(caller: Caller, request: SpawnRequest): Promise<Spawned> {
			const id = table.state.lastId + 1;
			let over = false;
			const spawning = facade.spawn(caller, request);
			spawning.then(() => over = true, () => over = true);
			await until(() => over || terminals.launched.some(launch => launch.name.startsWith(`@`) && launch.name.includes(` #${id} · `)));
			if (!over) {
				facade.connected(callerOf(this.agent(id)));
			}
			return settled(spawning);
		},
		/** As the window goes, or as Facade lets go of its agents while the window stays. */
		dispose(by?: ClosedBy): void {
			facade.dispose();
			table.dispose(by);
		}
	};
}
