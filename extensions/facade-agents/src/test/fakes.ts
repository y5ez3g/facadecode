/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { isProcessRunning } from '../base/system';
import { AgentCli, Environment, launchArgs, skillMarkdown } from '../clis/cli';
import { readCliConfig } from '../clis/config';
import { customAgentOf } from '../clis/custom';
import { Facade, StartRequest, Started } from '../core/facade';
import { customAgentNameProblem } from '../core/launch';
import { Fetched, FetchRequest } from '../core/mail';
import { Disposable, EndedAgent, EndTold, Git, InputEffect, KeysOptions, ListedWorktree, MadeWorktreeFolder, Notification, Person, PersonInput, Repository, SetupOutcome, SetupProgress, Severity, StopSignal, TerminalEnd, TerminalLaunch, Terminals, TerminalScreen, TerminalsInside, TypeOptions, WorktreeChanges, WorktreeDeletion } from '../core/ports';
import { AgentTable } from '../record/agents';
import { Agent, Caller } from '../record/events';
import { ClosedBy, Ledger } from '../record/ledger';
import { FACADE, MailboxEntry, Message, MessageRecord, NewMessage } from '../record/messages';
import { settled, until } from './clock';

/** The window's terminals, in memory: what was launched, typed and closed, and which run. */
/**
 * The agents' terminals in a window in memory, each by the agent's number. The tests name them by their
 * titles - `@main #a1` - whose number is the agent's: a terminal of a run's own process comes
 * back after a reload under the title a test gives it.
 */
/** The processes the fake terminals of every world run, by their ids: above any id a system gives. */
const FAKE_PROCESSES = new Set<number>();
let lastFakeProcess = 5_000_000;

/** Ends a fake terminal's process, as a signal it cannot ignore would - or the pty host ending it, unseen by the window. */
export function endFakeProcess(pid: number): void {
	FAKE_PROCESSES.delete(pid);
}

/** A process of the test's own, running until `endFakeProcess` ends it: an agent's MCP server, say. */
export function startFakeProcess(): number {
	const pid = ++lastFakeProcess;
	FAKE_PROCESSES.add(pid);
	return pid;
}

/** Whether a process runs: one of a fake terminal's while it does, else as the operating system says. */
export function isFakeProcessRunning(pid: number): boolean {
	return FAKE_PROCESSES.has(pid) || (pid <= 5_000_000 && isProcessRunning(pid));
}

export class FakeTerminals implements Terminals {

	readonly launched: TerminalLaunch[] = [];
	/** The process each agent's terminal runs, by the agent's number. */
	readonly processes = new Map<number, number>();
	/** While set, a launch does not say its process's id, as a terminal on Windows whose CLI has shown nothing yet. */
	noProcessIds = false;
	/** The titles of the terminals whose agents' processes run. */
	readonly running = new Set<string>();
	/** What was typed into each terminal, and the keys pressed there, and which were closed, by their titles. */
	readonly typed: string[] = [];
	/** Each text typed, into which agent's terminal, and whether Enter went after it. */
	readonly texts: { readonly id: number; readonly text: string; readonly enter: boolean }[] = [];
	/** How each text was asked to be typed, in order: every call, whether it went in or not. */
	readonly typeOptions: TypeOptions[] = [];
	/** What each agent's terminal shows, by its number: none for an empty screen. */
	readonly screens = new Map<number, TerminalScreen>();
	/** The terminals the window was told the final screens of, after a reload: `#a<id> <file>`. */
	readonly registered: string[] = [];
	/** What the next texts typed and keys pressed answer with, in turn - an effect, or an error thrown - where not all went in. */
	readonly nextInput: (InputEffect | Error)[] = [];
	/** While set, a text typed goes in once it settles, as the window's queue holds it: behind the person, or behind Facade's own. */
	typing: Promise<void> | undefined;
	/** What holds Facade's input into each agent's terminal back, by its number, as the window tells it: nothing unless a test sets it. */
	readonly inputs = new Map<number, PersonInput>();
	/** The next launch fails with this. */
	failNext: string | undefined;
	/** While set, a stop leaves the process running, as one that will not end. */
	stubborn = false;
	/** While set, a launch waits for it before its terminal opens, as a window slow to make one. */
	hold: Promise<void> | undefined;
	/** While set, called with each launch as it reaches the window, before its terminal opens. */
	beforeLaunch: ((launch: TerminalLaunch) => void) | undefined;
	/** The agents whose processes the window cannot tell of, by number: asked whether one runs, it rejects. */
	readonly untold = new Set<number>();
	/** The agents whose terminals were put in front, by number, in order. */
	readonly revealed: number[] = [];
	private readonly listeners = new Set<(id: number, end: TerminalEnd) => void>();

	async launch(launch: TerminalLaunch): Promise<{ readonly processId?: number }> {
		const failure = this.failNext;
		this.failNext = undefined;
		if (failure) {
			throw new Error(failure);
		}
		this.beforeLaunch?.(launch);
		await this.hold;
		this.launched.push(launch);
		this.running.add(launch.name);
		const processId = startFakeProcess();
		this.processes.set(launch.id, processId);
		return this.noProcessIds ? {} : { processId };
	}

