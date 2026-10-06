/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { messageOf } from '../base/errors';
import { isEqualPath } from '../base/files';
import { withFileLock } from '../base/lock';
import { AgentCli, Environment, InstalledCli } from '../clis/cli';
import { whyNotInstalled } from '../clis/config';
import { writeTrust } from '../clis/trust';
import { Caller, Exit, ExitKind, isLive, LiveProcess, MadeWorktree, Process, ProcessState, YOU_PID } from '../record/events';
import { injectedFile } from '../record/paths';
import { agentName, nameOfWorktree, ProcessTable } from '../record/processes';
import { FacadeError } from './errors';
import { Injections } from './injections';
import { Launcher } from './launch';
import { AgentSetup, CliCatalog, Disposable, Ports, Repository, TerminalEnd, Timing } from './ports';

/**
 * How often, and how many times, the folders Facade made that a process of an exited agent still had
 * in use are tried again: three minutes, past the two an MCP server of Facade's waits for its window
 * where the person sets nothing else. The next window to start tries too.
 */
const TAKE_BACK_AGAIN_MS = 15_000;
const TAKE_BACK_TRIES = 12;
/** A PID, as a tool is given one. */
const PID = /^\d+$/;

/** What the core is made with: the record, the window's ports, the CLIs, and what agents are given. */
export interface FacadeOptions {
	readonly table: ProcessTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	readonly setup: AgentSetup;
	readonly log: (message: string) => void;
	/** The record of the files Facade put into folders, which every window shares: by default `~/.facade/injected.json`. */
	readonly injected?: string;
	/** How long the core waits, as the person sets it; where left out, two minutes for a new process to come up. */
	readonly timing?: () => Timing;
}

/** What a caller asks `spawn` for: the CLI, its model and how hard it thinks, the task, where the child works, and its name. */
export interface SpawnRequest {
	/** The CLI, by its id. */
	readonly cli: string;
	/** The model and the effort as the CLI takes them: Facade passes them on as they are, and the CLI refuses one it does not have. */
	readonly model: string;
	readonly effort: string;
	/** Its task, if it is given one. */
	readonly prompt?: string;
	/** Omitted: the caller's folder; `new`: a new worktree on the branch `name`; else a worktree of the caller's repository, by name. */
	readonly worktree?: string;
	readonly name?: string;
	/** The folder the person starts an agent in, the one on screen: the person has none of their own. */
	readonly folder?: string;
}

/** What `spawn` answers with: the process started, and where it works. */
export interface Spawned {
	readonly pid: number;
	readonly name: string;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	/** Whether its worktree was made for it, on the new branch `worktree`. */
	readonly newWorktree: boolean;
}

/** One line of `ps`: a process as it is now. */
export interface ProcessRow {
	readonly pid: number;
	/** Its parent now: the process that spawned it while that one runs, else the person. */
	readonly ppid: number;
	readonly name: string;
	readonly state: ProcessState;
	readonly cli: string;
	readonly model: string;
	/** None for a process a ledger of an older Facade recorded. */
	readonly effort?: string;
	readonly worktree: string;
	readonly folder: string;
	readonly startTime: number;
	readonly exit?: Exit;
}

/** What `kill` answers with: the process, and how it exited. */
export interface Killed {
	readonly pid: number;
	readonly name: string;
	/** Whether it had exited before the call: then its exit says how. */
	readonly alreadyExited: boolean;
	readonly exit: Exit;
}

/** Where a child starts: a folder there is, or a worktree to make. */
type Place =
	| { readonly kind: 'folder'; readonly folder: string; readonly worktree: string }
	| { readonly kind: 'new'; readonly repository: Repository; readonly head: string; readonly branch: string };

/**
 * Facade, the kernel of AGENT-FRAMEWORK.md: it starts agents as processes, keeps their table, and ends
 * them, as Linux does. A process has a PID no other gets, a parent, and children; the person is PID 1,
 * who takes in the orphans. Facade knows what it did and what is certain - a process started, its MCP
 * server said hello, its terminal ended - and never what a process is doing: whether it works or waits
 * is its parent's to find out. Every caller comes through here - the contract for an agent's tool
 * calls, Start Agent for the person - and it reaches the window only through its ports.
 */
export class Facade implements Disposable {

	private readonly table: ProcessTable;
	private readonly ports: Ports;
	private readonly disposables: Disposable[] = [];
	/** What this window put into folders for its agents, beside what other windows did. */
	private readonly injections: Injections;
	private readonly launcher: Launcher;
	/** When the folders a process had in use are tried again, while some are. */
	private takingBack: ReturnType<typeof setTimeout> | undefined;
	private takeBackTriesLeft = 0;
	private disposed = false;

