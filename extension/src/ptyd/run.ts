/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { tailStyles } from '../base/screenStyle';
import { truncateText } from '../base/text';
import type { IPty } from 'node-pty';
import { InputReading, inputScreenOf, readInput } from './composer';
import { InputEffect, InputQueue } from './input';
import { KeyModes, keySequence, pasteSequence, win32Text } from './keys';
import type { RunExit, RunInfo, RunStatus, ScreenFrame, ScreenRead, SpawnParams, Termination } from './protocol';
import { MOST_SCREEN_LINES, readScreen, readStatusLines } from './screen';
import { ScreenReader, screenReaderOf } from './screenStatus';
import { parseStatus, ProgramStatus, STATUS_REPLY, StatusQueries } from './status';

/** The backend packaged beside ptyd, loaded lazily so tests can substitute the process adapter (ARCHITECTURE-1.2). */
let pty: typeof import('node-pty') | undefined;
/** A backend built without the ConPTY DLL can use Windows' own console for later runs too. */
let conptyDllMissing = false;
function loadPty(): typeof import('node-pty') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return pty ??= require('node-pty') as typeof import('node-pty');
}

/**
 * What of this ptyd's installation is gone, where an update or uninstall removed it while ptyd ran on: its own script, or on
 * Windows node-pty's console worker, which node-pty loads for every program it starts and without which each start ends with
 * code -1 before it has a PID (ARCHITECTURE-2.4). Undefined while all of it is there.
 */
export function installationGone(script = process.argv[1], platform = process.platform, exists = fs.existsSync): string | undefined {
	if (script && !exists(script)) {
		return script;
	}
	if (platform === 'win32') {
		let worker: string | undefined;
		try {
			worker = path.join(path.dirname(require.resolve('node-pty')), 'worker', 'conoutSocketWorker.js');
		} catch {
			// node-pty itself cannot be found: loading it says so
		}
		if (worker && !exists(worker)) {
			return worker;
		}
	}
	return undefined;
}

/** ptyd starts no program, as what of its installation `gone` names was removed (ARCHITECTURE-2.4): told to the window with it. */
export class InstallationGone extends Error {
	constructor(readonly gone: string) {
		super(`This agent runtime's installation was removed - ${gone} is gone, as an update or uninstall does - so it starts no program. Reload the window to start agents in the installed one.`);
	}
}