	async isAlive(id: number): Promise<boolean> {
		this.asking++;
		this.mostAsking = Math.max(this.mostAsking, this.asking);
		try {
			await this.answering;
			if (this.untold.has(id)) {
				throw new Error('the window cannot tell whether its process runs');
			}
			return this.titleOf(id) !== undefined;
		} finally {
			this.asking--;
		}
	}

	/** The process of agent `id`'s terminal, as the window had it when `isAlive` found it running; none for one not running. */
	processIdOf(id: number): number | undefined {
		return this.titleOf(id) === undefined ? undefined : this.processes.get(id);
	}

	/** While set, the window answers whether a process runs once it settles. */
	answering: Promise<void> | undefined;
	/** How many asked whether their process runs at once, now and at most. */
	private asking = 0;
	mostAsking = 0;

	/** How the processes that ended while no extension host watched ended, as the window saw it: set by a test. */
	readonly seenEnds = new Map<number, TerminalEnd>();

	endOf(id: number): TerminalEnd | undefined {
		return this.seenEnds.get(id);
	}

	/** Whether letting go of a listener throws, as a subscription of a window going may. */
	disposeThrows = false;

	onDidEnd(listener: (id: number, end: TerminalEnd) => void): Disposable {
		this.listeners.add(listener);
		return {
			dispose: () => {
				if (this.disposeThrows) {
					throw new Error('the window is gone');
				}
				this.listeners.delete(listener);
			}
		};
	}

	/** As the window ends an agent's process for the extension: it tells of the end as of any other. */
	/** The signals each stop sent, in order: `#a<id> <signal>`. */
	readonly signals: string[] = [];

	/** The exit code each agent's process ends with when stopped, by its number: none unless a test says. */
	readonly exitCodes = new Map<number, number>();

	async stop(id: number, signal: StopSignal = 'SIGHUP'): Promise<{ readonly exitCode?: number }> {
		const title = this.titleOf(id);
		this.signals.push(`#a${id} ${signal}`);
		if (title === undefined) {
			return {};
		}
		// A stubborn process ignores the hang-up and termination; a kill it cannot ignore
		if (this.stubborn && signal !== 'SIGKILL') {
			throw new Error('its process has not ended yet');
		}
		this.typed.push(`${title}: [closed]`);
		const exitCode = this.exitCodes.get(id);
		this.end(title, { byThePerson: false, ...(exitCode !== undefined ? { exitCode } : {}) });
		return exitCode !== undefined ? { exitCode } : {};
	}

	/** The agents working inside each folder by their terminals' cwd, beyond those started there: this record's, how many of another's, and other windows' by their titles. */
	readonly working = new Map<string, Partial<TerminalsInside>>();

	async inside(folder: string): Promise<TerminalsInside> {
		const working = this.working.get(folder);
		return { agents: working?.agents ?? [], others: working?.others ?? 0, elsewhere: working?.elsewhere ?? [] };
	}

	async reveal(id: number): Promise<boolean> {
		this.revealed.push(id);
		return this.titleOf(id) !== undefined;
	}

	async read(id: number, lines: number, _waitMs: number): Promise<TerminalScreen | undefined> {
		if (this.titleOf(id) === undefined) {
			return undefined;
		}
		const screen = this.screens.get(id) ?? { lines: [], buffer: 'normal', older: false, trimmed: false, capturedAt: 1000, exited: false };
		return { ...screen, lines: screen.lines.slice(Math.max(0, screen.lines.length - lines)), older: screen.older || screen.lines.length > lines };
	}

	async type(id: number, text: string, options: TypeOptions): Promise<InputEffect | undefined> {
		this.typeOptions.push(options);
		if (this.titleOf(id) === undefined) {
			return undefined;
		}
		await this.typing;
		const title = this.titleOf(id);
		if (title === undefined) {
			return { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false };
		}
		const next = this.nextInput.shift();
		if (next instanceof Error) {
			throw next;
		}
		this.typed.push(`${title}: type ${JSON.stringify(text)}${options.enter ? `, Enter after ${options.enterDelayMs} ms` : ''}${options.queueTimeoutMs !== undefined ? `, waiting ${options.queueTimeoutMs} ms at most` : ''}`);
		this.texts.push({ id, text, enter: options.enter });
		return next ?? { outcome: 'applied', pasted: true, entered: options.enter };
	}

	async keys(id: number, keys: readonly string[], options: KeysOptions): Promise<InputEffect | undefined> {
		const title = this.titleOf(id);
		if (title === undefined) {
			return undefined;
		}
		const next = this.nextInput.shift();
		if (next instanceof Error) {
			throw next;
		}
		this.typed.push(`${title}: keys ${keys.join(' ')}${options.queueTimeoutMs !== undefined ? `, waiting ${options.queueTimeoutMs} ms at most` : ''}`);
		return next ?? { outcome: 'applied', keysSent: keys.length };
	}

	async input(id: number): Promise<PersonInput | undefined> {
		return this.titleOf(id) === undefined ? undefined : this.inputs.get(id) ?? { pending: false };
	}