	constructor(private readonly options: FacadeOptions) {
		this.table = options.table;
		this.ports = options.ports;
		this.injections = new Injections(options.injected ?? injectedFile(), this.table.dir, message => this.log(message), text => this.ports.person.tell(text, undefined));
		this.launcher = new Launcher({
			table: this.table,
			ports: this.ports,
			clis: options.clis,
			setup: options.setup,
			injections: this.injections,
			...(options.timing ? { timing: options.timing } : {}),
			terminalOf: process => this.terminalOf(process),
			fail: (process, reason) => this.fail(process, reason),
			log: message => this.log(message)
		});
		this.disposables.push(this.launcher, this.ports.terminals.onDidEnd((terminal, end) => this.terminalEnded(terminal, end)));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		clearTimeout(this.takingBack);
		this.takingBack = undefined;
	}

	/** The process with the PID `pid`, exited or not. */
	process(pid: number): Process | undefined {
		return this.table.get(pid);
	}

	/** The process a caller is; undefined for the person. */
	processOf(caller: Caller): Process | undefined {
		return caller.pid === YOU_PID ? undefined : this.table.get(caller.pid);
	}

	/** A CLI's name for people, by its id. */
	cliName(id: string): string {
		return this.cliOf(id)?.displayName ?? id;
	}

	/** The CLIs Facade can start on this machine. */
	clis(): readonly InstalledCli[] {
		return this.options.clis.installed();
	}

	/**
	 * A process's MCP server said hello to Facade: it is running. One told of its task in its terminal is
	 * told now; then it is up.
	 */
	connected(caller: Caller): void {
		const process = this.processOf(caller);
		if (!this.disposed && process?.state === 'starting') {
			this.launcher.hello(process);
		}
	}

	/**
	 * Starts a child of the caller in its own UI: beside it, in a worktree of its repository, or in a new
	 * worktree on the branch `name`, at the caller's HEAD. Answers once the child is up, with its PID; a
	 * child that exits before fails the call. Once begun, a spawn is carried through: a caller that exits
	 * meanwhile leaves its child to the person. Its model and effort go to its CLI as they are: the CLI is
	 * the one that knows which it has.
	 */
	async spawn(caller: Caller, request: SpawnRequest, progress?: (message: string) => void): Promise<Spawned> {
		const installed = this.installed(request.cli);
		const { displayName } = installed.cli;
		const model = request.model.trim();
		if (!model) {
			throw new FacadeError('INVALID', `model is required: one of ${displayName}'s models, as ${displayName} takes it.`);
		}
		const effort = request.effort.trim();
		if (!effort) {
			throw new FacadeError('INVALID', `effort is required: how hard the child thinks, as ${displayName} takes it - low, medium, high and so on.`);
		}
		const name = request.name === undefined ? undefined : this.nameOf(request.name);
		const home = this.processOf(caller)?.folder ?? request.folder;
		if (home === undefined) {
			throw new FacadeError('INVALID', 'The person has no folder of their own: start an agent with Facade: Start Agent, in the folder on screen.');
		}
		// Everything that can refuse the call is asked before anything is made for it.
		const place = await this.placeOf(caller, home, request.worktree, name);
		this.stillOpen();
		const env = this.environmentOf(installed);
		this.launcher.check(installed, model, effort, home, request.prompt, env);

		let folder: string;
		let worktree: string;
		if (place.kind === 'new') {
			progress?.(`Making the worktree ${place.branch}.`);
			try {
				folder = await this.ports.git.makeWorktree(place.repository.main, place.branch, place.head);
			} catch (err) {
				throw new FacadeError('FAILED', `The worktree ${place.branch} could not be made: ${messageOf(err)}`);
			}
			this.stillOpen();
			worktree = place.branch;
			this.table.recordWorktree({ name: worktree, folder, repository: place.repository.main, parentWorktree: place.repository.worktree, madeBy: caller.pid });
		} else {
			({ folder, worktree } = place);
		}

		// In a worktree Facade made, the CLI is given the person's trust in it, so that it does not stop to ask.
		const made = this.table.madeWorktree(folder);
		if (made) {
			this.trust(installed, made, env);
		}
		const process = await this.launcher.launch(caller, installed, { name: name ?? nameOfWorktree(worktree), model, effort, prompt: request.prompt, worktree, folder, trusted: !!made }, progress);
		return { pid: process.pid, name: process.name, cli: process.cli, model: process.model, effort, worktree: process.worktree, folder: process.folder, newWorktree: place.kind === 'new' };
	}

