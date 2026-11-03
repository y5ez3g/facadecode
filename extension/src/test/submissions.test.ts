/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { titleText } from '../base/text';
import type { InputReading } from '../ptyd/composer';
import { submittedDraft, taken, TypedEnters } from '../host/execution/submissions';
import type * as AgentPtyModule from '../host/execution/agentPty';
import { TestEmitter, withModules } from './withModules';

suite('What the person submits in an agent\'s terminal, for its card\'s second line (PANEL-1.4)', () => {

	test('an Enter typed alone or as the kitty protocol reports it submits; one inside a paste, across chunks too, or Alt+Enter does not', () => {
		const enters = new TypedEnters();
		assert.deepStrictEqual(enters.next('\r'), { index: 0, length: 1 });
		assert.deepStrictEqual(enters.next('ab\x1b[13u'), { index: 2, length: 5 });
		assert.strictEqual(enters.next('\x1b\r'), undefined, 'Alt+Enter is a line break');
		assert.strictEqual(enters.next('hello'), undefined);
		assert.strictEqual(enters.next('\x1b[200~one\rtwo'), undefined, 'a paste\'s line break');
		assert.strictEqual(enters.next('three\r'), undefined, 'the paste goes on in the next chunk');
		assert.deepStrictEqual(enters.next('four\x1b[201~\r'), { index: 10, length: 1 }, 'the Enter after the paste ends');
	});

	test('a draft with text is what an Enter over it submits; an empty input, a menu or an unknown screen submits nothing', () => {
		const reading = (state: InputReading['state'], draft?: string): InputReading => ({ state, evidence: 'test', ...draft !== undefined ? { draft } : {} });
		assert.deepStrictEqual([
			submittedDraft(reading('draft', 'fix the login bug')), submittedDraft(reading('draft', '  ')), submittedDraft(reading('usable')),
			submittedDraft(reading('interaction')), submittedDraft(reading('unknown')), submittedDraft(undefined), submittedDraft(reading('draft', 'first line \\'))
		], ['fix the login bug', undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('CLIS-2.1: the CLI took it once its input is empty or shows a menu or question; not while it keeps the text, more after it or another draft', async () => {
		const reading = (state: InputReading['state'], draft?: string): InputReading => ({ state, evidence: 'test', ...draft !== undefined ? { draft } : {} });
		const waits: number[] = [];
		const wait = async (ms: number) => { waits.push(ms); };
		const read = (...readings: (InputReading | undefined)[]) => async () => readings.shift();
		assert.strictEqual(await taken(read(reading('draft', '/clear'), reading('usable')), wait, [1, 2, 3]), true);
		assert.strictEqual(await taken(read(reading('interaction')), wait, [1]), true, 'a menu the Enter opened');
		assert.strictEqual(await taken(read(reading('unknown'), reading('draft', 'next one')), wait, [1, 2]), false, 'another draft records nothing');
		assert.strictEqual(await taken(read(reading('draft', 'one two'), reading('draft', 'one two three')), wait, [1, 2]), false, 'a line break and more typed');
		assert.strictEqual(await taken(read(undefined), wait, [1, 2]), false, 'its input could not be read any more');
		assert.deepStrictEqual(waits, [1, 2, 1, 1, 2, 1, 2, 1]);
	});

	test('a CLI title\'s words leave out the spinner frame or state symbol before them, for every CLI alike', () => {
		assert.deepStrictEqual(
			['✳ Checking responsive layout', '⠐ Checking responsive layout', '● 检查标题更新 | workspace', '✓ Done', '✳ ★ Release v2 — notes!', 'claude - shop-app', '⠋', '', undefined].map(titleText),
			['Checking responsive layout', 'Checking responsive layout', '检查标题更新 | workspace', 'Done', 'Release v2 — notes!', 'claude - shop-app', undefined, undefined, undefined]
		);
	});
});

suite('An agent\'s tab spins while it works (LIFECYCLE-2.2)', () => {
	// Every terminal made is disposed, a test that failed too: its spinner's timer would keep the process alive
	const made: { dispose(): void }[] = [];
	teardown(() => { made.splice(0).forEach(each => each.dispose()); });
	const load = (still = false) => {
		const vscode = { EventEmitter: TestEmitter };
		const module = withModules({ vscode })<typeof AgentPtyModule>(path.join(__dirname, '..', 'host', 'execution', 'agentPty.js'));
		const pty = new module.AgentPty('Ada', () => undefined, () => still);
		made.push(pty);
		const names: string[] = [];
		pty.onDidChangeName(name => names.push(name));
		pty.open({ columns: 80, rows: 24 });
		return { pty, names };
	};

	test('a frame turns before its name while it works, and the name shows alone once it stops; the frames are no rename of the person\'s', async () => {
		const { pty, names } = load();
		pty.spin(true);
		// Until it turned twice, however late a busy machine runs its timers
		for (const end = Date.now() + 5_000; names.length < 4 && Date.now() < end;) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		pty.spin(false);
		const frames = names.slice(1, -1);
		assert.ok(frames.length >= 2, JSON.stringify(names));
		assert.ok(frames.every(name => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Ada$/u.test(name)), JSON.stringify(frames));
		assert.ok(new Set(frames).size > 1, 'it turns');
		assert.strictEqual(names[names.length - 1], 'Ada');
		assert.deepStrictEqual(frames.map(name => pty.shown(name)), frames.map(() => undefined));
		pty.spin(true);
		pty.rename('Ada Lovelace');
		assert.strictEqual(pty.shown('⠼ Ada'), undefined, 'a frame of its earlier name, shown late after a rename, is its own');
		pty.spin(false);
		assert.deepStrictEqual(pty.shown('⠙ Grace'), { renamed: 'Grace' }, 'a person\'s name with a frame before it is the name');
		assert.deepStrictEqual(pty.shown('Grace Hopper'), { renamed: 'Grace Hopper' });
		pty.dispose();
	});

	test('reduced motion shows one still frame while it works', async () => {
		const { pty, names } = load(true);
		pty.spin(true);
		await new Promise(resolve => setTimeout(resolve, 150));
		pty.spin(false);
		assert.deepStrictEqual(names, ['Ada', '⠋ Ada', 'Ada']);
		pty.dispose();
	});
});
