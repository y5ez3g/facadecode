/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import type * as AgentPtyModule from '../host/execution/agentPty';
import type { RunBinding } from '../host/execution/agentPty';
import { TerminalReplies } from '../base/terminalReplies';
import { TestEmitter, withModules } from './withModules';

const COLOURS = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\';
const ANSWERED = '\x1b]10;rgb:cccc/cccc/cccc\x1b\\\x1b]11;rgb:1919/1a1a/1b1b\x1b\\';

suite('An editor terminal\'s answers reach the program only as the answer it waits for (ARCHITECTURE-2.3)', () => {

	// Codex, made behind other tabs, asked its terminal's colours; VS Code drew the question - and answered it - once the tab was
	// opened, minutes later: Codex read an Escape and `]10;rgb:cccc/cccc/cccc\]11;rgb:1919/1a1a/1b1b\` in its input (2026-11-03).
	// Codex waits 200 to 300 ms: through the window and ptyd, even a prompt answer of VS Code's can pass that on a busy machine
	test('an editor\'s colour report never reaches the program, however soon it comes: it tells the window its colours, which ptyd answers with', () => {
		const learned: string[] = [];
		const replies = new TerminalReplies((osc, rgb) => learned.push(`${osc} ${rgb}`));
		replies.wrote(`Codex starting${COLOURS}`, 1_000);
		assert.strictEqual(replies.typed(ANSWERED, 1_000 + 20), '', 'at once');
		assert.strictEqual(replies.typed(`a${ANSWERED}b`, 90_000), 'ab', 'late, the keys around it kept');
		// The cursor colour, a palette entry, BEL as well as ST
		assert.strictEqual(replies.typed('\x1b]12;rgb:ffff/ffff/ffff\x07\x1b]4;1;rgb:cd/31/31\x07', 100_000), '');
		assert.deepStrictEqual(learned, ['10 cccc/cccc/cccc', '11 1919/1a1a/1b1b', '10 cccc/cccc/cccc', '11 1919/1a1a/1b1b', '12 ffff/ffff/ffff']);
	});

	test('what ptyd answers itself never comes from the editor too; what only the editor knows comes when prompt; keys, pastes and mouse reports go through', () => {
		const replies = new TerminalReplies();
		// Device attributes, status, modes and settings: ptyd's headless terminal answered them as they were asked
		for (const answer of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?2004;2$y', '\x1b[4;2$y', '\x1bP1$r0m\x1b\\', '\x1b[?3;5R']) {
			assert.strictEqual(replies.typed(answer, 1), '', JSON.stringify(answer));
		}
		// A cursor position answers a cursor question ptyd answered; with none asked it is a key - Ctrl+F3
		replies.wrote('\x1b[6n', 10);
		assert.strictEqual(replies.typed('\x1b[24;1R', 20), '');
		assert.strictEqual(replies.typed('\x1b[1;5R', 30), '\x1b[1;5R');
		// The kitty keyboard flags, the terminal's name, its unit and its size: the editor's own, when prompt
		replies.wrote('\x1b[?u\x1b[>q\x1b[=c\x1b[14t', 100);
		const own = '\x1b[?1u\x1bP>|xterm.js(6.1.0)\x1b\\\x1bP!|00000000\x1b\\\x1b[4;720;1280t';
		assert.strictEqual(replies.typed(own, 150), own);
		assert.strictEqual(replies.typed(own, 100_000), '', 'none asked any more');
		// Keys - kitty's too - a bracketed paste, a focus report and mouse reports are the person's
		const typed = 'hi\r\x1b[A\x1b[13;2u\x1b[200~text\x1b[201~\x1b[I\x1b[<0;10;5M\x1b[<0;10;5m\x1bOR';
		assert.strictEqual(replies.typed(typed, 200_000), typed);
	});

	test('a question of the editor\'s own it never answered stands for no later answer; a terminal gone takes its questions with it, so a modified F3 is a key again', () => {
		const replies = new TerminalReplies();
		// XTWINOPS: VS Code answers 14t, its size in pixels, and not 11t; an 11t long unanswered does not take the 14t answer's place
		replies.wrote('\x1b[11t', 1_000);
		replies.wrote('\x1b[14t', 10_000);
		assert.strictEqual(replies.typed('\x1b[4;720;1280t', 10_050), '\x1b[4;720;1280t');
		// A cursor question the terminal never answered - it went first - leaves the person's Ctrl+F3 their key
		replies.wrote('\x1b[6n', 20_000);
		replies.reset();
		assert.strictEqual(replies.typed('\x1b[1;5R', 30_000), '\x1b[1;5R');
	});
});

suite('An agent\'s terminal draws its run as it stands, from its screen (ARCHITECTURE-2.3)', () => {
	const made: { dispose(): void }[] = [];
	teardown(() => { made.splice(0).forEach(each => each.dispose()); });
	const load = (answersQueries = true) => {
		const vscode = { EventEmitter: TestEmitter };
		const module = withModules({ vscode })<typeof AgentPtyModule>(path.join(__dirname, '..', 'host', 'execution', 'agentPty.js'));
		const pty = new module.AgentPty('Ada', () => undefined);
		made.push(pty);
		// What reaches the editor's terminal of the run, Facade's own colour questions aside
		const drawn: string[] = [];
		pty.onDidWrite(data => { if (!data.startsWith('\x1b]10;?')) { drawn.push(data); } });
		// The screens taken, answered as the test says, and what reaches the run's process
		const taken: ((screen: string, seq: number) => void)[] = [];
		const typed: string[] = [];
		const binding: RunBinding = {
			snapshot: () => new Promise(resolve => taken.push((screen, seq) => resolve({ screen, seq }))),
			input: data => typed.push(data),
			resize: () => undefined,
			answersQueries
		};
		return { pty, drawn, taken, typed, binding };
	};
	const settled = () => new Promise(resolve => setImmediate(resolve));

	test('output that comes while it is not open is never kept for it: it opens on the run\'s screen taken anew, with no question asked before', async () => {
		const { pty, drawn, taken, binding } = load();
		pty.note('Starting Codex...');
		// A reattach took its screen while the terminal was not open: not drawn, and what follows is not kept
		pty.expectScreen();
		pty.bind(binding, { screen: 'old screen', seq: 3 });
		pty.output(4, `Codex asks: ${COLOURS}`);
		pty.output(5, 'more');
		assert.strictEqual(taken.length, 0, 'no screen is asked for a terminal not open');
		pty.open({ columns: 80, rows: 24 });
		assert.deepStrictEqual(drawn.join(''), '\x1b[2mStarting Codex...\x1b[0m\r\n', 'Facade\'s own line is kept for it, the run\'s output is not');
		assert.strictEqual(taken.length, 1);
		pty.output(6, 'while the screen is taken');
		taken[0]('the screen at 5', 5);
		await settled();
		pty.output(7, 'live');
		assert.ok(drawn.slice(1).join('').endsWith('the screen at 5while the screen is takenlive'));
		assert.ok(!drawn.join('').includes(COLOURS), 'the question asked while it was not open never reaches it');
	});

	test('how its process ended follows its last screen: a run that ended while its terminal was not open shows it after the screen it opens on, and again after a screen drawn anew', async () => {
		const { pty, drawn, taken, binding } = load();
		pty.expectScreen();
		pty.bind(binding, { screen: 'taken before it opened', seq: 3 });
		pty.exited('[Agent process exited with code 1]');
		assert.strictEqual(drawn.length, 0);
		pty.open({ columns: 80, rows: 24 });
		taken[0]('final screen', 3);
		await settled();
		const first = drawn.join('');
		assert.ok(/final screen\r\n\x1b\[2m\[Agent process exited with code 1\]\x1b\[0m\r\n$/.test(first), JSON.stringify(first));
		assert.strictEqual(first.split('exited with code 1').length, 2, 'said once');
		// Its terminal relaunched: the screen is drawn anew, from a reset terminal, and the line after it again
		pty.close();
		pty.open({ columns: 80, rows: 24 });
		taken[taken.length - 1]('final screen', 3);
		await settled();
		const again = drawn.join('').slice(first.length);
		assert.ok(again.startsWith('\x1bc') && again.endsWith('[Agent process exited with code 1]\x1b[0m\r\n'), JSON.stringify(again));
	});

	test('a terminal closed keeps nothing for later; opened again, it takes the screen anew', async () => {
		const { pty, drawn, taken, binding } = load();
		pty.open({ columns: 80, rows: 24 });
		pty.bind(binding);
		taken[0]('screen', 1);
		await settled();
		pty.close();
		const before = drawn.length;
		pty.output(2, COLOURS);
		assert.strictEqual(drawn.length, before, 'nothing written to a terminal that is gone');
		pty.open({ columns: 80, rows: 24 });
		assert.strictEqual(taken.length, 2);
		taken[1]('screen at 2', 2);
		await settled();
		assert.ok(!drawn.join('').includes(COLOURS));
		assert.ok(drawn.join('').endsWith('screen at 2'));
	});

	test('it asks the editor\'s terminal for its colours as it opens; what the editor answers for the program reaches the run but keys, and its colours go to the window', async () => {
		const learned: string[] = [];
		const vscode = { EventEmitter: TestEmitter };
		const module = withModules({ vscode })<typeof AgentPtyModule>(path.join(__dirname, '..', 'host', 'execution', 'agentPty.js'));
		const pty = new module.AgentPty('Ada', () => undefined, () => false, (osc, rgb) => learned.push(`${osc} ${rgb}`));
		made.push(pty);
		const drawn: string[] = [];
		pty.onDidWrite(data => drawn.push(data));
		const { taken, typed, binding } = load();
		pty.open({ columns: 80, rows: 24 });
		assert.strictEqual(drawn.join(''), '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\', 'the window\'s own questions');
		pty.bind(binding);
		taken[0]('', 0);
		await settled();
		pty.output(1, COLOURS);
		pty.handleInput(ANSWERED);
		pty.handleInput('\x1b[?1;2c');
		pty.handleInput('hello\r');
		assert.deepStrictEqual([typed, learned], [['hello\r'], ['10 cccc/cccc/cccc', '11 1919/1a1a/1b1b']]);
	});

	/** A pty whose run's supervisor is of an earlier protocol, or not, with the window's colours. */
	const earlier = (answersQueries = false) => {
		const vscode = { EventEmitter: TestEmitter };
		const module = withModules({ vscode })<typeof AgentPtyModule>(path.join(__dirname, '..', 'host', 'execution', 'agentPty.js'));
		const pty = new module.AgentPty('Ada', () => undefined, () => false, () => undefined, () => ({ foreground: 'cccc/cccc/cccc', background: '1f1f/1f1f/1f1f' }));
		made.push(pty);
		const { drawn, taken, typed, binding } = load(answersQueries);
		pty.onDidWrite(data => { if (!data.startsWith('\x1b]10;?')) { drawn.push(data); } });
		return { pty, drawn, taken, typed, binding };
	};
	const parsed = () => new Promise(resolve => setTimeout(resolve, 30));

	test('a hidden tab of a run of an earlier supervisor has its queries answered once by a stand-in from the run\'s screen as it was hidden: the cursor where that screen leaves it, the device attributes, the window\'s colours - what only an editor knows aside (ARCHITECTURE-2.3, J17)', async () => {
		const { pty, taken, typed, binding } = earlier();
		pty.open({ columns: 80, rows: 24 });
		pty.bind(binding);
		taken[0]('', 0);
		await settled();
		pty.output(1, 'line one');
		// Hidden: the stand-in takes the run's screen; what comes meanwhile is in that screen, its question asked again on it
		pty.close();
		assert.strictEqual(taken.length, 2);
		pty.output(2, '\r\nab\x1b[6n');
		taken[1]('line one\r\nab', 2);
		pty.output(3, '\x1b[c\x1b]11;?\x1b\\\x1b[>q\x1b[?u\x1b[14t');
		await parsed();
		assert.deepStrictEqual(typed, ['\x1b[2;3R', '\x1b[?1;2c', '\x1b]11;rgb:1f1f/1f1f/1f1f\x1b\\']);
		// Open again: what the screen it draws holds is answered by the stand-in, what follows it by the tab, then the stand-in goes
		typed.length = 0;
		pty.open({ columns: 80, rows: 24 });
		assert.strictEqual(taken.length, 3);
		pty.output(4, '\x1b[5n');
		pty.output(5, 'after\x1b[5n');
		taken[2]('the screen at 4', 4);
		await parsed();
		assert.deepStrictEqual(typed, ['\x1b[0n'], 'the question in the screen the tab drew, once, by the stand-in');
		pty.output(6, '\x1b[6n');
		await parsed();
		assert.deepStrictEqual(typed, ['\x1b[0n'], 'what the tab draws, the tab answers');
	});

	test('a run of an earlier supervisor bound with its tab hidden - a reattach - has a stand-in from the screen it was claimed with, in the run\'s size; one of a supervisor answering itself has none (ARCHITECTURE-2.3)', async () => {
		const hidden = earlier();
		hidden.pty.expectScreen();
		hidden.pty.output(4, 'cd\x1b[6n');
		hidden.pty.bind(hidden.binding, { screen: 'ab', seq: 3, cols: 100, rows: 30 });
		hidden.pty.output(5, '\x1b[99;200H\x1b[6n');
		await parsed();
		assert.deepStrictEqual([hidden.typed, hidden.taken.length], [['\x1b[1;5R', '\x1b[30;100R'], 0]);
		// Its process ended: nothing is answered any more
		hidden.pty.exited('[Agent process exited with code 0]');
		hidden.pty.output(6, '\x1b[6n');
		await parsed();
		assert.strictEqual(hidden.typed.length, 2);
		const current = earlier(true);
		current.pty.open({ columns: 80, rows: 24 });
		current.pty.bind(current.binding);
		current.taken[0]('', 0);
		await settled();
		current.pty.close();
		current.pty.output(1, '\x1b[6n');
		await parsed();
		assert.deepStrictEqual([current.typed, current.taken.length], [[], 1], 'ptyd answers it: no stand-in, no screen taken for one');
	});

	test('a run of an earlier protocol\'s ptyd, which answers no query itself, gets the editor\'s answers as they come; its colours still go to the window (ARCHITECTURE-2.3)', async () => {
		const learned: string[] = [];
		const vscode = { EventEmitter: TestEmitter };
		const module = withModules({ vscode })<typeof AgentPtyModule>(path.join(__dirname, '..', 'host', 'execution', 'agentPty.js'));
		const pty = new module.AgentPty('Ada', () => undefined, () => false, (osc, rgb) => learned.push(`${osc} ${rgb}`));
		made.push(pty);
		const { taken, typed, binding } = load(false);
		pty.open({ columns: 80, rows: 24 });
		pty.bind(binding);
		taken[0]('', 0);
		await settled();
		pty.output(1, COLOURS);
		pty.handleInput(ANSWERED);
		pty.handleInput('\x1b[?1;2c');
		pty.handleInput('hello\r');
		assert.deepStrictEqual([typed, learned], [[ANSWERED, '\x1b[?1;2c', 'hello\r'], ['10 cccc/cccc/cccc', '11 1919/1a1a/1b1b']]);
	});
});