	/**
	 * The process table as the caller sees it: itself, its parent, and its children - those it spawned,
	 * exited ones too, and those that are its own now; with `all`, every process the workspace has had.
	 * By PID.
	 */
	ps(caller: Caller, all = false): ProcessRow[] {
		const self = this.processOf(caller);
		const parent = self && this.table.parentOf(self);
		return [...this.table.state.processes.values()]
			.filter(process => all
				|| process.pid === caller.pid
				|| process.pid === parent
				|| process.ppid === caller.pid
				|| (isLive(process) && this.table.parentOf(process) === caller.pid))
			.sort((a, b) => a.pid - b.pid)
			.map(process => ({
				pid: process.pid,
				ppid: this.table.parentOf(process),
				name: process.name,
				state: process.state,
				cli: process.cli,
				model: process.model,
				...(process.effort !== undefined ? { effort: process.effort } : {}),
				worktree: process.worktree,
				folder: process.folder,
				startTime: process.startTime,
				...(process.exit ? { exit: process.exit } : {})
			}));
	}

	/**
	 * Ends one of the caller's children, as `kill` ends a process: its CLI ends and its terminal closes;
	 * its folder stays as it is. Its own children run on, and are the person's now. The person ends any
	 * process.
	 */
	async kill(caller: Caller, target: string): Promise<Killed> {
		this.stillOpen();
		const process = this.processNamed(target);
		if (caller.pid !== YOU_PID && this.table.parentOf(process) !== caller.pid) {
			throw new FacadeError('REFUSED', `${describe(process)} is not your child: an agent kills only its own children, and the person any. ${this.childrenOfText(caller)}`);
		}
		if (process.exit) {
			return { pid: process.pid, name: process.name, alreadyExited: true, exit: process.exit };
		}
		const exit = this.exited(process, 'killed', `killed by ${describe(caller)}`, caller.pid === YOU_PID);
		// Only a window that closed records nothing for a process that has not exited.
		if (!exit) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
		// Recorded as killed already: a terminal that would not close is the log's to say, not the call's.
		try {
			await this.ports.terminals.stop(this.terminalOf(process));
		} catch (err) {
			this.log(`${this.terminalOf(process)} could not be closed: ${messageOf(err)}`);
		}
		return { pid: process.pid, name: process.name, alreadyExited: false, exit };
	}

	/**
	 * After a reload or a restart: a process whose terminal is gone has exited. One that was starting is
	 * waited for again, its MCP server's hello coming to this window; one not yet told of its task is told
	 * now. What windows that closed left in folders is taken back.
	 */
	async recover(): Promise<void> {
		if (this.sweep()) {
			this.takeBackLater();
		}
		// A worktree Facade made that is gone - deleted by the person, or by git - is its no more.
		for (const made of [...this.table.state.worktrees.values()]) {
			if (!fs.existsSync(made.folder)) {
				this.table.forgetWorktree(made.folder);
			}
		}
		for (const process of this.liveProcesses()) {
			// One whose terminal the window does not answer for keeps neither the others nor Facade from coming back.
			try {
				if (await this.ports.terminals.isAlive(this.terminalOf(process))) {
					this.launcher.resume(process);
				} else {
					this.exited(process, process.state === 'starting' ? 'failed' : 'exited', 'its terminal was gone when the window came back');
				}
			} catch (err) {
				this.log(`Coming back to ${this.terminalOf(process)} failed: ${messageOf(err)}`);
			}
			if (this.disposed) {
				return;
			}
		}
		// What was put into a folder whose agents exited while no window was there to see it.
		for (const folder of this.injections.held()) {
			this.withdraw(folder);
		}
	}

	/** Where a child of the caller starts: in `home`, a worktree of its repository, or a new worktree to make. */
	private async placeOf(caller: Caller, home: string, worktree: string | undefined, name: string | undefined): Promise<Place> {
		if (worktree === undefined) {
			return { kind: 'folder', folder: home, worktree: this.processOf(caller)?.worktree ?? await this.worktreeOf(home) };
		}
		if (worktree === 'new' && name === undefined) {
			throw new FacadeError('INVALID', 'name is required with worktree "new": the new worktree\'s branch is named after the child.');
		}
		const repository = await this.ports.git.repositoryOf(home);
		if (!repository) {
			throw new FacadeError('REFUSED', `${home} is in no git repository, so it has no worktrees: start the child there, without worktree.`);
		}
		if (worktree === 'new' && name !== undefined) {
			if (repository.head === undefined) {
				throw new FacadeError('REFUSED', `${home} is on a branch with no commit yet, or one git cannot read: a new worktree starts at a commit.`);
			}
			return { kind: 'new', repository, head: repository.head, branch: name };
		}
		const listed = await this.ports.git.worktreesOf(repository.main);
		const found = listed.find(each => each.name === worktree);
		if (!found) {
			throw new FacadeError('NOT_FOUND', `No worktree of ${path.basename(repository.main)} is called ${worktree}. Its worktrees: ${listed.map(each => each.name).join(', ')}.`);
		}
		return { kind: 'folder', folder: found.folder, worktree: found.name };
	}