	async register(id: number, finalScreen: string): Promise<boolean> {
		this.registered.push(`#a${id} ${finalScreen}`);
		return this.titleOf(id) !== undefined;
	}

	/** As when the window loses the terminal of that title - a reload that did not bring it back - its process running on. */
	lose(title: string): void {
		this.running.delete(title);
	}

	/**
	 * As when a terminal closes, or its process exits: the terminal of that title. `processRunsOn`: its process
	 * outlives the terminal, as a CLI that ignores the hang-up does.
	 */
	end(title: string, end: TerminalEnd = { byThePerson: false }, processRunsOn = false): void {
		if (this.running.delete(title)) {
			if (!processRunsOn) {
				FAKE_PROCESSES.delete(this.processes.get(idOf(title)) ?? 0);
			}
			for (const listener of [...this.listeners]) {
				listener(idOf(title), end);
			}
		}
	}

	/**
	 * As when a terminal the window had lost already - its typing failing - is said to have ended only now: its
	 * process gone, and the window telling of its end after (C4-09).
	 */
	endLost(title: string, end: TerminalEnd = { byThePerson: false }): void {
		this.running.delete(title);
		FAKE_PROCESSES.delete(this.processes.get(idOf(title)) ?? 0);
		for (const listener of [...this.listeners]) {
			listener(idOf(title), end);
		}
	}

	/** The title of the terminal of agent `id` whose process runs; undefined for none. */
	private titleOf(id: number): string | undefined {
		return [...this.running].find(title => idOf(title) === id);
	}
}

