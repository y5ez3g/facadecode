/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../terminal/browser/terminalExtensions.js';
import { ITerminalProcessManager, ProcessState } from '../../terminal/common/terminal.js';
import { inputPieces, keySequences, PASTE_END, PASTE_START } from './facadeAgentKeys.js';
import { finalScreen, IAgentScreen, MOST_SCREEN_LINES, readScreen } from './facadeAgentScreen.js';

/** How long the person's unsent typing in a terminal holds automated input back, from their last key. */
const PERSON_INPUT_GUARD_MS = 10_000;

/** The pause between two keys of one call. */
const KEY_GAP_MS = 50;

/** The DEC private modes whose reset leaves the alternate buffer: `CSI ? 1049 l`, `? 1047 l` and `? 47 l`. */
const ALTERNATE_BUFFER_MODES: ReadonlySet<number> = new Set([1049, 1047, 47]);

/** A screen as an agent's terminal gives it: its lines, and when it was read and last showed output. */
export interface IAgentScreenRead extends IAgentScreen {
	/** When it was read, in milliseconds since 1970. */
	readonly capturedAt: number;
	/** When the terminal last showed new output, where that is known: a terminal registered as an agent's. */
	readonly lastOutput: number | undefined;
}

/** What automated input into a terminal did: what went in, and why the rest did not. */
export interface IAgentInputEffect {
	/** `applied`: all of it; `partial`: a first part, the terminal ending before the rest; `not_applied`: nothing. */
	readonly outcome: 'applied' | 'partial' | 'not_applied';
	/** Why not all of it went in: the terminal ended, or the input waited in its queue past its time. */
	readonly reason?: 'ended' | 'timeout';
	/** For text: whether it was pasted. */
	readonly pasted?: boolean;
	/** For text: whether Enter followed. */
	readonly entered?: boolean;
	/** For keys: how many went in, from the first. */
	readonly keysSent?: number;
}

/** A terminal registered as an agent's: its run, and the file its final screen goes to. */
export interface IAgentTerminalOptions {
	/** The agent's number, which its run has in the agents' extension. */
	readonly run: number;
	/** Where its final screen is written once its process ends or its terminal closes. */
	readonly finalScreen: URI;
}

/** How a line is typed: with Enter after it or not, and how long it may wait for its turn. */
export interface IAgentTypeOptions {
	readonly enter: boolean;
	/** How long after the paste Enter is pressed: the time its CLI needs to take the paste in. */
	readonly enterDelayMs: number;
	/** How long it may wait for its turn; none to wait as long as the person's typing holds it. */
	readonly queueTimeoutMs?: number;
}

/** How keys are pressed: how long they may wait for their turn. */
export interface IAgentKeysOptions {
	/** How long they may wait for their turn; none to wait as long as the person's typing holds them. */
	readonly queueTimeoutMs?: number;
}

/** What the person typed into an agent's terminal, never what Facade typed there. */
export interface IAgentPersonInput {
	/** Whether they typed since they last pressed Enter or Ctrl+C there. */
	readonly pending: boolean;
	/** When they last typed there, in milliseconds since 1970. */
	readonly lastKey: number | undefined;
}

/** What holds automated input into an agent's terminal back now: the person's typing, and Facade's own input there. */
export interface IAgentInputState extends IAgentPersonInput {
	/** Whether Facade's own input goes in there, or waits its turn. */
	readonly busy: boolean;
}

/** xterm's terminal with the write buffer its core keeps, as `xtermTerminal.ts` reaches the core: internal to xterm. */
interface ITerminalWithWriteBuffer extends RawXtermTerminal {
	readonly _core?: { readonly _writeBuffer?: { flushSync?(): void } };
}

/**
 * What the person types into one terminal, as the terminal takes it in - their keys and pastes, what the
 * window sends for them, a dropped file's path or a keybinding's sequence, and what the terminal answers
 * a program with; never Facade's own input, which goes to the process past it: a character typed leaves
 * a line pending, Enter sends it and Ctrl+C drops it; while one is pending, any key is the person still
 * at it. A terminal's replies are no key.
 */