	/** An agent's terminal ended: its process exited, unless it had already. */
	private terminalEnded(terminal: string, end: TerminalEnd): void {
		const process = this.liveProcesses().find(each => this.terminalOf(each) === terminal);
		if (!process) {
			return;
		}
		try {
			if (end.byThePerson) {
				this.exited(process, 'killed', 'the person closed its terminal', true);
			} else {
				this.exited(process, process.state === 'starting' ? 'failed' : 'exited', end.exitCode !== undefined ? `its CLI ended with exit code ${end.exitCode}` : 'its terminal closed');
			}
		} catch (err) {
			this.log(`Recording that ${terminal} ended failed: ${messageOf(err)}`);
		}
	}

	/**
	 * Records how a process exited - once - and takes back what was put into its folder once no process
	 * runs there. The person hears of a child of theirs that exited without their doing, and of the
	 * children that are theirs now; an agent parent sees it in `ps`. Answers with its exit; undefined for
	 * a process that had exited already, or once the window closed.
	 */
	private exited(process: Process, kind: ExitKind, reason: string, byThePerson = false): Exit | undefined {
		if (this.disposed) {
			return undefined;
		}
		const parent = this.table.parentOf(process);
		const orphans = this.table.childrenOf(process.pid);
		const waiter = this.launcher.waiterOf(process.pid);
		const exit = this.table.setExited(process.pid, kind, reason);
		if (!exit) {
			return undefined;
		}
		this.log(`${this.terminalOf(process)} exited (${kind}): ${reason}`);
		this.launcher.ended(process.pid, reason);
		this.withdraw(process.folder);
		// A spawn of the person's tells them itself.
		if (parent === YOU_PID && !byThePerson && waiter !== YOU_PID) {
			this.ports.person.tell(l10n.t("@{0} (PID {1}) exited: {2}.", process.name, process.pid, reason), undefined);
		}
		if (orphans.length) {
			this.ports.person.tell(l10n.t("@{0} (PID {1}) exited, and its children are yours now: {2}.", process.name, process.pid, orphans.map(describe).join(', ')), this.terminalOf(orphans[0]));
		}
		return exit;
	}

	/** Ends a process that did not come up, or could not be told of its task: recorded as failed, and its terminal closed. */
	private async fail(process: Process, reason: string): Promise<void> {
		if (!this.exited(process, 'failed', reason)) {
			return;
		}
		try {
			await this.ports.terminals.stop(this.terminalOf(process));
		} catch (err) {
			this.log(`${this.terminalOf(process)} could not be closed: ${messageOf(err)}`);
		}
	}

	/**
	 * Gives a CLI that keeps it in a file the person's trust in a worktree Facade made, as its
	 * `launch.trust` says: in the file the CLI reads in `env`, the environment it starts with.
	 */
	private trust({ cli, config }: InstalledCli, made: MadeWorktree, env: Environment): void {
		try {
			// Under a lock every window takes: two windows trusting worktrees at once each keep the other's.
			const done = writeTrust(cli, config, { folder: made.folder, repository: made.repository }, withFileLock, env);
			if (done) {
				this.log(done);
			}
		} catch (err) {
			// It asks on its own screen instead, where the person answers.
			this.log(`${cli.displayName}'s trust in ${made.folder} could not be written: ${messageOf(err)}`);
		}
	}

	/** Takes back what Facade put into a folder for this window's agents, once none of them runs there. */
	private withdraw(folder: string): void {
		if (this.liveProcesses().some(process => isEqualPath(process.folder, folder))) {
			return;
		}
		try {
			if (this.injections.release(folder)) {
				this.takeBackLater();
			}
		} catch (err) {
			this.log(`What Facade put into ${folder} could not be taken back: ${messageOf(err)}`);
		}
	}

	/** Takes back what only windows that closed hold; answers whether folders a process had in use are left. */
	private sweep(): boolean {
		try {
			return this.injections.sweep();
		} catch (err) {
			this.log(`What windows that closed left in folders could not be taken back: ${messageOf(err)}. The next window tries again.`);
			return false;
		}
	}