/** The agent's number a terminal's title says: `@main #a1` is #a1's. */
function idOf(title: string): number {
	const number = /#a(?<id>\d+)\b/.exec(title)?.groups?.id;
	if (number === undefined) {
		throw new Error(`${title} is no agent's terminal`);
	}
	return Number(number);
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
	/** While set, a worktree being made is answered for once it settles: git has made it by then. */
	making: Promise<void> | undefined;
	/** While set, a worktree to make waits for it before git is asked: in the window's queue, its branch not made yet. */
	queued: Promise<void> | undefined;
	/** What could not be copied into a worktree made, and how a hook failed, as the window answers. */
	copyFailures: readonly string[] = [];
	hookFailure: string | undefined;
	/** How the setup of a worktree made comes out, once it settles: none to run unless a test says. */
	setup: SetupOutcome | Promise<SetupOutcome> = { kind: 'none' };
	/** What deleting a worktree would lose, by its folder: nothing unless a test says. */
	readonly changes = new Map<string, WorktreeChanges>();
	/**
	 * What the window's own check of a deletion finds that the extension host never sees - an unsaved image in its image
	 * editor, say - by the worktree's folder, as the window words it: nothing unless a test says.
	 */
	readonly windowOnlyLoss = new Map<string, readonly string[]>();
	/** Where the setup of each worktree is while it runs, by its folder, as the window tells it: none unless a test says. */
	readonly setupStates = new Map<string, SetupProgress>();
	/** While set, deleting a worktree fails with this. */
	failDelete: string | undefined;
	/**
	 * While set, deleting a worktree fails with this before anything that goes with it is stopped: the window could not move
	 * off it, or the workspace did not let it go (WORKTREE.md WT-8, steps 4 and 5).
	 */
	failBeforeStopping: string | undefined;
	/** Whether a deletion that fails gets as far as git forgetting the worktree, its folder left: a file it cannot delete. */
	failAfterForgetting = false;
	private readonly worktrees = new Map<string, ListedWorktree[]>();
	/** The branches of each repository that no worktree has checked out, by its main checkout. */
	private readonly otherBranches = new Map<string, Set<string>>();
	/** The HEAD of each worktree, by its folder, where it is not the world's `head`. */
	private readonly heads = new Map<string, string>();

	/**
	 * `repositories`: by their main checkouts, on the branch `main`, the branches of their other worktrees,
	 * each in a folder of its name. `gitDir` holds each repository's `info/exclude`, by its main checkout's
	 * name; `unborn` are those with no commit yet.
	 */
	constructor(repositories: { readonly [main: string]: readonly string[] }, private readonly gitDir: string, private readonly unborn: readonly string[] = [], readonly head = 'a'.repeat(40)) {
		for (const [main, branches] of Object.entries(repositories)) {
			this.worktrees.set(main, [{ name: 'main', branch: 'main', folder: main }, ...branches.map(branch => ({ name: branch, branch, folder: worktreeFolder(main, branch) }))]);
			// On the disk, as git would have them
			for (const branch of branches) {
				fs.mkdirSync(worktreeFolder(main, branch), { recursive: true });
			}
		}
	}

	/** The worktree of `main` on `branch` is on a detached HEAD from now on: no branch, its label its folder's name. */
	detach(main: string, branch: string): void {
		this.worktrees.set(main, (this.worktrees.get(main) ?? []).map(each => each.branch === branch ? { name: path.basename(each.folder), folder: each.folder } : each));
	}

	/** `main` has a branch no worktree has checked out. */
	addBranch(main: string, branch: string): void {
		this.otherBranches.set(main, new Set([...this.otherBranches.get(main) ?? [], branch]));
	}

	/** The HEAD of the worktree at `folder` - a main checkout's too - is `head`, not the world's. */
	setHead(folder: string, head: string): void {
		this.heads.set(folder, head);
	}

	/** A worktree of `main` on `branch`, at `folder`, which git was forced to check out there too. */
	addWorktree(main: string, branch: string, folder: string): void {
		fs.mkdirSync(folder, { recursive: true });
		this.worktrees.set(main, [...this.worktrees.get(main) ?? [], { name: branch, branch, folder }]);
	}

	async repositoryOf(folder: string): Promise<Repository | undefined> {
		const found = this.worktreeAt(folder);
		return found && { main: found.main, mainCheckout: found.main === found.worktree.folder, worktree: found.worktree.name, head: this.unborn.includes(found.main) ? undefined : this.heads.get(found.worktree.folder) ?? this.head };
	}

	async worktreeRootOf(folder: string): Promise<string | undefined> {
		return this.worktreeAt(folder)?.worktree.folder;
	}

	async worktreesOf(main: string): Promise<readonly ListedWorktree[]> {
		await this.hold;
		return this.worktrees.get(main) ?? [];
	}

	async hasBranch(main: string, branch: string): Promise<boolean> {
		return (this.worktrees.get(main) ?? []).some(each => each.branch === branch) || !!this.otherBranches.get(main)?.has(branch);
	}

	async whyNotBranchName(_main: string, branch: string): Promise<string | undefined> {
		return branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('.') ? `git does not take ${JSON.stringify(branch)} for a branch's name` : undefined;
	}

	async changesIn(folder: string): Promise<WorktreeChanges> {
		return this.changes.get(folder) ?? { files: [], unsaved: [], submodules: [] };
	}

	/** What each deletion was told, by the worktree's folder. */
	readonly deletions = new Map<string, WorktreeDeletion>();
	/** While set, a deletion waits for it before git is asked: what goes with the worktree has stopped by then. */
	deleting: Promise<void> | undefined;
	/**
	 * A deletion's step 6, as the world wires it: Facade's agents working in the worktree stopped, and waited for - those
	 * still stopping answered (WORKTREE.md WT-8, step 6). None to stop unless wired.
	 */
	stopping: (folder: string) => Promise<{ readonly stopping: readonly string[]; readonly why?: string }> = async () => ({ stopping: [] });

	/** What the window's own check finds deleting the worktree `folder` would lose, `options` applied: as it words each. */
	async deletionLoss(folder: string, options: WorktreeDeletion): Promise<readonly string[]> {
		this.steps.push(`check the deletion of ${folder}`);
		const changes = this.changes.get(folder);
		return [...(options.leftover ? [] : changes?.files ?? []).filter(file => !options.ownFiles.some(owned => owned.path === file)), ...(changes?.unsaved ?? []).map(file => `${file} (unsaved)`), ...this.windowOnlyLoss.get(folder) ?? []];
	}

	async deleteWorktree(folder: string, options: WorktreeDeletion): Promise<void> {
		this.deletions.set(folder, options);
		const found = this.worktreeAt(folder);
		if (!options.leftover && (!found || found.main === found.worktree.folder)) {
			throw new Error(`${folder} is no worktree to delete`);
		}
		// As the window looks before it moves anything, and again once what ran in it has stopped: changes git would lose,
		// and what only the window sees, refuse it unless discarded (WT-8.10)
		const lost = () => options.discardChanges ? [] : [...(options.leftover ? [] : this.changes.get(folder)?.files ?? []).filter(file => !options.ownFiles.some(owned => owned.path === file)), ...this.windowOnlyLoss.get(folder) ?? []];
		const before = lost();
		if (before.length) {
			throw new Error(`${folder} has changes that deleting it would lose: ${before.join(', ')}`);
		}
		if (this.failBeforeStopping) {
			throw new Error(this.failBeforeStopping);
		}
		// Out of the workspace, what goes with it stops, and is waited for (WT-8, step 6)
		const stopped = await this.stopping(folder);
		if (stopped.stopping.length) {
			throw new Error(stopped.why ?? `${folder} was not deleted: ${stopped.stopping.join(', ')} still stopping`);
		}
		await this.deleting;
		const late = lost();
		if (late.length) {
			throw new Error(`${folder} was not deleted: changes came into it as it was being deleted, which deleting it would lose: ${late.join(', ')}`);
		}
		if (this.failDelete) {
			if (this.failAfterForgetting && found && !options.leftover) {
				this.worktrees.set(found.main, (this.worktrees.get(found.main) ?? []).filter(each => each.folder !== found.worktree.folder));
			}
			throw new Error(this.failDelete);
		}
		if (options.leftover) {
			this.steps.push(`delete what is left of ${folder}`);
		} else if (found) {
			this.steps.push(`delete ${folder}`);
			this.worktrees.set(found.main, (this.worktrees.get(found.main) ?? []).filter(each => each.folder !== found.worktree.folder));
		}
		fs.rmSync(folder, { recursive: true, force: true });
	}

	plannedWorktreeFolder(main: string, branch: string): string {
		return worktreeFolder(main, branch);
	}

	async makeWorktree(main: string, branch: string, startPoint: string): Promise<MadeWorktreeFolder> {
		await this.queued;
		const worktrees = this.worktrees.get(main) ?? [];
		if (await this.hasBranch(main, branch)) {
			throw new Error(`A branch named ${branch} already exists. Choose another name.`);
		}
		this.steps.push(`make ${branch} from ${startPoint.slice(0, 7)} in ${main}`);
		// A path that is taken gets -1, -2 and so on, as the window has it (WORKTREE.md, WT-2.3)
		let folder = worktreeFolder(main, branch);
		for (let suffix = 1; fs.existsSync(folder); suffix++) {
			folder = `${worktreeFolder(main, branch)}-${suffix}`;
		}
		fs.mkdirSync(folder, { recursive: true });
		worktrees.push({ name: branch, branch, folder });
		this.worktrees.set(main, worktrees);
		await this.making;
		return { folder, copyFailures: this.copyFailures, ...(this.hookFailure ? { hookFailure: this.hookFailure } : {}) };
	}

	async setupOutcome(folder: string): Promise<SetupOutcome> {
		this.steps.push(`set up ${folder}`);
		return await this.setup;
	}

	async setupState(folder: string): Promise<SetupProgress | undefined> {
		return this.setupStates.get(folder);
	}

	stopSetup(folder: string): void {
		this.steps.push(`stop setup ${folder}`);
	}

	async excludeOf(folder: string): Promise<{ readonly file: string; readonly root: string } | undefined> {
		const found = this.worktreeAt(folder);
		return found && { file: path.join(this.gitDir, path.basename(found.main), 'info', 'exclude'), root: found.worktree.folder };
	}

	/** With `commit`, the files tracked in `folder`, the main checkout, stand for the commit's. */
	/** What a commit's files hold, by `<commit>:<path>` from the repository's root - or by the path alone, every commit alike. */
	readonly committed = new Map<string, string>();

	/** What each leftover holds that its branch does not, by its folder: nothing unless a test says. */
	readonly leftoverWork = new Map<string, readonly string[]>();

	async leftoverWorkIn(_main: string, branch: string, folder: string): Promise<readonly string[]> {
		this.steps.push(`look at what is left of ${branch} in ${folder}`);
		return this.leftoverWork.get(folder) ?? [];
	}

	async fileAt(main: string, commit: string, file: string): Promise<string | undefined> {
		this.steps.push(`read ${file} at ${commit.slice(0, 7)} in ${main}`);
		return this.committed.get(`${commit}:${file}`) ?? this.committed.get(file);
	}

	async tracks(folder: string, files: readonly string[], commit?: string): Promise<ReadonlySet<string>> {
		if (commit !== undefined) {
			this.steps.push(`ls-tree ${commit.slice(0, 7)} in ${folder}`);
		}
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

/** The person: what Facade told them, the notifications they were shown, and the chat rooms they were taken to. */
export class FakePerson implements Person {

	readonly told: string[] = [];
	/** Every notification shown or updated, in order. */
	readonly notified: Notification[] = [];
	/** The notifications up now, by key. */
	readonly shown = new Map<string, Notification>();
	/** The chat rooms opened, each as its file's name and the message, in order. */
	readonly opened: string[] = [];
	private readonly answers = new Map<string, (button: string | undefined) => void>();
	/** The agents that ended the person was shown, in turn. */
	readonly ended: EndedAgent[] = [];

	/** The notices closed, each as `<key>: <text>`, in order. */
	readonly closed: string[] = [];
	/** What was last told or shown with each key, a notice's text or a notification's. */
	private readonly shownWith = new Map<string, string>();

	tell(text: string, agent: number | undefined, severity: Severity, key?: string): void {
		this.told.push(`${severity}: ${text}${agent !== undefined ? ` (#a${agent}'s terminal)` : ''}`);
		if (key !== undefined) {
			this.shownWith.set(key, text);
		}
	}

	/** As the window closes a notice: only while it is the one last shown with its key. */
	close(key: string, text: string): void {
		if (this.shownWith.get(key) === text) {
			this.shownWith.delete(key);
			this.closed.push(`${key}: ${text}`);
		}
	}

	/** The ends told together, by batch: each one's ends as last told. */
	readonly endsTold = new Map<string, readonly EndTold[]>();

	tellEnded(batch: string, ends: readonly EndTold[]): void {
		this.endsTold.set(batch, ends);
		// Told as each end comes: the newest, as a notice of its own reads
		const newest = ends[ends.length - 1];
		this.tell(newest.text, newest.agent, newest.severity);
	}

	notify(notification: Notification): Promise<string | undefined> {
		this.notified.push(notification);
		this.shownWith.set(notification.key, notification.text);
		this.answers.get(notification.key)?.(undefined);
		this.shown.set(notification.key, notification);
		return new Promise(resolve => this.answers.set(notification.key, resolve));
	}

	async openRoom(file: string, message: number): Promise<void> {
		this.opened.push(`${path.basename(file)} #m${message}`);
	}

	async showEnded(agent: EndedAgent): Promise<void> {
		this.ended.push(agent);
	}

	/** As the person presses a button of the notification up with that key: it closes. */
	press(key: string, button: string): void {
		const answer = this.answers.get(key);
		this.answers.delete(key);
		this.shown.delete(key);
		answer?.(button);
	}
}

/**
 * How recording a world's messages fails, where a test says: each message `fails` gives an error for, with that error;
 * each delivery of an agent's messages `deliveryFails` gives one for, with that one.
 */
interface Recording {
	fails?: (message: NewMessage) => Error | undefined;
	deliveryFails?: (agent: number, ids: readonly number[]) => Error | undefined;
}

/** A world's record of messages: Facade's own, but that recording one fails where `recording` says, as a disk that refuses the write would. */
class FallibleMessageRecord extends MessageRecord {

	constructor(dir: string, ledger: Ledger, private readonly recording: Recording) {
		super(dir, ledger);
	}

	override send(message: NewMessage): Message {
		const failure = this.recording.fails?.(message);
		if (failure) {
			throw failure;
		}
		return super.send(message);
	}

	override delivered(agent: number, ids: readonly number[]): void {
		const failure = this.recording.deliveryFails?.(agent, ids);
		if (failure) {
			throw failure;
		}
		super.delivered(agent, ids);
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
		setting: 'facade.agents.arg',
		command: 'arg',
		defaults: {
			path: '',
			enabled: true,
			launch: {
				arguments: { connect: ['--config', '${config}'], yoloOn: ['--yolo'], yoloOff: ['--sandbox', '--allow', 'facade'], model: ['--model', '${model}'], effort: ['--effort', '${effort}'], task: ['--', '${task}'] },
				environment: { ARG_QUIET: '1' },
				trust: { file: '${argHome}/trust.json', merge: { trusted: ['${repository}'] } },
				enterDelay: 300,
				taskDelay: 0,
				// Where nobody may be watching: its question tool taken away (AGENT-LAUNCHER.md, L4)
				unattended: { arguments: { questions: ['--no-ask'] }, environment: {} }
			}
		},
		trustValues: ({ repository }, env) => ({ argHome: env.ARG_HOME ?? home, repository }),
		// The person's own setting that takes its exemption away: a deny rule, where its environment names one
		exemptionOverride: (_config, env) => env.ARG_DENY ? `${env.ARG_DENY} denies mcp__facade` : undefined,
		// The person's own configuration of it: a server named facade in `own.conf` of its home, which its `--config` would merge into
		conflict: (args, _folder, env) => {
			const own = path.join(env.ARG_HOME ?? home, 'own.conf');
			return args.includes('--config') && fs.existsSync(own) ? `${own} has a server of its own named facade.` : undefined;
		},
		task: 'argument',
		sandbox: { yoloOn: 'off', yoloOff: 'on' },
		exemption: 'precise',
		questionTool: 'removed',
		launch: (input, executable) => {
			const config = path.join(input.runDir, `${input.slug}.config.json`);
			return {
				executable,
				args: launchArgs(cli.setting + '.launch', input.config, {
					config,
					...input.model !== undefined ? { model: input.model } : {},
					...input.effort !== undefined ? { effort: input.effort } : {},
					...input.task !== undefined ? { task: input.task } : {},
					...input.opening !== undefined ? { opening: input.opening } : {}
				}, { framework: !!input.connection, yolo: input.yolo, model: input.model !== undefined, effort: input.effort !== undefined, task: input.task !== undefined, trust: true }),
				env: input.config.launch.environment,
				cwd: input.folder,
				files: input.connection ? [{ path: config, content: JSON.stringify(input.connection.mcp) }] : [],
				injected: []
			};
		}
	};
	return cli;
}

/**
 * A CLI whose first conversation has no MCP tools - its first line typed into its terminal - which reads one
 * server for all its agents, and its skills, from files in its folder, and is given the person's trust
 * in its arguments.
 */
export function toldCli(): AgentCli {
	const server = (mcp: { readonly command: string; readonly args: readonly string[] }) => ({ command: mcp.command, args: mcp.args });
	const cli: AgentCli = {
		id: 'told',
		displayName: 'Told Code',
		setting: 'facade.agents.told',
		command: 'told',
		defaults: {
			path: '',
			enabled: true,
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
		sandbox: { yoloOn: 'unavailable', yoloOff: 'unavailable' },
		exemption: 'all',
		questionTool: 'kept',
		launch: (input, executable) => {
			const { connection } = input;
			return {
				executable,
				args: launchArgs(cli.setting + '.launch', input.config, {
					...input.model !== undefined ? { model: input.model } : {},
					...input.effort !== undefined ? { effort: input.effort } : {}
				}, { framework: !!connection, yolo: input.yolo, model: input.model !== undefined, effort: input.effort !== undefined, task: false, trust: true }),
				env: input.config.launch.environment,
				cwd: input.folder,
				files: [],
				injected: connection ? [
					{
						path: '.mcp.json',
						content: JSON.stringify({ mcpServers: { facade: server(connection.mcp) } }, undefined, '\t'),
						merge: theirs => {
							let file: { mcpServers?: { [name: string]: unknown } };
							try {
								file = JSON.parse(theirs);
							} catch {
								return undefined;
							}
							return file.mcpServers?.facade ? undefined : JSON.stringify({ ...file, mcpServers: { ...file.mcpServers, facade: server(connection.mcp) } }, undefined, 2);
						}
					},
					...input.skills.map(skill => ({ path: `.told/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) }))
				] : []
			};
		}
	};
	return cli;
}

export interface WorldOptions {
	/** Repositories by their main checkout, with the branches of their worktrees: each main checkout a folder of the workspace. */
	readonly repositories?: { readonly [main: string]: readonly string[] };
	/** The workspace's folders besides the repositories' main checkouts. */
	readonly folders?: readonly string[];
	/** The window's folders before its repositories, as a workspace whose first folder is a worktree has them. */
	readonly firstFolders?: readonly string[];
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
	/** The environment the agents' terminals start with, by their folder: none of the person's home folders. */
	readonly environment?: (folder: string) => Environment | Promise<Environment>;
	/** The body of the skill every agent is handed, as this build of Facade writes it. */
	readonly skill?: string;
	/** Where a terminal with the environment `env` finds a CLI, by its id: where the window does unless set; undefined for nowhere. */
	readonly locate?: (cli: string, env: Environment) => string | undefined;
	/** The platform agents' programs run on: this machine's unless set. */
	readonly platform?: NodeJS.Platform;
	/** Whether a process the ledger's lock names runs, as the operating system says unless set. */
	readonly isRunning?: (pid: number) => boolean;
	/** The folder on the person's screen: none unless set. */
	readonly activeFolder?: string;
	/** Who opens the ledger: the workspace `lab`'s window unless set. */
	readonly owner?: string;
	/** The load of the window it opens in: a new one for each world unless set. */
	readonly session?: string;
	/** Told Code's models carry their effort in their names, as Antigravity's do (N-64). */
	readonly toldModelCarriesEffort?: boolean;
	/** Arg Code keeps its question tool, as Muse Code does: no launch takes it away (N-71). */
	readonly argKeepsQuestions?: boolean;
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
	const recording: Recording = {};
	const table = AgentTable.open({ dir, isRunning: options.isRunning, owner: options.owner ?? 'lab', session: options.session ?? `load-${++loads}`, messageRecord: (recordDir, ledger) => new FallibleMessageRecord(recordDir, ledger, recording) });
	const terminals = new FakeTerminals();
	const git = new FakeGit(options.repositories ?? {}, options.gitDir ?? path.join(dir, 'git'), options.unborn);
	const person = new FakePerson();
	const settings: { [section: string]: { [name: string]: unknown } } = {};
	// The window writes no final screens here: none is waited for
	const timing = { startTimeoutMs: options.startTimeoutMs ?? 120_000, finalScreenWaitMs: 0 };
	const switches: { yolo: unknown; framework: boolean; worktrees: boolean } = { yolo: true, framework: true, worktrees: true };
	/** The person's custom agents, `facade.agents.custom`, as a test sets them: by name, in order. */
	const custom: { [name: string]: unknown } = {};
	const arg = argCli(path.join(dir, 'arg-home'));
	const known: readonly AgentCli[] = [options.argKeepsQuestions ? { ...arg, questionTool: 'kept' } : arg, options.toldModelCarriesEffort ? { ...toldCli(), modelCarriesEffort: true } : toldCli()];
	const sectionOf = (cli: AgentCli) => cli.setting.replace(/^facade\.agents\./, '');
	const configFor = (cli: AgentCli) => readCliConfig(cli, name => settings[sectionOf(cli)]?.[name]);
	const executableOf = (cli: AgentCli) => cli.custom ? path.join(dir, 'bin', `${cli.command}.exe`) : path.join(dir, 'bin', `${cli.id}.exe`);
	const onMachine = (cli: AgentCli) => cli.custom ? true : (options.clis ?? ['arg', 'told']).includes(cli.id);
	const installed = () => known.filter(cli => onMachine(cli) && configFor(cli).enabled).map(cli => ({ cli, config: configFor(cli), executable: executableOf(cli) }));
	/** What the core wrote to its log, in order. */
	const logs: string[] = [];
	const processFolders = new Map<number, readonly string[]>();
	const processStarts = new Map<number, number>();
	const killed: string[] = [];
	const refreshes = { count: 0 };
	const ignoringTermination = new Set<number>();
	const facade = new Facade({
		...(options.platform ? { platform: options.platform } : {}),
		table,
		ports: { terminals, git, workspace: { folders: () => [...options.firstFolders ?? [], ...Object.keys(options.repositories ?? {}), ...options.folders ?? []], activeFolder: async () => options.activeFolder, worktreesManaged: () => switches.worktrees }, person },
		clis: {
			known,
			custom: () => Object.entries(custom).map(([name, value]) => customAgentOf(name, value, customAgentNameProblem(name, new Set(known.map(cli => cli.id))))),
			installed,
			refresh: async () => {
				refreshes.count++;
			},
			locate: (cli, config, env) => {
				const found = options.locate ? options.locate(cli.id, env) : onMachine(cli) ? executableOf(cli) : undefined;
				return found ? { cli, config, executable: found } : undefined;
			},
			yolo: () => {
				if (typeof switches.yolo !== 'boolean') {
					throw new Error(`facade.agents.yolo is ${JSON.stringify(switches.yolo)}, which is neither true nor false`);
				}
				return switches.yolo;
			},
			framework: () => switches.framework,
			configOf: configFor,
			environment: async folder => await options.environment?.(folder) ?? {}
		},
		setup: {
			connection: tokenFile => ({
				mcp: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' } },
				values: { executable: '/facade/facade', shimFile: '/facade/shim.js', pipe: 'pipe', recordDir: dir, tokenFile, waitMs: '120000' }
			}),
			sharedMcpServer: () => ({ command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--agent'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
			agentEnv: tokenFile => ({ FACADE_AGENTS_PIPE: 'pipe', FACADE_AGENTS_TOKEN: tokenFile }),
			skills: () => [{ name: 'facade', description: 'How to work in Facade Code.', body: options.skill ?? '# Working in Facade Code' }],
			firstLine: (agent, creator, task, note) => [
				`[facade] You are @${agent.name} #a${agent.id}, created by @${creator.name}${creator.id !== undefined ? ` #a${creator.id}` : ''}.`,
				...note ? [note] : [],
				...task !== undefined ? [`Your task is #m${task}.`] : []
			].join(' ')
		},
		timing: () => timing,
		log: message => logs.push(message),
		injected: options.injected ?? path.join(dir, 'injected.json'),
		isRunning: isFakeProcessRunning,
		workingFolders: async roots => new Map(roots.map(root => [root, processFolders.get(root) ?? []])),
		processStartedAt: pid => processStarts.get(pid),
		killProcess: (pid, signal) => {
			killed.push(`${pid} ${signal}`);
			if (signal === 'SIGKILL' || !ignoringTermination.has(pid)) {
				endFakeProcess(pid);
			}
		}
	});
	// The window's deletion stops the agents working in a worktree through the core, as the window asks it to
	git.stopping = folder => facade.worktreeStopping(folder);
	return {
		table,
		facade,
		terminals,
		git,
		person,
		logs,
		/** The folders the processes under each agent's process work in, by its process's id: where a CLI went with cd. */
		processFolders,
		/** When each process started, by its id, where a test says: none, as on Windows, unless set. */
		processStarts,
		/** The signals sent to processes by their ids: `<pid> <signal>`. */
		killed,
		/** How many times the CLIs this machine has were looked for again. */
		refreshes,
		/** The processes, by their ids, that a termination does not end: only a kill. */
		ignoringTermination,
		settings,
		/** How long the core waits, as the person set it: a test changes it as it goes. */
		timing,
		/** The person's switches: YOLO, on unless a test turns it off or sets it to what is no switch; the agent framework and worktree management, on. */
		switches,
		/** The person's custom agents, by name: a test adds them. */
		custom,
		/** How recording a message, or a delivery of messages, fails: never, unless a test says. */
		recording,
		/** The agent numbered `id`. */
		agent(id: number): Agent {
			const found = table.get(id);
			if (!found) {
				throw new Error(`no agent is #a${id}`);
			}
			return found;
		},
		/** As the MCP server of agent `id` says hello: it is running. */
		hello(id: number): void {
			facade.connected(callerOf(this.agent(id)));
		},
		/** As agent `id` fetches its messages - `request`, else its unread ones - and the result reaches its MCP server. */
		fetched(id: number, request: FetchRequest = {}): Promise<Fetched> {
			return facade.mail.fetch(callerOf(this.agent(id)), request, listener => listener(true));
		},
		/**
		 * The texts of Facade's messages to agent `id` - its notices, and what came back to it - in the order they came; with
		 * `state`, of those in that state alone.
		 */
		facadeMessagesTo(id: number, state?: MailboxEntry['state']): string[] {
			const mail = table.state.mail;
			return (mail.mailboxes.get(id) ?? []).flatMap(each => {
				const message = mail.messages.get(each);
				return message?.from === FACADE && (state === undefined || mail.entries.get(each)?.state === state) ? [table.messages.textOf(message) ?? ''] : [];
			});
		},
		/**
		 * A start whose child's MCP server says hello once its terminal is launched, as a CLI's does: what
		 * start_agent answered, or its error. On a test's clock.
		 */
		async startUp(caller: Caller, request: StartRequest): Promise<Started> {
			const id = table.state.lastId + 1;
			let over = false;
			const starting = facade.startAgent(caller, request);
			starting.then(() => over = true, () => over = true);
			await until(() => over || terminals.launched.some(launch => launch.name.startsWith(`@`) && launch.name.endsWith(` #a${id}`)));
			if (!over) {
				facade.connected(callerOf(this.agent(id)));
			}
			return settled(starting);
		},
		/** As the window goes, or as Facade lets go of its agents while the window stays. */
		dispose(by?: ClosedBy): void {
			facade.dispose();
			table.dispose(by);
		}
	};
}
