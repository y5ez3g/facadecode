/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPty } from 'node-pty';
import type { RunExit, RunInfo, RunStatus, SpawnParams, Termination } from './protocol';
import { ScreenReader, screenReaderOf } from './screenStatus';
import { parseStatus, ProgramStatus, STATUS_REPLY } from './status';

/** The backend packaged beside ptyd, loaded lazily so tests can substitute the process adapter (ARCHITECTURE-1.2). */
let pty: typeof import('node-pty') | undefined;
/** A backend built without the ConPTY DLL can use Windows' own console for later runs too. */
let conptyDllMissing = false;
function loadPty(): typeof import('node-pty') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return pty ??= require('node-pty') as typeof import('node-pty');
}

function spawnPty(params: SpawnParams): IPty {
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

/** How soon after a Ctrl+C an exit counts as following it: the evidence an adapter may verify as an interrupt (RULES-3.3). */
const INTERRUPT_EVIDENCE_MS = 2_000;

/** How long a forced kill has to be confirmed by the process's exit. */
const KILL_CONFIRM_MS = 2_000;

/** How long a Windows console's output pipe may still bring what its program wrote last once it ended: node-pty's own flush time. */
const CONSOLE_FLUSH_MS = 1_000;

/** How soon after what it drew a screen read as its status is read again (CLIS-2.3): at most this often, while it draws. */
const SCREEN_READ_MS = 200;

/** What node-pty 1.1 keeps of a Windows console: the pipes to it, and the worker thread that reads its output. */
interface WindowsConsole {
	readonly _agent?: {
		readonly _conoutSocketWorker?: { dispose?(): void };
		readonly _outSocket?: { destroy?(): void };
		readonly _inSocket?: { destroy?(): void };
	};
}

/**
 * Lets go of node-pty's connection to a Windows console whose program ended. With the ConPTY DLL, node-pty 1.1 never closes the
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
 * five-minute connection cleanup policy. An upgrade alone never terminates it.
 */
export class Run {

	private readonly pty: IPty;
	private readonly terminal: import('@xterm/headless').Terminal;
	private readonly serializer: import('@xterm/addon-serialize').SerializeAddon;
	private listener: RunListener | undefined;
	private readonly exitListeners = new Set<(exit: RunExit) => void>();
	/** Whoever cannot take more of what the run writes yet: while anyone is, its pty is not read, and the CLI waits. */
	private readonly holders = new Set<object>();
	private readonly programStatus = new ProgramStatus();
	/** How its screen is read as its status while its program reports nothing, where its adapter names a reader (CLIS-2.3, D80). */
	private readonly screenReader: ScreenReader | undefined;
	private screenRead: ReturnType<typeof setTimeout> | undefined;
	/** The number of the last output chunk: each is numbered as it is drawn, so that a reattach never shows one twice. */
	private seq = 0;
	/** What was written to the headless terminal and is not drawn yet, in UTF-8 bytes. */
	private undrawn = 0;
	private title = '';
	private exited: RunExit | undefined;
	/** Set as node-pty reports the exit, before what it wrote last is drawn: from then on its PID is never signalled. */
	private reaped = false;
	/** When a Ctrl+C last went into its terminal. */
	private ctrlCAt: number | undefined;
	/** Set once a window removed it: no window lists it again, and it is dropped as it ends. */
	removed = false;
	readonly startedAt = Date.now();
	/** What the window keeps with its run, as it said last. */
	meta: { readonly [key: string]: unknown };

	constructor(readonly params: SpawnParams) {
		this.meta = params.meta;
		this.screenReader = screenReaderOf(params.screenStatus);
		const { Terminal } = loadXterm();
		const { SerializeAddon } = loadSerialize();
		const terminal = this.terminal = new Terminal({ cols: params.cols, rows: params.rows, scrollback: scrollbackRows(params.cols), allowProposedApi: true });
		this.serializer = new SerializeAddon();
		terminal.loadAddon(this.serializer as never);
		// Characters as wide as the window's terminal draws them, by Unicode 11: an emoji takes two cells
		const { Unicode11Addon } = loadUnicode11();
		terminal.loadAddon(new Unicode11Addon() as never);
		terminal.unicode.activeVersion = '11';
		terminal.onTitleChange(title => {
			this.title = title;
			this.listener?.title(title);
		});
		this.followStatus();
		this.programStatus.onDidChange(status => this.listener?.status(status));
		try {
			this.pty = spawnPty(params);
		} catch (error) {
			terminal.dispose();
			throw error;
		}
		// With no window showing it, ptyd answers what the program asks its terminal - where its cursor is - so that a CLI waiting
		// for the answer goes on; a window that shows it answers itself
		terminal.onData(reply => {
			if (!this.listener && !this.exited) {
				this.pty.write(reply);
			}
		});
		this.pty.onData(data => {
			const seq = ++this.seq;
			this.draw(data);
			this.listener?.output(seq, data);
		});
		this.pty.onExit(({ exitCode, signal }) => {
			this.reaped = true;
			const ctrlC = this.ctrlCAt !== undefined && Date.now() - this.ctrlCAt <= INTERRUPT_EVIDENCE_MS;
			// Told once what it wrote last is drawn
			this.terminal.write('', () => {
				this.exited = { exitCode, ...(signal ? { signal } : {}), ...(ctrlC ? { ctrlC: true as const } : {}) };
				this.holders.clear();
				this.listener?.exit(this.exited);
				// A listener may drop/dispose this run. Every waiter registered for this exit still receives it.
				for (const listener of [...this.exitListeners]) {
					listener(this.exited);
				}
			});
			if (process.platform === 'win32') {
				setTimeout(() => releaseConsole(this.pty), CONSOLE_FLUSH_MS).unref?.();
			}
		});
	}

	get id(): string {
		return this.params.run;
	}

	get hasExited(): boolean {
		return !!this.exited;
	}

	/** The run as `claimedElsewhere` has it for the connection asking. */
	info(claimedElsewhere: boolean): RunInfo {
		const status = this.programStatus.status;
		return {
			run: this.params.run,
			owner: this.params.owner,
			pid: this.pty.pid,
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
	 * Its screen as it stands, with the number of the last output in it (ARCHITECTURE-2.3): the empty write is the cut, so what
	 * was written before it is the screen and what comes after is numbered after `seq`.
	 */
	snapshot(): Promise<{ readonly screen: string; readonly seq: number }> {
		const seq = this.seq;
		return new Promise((resolve, reject) => this.terminal.write('', () => {
			try {
				resolve({ screen: this.serializer.serialize({ scrollback: scrollbackRows(this.terminal.cols) }), seq });
			} catch (err) {
				reject(err);
			}
		}));
	}

	/** Stops reading what the run writes until `holder` lets go: ordinary backpressure, the CLI waiting (ARCHITECTURE-2.4). */
	hold(holder: object): void {
		if (this.exited || this.holders.has(holder)) {
			return;
		}
		if (!this.holders.size) {
			this.pty.pause();
		}
		this.holders.add(holder);
	}

	release(holder: object): void {
		if (this.holders.delete(holder) && !this.holders.size && !this.exited) {
			this.pty.resume();
		}
	}

	/** What the person typed in the window that shows the run: straight to its process (EXPERIENCE-2.1). */
	write(data: string): void {
		if (this.exited) {
			return;
		}
		if (hasCtrlC(data)) {
			this.ctrlCAt = Date.now();
		}
		this.pty.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.exited || cols < 1 || rows < 1 || (cols === this.terminal.cols && rows === this.terminal.rows)) {
			return;
		}
		this.pty.resize(cols, rows);
		this.terminal.resize(cols, rows);
		this.terminal.options.scrollback = scrollbackRows(cols);
	}

	/**
	 * Ends its process (LIFECYCLE-4.2): its process group hung up, as a closed terminal would, then killed where it has not ended
	 * within `graceMs`. A process already reaped is never signalled: its PID may be another's now. Windows ends the console's
	 * processes as node-pty does. Answers what its exit showed.
	 */
	async terminate(graceMs: number): Promise<Termination> {
		if (this.exited) {
			return 'already_exited';
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

	/** Ends what is left of it: ptyd itself is going, or a window forgot it. */
	dispose(): void {
		this.signal(process.platform === 'win32' ? undefined : 'SIGHUP');
		this.listener = undefined;
		this.exitListeners.clear();
		clearTimeout(this.screenRead);
		this.screenRead = undefined;
		this.terminal.dispose();
	}

	/**
	 * Sends `signal` to its process group - the leader and what it started in its session - while the leader is not reaped; on
	 * Windows node-pty's kill. False where nothing could be signalled.
	 */
	private signal(signal: NodeJS.Signals | undefined): boolean {
		if (this.reaped) {
			return false;
		}
		if (process.platform === 'win32' || signal === undefined) {
			try {
				this.pty.kill();
				return true;
			} catch {
				return false;
			}
		}
		// Only a real process group: -1 would be every process this user may signal, -0 the caller's own group
		const pid = this.pty.pid;
		try {
			if (!Number.isInteger(pid) || pid <= 1) {
				throw new Error(`No process group ${pid}.`);
			}
			process.kill(-pid, signal);
			return true;
		} catch {
			// No group of its own: its leader alone
			try {
				this.pty.kill(signal);
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
		const size = Buffer.byteLength(data, 'utf8');
		this.undrawn += size;
		if (this.undrawn > MOST_RUN_BUFFER) {
			this.hold(DRAWING);
		}
		this.terminal.write(data, () => {
			this.undrawn -= size;
			if (this.undrawn <= MOST_RUN_BUFFER / 2) {
				this.release(DRAWING);
			}
			this.readScreenSoon();
		});
	}

	/**
	 * Reads its screen as its status a moment after it drew (CLIS-2.3, D80), where its adapter names a reader and its program has
	 * neither asked nor reported: at most every {@link SCREEN_READ_MS}, never in the middle of a synchronized update, and no more once
	 * the program takes part or ends.
	 */
	private readScreenSoon(): void {
		if (!this.screenReader || this.screenRead || this.programStatus.takesPart || this.exited) {
			return;
		}
		this.screenRead = setTimeout(() => {
			this.screenRead = undefined;
			if (this.programStatus.takesPart || this.exited) {
				return;
			}
			if (this.terminal.modes.synchronizedOutputMode) {
				this.readScreenSoon();
				return;
			}
			const reading = this.screenReader!(this.screenRows());
			if (reading) {
				this.programStatus.observed(reading);
			}
		}, SCREEN_READ_MS);
		this.screenRead.unref?.();
	}

	/** The rows its terminal shows now, top to bottom, each without the spaces at its end. */
	private screenRows(): string[] {
		const buffer = this.terminal.buffer.active;
		const rows: string[] = [];
		for (let y = 0; y < this.terminal.rows; y++) {
			rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
		}
		return rows;
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
				if (!this.exited) {
					this.pty.write(STATUS_REPLY);
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