class PersonInput extends Disposable {

	private _pending = false;
	private _lastKey: number | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Follows what `instance` takes in from now on. */
	attach(instance: ITerminalInstance): void {
		this._register(instance.onDidInputData(data => this.took(data)));
	}

	/** Whether the person typed since they last pressed Enter or Ctrl+C, and when they last typed. */
	state(): IAgentPersonInput {
		return { pending: this._pending, lastKey: this._lastKey };
	}

	/** When the person's typing stops holding automated input back; undefined while it does not. */
	releaseTime(): number | undefined {
		return this._pending && this._lastKey !== undefined ? this._lastKey + PERSON_INPUT_GUARD_MS : undefined;
	}

	private took(data: string): void {
		const pending = this._pending;
		const lastKey = this._lastKey;
		for (const piece of inputPieces(data)) {
			if (piece === 'submit') {
				this._pending = false;
			} else if (piece === 'text') {
				this._pending = true;
				this._lastKey = Date.now();
			} else if (piece === 'key' && this._pending) {
				this._lastKey = Date.now();
			}
		}
		if (pending !== this._pending || lastKey !== this._lastKey) {
			this._onDidChange.fire();
		}
	}
}

/** One operation waiting its turn in a terminal's queue. */
interface IQueuedInput {
	/** Runs it, `alive` saying whether its terminal still runs the process it was queued for. */
	readonly run: (alive: () => boolean) => Promise<IAgentInputEffect>;
	/** By when it must have begun, in milliseconds since 1970; none to wait as long as it takes. */
	readonly deadline: number | undefined;
	/** The process it was queued for: the first id the window knew it by, where it knew none yet. */
	processId: number | undefined;
	readonly done: DeferredPromise<IAgentInputEffect>;
	/** What it answers with, should it never begin. */
	readonly notApplied: IAgentInputEffect;
	/** Ends its wait at its deadline, wherever it is in the queue. */
	expiry?: ReturnType<typeof setTimeout>;
}

/**
 * The input of one terminal, in turn: each operation whole - text and its Enter, every key of a call -
 * before the next begins, and each begun only once the person's typing there lets it. An operation still
 * waiting at its deadline, wherever it is in the queue, leaves it without going in. Once the terminal's
 * process ends, or the queue goes with its terminal, nothing waiting goes in.
 */
class InputQueue extends Disposable {

	private readonly queued: IQueuedInput[] = [];
	private draining = false;
	private readonly ended = new DeferredPromise<void>();

	constructor(
		private readonly instance: ITerminalInstance,
		private readonly processManager: ITerminalProcessManager,
		private readonly person: PersonInput
	) {
		super();
		this._register(instance.onExit(() => this.end()));
	}

	override dispose(): void {
		this.end();
		super.dispose();
	}

	/** Settles once the terminal's process ended, or the queue went with its terminal. */
	get whenEnded(): Promise<void> {
		return this.ended.p;
	}

	/** Whether an operation goes in now, or waits its turn. */
	get busy(): boolean {
		return this.draining || this.queued.length > 0;
	}

	add(run: IQueuedInput['run'], queueTimeoutMs: number | undefined, notApplied: IAgentInputEffect): Promise<IAgentInputEffect> {
		const done = new DeferredPromise<IAgentInputEffect>();
		if (this.ended.isSettled || !this.isRunning(this.instance.processId)) {
			done.complete({ ...notApplied, reason: 'ended' });
			return done.p;
		}
		const item: IQueuedInput = { run, deadline: queueTimeoutMs === undefined ? undefined : Date.now() + queueTimeoutMs, processId: this.instance.processId, done, notApplied };
		if (queueTimeoutMs !== undefined) {
			// Behind other operations as much as behind the person
			item.expiry = setTimeout(() => this.expire(item), queueTimeoutMs);
		}
		this.queued.push(item);
		void this.drain();
		return done.p;
	}

	/** An operation still waiting at its deadline leaves the queue, and goes in neither now nor later. */
	private expire(item: IQueuedInput): void {
		const index = this.queued.indexOf(item);
		if (index >= 0) {
			this.queued.splice(index, 1);
			item.done.complete({ ...item.notApplied, reason: 'timeout' });
		}
	}

