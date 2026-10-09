/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import assert from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { BeforeShutdownEvent, ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { TerminalWidgetManager } from '../../../terminal/browser/widgets/widgetManager.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { ITerminalProcessManager, ProcessState } from '../../../terminal/common/terminal.js';
import { inputPieces, isAgentKey, keySequences } from '../../browser/facadeAgentKeys.js';
import { finalScreen, readScreen } from '../../browser/facadeAgentScreen.js';
import { FacadeAgentTerminal, IAgentTerminalOptions } from '../../browser/facadeAgentTerminal.js';

/** A terminal of the window as its contribution sees it: its process, what was written to it, and how it ends. */
class TestTerminal {

	private readonly _onExit: Emitter<number | undefined>;
	readonly onExit: Event<number | undefined>;
	private readonly _onWillDispose: Emitter<ITerminalInstance>;
	readonly onWillDispose: Event<ITerminalInstance>;
	private readonly _onDidInputData: Emitter<string>;
	readonly onDidInputData: Event<string>;

	/** What was written to its process, each with the time it went. */
	readonly written: string[] = [];
	/** While set, a write waits for it, as one to a process not ready yet does. */
	hold: Promise<void> | undefined;
	/** The next write fails with this. */
	failNext: Error | undefined;
	readonly title = '@lint #3 - Codex';
	isDisposed = false;
	exitCode: number | undefined;
	processId: number | undefined = 4242;
	/** Its process as its process manager has it: the state it is in, and what is written to it. */
	readonly process = { processState: ProcessState.Running, write: (data: string) => this.write(data) };

	constructor(store: Pick<DisposableStore, 'add'>, readonly raw?: RawXtermTerminal) {
		this._onExit = store.add(new Emitter<number | undefined>());
		this.onExit = this._onExit.event;
		this._onWillDispose = store.add(new Emitter<ITerminalInstance>());
		this.onWillDispose = this._onWillDispose.event;
		this._onDidInputData = store.add(new Emitter<string>());
		this.onDidInputData = this._onDidInputData.event;
		// What xterm takes in is the terminal's input, as the window tells it
		if (raw) {
			store.add(raw.onData(data => this._onDidInputData.fire(data)));
		}
	}

	get xtermReadyPromise(): Promise<XtermTerminal | undefined> { return Promise.resolve(this.raw && upcastPartial<XtermTerminal>({ raw: this.raw })); }

	/** As the person types `data` into it: xterm takes it in as typed. */
	type(data: string): void {
		this.raw?.input(data, true);
	}

	/** As the window sends it text for the person - a file dropped on it - past xterm: told as its input all the same. */
	async sendText(text: string): Promise<void> {
		this._onDidInputData.fire(text);
	}

	/** Its process exits, and the terminal says so once it drew what the process wrote last. */
	exit(code: number): void {
		this.process.processState = ProcessState.KilledByProcess;
		this.exitCode = code;
		this._onExit.fire(code);
	}

	dispose(): void {
		this._onWillDispose.fire(this.asInstance());
		this.isDisposed = true;
	}

	asInstance(): ITerminalInstance {
		return upcastPartial<ITerminalInstance>(this);
	}

	private async write(data: string): Promise<void> {
		await this.hold;
		const failure = this.failNext;
		this.failNext = undefined;
		if (failure) {
			throw failure;
		}
		this.written.push(`${Date.now()} ${JSON.stringify(data)}`);
	}
}

suite('Facade agent terminals', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let TerminalCtor: typeof RawXtermTerminal;
	/** The files written, by path. */
	let written: Map<string, unknown>;
	let onBeforeShutdown: Emitter<BeforeShutdownEvent>;

	suiteSetup(async () => {
		TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
	});

	setup(() => {
		written = new Map();
		onBeforeShutdown = store.add(new Emitter<BeforeShutdownEvent>());
	});

	function xterm(cols = 20, rows = 6, kitty = false): RawXtermTerminal {
		return store.add(new TerminalCtor({ cols, rows, allowProposedApi: true, vtExtensions: { kittyKeyboard: kitty } }));
	}

	function write(raw: RawXtermTerminal, data: string): Promise<void> {
		return new Promise(resolve => raw.write(data, resolve));
	}

	/**
	 * The contribution of `terminal`, its xterm ready where it has one: registered as the terminal of the
	 * agent `agent` says - #3's where left out - or, with null, no agent's.
	 */
	function contributionOf(terminal: TestTerminal, agent: IAgentTerminalOptions | null = { run: 3, finalScreen: URI.file('/record/screens/a3.json') }): FacadeAgentTerminal {
		const fileService = upcastPartial<IFileService>({
			writeFile: async (resource: URI, buffer: VSBuffer) => {
				written.set(resource.path, JSON.parse(buffer.toString()));
				return upcastPartial({});
			}
		});
		const lifecycleService = upcastPartial<ILifecycleService>({ onBeforeShutdown: onBeforeShutdown.event, onShutdownVeto: Event.None });
		const contribution = store.add(new FacadeAgentTerminal({ instance: terminal.asInstance(), processManager: upcastPartial<ITerminalProcessManager>(terminal.process), widgetManager: upcastPartial<TerminalWidgetManager>({}) }, fileService, lifecycleService, new NullLogService()));
		if (agent) {
			contribution.register(agent);
		}
		if (terminal.raw) {
			contribution.xtermReady(upcastPartial<IXtermTerminal & { raw: RawXtermTerminal }>({ raw: terminal.raw }));
		}
		return contribution;
	}

	suite('screens', () => {

		test('joins the rows a line wraps over, keeps blank lines between and cuts trailing spaces', async () => {
			const raw = xterm(10, 6);
			await write(raw, '\r\n\r\n  indented   \r\n\r\nabcdefghijklmno\r\nlast');
			assert.deepStrictEqual(readScreen(raw, 50), { lines: ['  indented', '', 'abcdefghijklmno', 'last'], buffer: 'normal', older: false, trimmed: false });
		});

		test('reads the bottom lines and says whether older ones are there, and whether the terminal let go of lines past its scrollback', async () => {
			const raw = xterm(20, 4);
			await write(raw, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix');
			const full = store.add(new TerminalCtor({ cols: 20, rows: 2, scrollback: 3, allowProposedApi: true }));
			await write(full, '1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7');
			assert.deepStrictEqual({ some: readScreen(raw, 2), full: readScreen(full, 50) }, {
				some: { lines: ['five', 'six'], buffer: 'normal', older: true, trimmed: false },
				full: { lines: ['3', '4', '5', '6', '7'], buffer: 'normal', older: false, trimmed: true }
			});
		});

		test('marks inverse video and dim text, and both; keeps a cursor drawn as an inverse space after text, and ends a picked item\'s bar with its text', async () => {
			const raw = xterm(40, 4);
			await write(raw, '\x1b[7m> Yes\x1b[0m no \x1b[2mhint\x1b[0m \x1b[7;2mX\x1b[0m\r\n> hi\x1b[7m \x1b[0m\r\n\x1b[7m 1. Yes            \x1b[0m\r\n> \x1b[7m \x1b[0m');
			assert.deepStrictEqual(readScreen(raw, 4).lines, ['[[> Yes]] no {{hint}} [[{{X}}]]', '> hi[[ ]]', '[[ 1. Yes]]', '> [[ ]]']);
		});

		test('reads a full-screen program\'s frame without the history behind it, and an empty terminal as no lines', async () => {
			const raw = xterm(20, 3);
			await write(raw, 'history\r\nmore\r\n\x1b[?1049h\x1b[H\x1b[2Jmenu\r\n\x1b[7m> pick\x1b[0m');
			assert.deepStrictEqual({ frame: readScreen(raw, 50), empty: readScreen(xterm(20, 3), 50) }, {
				frame: { lines: ['menu', '[[> pick]]'], buffer: 'alternate', older: false, trimmed: false },
				empty: { lines: [], buffer: 'normal', older: false, trimmed: false }
			});
		});

		test('reads wide characters once, and a wide character wrapped to the next row leaves no space in its line', async () => {
			const raw = xterm(5, 4);
			const wide = String.fromCharCode(0x4e2d, 0x6587);
			await write(raw, `abcd${wide}!`);
			assert.deepStrictEqual(readScreen(raw, 1).lines, [`abcd${wide}!`]);
		});

		test('a final screen is the screen as the terminal ended, after the last frame of a full-screen program that left it; one still on its frame, that frame once', async () => {
			const raw = xterm(20, 3);
			await write(raw, 'Error: bad model\r\n$');
			const onFrame = xterm(20, 3);
			await write(onFrame, '\x1b[?1049hframe');
			const longFrame = Array.from({ length: 1_999 }, (_, index) => `row ${index}`);
			assert.deepStrictEqual({ left: finalScreen(raw, ['menu', '> pick']), on: finalScreen(onFrame, ['older frame']), none: finalScreen(raw, undefined), long: finalScreen(raw, longFrame) }, {
				left: { frame: ['menu', '> pick'], final: { buffer: 'normal', lines: ['Error: bad model', '$'] } },
				on: { final: { buffer: 'alternate', lines: ['frame'] } },
				none: { final: { buffer: 'normal', lines: ['Error: bad model', '$'] } },
				// 2,000 lines in all: the frame first, then the newest of the screen
				long: { frame: longFrame, final: { buffer: 'normal', lines: ['$'] } }
			});
		});
	});

	suite('keys and what a terminal takes in', () => {

		test('takes the names and one printable character', () => {
			assert.deepStrictEqual({
				taken: ['Enter', 'Shift+Tab', 'PageDown', 'Ctrl+C', 'Ctrl+Z', 'y', '1', ' ', '?'].map(isAgentKey),
				refused: ['F1', 'enter', 'Ctrl+1', 'ab', '', '\x1b', '\t', String.fromCharCode(0x200b)].map(isAgentKey)
			}, { taken: Array(9).fill(true), refused: Array(8).fill(false) });
		});

		test('sends each as the terminal does for the person, in its modes - application cursor keys, the kitty protocol - and Ctrl+J as the line feed it is', async () => {
			const raw = xterm();
			const keys = ['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Backspace', 'Up', 'Ctrl+C', 'Ctrl+J', 'Space', 'y'];
			const normal = keys.map(key => keySequences(raw, key).join(''));
			await write(raw, '\x1b[?1h');
			const applicationCursor = keySequences(raw, 'Up');
			const kitty = xterm(20, 6, true);
			await write(kitty, '\x1b[>1u');
			assert.deepStrictEqual({ normal, applicationCursor, kitty: keySequences(kitty, 'Escape'), withoutXterm: [keySequences(undefined, 'Down'), keySequences(undefined, 'Ctrl+A')] }, {
				normal: ['\r', '\x1b', '\t', '\x1b[Z', '\x7f', '\x1b[A', '\x03', '\n', ' ', 'y'],
				applicationCursor: ['\x1bOA'],
				kitty: ['\x1b[27u'],
				withoutXterm: [['\x1b[B'], ['\x01']]
			});
		});

		test('tells typed text, Enter and Ctrl+C, other keys and the terminal\'s own replies apart - in the default encoding, the kitty protocol\'s and win32 input mode\'s', () => {
			assert.deepStrictEqual({
				typed: inputPieces('ab\r\x03'),
				keys: inputPieces('\x1b[A\x1bOB\x1b[3~\x7f\x1b'),
				replies: inputPieces('\x1b[12;3R\x1b[I\x1b[?1;2c\x1b]11;rgb:0/0/0\x07\x1bP>|xterm.js\x1b\\x'),
				kitty: inputPieces('\x1b[97u\x1b[13;2u\x1b[27u\x1b[97;1:3u\x1b[99;5u\x1b[13u'),
				win32: inputPieces('\x1b[65;30;97;1;0;1_\x1b[65;30;97;0;0;1_\x1b[38;72;0;1;0;1_\x1b[67;46;3;1;8;1_')
			}, {
				typed: ['text', 'text', 'submit', 'submit'],
				keys: ['key', 'key', 'key', 'key', 'key'],
				replies: ['reply', 'reply', 'reply', 'reply', 'reply', 'text'],
				kitty: ['text', 'text', 'key', 'key', 'submit', 'submit'],
				win32: ['text', 'key', 'key', 'submit']
			});
		});

		test('takes a bracketed paste as typing, whole, its line breaks too; and AltGr with a key in win32 input mode as the character it types', () => {
			const ESC = String.fromCharCode(27);
			const CR = String.fromCharCode(13);
			assert.deepStrictEqual({
				pasted: inputPieces(`${ESC}[200~one${CR}two${CR}${ESC}[201~`),
				pastedThenEnter: inputPieces(`${ESC}[200~x${ESC}[201~${CR}`),
				altGr: inputPieces(`${ESC}[81;16;64;1;9;1_`),
				altGrLetGo: inputPieces(`${ESC}[81;16;64;0;9;1_`)
			}, {
				pasted: ['text'],
				pastedThenEnter: ['text', 'submit'],
				altGr: ['text'],
				altGrLetGo: ['key']
			});
		});
	});

	suite('input', () => {

		test('pastes text - bracketed where the program asked for it - and presses Enter after the delay, as one operation', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const raw = xterm();
			await write(raw, '\x1b[?2004h');
			const terminal = new TestTerminal(store, raw);
			const effect = await contributionOf(terminal).type('go on', { enter: true, enterDelayMs: 300 });
			assert.deepStrictEqual({ effect, written: terminal.written }, {
				effect: { outcome: 'applied', pasted: true, entered: true },
				written: ['0 "\\u001b[200~go on\\u001b[201~"', '300 "\\r"']
			});
		}));

		test('takes one operation whole before the next: text and its Enter, every key of a call, 50 ms apart', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			const effects = await Promise.all([
				agent.type('first', { enter: true, enterDelayMs: 100 }),
				agent.keys(['Down', 'Enter'], {}),
				agent.type('second', { enter: false, enterDelayMs: 100 })
			]);
			assert.deepStrictEqual({ effects, written: terminal.written }, {
				effects: [{ outcome: 'applied', pasted: true, entered: true }, { outcome: 'applied', keysSent: 2 }, { outcome: 'applied', pasted: true, entered: false }],
				written: ['0 "first"', '100 "\\r"', '100 "\\u001b[B"', '150 "\\r"', '150 "second"']
			});
		}));

		test('waits behind what the person typed until ten seconds pass without a key, then goes in after it', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			terminal.type('fix th');
			const effect = agent.type('hello', { enter: true, enterDelayMs: 0 });
			await timeout(4_000);
			terminal.type('e');
			await timeout(4_000);
			// Keys that type nothing keep the line pending, and the person at it
			terminal.type('\x1b[D');
			assert.deepStrictEqual({ effect: await effect, written: terminal.written }, {
				effect: { outcome: 'applied', pasted: true, entered: true },
				written: ['18000 "hello"', '18000 "\\r"']
			});
		}));

		test('goes in at once once the person pressed Enter, or Ctrl+C; their replies to the program are no typing', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const entered = new TestTerminal(store, xterm());
			const cancelled = new TestTerminal(store, xterm());
			const replied = new TestTerminal(store, xterm());
			const agents = [contributionOf(entered), contributionOf(cancelled), contributionOf(replied)];
			entered.type('draft');
			cancelled.type('draft');
			replied.type('\x1b[5;1R\x1b[I');
			const effects = agents.map(agent => agent.keys(['y'], {}));
			await timeout(2_000);
			entered.type('\r');
			cancelled.type('\x03');
			assert.deepStrictEqual({ effects: await Promise.all(effects), written: [entered.written, cancelled.written, replied.written] }, {
				effects: Array(3).fill({ outcome: 'applied', keysSent: 1 }),
				written: [['2000 "y"'], ['2000 "y"'], ['0 "y"']]
			});
		}));

		test('Facade\'s own Enter does not end the person\'s line: their typing while a paste waits for its Enter holds the next operation back', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			const first = agent.type('one', { enter: true, enterDelayMs: 300 });
			const second = agent.type('two', { enter: false, enterDelayMs: 0 });
			await timeout(100);
			terminal.type('x');
			await Promise.all([first, second]);
			assert.deepStrictEqual(terminal.written, ['0 "one"', '300 "\\r"', '10100 "two"']);
		}));

		test('what the window sends there for the person - a file dropped on it - is their typing too, and holds what Facade types back', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			await terminal.sendText('/lab/notes.md');
			const effect = await agent.type('hello', { enter: false, enterDelayMs: 0 });
			assert.deepStrictEqual({ effect, written: terminal.written }, {
				effect: { outcome: 'applied', pasted: true, entered: false },
				written: ['10000 "hello"']
			});
		}));

		test('tells what the person typed there - whether a line is pending, and their last key - never what Facade typed', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			await agent.type('from Facade', { enter: true, enterDelayMs: 0 });
			const afterFacade = agent.inputState();
			await timeout(1_000);
			terminal.type('draft');
			const afterDraft = agent.inputState();
			terminal.type(String.fromCharCode(13));
			assert.deepStrictEqual({ afterFacade, afterDraft, afterEnter: agent.inputState() }, {
				afterFacade: { pending: false, lastKey: undefined, busy: false },
				afterDraft: { pending: true, lastKey: 1000, busy: false },
				afterEnter: { pending: false, lastKey: 1000, busy: false }
			});
		}));

		test('tells whether Facade\'s own input goes in there, or waits its turn, now: a doorbell waits until none does, then says what is unread', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			const idle = agent.inputState().busy;
			const typing = agent.type('one', { enter: true, enterDelayMs: 300 });
			const pressing = agent.keys(['Enter'], {});
			const whileTyping = agent.inputState().busy;
			await typing;
			const whilePressing = agent.inputState().busy;
			await pressing;
			assert.deepStrictEqual({ idle, whileTyping, whilePressing, after: agent.inputState().busy }, { idle: false, whileTyping: true, whilePressing: true, after: false });
		}));

		test('gives up on a call still waiting at its queue timeout - wherever it is in the queue - and never types it later', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			terminal.type('x');
			const notice = agent.type('task', { enter: true, enterDelayMs: 0 });
			const late = agent.type('late', { enter: true, enterDelayMs: 0, queueTimeoutMs: 5_000 });
			const atDeadline = agent.keys(['Enter'], { queueTimeoutMs: 10_000 });
			assert.deepStrictEqual({ late: await late, atDeadline: await atDeadline, notice: await notice, written: terminal.written }, {
				late: { outcome: 'not_applied', reason: 'timeout', pasted: false, entered: false },
				atDeadline: { outcome: 'not_applied', reason: 'timeout', keysSent: 0 },
				notice: { outcome: 'applied', pasted: true, entered: true },
				written: ['10000 "task"', '10000 "\\r"']
			});
		}));

		test('input queued before the window knew the process\'s id goes into that process once it does, not into another after it', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			terminal.processId = undefined;
			const agent = contributionOf(terminal);
			terminal.type('x');
			const first = agent.type('task', { enter: true, enterDelayMs: 0 });
			// Its first output, with which the id comes on Windows
			terminal.processId = 4242;
			const effect = await first;
			const next = agent.type('later', { enter: false, enterDelayMs: 0 });
			terminal.processId = 777;
			assert.deepStrictEqual({ effect, next: await next, written: terminal.written }, {
				effect: { outcome: 'applied', pasted: true, entered: true },
				next: { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false },
				written: ['10000 "task"', '10000 "\\r"']
			});
		}));

		test('drops what is waiting and the keys left once the process ends; a write that never goes ends with its terminal', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			const keys = agent.keys(['Down', 'Down', 'Enter'], {});
			const waiting = agent.type('after', { enter: true, enterDelayMs: 0 });
			await timeout(60);
			terminal.exit(130);
			const after = await agent.type('later', { enter: true, enterDelayMs: 0 });
			const stuck = new TestTerminal(store, xterm());
			stuck.hold = new DeferredPromise<void>().p;
			const stuckAgent = contributionOf(stuck);
			const neverWritten = stuckAgent.type('lost', { enter: true, enterDelayMs: 0 });
			await timeout(100);
			stuck.exit(1);
			assert.deepStrictEqual({ keys: await keys, waiting: await waiting, after, neverWritten: await neverWritten, written: terminal.written }, {
				keys: { outcome: 'partial', reason: 'ended', keysSent: 2 },
				waiting: { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false },
				after: { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false },
				neverWritten: { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false },
				written: ['0 "\\u001b[B"', '50 "\\u001b[B"']
			});
		}));

		test('takes a process that exited as ended at once, before its terminal says so: nothing is written to it then', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			const typing = agent.type('one', { enter: true, enterDelayMs: 300 });
			await timeout(100);
			// The terminal draws what the process wrote last before it tells of its exit
			terminal.process.processState = ProcessState.KilledByProcess;
			assert.deepStrictEqual({ typing: await typing, after: await agent.keys(['Enter'], {}), written: terminal.written }, {
				typing: { outcome: 'partial', reason: 'ended', pasted: true, entered: false },
				after: { outcome: 'not_applied', reason: 'ended', keysSent: 0 },
				written: ['0 "one"']
			});
		}));

		test('a write that fails leaves what went in unknown: the call fails, and is never said to have done nothing', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
			const terminal = new TestTerminal(store, xterm());
			const agent = contributionOf(terminal);
			terminal.failNext = new Error('the pty host went away');
			assert.deepStrictEqual(await agent.type('text', { enter: true, enterDelayMs: 0 }).then(() => 'done', err => (err as Error).message), 'the pty host went away');
		}));
	});

	suite('final screens', () => {

		test('keeps the screen as the terminal goes - what its process wrote last drawn first - with a full-screen program\'s last frame', async () => {
			const raw = xterm(20, 3);
			const terminal = new TestTerminal(store, raw);
			contributionOf(terminal);
			await write(raw, 'starting\r\n\x1b[?1049h\x1b[H\x1b[2JTrust this folder?\r\n\x1b[7m> Yes\x1b[0m\x1b[?1049lgone\r\n');
			// Not yet parsed as the terminal goes
			raw.write('bye');
			terminal.dispose();
			await timeout(0);
			assert.deepStrictEqual([...written], [['/record/screens/a3.json', { frame: ['Trust this folder?', '[[> Yes]]'], final: { buffer: 'normal', lines: ['starting', 'gone', 'bye'] } }]]);
		});

		test('keeps it once its process ends, once what it wrote is drawn - the terminal drawing on what comes after, once - and not again as its terminal closes', async () => {
			const raw = xterm(30, 4);
			const terminal = new TestTerminal(store, raw);
			contributionOf(terminal, { run: 4, finalScreen: URI.file('/record/screens/a4.json') });
			raw.write('bye');
			terminal.exit(1);
			// What the terminal says of its process's end, written as it ended
			await write(raw, '\r\n[process exited: 1]');
			const shown = readScreen(raw, 50).lines;
			terminal.dispose();
			await timeout(0);
			assert.deepStrictEqual({ shown, written: [...written] }, {
				shown: ['bye', '[process exited: 1]'],
				written: [['/record/screens/a4.json', { final: { buffer: 'normal', lines: ['bye'] } }]]
			});
		});

		test('registered again - the window gave its terminal back after a reload - keeps what it saw of it, its final screen going to the file it was given last', async () => {
			const raw = xterm(20, 3);
			const terminal = new TestTerminal(store, raw);
			const agent = contributionOf(terminal);
			await write(raw, '\x1b[?1049hmenu\x1b[?1049l$ ');
			agent.register({ run: 3, finalScreen: URI.file('/record/screens/a3-again.json') });
			terminal.dispose();
			await timeout(0);
			assert.deepStrictEqual([...written], [['/record/screens/a3-again.json', { frame: ['menu'], final: { buffer: 'normal', lines: ['$'] } }]]);
		});

		test('keeps none as the window shuts down or reloads while the process runs - it outlives its terminal - nor of a terminal no agent\'s', async () => {
			const running = new TestTerminal(store, xterm());
			contributionOf(running, { run: 5, finalScreen: URI.file('/record/screens/a5.json') });
			const shell = new TestTerminal(store, xterm());
			contributionOf(shell, null);
			shell.dispose();
			onBeforeShutdown.fire(upcastPartial<BeforeShutdownEvent>({}));
			running.dispose();
			await timeout(0);
			assert.deepStrictEqual([...written], []);
		});
	});
});