	/**
	 * Tries again, a while on, to remove the folders Facade made that a process of an exited agent had in
	 * use - its CLI's, a moment from its end - while some are left: each time some are left in use, for
	 * another {@link TAKE_BACK_TRIES} tries.
	 */
	private takeBackLater(): void {
		this.takeBackTriesLeft = TAKE_BACK_TRIES;
		if (this.disposed || this.takingBack) {
			return;
		}
		const tryAgain = () => {
			this.takingBack = setTimeout(() => {
				this.takingBack = undefined;
				if (this.sweep() && --this.takeBackTriesLeft > 0 && !this.disposed) {
					tryAgain();
				}
			}, TAKE_BACK_AGAIN_MS);
		};
		tryAgain();
	}

	/** The CLI with the id `id` on this machine; where it has none, why, and the CLIs it has. */
	private installed(id: string): InstalledCli {
		const installed = this.options.clis.installed();
		const found = installed.find(each => each.cli.id === id);
		if (!found) {
			const known = this.cliOf(id);
			const why = known ? `: ${whyNotInstalled(known, this.options.clis.configOf(known))}` : '';
			throw new FacadeError('UNAVAILABLE', installed.length
				? `Facade cannot start ${id} here${why}. It starts: ${installed.map(each => each.cli.id).join(', ')}.`
				: `Facade cannot start ${id} here${why}. None of the CLIs it starts is on this machine.`);
		}
		return found;
	}

	/** The environment a CLI starts with: the terminals', with what its launch sets in it. */
	private environmentOf(installed: InstalledCli): Environment {
		return { ...this.options.clis.environment(), ...installed.config.launch.environment };
	}

	/** The process a tool names: by its PID, or by `@name` where one process that has not exited has that name. */
	private processNamed(target: string): Process {
		const text = target.trim();
		if (PID.test(text)) {
			const pid = Number(text);
			if (pid === YOU_PID) {
				throw new FacadeError('REFUSED', 'PID 1 is the person, whom no agent ends.');
			}
			const process = this.table.get(pid);
			if (!process) {
				throw new FacadeError('NOT_FOUND', `No process has PID ${pid}: ps with all lists every process this workspace has had.`);
			}
			return process;
		}
		const name = text.replace(/^@/, '').toLowerCase();
		const named = this.table.liveNamed(name);
		if (named.length > 1) {
			throw new FacadeError('INVALID', `${named.length} running processes are called @${name}: ${named.map(describe).join(', ')}. Name one by its PID.`);
		}
		if (!named.length) {
			throw new FacadeError('NOT_FOUND', `No running process is called @${name}: name an exited one by its PID, which ps with all lists.`);
		}
		return named[0];
	}

	/** Whom the caller can kill, for a refusal to name. */
	private childrenOfText(caller: Caller): string {
		const children = this.table.childrenOf(caller.pid).map(describe);
		return children.length ? `Your running children: ${children.join(', ')}.` : 'You have no running children.';
	}

	private nameOf(text: string): string {
		try {
			return agentName(text);
		} catch (err) {
			throw new FacadeError('INVALID', messageOf(err));
		}
	}

	/** The name of the worktree `folder` is: `main`, its branch, or the folder's own name outside a repository. */
	private async worktreeOf(folder: string): Promise<string> {
		return (await this.ports.git.repositoryOf(folder))?.worktree ?? path.basename(folder);
	}

	/** A CLI Facade knows, by its id. */
	private cliOf(id: string): AgentCli | undefined {
		return this.options.clis.known.find(cli => cli.id === id);
	}

	/** The name of the terminal a process runs in: unique per process, and the same after a reload. */
	private terminalOf(process: Process): string {
		return `@${process.name} (${process.pid}) · ${this.cliName(process.cli)}`;
	}

	private liveProcesses(): LiveProcess[] {
		return [...this.table.state.processes.values()].filter(isLive);
	}

	private log(message: string): void {
		this.options.log(message);
	}

	/** After each of its waits: a window that closed meanwhile does nothing more, and says so. */
	private stillOpen(): void {
		if (this.disposed) {
			throw new FacadeError('UNAVAILABLE', 'The window closed meanwhile, and does nothing more: try again once it is open.');
		}
	}
}

/** A process or the person, as Facade's words name them: `@name (PID 7)`, or `the person`. */
function describe(who: { readonly pid: number; readonly name: string }): string {
	return who.pid === YOU_PID ? 'the person' : `@${who.name} (PID ${who.pid})`;
}