	/** Takes `item` out of the queue as it begins, or is answered without beginning: its deadline no longer counts. */
	private leave(item: IQueuedInput): void {
		clearTimeout(item.expiry);
		const index = this.queued.indexOf(item);
		if (index >= 0) {
			this.queued.splice(index, 1);
		}
	}

	/** Nothing waiting goes in any more: the terminal's process ended, or the terminal went. */
	private end(): void {
		if (this.ended.isSettled) {
			return;
		}
		this.ended.complete();
		for (const item of [...this.queued]) {
			this.leave(item);
			item.done.complete({ ...item.notApplied, reason: 'ended' });
		}
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (this.queued.length) {
				const item = this.queued[0];
				const turn = await this.waitForPerson(item);
				if (this.queued[0] !== item) {
					// Answered meanwhile: its deadline passed, or the terminal ended
					continue;
				}
				this.leave(item);
				if (turn !== 'go') {
					item.done.complete({ ...item.notApplied, reason: turn });
					continue;
				}
				try {
					item.done.complete(await item.run(() => !this.ended.isSettled && this.isRunning(item.processId, item)));
				} catch (err) {
					// What went in before it failed is not known: the caller is told it failed, never that nothing did
					item.done.error(err);
				}
			}
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Waits until `item` may begin: while the person has typed something unsent and pressed a key within
	 * {@link PERSON_INPUT_GUARD_MS}, it waits - for Enter or Ctrl+C, or that long without another key -
	 * then goes in after what they typed. Never past the item's deadline, nor the terminal's end.
	 */
	private async waitForPerson(item: IQueuedInput): Promise<'go' | 'timeout' | 'ended'> {
		while (true) {
			if (this.ended.isSettled || !this.isRunning(item.processId, item)) {
				return 'ended';
			}
			const now = Date.now();
			if (item.deadline !== undefined && item.deadline <= now) {
				return 'timeout';
			}
			const release = this.person.releaseTime();
			if (release === undefined || release <= now) {
				return 'go';
			}
			const store = new DisposableStore();
			const timer = timeout(Math.min(release, item.deadline ?? release) - now);
			try {
				await Promise.race([timer, Event.toPromise(this.person.onDidChange, store), this.ended.p]);
			} finally {
				timer.cancel();
				store.dispose();
			}
		}
	}

	/**
	 * Whether the terminal runs `processId` still: not ended, nor running another process since. A process
	 * that exited is ended at once, though the terminal draws what it wrote last before it says so: what is
	 * written to it then goes nowhere. Input queued before the window knew the process's id - on Windows it
	 * comes with the process's first output - takes the first id the window knows, which `item` keeps from
	 * then on.
	 */
	private isRunning(processId: number | undefined, item?: IQueuedInput): boolean {
		const state = this.processManager.processState;
		if (this.instance.isDisposed || this.instance.exitCode !== undefined || state === ProcessState.KilledDuringLaunch || state === ProcessState.KilledByUser || state === ProcessState.KilledByProcess) {
			return false;
		}
		if (processId === undefined) {
			if (item) {
				item.processId = this.instance.processId;
			}
			return true;
		}
		return this.instance.processId === processId;
	}
}

/** What is kept of a terminal registered as an agent's. */
interface IAgentTerminal {
	options: IAgentTerminalOptions;
	/** The last frame a full-screen program drew before it left the alternate buffer. */
	alternateFrame: readonly string[] | undefined;
	lastOutput: number | undefined;
	/** Set once its final screen was taken. */
	captured: boolean;
}

/**
 * What the agents' extension does through the workbench in a terminal registered as an agent's: reads its
 * screen as the terminal draws it; types and presses keys there, one operation at a time, behind what the
 * person is typing; and keeps its final screen as it ends - with the last frame of a full-screen program
 * that left the alternate buffer. Any terminal's screen can be read; one no agent's is neither watched nor
 * kept.
 */
export class FacadeAgentTerminal extends Disposable implements ITerminalContribution {

	static readonly ID = 'terminal.facadeAgent';