function spawnPty(params: SpawnParams): IPty {
	const gone = installationGone();
	if (gone) {
		throw new InstallationGone(gone);
	}
	const native = loadPty();
	const options = {
		...(process.platform === 'win32' ? { useConptyDll: !conptyDllMissing } : {}),
		name: 'xterm-256color',
		cols: params.cols,
		rows: params.rows,
		cwd: params.cwd,
		env: { ...params.env }
	};
	try {
		return native.spawn(params.file, [...params.args], options);
	} catch (error) {
		// node-pty's DLL lookup reports this exact error when the backend does not include conpty/conpty.dll. Other failures,
		// including an invalid executable, must reach the caller unchanged, without starting another process.
		if (!options.useConptyDll || !(error instanceof Error) || !error.message.startsWith('Cannot find conpty.dll at ')) {
			throw error;
		}
		conptyDllMissing = true;
		return native.spawn(params.file, [...params.args], { ...options, useConptyDll: false });
	}
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadXterm = () => require('@xterm/headless') as typeof import('@xterm/headless');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadSerialize = () => require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadUnicode11 = () => require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11');

/** The headless scrollback bound (ARCHITECTURE-2.4): 10,000 lines, and no more than 8 MiB of cells. */
export const MOST_SCROLLBACK_LINES = 10_000;
export const MOST_SCROLLBACK_BYTES = 8 * 1024 * 1024;
/** What a headless terminal keeps of one cell: three 32-bit words. */
const CELL_BYTES = 12;

/** The scrollback rows a terminal `cols` wide keeps within both bounds. */
export function scrollbackRows(cols: number): number {
	return Math.max(1, Math.min(MOST_SCROLLBACK_LINES, Math.floor(MOST_SCROLLBACK_BYTES / (Math.max(1, cols) * CELL_BYTES))));
}

/** How much output of a run may wait to be drawn before its process is paused (ARCHITECTURE-2.4). */
export const MOST_RUN_BUFFER = 8 * 1024 * 1024;

/** The OSCs of the Program Status Protocol, and of a shell's prompt marks (OSC 133), whose `A` ends what a program reported. */
const PROGRAM_STATUS_OSC = 7501;
const PROMPT_MARK_OSC = 133;

/**
 * The pause after a lone Escape that another key of the call follows: in the legacy encoding Escape is the ESC that also starts
 * every escape sequence, and a program that reads the next key with it takes the two for Alt with that key. No other key needs
 * one: each other sequence ends itself, and the kitty and win32 encodings write Escape as a sequence of its own (MCP-5.2).
 */
const ESCAPE_GAP_MS = 50;

/** Leaving the alternate screen: DECRST 47, 1047 or 1049. */
const ALTERNATE_SCREEN_MODES = [47, 1047, 1049];

/** Win32 input mode: `CSI ? 9001 h`. */
const WIN32_INPUT_MODE = 9001;
/** Mouse reports as SGR, `ESC [ < ...`, and as SGR in pixels: the encodings a program sets beside the reports it asks for. */
const MOUSE_ENCODINGS = [1006, 1016];
/** Show the cursor (DECTCEM): reset, the program hides it. */
const CURSOR_SHOWN_MODE = 25;

/** How many sets of kitty keyboard flags a screen's stack holds, as the protocol has it. */
const KITTY_STACK_MOST = 16;

/** How soon after a Ctrl+C an exit counts as following it: the evidence an adapter may verify as an interrupt (RULES-3.3). */
const INTERRUPT_EVIDENCE_MS = 2_000;

/** How long a forced kill has to be confirmed by the process's exit. */
const KILL_CONFIRM_MS = 2_000;

/** The longest terminal title kept: a tab shows far less, and no message of a run may outgrow ptyd's frames (ARCHITECTURE-2.4). */
const MOST_TITLE = 4096;

/** `title` cut to {@link MOST_TITLE} code units, between complete graphemes. */
function boundedTitle(title: string): string {
	return truncateText(title, MOST_TITLE);
}

/** How long a Windows console's output pipe may still bring what its program wrote last once it ended: node-pty's own flush time. */
const CONSOLE_FLUSH_MS = 1_000;

/**
 * How long a Windows console may take to start its program. node-pty 1.2 starts it once the console's output is connected, and
 * itself gives that up after five seconds, reporting an exit.
 */
const START_WAIT_MS = 10_000;

/** How soon after what it drew a screen read as its status is read again (CLIS-2.3): at most this often, while it draws. */
const SCREEN_READ_MS = 200;

/**
 * What node-pty 1.2 keeps of a Windows console: whether it is ready - its program connected and its first output read - and its
 * agent, with the pipes to it and the worker thread that reads its output.
 */
interface WindowsConsole {
	readonly _isReady?: boolean;
	readonly _agent?: {
		kill?(): void;
		readonly _conoutSocketWorker?: { dispose?(): void };
		readonly _outSocket?: { destroy?(): void };
		readonly _inSocket?: { destroy?(): void };
	};
}

/**
 * Lets go of node-pty's connection to a Windows console whose program ended. With the ConPTY DLL, node-pty 1.2 never closes the
 * output pipe or ends the worker thread reading it - a thread and some 17 MB held in ptyd for every run that ended, measured on
 * Windows 11 - so they are closed here, where the backend has them; anything else has none of them, and nothing is done.
 */
export function releaseConsole(pty: object): void {
	const agent = (pty as WindowsConsole)._agent;
	agent?._conoutSocketWorker?.dispose?.();
	agent?._outSocket?.destroy?.();
	agent?._inSocket?.destroy?.();
}

/** What a run tells the window that claims it, as it happens. */
export interface RunListener {
	output(seq: number, data: string): void;
	title(title: string): void;
	status(status: RunStatus | undefined): void;
	exit(exit: RunExit): void;
}

/** Ctrl+C as a terminal sends it: the control character, or the kitty keyboard protocol's escape code. */
function hasCtrlC(data: string): boolean {
	return data.includes('\x03') || data.includes('\x1b[99;5u');
}

/** The holder that pauses a run while its own headless terminal has more than {@link MOST_RUN_BUFFER} to draw. */
const DRAWING = {};

/**
 * One agent's process in a pty of ptyd's, with a headless terminal that draws everything it writes: what a window shows again
 * after a reload (ARCHITECTURE-2.3). It outlives the window that shows it; the supervisor owns explicit close and the selected
 * five-minute connection cleanup policy. An upgrade alone never terminates it. Its program is created as it is made, or for
 * ptyd's starts in its turn ({@link spawn}, ARCHITECTURE-2.3): until then it has no process, keeps its size and what the person types for
 * it, takes no automated input, and a close ends it with none ever created.
 */
export class Run {

	/** Its pty, once its turn created its program (ARCHITECTURE-2.3). */
	private pty: IPty | undefined;
	/** What was typed before its program was created, written to it once it is: a console takes what is typed as it starts (ARCHITECTURE-2.3). */
	private readonly unwritten: string[] = [];
	/** When its program was created; until then, when it was asked for (CLIS-2.3, ARCHITECTURE-2.3). */
	private startTime = Date.now();
	private readonly terminal: import('@xterm/headless').Terminal;
	private readonly serializer: import('@xterm/addon-serialize').SerializeAddon;
	private listener: RunListener | undefined;
	private readonly exitListeners = new Set<(exit: RunExit) => void>();
	/** Whoever cannot take more of what the run writes yet: while anyone is, its pty is not read, and the CLI waits. */
	private readonly holders = new Set<object>();
	/** Whether it is being ended: what it writes is read on, held back or not, as its exit is known only once that is drained. */
	private ending = false;
	private readonly programStatus: ProgramStatus;
	/** Its questions whether ptyd takes reports, found in its output as it comes (CLIS-2.3). */
	private readonly statusQueries = new StatusQueries();
	/** Of those, the ones answered that its headless terminal has not parsed yet: it answers none of them again. */
	private answeredQueries = 0;
	private readonly queue = new InputQueue();
	/** The adapter's tested native status layout, as a fallback or a version-scoped correction (CLIS-2.3). */
	private readonly screenReader: ScreenReader | undefined;
	private screenRead: ReturnType<typeof setTimeout> | undefined;
	/** The number of the last output chunk: each is numbered as it is drawn, so that a reattach never shows one twice. */
	private seq = 0;
	/** What was written to the headless terminal and is not drawn yet, in UTF-8 bytes. */
	private undrawn = 0;
	/**
	 * For each write to the headless terminal not drawn yet, oldest first, what waits for it to be drawn: the barrier after all that was
	 * written is the last write's own callback, never an empty write, which xterm may drop with its callback (`afterDrawn`).
	 */
	private readonly drawing: (() => void)[][] = [];
	private title = '';
	private lastOutput: number | undefined;
	private exited: RunExit | undefined;
	private endedAt: number | undefined;
	/** Set as node-pty reports the exit, before what it wrote last is drawn: from then on its PID is never signalled. */
	private reaped = false;
	/** The exit code node-pty reported: on Windows, where a program never started, the system's error. */
	private reapedCode: number | undefined;
	/**
	 * Whether its console was ended, on Windows: node-pty's kill there ends every process of the console and closes it, and a second
	 * kill - a later one, once that close is done - reaches a console already freed and corrupts the whole process's heap. It is
	 * ended once; nothing stronger follows, nor any resize of what is gone.
	 */
	private consoleEnded = false;

	/** Whether its terminal still takes what is written to it and its size: not once it ended, nor once its console was ended. */
	private get writable(): boolean {
		return !this.exited && !this.consoleEnded;
	}
	/** When a Ctrl+C last went into its terminal, from the person or from automated keys. */
	private ctrlCAt: number | undefined;
	private readonly kittyStacks = { normal: [] as number[], alternate: [] as number[] };
	private win32Input = false;
	/** The mouse encoding its program set, of {@link MOUSE_ENCODINGS}; none for the default one. */
	private mouseEncoding: number | undefined;
	private cursorHidden = false;
	/** The last frame its program drew on the alternate screen, kept as it left it or ended there (MCP-5.1). */
	private frame: ScreenFrame | undefined;
	/** Set once ptyd let go of it: its headless terminal is gone. */
	private disposed = false;
	/** Set once a window removed it: no window lists it again, and it is dropped as it ends. */
	removed = false;
	/**
	 * When its program was created - the process start a run's startup counts from (CLIS-2.3) - or, until its turn, now: a window that sees
	 * it before then gives its startup no less time than it has (ARCHITECTURE-2.3).
	 */
	get startedAt(): number {
		return this.pty ? this.startTime : Date.now();
	}
	/** What the window keeps with its run, as it said last. */
	meta: { readonly [key: string]: unknown };

	/** `later` makes it with no program, for {@link spawn} to create in its turn (ARCHITECTURE-2.3); else its program is created now. */
	constructor(readonly params: SpawnParams, options: { readonly later?: boolean } = {}) {
		this.meta = params.meta;
		this.screenReader = screenReaderOf(params.screenStatus);
		this.programStatus = new ProgramStatus(params.screenStatus === 'codex-0.166');
		const { Terminal } = loadXterm();
		const { SerializeAddon } = loadSerialize();
		const terminal = this.terminal = new Terminal({ cols: params.cols, rows: params.rows, scrollback: scrollbackRows(params.cols), allowProposedApi: true,
			reflowCursorLine: true });
		this.serializer = new SerializeAddon();
		terminal.loadAddon(this.serializer as never);
		// Characters as wide as the window's terminal draws them, by Unicode 11: an emoji takes two cells
		const { Unicode11Addon } = loadUnicode11();
		terminal.loadAddon(new Unicode11Addon() as never);
		terminal.unicode.activeVersion = '11';
		terminal.onTitleChange(title => {
			this.title = boundedTitle(title);
			this.listener?.title(this.title);
		});
		this.followStatus();
		this.followModes();
		this.programStatus.onDidChange(status => this.listener?.status(status));
		// With no window showing it, ptyd answers what the program asks its terminal - where its cursor is - so that a CLI waiting
		// for the answer goes on; a window that shows it answers itself
		terminal.onData(reply => {
			if (!this.listener && this.writable) {
				this.send(reply);
			}
		});
		if (!options.later) {
			try {
				this.spawn();
			} catch (error) {
				terminal.dispose();
				throw error;
			}
		}
	}

	/**
	 * Creates its program, in its size as it stands, and writes what was typed for it meanwhile (ARCHITECTURE-2.3). Throws where the run was
	 * ended first - its program is then never created - or where node-pty cannot create it.
	 */
	spawn(): void {
		if (this.exited || this.disposed) {
			throw new Error(`Run ${this.params.run} was closed before its turn to start came: it never started.`);
		}
		if (this.pty) {
			return;
		}
		const pty = this.pty = spawnPty({ ...this.params, cols: this.terminal.cols, rows: this.terminal.rows });
		this.startTime = Date.now();
		// Held back already - its window over its buffer - it is not read either until let go
		if (this.holders.size) {
			pty.pause();
		}
		pty.onData(data => {
			this.lastOutput = Date.now();
			// Its question whether ptyd takes reports is answered before any of it reaches a window, whose terminal answers its other
			// questions: one of those answered first - its headless parse behind - would tell the program there is none (CLIS-2.3)
			for (let asked = this.statusQueries.feed(data); asked > 0; asked--) {
				this.answeredQueries++;
				if (this.writable) {
					this.send(STATUS_REPLY);
				}
			}
			const seq = ++this.seq;
			this.draw(data);
			this.listener?.output(seq, data);
		});
		pty.onExit(({ exitCode, signal }) => {
			this.reaped = true;
			this.reapedCode = exitCode;
			const ctrlC = this.ctrlCAt !== undefined && Date.now() - this.ctrlCAt <= INTERRUPT_EVIDENCE_MS;
			this.queue.end();
			// Told once what it wrote last is drawn
			this.afterDrawn(() => {
				if (!this.disposed && this.terminal.buffer.active.type === 'alternate') {
					// It ended on the alternate screen: that is its last frame, and the normal buffer its final output
					this.keepFrame();
				}
				this.ended({ exitCode, ...(signal ? { signal } : {}), ...(ctrlC ? { ctrlC: true as const } : {}) });
			});
			if (process.platform === 'win32') {
				setTimeout(() => releaseConsole(pty), CONSOLE_FLUSH_MS).unref?.();
			}
		});
		for (const data of this.unwritten.splice(0)) {
			pty.write(data);
		}
	}

	/** It ended with `exit`: its input ends, and its claimant and every waiter for its exit are told. */
	private ended(exit: RunExit): void {
		this.queue.end();
		this.endedAt = Date.now();
		this.exited = exit;
		this.holders.clear();
		this.listener?.exit(exit);
		// A listener may drop/dispose this run. Every waiter registered for this exit still receives it.
		for (const listener of [...this.exitListeners]) {
			listener(exit);
		}
	}

	/** Writes `data` to its program, or keeps it for the program its turn creates (ARCHITECTURE-2.3). */
	private send(data: string): void {
		if (this.pty) {
			this.pty.write(process.platform === 'win32' && this.win32Input ? win32Text(data) : data);
		} else {
			this.unwritten.push(data);
		}
	}

	get id(): string {
		return this.params.run;
	}

	get hasExited(): boolean {
		return !!this.exited;
	}

	/**
	 * Resolves once its program has started, with its PID: at once where node-pty starts it as it spawns, and on Windows - where
	 * node-pty 1.2 starts it only once the console's output is connected - as soon as it has one. Rejects where it ended first, as
	 * a program that could not start does, or none came within {@link START_WAIT_MS}: what ptyd heard meanwhile is read first, as
	 * timers run before I/O, so that a busy ptyd never takes a program that started for one that did not (ARCHITECTURE-2.3).
	 */
	started(): Promise<void> {
		return new Promise((resolve, reject) => {
			const end = Date.now() + START_WAIT_MS;
			const check = (last: boolean) => {
				if ((this.pty?.pid ?? 0) > 0) {
					resolve();
				} else if (this.reaped) {
					// node-pty's own words for a program Windows could not start, as it threw them before it started programs later
					reject(new Error(`Cannot create process (error code: ${this.reapedCode})`));
				} else if (last) {
					reject(new Error(`${this.params.file} did not start within ${START_WAIT_MS / 1_000} seconds.`));
				} else if (Date.now() > end) {
					setImmediate(() => check(true));
				} else {
					setTimeout(() => check(false), 20);
				}
			};
			check(false);
		});
	}

	/** The run as `claimedElsewhere` has it for the connection asking. */
	info(claimedElsewhere: boolean): RunInfo {
		const status = this.programStatus.status;
		return {
			run: this.params.run,
			owner: this.params.owner,
			pid: this.pty?.pid ?? 0,
			cwd: this.params.cwd,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			title: this.title,
			startedAt: this.startedAt,
			...(this.exited ? { exited: this.exited } : {}),
			...(status ? { status } : {}),
			seq: this.seq,
			claimedElsewhere,
			meta: this.meta
		};
	}

	/** Tells `listener` what the run does from now on: its claimant. */
	listen(listener: RunListener | undefined): void {
		this.listener = listener;
	}

	/** Calls `listener` once the run's process ended and what it wrote last is drawn. */
	onExit(listener: (exit: RunExit) => void): void {
		this.exitListeners.add(listener);
	}

	/**
	 * Its screen as it stands, with the number of the last output in it (ARCHITECTURE-2.3): the drawing of the last output is the cut,
	 * read in its own callback, so what was written before is the screen and what comes after is numbered after `seq`.
	 */
	snapshot(): Promise<{ readonly screen: string; readonly seq: number }> {
		const seq = this.seq;
		return new Promise((resolve, reject) => this.afterDrawn(() => {
			try {
				resolve({ screen: this.serializer.serialize({ scrollback: scrollbackRows(this.terminal.cols) }) + this.modesBeyondScreen(), seq });
			} catch (err) {
				reject(err);
			}
		}));
	}

	/** Stops reading what the run writes until `holder` lets go: ordinary backpressure, the CLI waiting (ARCHITECTURE-2.4). */
	hold(holder: object): void {
		if (this.exited || this.ending || this.holders.has(holder)) {
			return;
		}
		if (!this.holders.size) {
			this.pty?.pause();
		}
		this.holders.add(holder);
	}

	release(holder: object): void {
		if (this.holders.delete(holder) && !this.holders.size && !this.exited) {
			this.pty?.resume();
		}
	}

	/** What the person typed in the window that shows the run: straight to its process (EXPERIENCE-2.1). */
	write(data: string): void {
		if (!this.writable) {
			return;
		}
		if (hasCtrlC(data)) {
			this.ctrlCAt = Date.now();
		}
		this.send(data);
	}

	resize(cols: number, rows: number): void {
		if (!this.writable || cols < 1 || rows < 1 || (cols === this.terminal.cols && rows === this.terminal.rows)) {
			return;
		}
		this.pty?.resize(cols, rows);
		this.terminal.resize(cols, rows);
		this.readScreenSoon();
		this.terminal.options.scrollback = scrollbackRows(cols);
	}

	/**
	 * Pastes `text` as one input - bracketed where the program turned that mode on - and Enter after it if asked, in turn. A `lead` is
	 * typed before the paste, in the same write: the program takes it as typed, and the paste whole after it (COLLABORATION-2.1).
	 */
	type(text: string, enter: boolean, lead?: string): Promise<InputEffect> {
		return this.queue.add(async alive => {
			await this.parsed();
			if (!alive()) {
				return { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false };
			}
			if (!this.pty) {
				// No program yet to take it: nothing is kept to go in later, in modes it has not set yet (ARCHITECTURE-2.3)
				return { outcome: 'not_applied', pasted: false, entered: false };
			}
			if (text) {
				this.send(`${lead ?? ''}${pasteSequence(this.terminal.modes.bracketedPasteMode, text)}`);
			}
			if (!enter) {
				return { outcome: 'applied', pasted: !!text, entered: false };
			}
			await this.parsed();
			if (!alive()) {
				return { outcome: text ? 'partial' : 'not_applied', reason: 'ended', pasted: !!text, entered: false };
			}
			this.send(keySequence(this.keyModes(), 'Enter'));
			return { outcome: 'applied', pasted: !!text, entered: true };
		}, { outcome: 'not_applied', pasted: false, entered: false });
	}

	/**
	 * Presses `keys` in order, each in the modes the program has as it is pressed, in turn: one after another, but for the pause a
	 * lone Escape needs before the key after it ({@link ESCAPE_GAP_MS}).
	 */
	keys(keys: readonly string[]): Promise<InputEffect> {
		return this.queue.add(async alive => {
			if (!this.pty) {
				// No program yet to take them (ARCHITECTURE-2.3)
				return { outcome: 'not_applied', keysSent: 0 };
			}
			let lone = false;
			for (let sent = 0; sent < keys.length; sent++) {
				if (lone) {
					await new Promise(resolve => setTimeout(resolve, ESCAPE_GAP_MS));
				}
				await this.parsed();
				if (!alive()) {
					return { outcome: sent ? 'partial' : 'not_applied', reason: 'ended', keysSent: sent };
				}
				if (keys[sent] === 'Ctrl+C') {
					this.ctrlCAt = Date.now();
				}
				const sequence = keySequence(this.keyModes(), keys[sent]);
				lone = sequence === '\x1b';
				this.send(sequence);
			}
			return { outcome: 'applied', keysSent: keys.length };
		}, { outcome: 'not_applied', keysSent: 0 });
	}

	/**
	 * Ends its process (LIFECYCLE-4.2): no more automated input; its process group hung up, as a closed terminal would, then
	 * killed where it has not ended within `graceMs`. A process already reaped is never signalled: its PID may be another's now.
	 * Windows ends the console's processes as node-pty does, once: nothing stronger follows its grace. Answers what its exit showed.
	 */
	async terminate(graceMs: number): Promise<Termination> {
		this.queue.end();
		if (this.exited) {
			return 'already_exited';
		}
		if (!this.pty) {
			// Its turn never came: it ends now, nothing having run, and its turn creates no program (ARCHITECTURE-2.3)
			this.ended({ exitCode: 0 });
			return 'terminated';
		}
		// A run held back is read on as it ends: node-pty tells its exit once its output is drained, which a paused read never is
		this.ending = true;
		if (this.holders.size) {
			this.holders.clear();
			this.pty.resume();
		}
		if (!this.signal(process.platform === 'win32' ? undefined : 'SIGHUP')) {
			return this.reaped ? await this.exitWithin(KILL_CONFIRM_MS) ? 'terminated' : 'unconfirmed' : 'failed';
		}
		if (await this.exitWithin(graceMs)) {
			return 'terminated';
		}
		if (!this.signal('SIGKILL')) {
			return this.reaped ? await this.exitWithin(KILL_CONFIRM_MS) ? 'terminated' : 'unconfirmed' : 'failed';
		}
		return await this.exitWithin(KILL_CONFIRM_MS) ? 'terminated' : 'unconfirmed';
	}

	/**
	 * The bottom `lines` lines of its screen, once what was written is drawn (MCP-5.1). Read from the normal buffer - its output, and
	 * its final output once it ended, also where it ended on the alternate screen - it comes with the last frame drawn there.
	 */
	async read(lines: number): Promise<ScreenRead> {
		await this.parsed();
		const count = Math.max(1, Math.min(MOST_SCREEN_LINES, Math.floor(lines)));
		const screen = readScreen(this.terminal as never, count, this.exited ? 'normal' : 'active');
		const frame = screen.buffer === 'normal' ? this.frame : undefined;
		return {
			...screen,
			capturedAt: this.endedAt ?? Date.now(),
			...(this.lastOutput !== undefined ? { lastOutput: this.lastOutput } : {}),
			exited: !!this.exited,
			...(frame ? { frame: { lines: frame.lines.slice(-count), text: frame.text.slice(-count), styles: tailStyles(frame.text, frame.styles, count), capturedAt: frame.capturedAt } } : {})
		};
	}

	/**
	 * Its ordinary-message input as `adapter` reads it from the screen, once what was written is drawn (CLIS-2.1, RULES-1.4): read,
	 * never probed with a key. An ended run's is unknown.
	 */
	async inspect(adapter: string): Promise<InputReading> {
		await this.parsed();
		if (this.exited || this.disposed) {
			return { state: 'unknown', evidence: 'its process ended' };
		}
		return readInput(inputScreenOf(this.terminal), adapter);
	}

	/** Keeps the alternate screen as it stands as the last frame its program drew there. */
	private keepFrame(): void {
		const { lines, text, styles } = readScreen(this.terminal as never, MOST_SCREEN_LINES, 'alternate');
		this.frame = { lines, text, styles, capturedAt: Date.now() };
	}

	/** Ends what is left of it: ptyd itself is going, or a window forgot it. */
	dispose(): void {
		this.disposed = true;
		this.queue.end();
		this.signal(process.platform === 'win32' ? undefined : 'SIGHUP');
		this.listener = undefined;
		this.exitListeners.clear();
		clearTimeout(this.screenRead);
		this.screenRead = undefined;
		this.terminal.dispose();
	}

	/**
	 * Sends `signal` to its process group - the leader and what it started in its session - while the leader is not reaped; on
	 * Windows node-pty's kill, once (`consoleEnded`). False where nothing could be signalled.
	 */
	private signal(signal: NodeJS.Signals | undefined): boolean {
		const pty = this.pty;
		if (this.reaped || !pty) {
			return false;
		}
		if (process.platform === 'win32') {
			if (this.consoleEnded) {
				return true;
			}
			try {
				// node-pty queues its kill until the console is ready, and one never ready would never be ended: it is ended through its
				// agent at once, as node-pty ends a console it gave up on, and nothing is queued to end it again
				const console = pty as unknown as WindowsConsole;
				if (console._isReady === false && console._agent?.kill) {
					console._agent.kill();
					releaseConsole(pty);
				} else {
					pty.kill();
				}
				this.consoleEnded = true;
				return true;
			} catch {
				return false;
			}
		}
		if (signal === undefined) {
			try {
				pty.kill();
				return true;
			} catch {
				return false;
			}
		}
		// Only a real process group: -1 would be every process this user may signal, -0 the caller's own group
		const pid = pty.pid;
		try {
			if (!Number.isInteger(pid) || pid <= 1) {
				throw new Error(`No process group ${pid}.`);
			}
			process.kill(-pid, signal);
			return true;
		} catch {
			// No group of its own: its leader alone
			try {
				pty.kill(signal);
				return true;
			} catch {
				return false;
			}
		}
	}

	/** Whether its process ends within `ms`. */
	private exitWithin(ms: number): Promise<boolean> {
		if (this.exited) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const done = (ended: boolean) => {
				clearTimeout(timer);
				this.exitListeners.delete(listener);
				resolve(ended);
			};
			const listener = () => done(true);
			const timer = setTimeout(() => done(!!this.exited), Math.max(0, ms));
			this.exitListeners.add(listener);
		});
	}

	/** Draws `data` in the headless terminal; while more than {@link MOST_RUN_BUFFER} waits to be drawn, the CLI waits. */
	private draw(data: string): void {
		if (!data) {
			return;
		}
		const size = Buffer.byteLength(data, 'utf8');
		this.undrawn += size;
		if (this.undrawn > MOST_RUN_BUFFER) {
			this.hold(DRAWING);
		}
		const waiting: (() => void)[] = [];
		this.terminal.write(data, () => {
			// xterm calls its writes' callbacks in order: this write's is the oldest waiting
			this.drawing.shift();
			this.undrawn -= size;
			if (this.undrawn <= MOST_RUN_BUFFER / 2) {
				this.release(DRAWING);
			}
			this.readScreenSoon();
			for (const then of waiting) {
				then();
			}
		});
		this.drawing.push(waiting);
	}

	/**
	 * Calls `then` once all that was written to the headless terminal is drawn: at once where nothing waits, else in the callback of
	 * the last write, before anything written after it is drawn.
	 */
	private afterDrawn(then: () => void): void {
		const last = this.drawing[this.drawing.length - 1];
		if (last) {
			last.push(then);
		} else {
			then();
		}
	}

	/** Settles once all that was written to the headless terminal is drawn. */
	private parsed(): Promise<void> {
		return new Promise(resolve => this.afterDrawn(resolve));
	}

	/**
	 * What its program set that a terminal drawing its screen anew needs beside the serializer's modes, which leave these out
	 * (ARCHITECTURE-2.3): the mouse encoding - without which a reload sends the program mouse reports it cannot read, so that
	 * neither its scrolling nor its selection works - the hidden cursor, the kitty keyboard protocol's flags on the screen it is on and
	 * win32 input mode. Written after the screen, in the terminal the screen leaves it in.
	 */
	private modesBeyondScreen(): string {
		const kitty = this.kittyStacks[this.terminal.buffer.active.type];
		return [
			...this.mouseEncoding ? [`\x1b[?${this.mouseEncoding}h`] : [],
			...this.cursorHidden ? [`\x1b[?${CURSOR_SHOWN_MODE}l`] : [],
			...kitty.map(flags => `\x1b[>${flags}u`),
			...this.win32Input ? [`\x1b[?${WIN32_INPUT_MODE}h`] : []
		].join('');
	}

	private keyModes(): KeyModes {
		const stack = this.kittyStacks[this.terminal.buffer.active.type];
		return { applicationCursorKeys: this.terminal.modes.applicationCursorKeysMode, kittyFlags: stack[stack.length - 1] ?? 0, win32Input: this.win32Input };
	}

	/**
	 * Follows what the program sets that the headless terminal does not keep, or keeps where its serializer does not write it: the
	 * kitty keyboard protocol's flags - pushed, popped and set, a stack for each screen - win32 input mode, the mouse encoding and the
	 * cursor's visibility, each back to its default on a reset. The terminal's own handling of each sequence still runs.
	 */
	private followModes(): void {
		const parser = this.terminal.parser;
		const stack = () => this.kittyStacks[this.terminal.buffer.active.type];
		const numbers = (params: (number | number[])[]) => params.map(param => Array.isArray(param) ? param[0] : param);
		parser.registerCsiHandler({ prefix: '>', final: 'u' }, params => {
			const flags = stack();
			flags.push(numbers(params)[0] ?? 0);
			flags.splice(0, Math.max(0, flags.length - KITTY_STACK_MOST));
			return true;
		});
		parser.registerCsiHandler({ prefix: '<', final: 'u' }, params => {
			const flags = stack();
			flags.splice(Math.max(0, flags.length - Math.max(1, numbers(params)[0] || 1)));
			return true;
		});
		parser.registerCsiHandler({ prefix: '=', final: 'u' }, params => {
			const [value = 0, mode = 1] = numbers(params);
			const flags = stack();
			const current = flags.pop() ?? 0;
			flags.push(mode === 2 ? current | value : mode === 3 ? current & ~value : value);
			return true;
		});
		parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
			for (const mode of numbers(params)) {
				if (mode === WIN32_INPUT_MODE) {
					this.win32Input = true;
				} else if (MOUSE_ENCODINGS.includes(mode)) {
					this.mouseEncoding = mode;
				} else if (mode === CURSOR_SHOWN_MODE) {
					this.cursorHidden = false;
				}
			}
			return false;
		});
		parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
			const modes = numbers(params);
			for (const mode of modes) {
				if (mode === WIN32_INPUT_MODE) {
					this.win32Input = false;
				} else if (MOUSE_ENCODINGS.includes(mode)) {
					// As the terminal does: the default encoding again, whichever of them is reset
					this.mouseEncoding = undefined;
				} else if (mode === CURSOR_SHOWN_MODE) {
					this.cursorHidden = true;
				}
			}
			// Before the terminal leaves the alternate screen, which it clears as it does: its last frame is kept (MCP-5.1)
			if (this.terminal.buffer.active.type === 'alternate' && modes.some(mode => ALTERNATE_SCREEN_MODES.includes(mode))) {
				this.keepFrame();
			}
			return false;
		});
		// A soft reset shows the cursor again; a full one sets everything back
		parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
			this.cursorHidden = false;
			return false;
		});
		parser.registerEscHandler({ final: 'c' }, () => {
			this.kittyStacks.normal.length = 0;
			this.kittyStacks.alternate.length = 0;
			this.win32Input = false;
			this.mouseEncoding = undefined;
			this.cursorHidden = false;
			return false;
		});
	}

	/**
	 * Reads eligible native screen evidence after drawing (CLIS-2.3): at most every {@link SCREEN_READ_MS}, never in the middle
	 * of a synchronized update or after exit. ProgramStatus owns when the adapter's fallback/correction can apply.
	 */
	private readScreenSoon(): void {
		if (!this.screenReader || this.screenRead || !this.programStatus.acceptsScreen || this.exited) {
			return;
		}
		this.screenRead = setTimeout(() => {
			this.screenRead = undefined;
			if (!this.programStatus.acceptsScreen || this.exited) {
				return;
			}
			if (this.drawing.length || this.terminal.modes.synchronizedOutputMode) {
				this.readScreenSoon();
				return;
			}
			const screen = readStatusLines(this.terminal);
			this.programStatus.observed(this.screenReader!(screen.lines, screen.clippedStart, screen.boldHeads, screen.dimLines, this.terminal.cols));
		}, SCREEN_READ_MS);
		this.screenRead.unref?.();
	}

	/**
	 * Follows what its program reports of itself (OSC 7501): its question whether ptyd takes reports is answered at once, whichever
	 * window shows the run or none - ptyd implements the protocol, a window's terminal does not - and each report is taken. A new
	 * shell prompt (OSC 133 A) and a full reset (RIS) end what it reported (CLIS-2.3).
	 */
	private followStatus(): void {
		const parser = this.terminal.parser;
		parser.registerOscHandler(PROGRAM_STATUS_OSC, data => {
			const message = parseStatus(data);
			if (message === 'query') {
				// Answered as it came, unless the scan of its output missed it
				if (this.answeredQueries > 0) {
					this.answeredQueries--;
				} else if (this.writable) {
					this.send(STATUS_REPLY);
				}
				this.programStatus.asked();
			} else if (message) {
				this.programStatus.report(message);
			}
			return true;
		});
		parser.registerOscHandler(PROMPT_MARK_OSC, data => {
			if (/^A(?:;|$)/.test(data)) {
				this.programStatus.promptStarted();
			}
			return false;
		});
		parser.registerEscHandler({ final: 'c' }, () => {
			this.programStatus.clear();
			return false;
		});
	}
}