	static get(instance: ITerminalInstance): FacadeAgentTerminal | null {
		return instance.getContribution<FacadeAgentTerminal>(FacadeAgentTerminal.ID);
	}

	private readonly person = this._register(new PersonInput());
	private readonly queue: InputQueue;
	private raw: RawXtermTerminal | undefined;
	private agent: IAgentTerminal | undefined;
	/** Set once the agent's terminal is watched: `watchAgent`. */
	private watching = false;
	/** Set while the window shuts down, or reloads: its terminals go, their processes not with them. */
	private shuttingDown = false;

	constructor(
		private readonly ctx: ITerminalContributionContext,
		@IFileService private readonly fileService: IFileService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.queue = this._register(new InputQueue(ctx.instance, ctx.processManager, this.person));
		// Before the terminal disposes its contributions, this one among them: its buffer is still there
		this._register(ctx.instance.onWillDispose(() => this.capture(true)));
		this._register(ctx.instance.onExit(() => this.captureWhenParsed()));
		this._register(lifecycleService.onBeforeShutdown(() => this.shuttingDown = true));
		this._register(lifecycleService.onShutdownVeto(() => this.shuttingDown = false));
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this.raw = xterm.raw;
		this.watchAgent();
	}

	/** Whether the terminal is registered as an agent's. */
	get isAgent(): boolean {
		return !!this.agent;
	}

	/** Whether the terminal's process has ended, the terminal kept open. */
	get exited(): boolean {
		return this.ctx.instance.exitCode !== undefined;
	}

	/**
	 * What holds Facade's input there back now: what the person typed, watched from when it is registered as an
	 * agent's, and whether Facade's own input goes in or waits its turn.
	 */
	inputState(): IAgentInputState {
		return { ...this.person.state(), busy: this.queue.busy };
	}

	/**
	 * Registers the terminal as an agent's: its final screen is written to `options.finalScreen` once its
	 * process ends or the terminal closes. Registering it again - after a reload, the terminal found
	 * again - keeps what was seen of it.
	 */
	register(options: IAgentTerminalOptions): void {
		if (this.agent?.options.run === options.run) {
			this.agent.options = options;
		} else {
			this.agent = { options, alternateFrame: undefined, lastOutput: undefined, captured: false };
		}
		this.watchAgent();
	}

	/** The bottom `lines` lines of the screen; undefined while the terminal has none. */
	async read(lines: number): Promise<IAgentScreenRead | undefined> {
		const raw = this.raw ?? (await this.ctx.instance.xtermReadyPromise)?.raw;
		if (!raw) {
			return undefined;
		}
		return { ...readScreen(raw, Math.max(1, Math.min(MOST_SCREEN_LINES, Math.floor(lines)))), capturedAt: Date.now(), lastOutput: this.agent?.lastOutput };
	}

	/**
	 * Pastes `text` as one paste - bracketed where the terminal's program turned that mode on - and, with
	 * Enter, presses Enter `options.enterDelayMs` later: in its turn, behind what the person is typing.
	 */
	type(text: string, options: IAgentTypeOptions): Promise<IAgentInputEffect> {
		const notApplied: IAgentInputEffect = { outcome: 'not_applied', pasted: false, entered: false };
		return this.queue.add(async alive => {
			if (!alive()) {
				return { ...notApplied, reason: 'ended' };
			}
			const pasted = this.raw?.modes.bracketedPasteMode ? `${PASTE_START}${text}${PASTE_END}` : text;
			if (!await this.send(pasted)) {
				return { ...notApplied, reason: 'ended' };
			}
			if (!options.enter) {
				return { outcome: 'applied', pasted: true, entered: false };
			}
			await timeout(Math.max(0, options.enterDelayMs));
			if (!alive() || !await this.send('\r')) {
				return { outcome: 'partial', reason: 'ended', pasted: true, entered: false };
			}
			return { outcome: 'applied', pasted: true, entered: true };
		}, options.queueTimeoutMs, notApplied);
	}

	/**
	 * Presses `keys`, each one `isAgentKey` takes, in order and {@link KEY_GAP_MS} apart, each as the
	 * terminal sends it for a key the person presses in its modes then: in its turn, behind what the
	 * person is typing.
	 */
	keys(keys: readonly string[], options: IAgentKeysOptions): Promise<IAgentInputEffect> {
		const notApplied: IAgentInputEffect = { outcome: 'not_applied', keysSent: 0 };
		return this.queue.add(async alive => {
			for (let sent = 0; sent < keys.length; sent++) {
				if (sent) {
					await timeout(KEY_GAP_MS);
				}
				// Encoded as it is pressed: the keys before it can have changed the terminal's modes
				if (!alive() || !await this.send(keySequences(this.raw, keys[sent]).join(''))) {
					return { outcome: sent ? 'partial' : 'not_applied', reason: 'ended', keysSent: sent };
				}
			}
			return { outcome: 'applied', keysSent: keys.length };
		}, options.queueTimeoutMs, notApplied);
	}

	/**
	 * Watches an agent's terminal once both its buffer and its registration are there: what the person
	 * types there, when it last showed output, and the last frame of a full-screen program, taken just
	 * before xterm leaves the alternate buffer - its own handler of that sequence still runs. A terminal no
	 * agent's is not watched.
	 */
	private watchAgent(): void {
		const raw = this.raw;
		if (!raw || !this.agent || this.watching) {
			return;
		}
		this.watching = true;
		this.person.attach(this.ctx.instance);
		this._register(raw.onWriteParsed(() => {
			if (this.agent) {
				this.agent.lastOutput = Date.now();
			}
		}));
		this._register(raw.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
			if (this.agent && raw.buffer.active.type === 'alternate' && params.some(param => typeof param === 'number' && ALTERNATE_BUFFER_MODES.has(param))) {
				this.agent.alternateFrame = readScreen(raw, MOST_SCREEN_LINES).lines;
			}
			return false;
		}));
	}

	/**
	 * Writes `data` to the terminal's process as it is - no line ending rewritten, as a program's text
	 * (`sendText`) would have it - never through a DOM event, which VS Code's keybindings would see first.
	 * A person scrolled up in the terminal stays where they were. False where the terminal ended before
	 * it went.
	 */
	private async send(data: string): Promise<boolean> {
		const buffer = this.raw?.buffer.active;
		const viewport = buffer && buffer.viewportY < buffer.baseY ? buffer.viewportY : undefined;
		// A process that never got going leaves its write waiting: the terminal's end settles it
		const written = await Promise.race([this.ctx.processManager.write(data).then(() => true), this.queue.whenEnded.then(() => false)]);
		if (viewport !== undefined) {
			this.raw?.scrollToLine(viewport);
		}
		return written;
	}

	/**
	 * Takes the final screen once what the process wrote last is drawn: its terminal can stay open after it.
	 * xterm calls back from within its write loop, which must not be flushed then - it would parse again
	 * what it has parsed, and drop what is written after - and has no need to: what came before is drawn.
	 */
	private captureWhenParsed(): void {
		this.raw?.write('', () => this.capture(false));
	}

	/**
	 * Takes an agent terminal's final screen, once, and writes it to its file - with `flush`, what the
	 * process wrote last and xterm has not parsed yet drawn first, as the terminal goes. Not as the window
	 * shuts down or reloads while the process runs: it outlives its terminal.
	 */
	private capture(flush: boolean): void {
		const agent = this.agent;
		const raw = this.raw;
		if (!agent || agent.captured || !raw || (this.shuttingDown && this.ctx.instance.exitCode === undefined)) {
			return;
		}
		agent.captured = true;
		if (flush) {
			(raw as ITerminalWithWriteBuffer)._core?._writeBuffer?.flushSync?.();
		}
		const { finalScreen: file } = agent.options;
		this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(finalScreen(raw, agent.alternateFrame)))).then(undefined, err => {
			this.logService.warn(`[facade] The final screen of ${this.ctx.instance.title} could not be kept in ${file.toString()}: ${toErrorMessage(err)}`);
		});
	}
}

registerTerminalContribution(FacadeAgentTerminal.ID, FacadeAgentTerminal);
