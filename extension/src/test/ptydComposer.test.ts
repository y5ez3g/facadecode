/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isOwnDraft } from '../ptyd/drafts';
import { INPUT_ADAPTERS, InputCell, InputScreen, InputState, readInput } from '../ptyd/composer';

/**
 * The rendered screens of real signed-in CLIs, probed in a 120x40 headless terminal (VERIFICATION G3): Claude Code, Codex and Muse
 * Code on 2026-10-29, Antigravity, OpenCode and Pi on 2026-10-30; and on 2026-10-31 each built-in's pastes by
 * `scripts/capture-inputs.mjs`, which keeps a paste's text with its screen - Claude Code 2.1.316 and Codex 0.166.0 then new, Codex
 * with the warning under its input that its configuration overrides bring - and again in a 120x24 terminal, as an editor's panel
 * may be, with a taller paste and a wider one: where Antigravity and Pi scroll a draft in its input box, and Pi draws a wide paste
 * as `[paste #1 1284 chars]` (D118).
 */
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'composer');

/**
 * Each fixture folder - the CLI and the version it was probed with - and the input reader that recognizes its layout; and how to
 * spoil what that reader recognizes the input by, its prompt or its frame, so that no reader vouches for what is left.
 */
const FOLDERS: { readonly [folder: string]: { readonly adapter: string; readonly garble: (chars: string) => string } } = {
	'claude-2.1.312': { adapter: 'claude-frame', garble: chars => chars.replace('❯', '>') },
	'codex-0.165.0': { adapter: 'codex-prompt', garble: chars => chars.replace('›', '>') },
	'muse-1.4.14': { adapter: 'muse-frame', garble: chars => chars.replace('❯', '>') },
	'agy-1.4.12': { adapter: 'agy-frame', garble: chars => chars.replace('>', '❯') },
	'pi-1.4.0': { adapter: 'pi-frame', garble: chars => chars.replace(/─/g, '-') },
	'opencode-2.1.4': { adapter: 'opencode-frame', garble: chars => chars.replace('┃', '|') },
	'claude-2.1.316': { adapter: 'claude-frame', garble: chars => chars.replace('❯', '>') },
	'codex-0.166.0': { adapter: 'codex-prompt', garble: chars => chars.replace('›', '>') },
	'agy-1.4.12-pastes': { adapter: 'agy-frame', garble: chars => chars.replace('>', '❯') },
	'muse-1.4.14-pastes': { adapter: 'muse-frame', garble: chars => chars.replace('❯', '>') },
	'pi-1.4.0-pastes': { adapter: 'pi-frame', garble: chars => chars.replace(/─/g, '-') },
	'opencode-2.1.4-pastes': { adapter: 'opencode-frame', garble: chars => chars.replace('┃', '|') },
	'claude-2.1.316-24rows': { adapter: 'claude-frame', garble: chars => chars.replace('❯', '>') },
	'codex-0.166.0-24rows': { adapter: 'codex-prompt', garble: chars => chars.replace('›', '>') },
	'agy-1.4.12-24rows': { adapter: 'agy-frame', garble: chars => chars.replace('>', '❯') },
	'muse-1.4.14-24rows': { adapter: 'muse-frame', garble: chars => chars.replace('❯', '>') },
	'pi-1.4.0-24rows': { adapter: 'pi-frame', garble: chars => chars.replace(/─/g, '-') },
	'opencode-2.1.4-24rows': { adapter: 'opencode-frame', garble: chars => chars.replace('┃', '|') }
};

/** A screen as a fixture keeps it: each row's cells - a string of one character each, trailing spaces cut - and its dim and inverse runs. */
interface Fixture {
	readonly name: string;
	readonly expect: InputState;
	readonly cols: number;
	readonly cursor: { readonly x: number; readonly y: number };
	readonly rows: readonly { readonly cells: string | readonly string[]; readonly dim?: readonly [number, number][]; readonly inverse?: readonly [number, number][] }[];
	/** What was pasted, where the capture kept it, and the lead typed before it. */
	readonly paste?: string;
	readonly lead?: string;
}

interface Probed {
	readonly folder: string;
	readonly adapter: string;
	readonly garble: (chars: string) => string;
	readonly fixture: Fixture;
	readonly screen: InputScreen;
}

/** The screen a fixture keeps, each row padded to the terminal's width. */
function screenOf(fixture: Fixture): InputScreen {
	const within = (runs: readonly (readonly [number, number])[] | undefined, x: number) => (runs ?? []).some(([start, end]) => x >= start && x < end);
	return {
		rows: fixture.rows.map(row => {
			const chars = typeof row.cells === 'string' ? [...row.cells] : row.cells;
			return Array.from({ length: Math.max(fixture.cols, chars.length) }, (_, x): InputCell => ({ chars: chars[x] ?? ' ', dim: within(row.dim, x), inverse: within(row.inverse, x) }));
		}),
		cursor: fixture.cursor
	};
}

const PROBED: readonly Probed[] = Object.entries(FOLDERS).flatMap(([folder, { adapter, garble }]) => fs.readdirSync(path.join(FIXTURES, folder)).sort().map(file => {
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, folder, file), 'utf8')) as Fixture;
	return { folder, adapter, garble, fixture, screen: screenOf(fixture) };
}));

const blank = (screen: InputScreen, rows: (y: number) => boolean): InputScreen => ({
	...screen,
	rows: screen.rows.map((row, y) => rows(y) ? row.map(cell => ({ ...cell, chars: ' ', dim: false, inverse: false })) : row)
});

const label = ({ folder, fixture }: Probed) => `${folder}/${fixture.name}`;

/** A row of OpenCode's bar with nothing after it, at its column on the cursor's row. */
const isBarAlone = (screen: InputScreen, y: number) => {
	const bar = screen.rows[screen.cursor.y].findIndex(cell => cell.chars !== ' ');
	return screen.rows[y][bar]?.chars === '┃' && screen.rows[y].slice(bar + 1).every(cell => cell.chars === ' ');
};

/**
 * The first row of the input on a probed screen, for a reader that needs what is above it: the prompt row under Claude Code's, Muse
 * Code's and Antigravity's upper rule, the first row under Pi's, the first under the blank row at the top of OpenCode's box. Codex's
 * input is found from its footer, so the top does not matter to it.
 */
function firstInputRow({ adapter, screen }: Probed): number | undefined {
	const { rows, cursor } = screen;
	const prompt = (glyph: string) => rows.findIndex((row, y) => y <= cursor.y && row[0].chars === glyph && rows.slice(y + 1, cursor.y + 1).every(below => below[0].chars === ' '));
	let y = cursor.y;
	switch (adapter) {
		case 'claude-frame': case 'muse-frame': return prompt('❯');
		case 'agy-frame': return prompt('>');
		case 'pi-frame':
			while (y > 0 && rows[y - 1][0].chars !== '─') {
				y--;
			}
			return y;
		case 'opencode-frame':
			while (y > 0 && !isBarAlone(screen, y - 1)) {
				y--;
			}
			return y;
		default: return undefined;
	}
}

suite('Composer: ordinary-message input read from the screen (CLIS-2.1, 2.3, RULES-1.4; VERIFICATION G3)', () => {

	test('every fixture folder is read by one of ptyd\'s input readers, and every reader has its CLI\'s probed screens', () => {
		assert.deepStrictEqual(fs.readdirSync(FIXTURES).sort(), Object.keys(FOLDERS).sort());
		assert.deepStrictEqual([...INPUT_ADAPTERS].sort(), [...new Set(Object.values(FOLDERS).map(each => each.adapter))].sort());
	});

	test('each probed screen reads as what it showed: usable empty input, a draft, or a native question in its place', () => {
		assert.ok(PROBED.length >= 150, `${PROBED.length} fixtures`);
		const read = PROBED.map(each => `${label(each)}: ${readInput(each.screen, each.adapter).state}`);
		assert.deepStrictEqual(read, PROBED.map(each => `${label(each)}: ${each.fixture.expect}`));
		// Each kind of screen is among them, for each CLI
		for (const adapter of INPUT_ADAPTERS) {
			const kinds = new Set(PROBED.filter(each => each.adapter === adapter).map(each => each.fixture.expect));
			assert.deepStrictEqual([...kinds].sort(), ['draft', 'interaction', 'usable'], adapter);
		}
	});

	test('each CLI\'s pasted draft reads as the message\'s own - its text, or its placeholder for a paste of its size - and a typed one does not (RULES-1.6, D104)', () => {
		// What the probes pasted: three lines, a Facade message, and 33 lines of 3,886 characters, here as long as those were
		const pasted: { readonly [name: string]: string } = {
			'pasted': 'first pasted line\nsecond pasted line\nthird pasted line',
			'message-pasted': '[Facade message #m1 | from @probe #a0 | window Probe]\nReply with exactly the word ACK-TWO and nothing else.\n[/Facade message #m1]',
			'long-pasted': [...Array.from({ length: 32 }, () => 'x'.repeat(117)), 'x'.repeat(3_886 - 32 * 118)].join('\n')
		};
		assert.strictEqual([...pasted['long-pasted']].length, 3_886);
		let checked = 0;
		for (const each of PROBED.filter(probed => probed.fixture.paste === undefined && Object.hasOwn(pasted, probed.fixture.name))) {
			const reading = readInput(each.screen, each.adapter);
			assert.strictEqual(reading.state, 'draft', label(each));
			assert.ok(reading.draft !== undefined && isOwnDraft(reading.draft, pasted[each.fixture.name], each.adapter), `${label(each)}: ${JSON.stringify(reading.draft)}`);
			// One line less or one more is someone else's
			assert.ok(!isOwnDraft(reading.draft, `${pasted[each.fixture.name]}\nmore`, each.adapter), label(each));
			checked++;
		}
		assert.strictEqual(checked, 3 * Object.keys(FOLDERS).filter(folder => !folder.endsWith('-pastes') && !folder.endsWith('-24rows') && !['claude-2.1.316', 'codex-0.166.0'].includes(folder)).length);
		// Each captured paste, its text kept with its screen: its own draft, after its lead where one was typed
		const captured = PROBED.filter(probed => probed.fixture.paste !== undefined);
		assert.ok(captured.length >= 60, `${captured.length} captured pastes`);
		for (const each of captured) {
			const reading = readInput(each.screen, each.adapter);
			assert.ok(reading.draft !== undefined && isOwnDraft(reading.draft, each.fixture.paste!, each.adapter, each.fixture.lead, reading.hidden), `${label(each)}: ${JSON.stringify(reading.draft)}`);
			assert.ok(!isOwnDraft(reading.draft, `${each.fixture.paste}\nmore`, each.adapter, each.fixture.lead, reading.hidden), label(each));
		}
		// A draft scrolled in its box: the rows out of sight said apart from it, its marks no part of it (D118)
		const scrolled = captured.filter(each => readInput(each.screen, each.adapter).hidden !== undefined).map(each => `${each.folder}/${each.fixture.name}`);
		assert.deepStrictEqual(scrolled.sort(), ['agy-1.4.12-24rows/wide-pasted', 'pi-1.4.0-24rows/medium-pasted']);
		for (const each of captured.filter(probed => readInput(probed.screen, probed.adapter).hidden !== undefined)) {
			const reading = readInput(each.screen, each.adapter);
			assert.ok(reading.hidden!.above > 0 && reading.hidden!.below === 0 && !/more/.test(reading.draft!.split('\n')[0]), `${label(each)}: ${JSON.stringify(reading)}`);
			// Its rows in sight are not the text whole: without what it says is out of sight, they are not its own
			assert.ok(!isOwnDraft(reading.draft!, each.fixture.paste!, each.adapter), label(each));
		}
		// A draft the person typed is not a message's own
		for (const each of PROBED.filter(probed => probed.fixture.name === 'typed')) {
			const reading = readInput(each.screen, each.adapter);
			assert.ok(reading.draft !== undefined && !isOwnDraft(reading.draft, pasted['message-pasted'], each.adapter), label(each));
		}
	});

	test('a reading says what it rests on, without the text on the screen', () => {
		for (const each of PROBED) {
			const { evidence } = readInput(each.screen, each.adapter);
			assert.ok(evidence.length > 0 && evidence.length <= 160, `${label(each)}: ${evidence}`);
			assert.ok(!/READY|probe|Facade message|Trust|Yes/.test(evidence), `${label(each)}: ${evidence}`);
		}
	});

	test('another CLI\'s screen is nothing a reader vouches for: unknown, never usable', () => {
		for (const each of PROBED) {
			for (const other of INPUT_ADAPTERS.filter(adapter => adapter !== each.adapter)) {
				assert.strictEqual(readInput(each.screen, other).state, 'unknown', `${label(each)} read by ${other}`);
			}
		}
	});

	test('a screen cut off below the cursor, its cursor elsewhere or its prompt or frame garbled reads unknown', () => {
		const inputs = PROBED.filter(each => each.fixture.expect !== 'interaction');
		for (const each of inputs) {
			const { cursor } = each.screen;
			const cutBelow = blank(each.screen, y => y > cursor.y);
			const moved = { ...each.screen, cursor: { x: 0, y: 0 } };
			const garbled = { ...each.screen, rows: each.screen.rows.map(row => row.map(cell => ({ ...cell, chars: each.garble(cell.chars) }))) };
			for (const [what, screen] of [['cut below', cutBelow], ['cursor moved', moved], ['garbled', garbled]] as const) {
				assert.strictEqual(readInput(screen, each.adapter).state, 'unknown', `${label(each)}, ${what}: ${readInput(screen, each.adapter).evidence}`);
			}
		}
		// An input cut off above its first row has no upper rule, or no blank row at the top of its box
		for (const each of inputs) {
			const first = firstInputRow(each);
			if (first !== undefined) {
				assert.ok(first > 0, `${label(each)}: its first input row`);
				assert.strictEqual(readInput(blank(each.screen, y => y < first), each.adapter).state, 'unknown', `${label(each)}, cut above`);
			}
		}
	});

	test('OpenCode\'s box: an empty line under a line of text is a draft; a box right under a message of its own, with the same bar, is unknown', () => {
		const answered = PROBED.find(each => each.folder === 'opencode-2.1.4' && each.fixture.name === 'answered')!;
		assert.strictEqual(readInput(answered.screen, 'opencode-frame').state, 'usable');
		const { cursor } = answered.screen;
		const bar = answered.screen.rows[cursor.y].findIndex(cell => cell.chars === '┃');
		const drawn = (rows: { readonly [y: number]: string }): InputScreen => ({
			...answered.screen,
			rows: answered.screen.rows.map((row, y) => rows[y] === undefined ? row : Array.from(row, (_, x) => ({ chars: [...rows[y]][x] ?? ' ', dim: false, inverse: false })))
		});
		const barAlone = `${' '.repeat(bar)}┃`;
		const text = `${' '.repeat(bar)}┃  first line`;
		// Its blank top row, a line of text, an empty line, and the cursor on the next empty line
		assert.strictEqual(readInput(drawn({ [cursor.y - 3]: barAlone, [cursor.y - 2]: text, [cursor.y - 1]: barAlone }), 'opencode-frame').state, 'draft');
		// A message's last text and its blank row, then the box's blank top row right under it
		assert.strictEqual(readInput(drawn({ [cursor.y - 3]: text, [cursor.y - 2]: barAlone, [cursor.y - 1]: barAlone }), 'opencode-frame').state, 'unknown');
		// Its placeholder is empty input only with the cursor where the input starts
		const home = PROBED.find(each => each.folder === 'opencode-2.1.4' && each.fixture.name === 'empty')!;
		assert.deepStrictEqual(readInput(home.screen, 'opencode-frame'), { state: 'usable', evidence: `the input box at row ${home.screen.cursor.y + 1} is empty but for its placeholder` });
	});

	test('Pi\'s editor is no taller than it can be: a picker between two rules over its footer is a native menu, never input', () => {
		const picker = PROBED.find(each => each.folder === 'pi-1.4.0' && each.fixture.name === 'model-picker')!;
		assert.strictEqual(readInput(picker.screen, 'pi-frame').state, 'interaction');
		// Without its hint, a list of its own under the editor - its slash menu - is no question
		const slash = PROBED.find(each => each.folder === 'pi-1.4.0' && each.fixture.name === 'slash')!;
		assert.strictEqual(readInput({ ...slash.screen, cursor: { x: 0, y: 0 } }, 'pi-frame').state, 'unknown');
	});

	test('an empty input is usable only with the cursor where it starts; dim text under the prompt row is no placeholder', () => {
		const empty = PROBED.filter(each => each.fixture.expect === 'usable');
		for (const each of empty) {
			const { cursor } = each.screen;
			const away = { ...each.screen, cursor: { x: cursor.x + 5, y: cursor.y } };
			assert.strictEqual(readInput(away, each.adapter).state, 'unknown', `${label(each)}, cursor away`);
		}
		const claude = PROBED.find(each => each.folder === 'claude-2.1.312' && each.fixture.name === 'busy-pasted')!;
		const dimmed = { ...claude.screen, rows: claude.screen.rows.map((row, y) => y >= 34 ? row.map(cell => ({ ...cell, dim: true })) : row) };
		assert.strictEqual(readInput(dimmed, 'claude-frame').state, 'unknown');
		// A draft's letter under a cursor the CLI draws itself is still the draft's
		const empties = PROBED.find(each => each.folder === 'claude-2.1.312' && each.fixture.name === 'empty')!;
		assert.strictEqual(readInput(empties.screen, 'claude-frame').state, 'usable');
		const lettered = { ...empties.screen, rows: empties.screen.rows.map((row, y) => y === empties.screen.cursor.y ? row.map((cell, x) => x === 2 ? { chars: 'a', dim: false, inverse: true } : cell) : row) };
		assert.strictEqual(readInput(lettered, 'claude-frame').state, 'draft');
	});

	test('a screen still being drawn, a cursor off the screen or a reader ptyd does not know reads unknown', () => {
		const usable = PROBED.find(each => each.fixture.expect === 'usable')!;
		assert.strictEqual(readInput(usable.screen, usable.adapter).state, 'usable');
		assert.deepStrictEqual(readInput({ ...usable.screen, drawing: true }, usable.adapter).state, 'unknown');
		assert.deepStrictEqual(readInput({ ...usable.screen, cursor: { x: 2, y: usable.screen.rows.length } }, usable.adapter).state, 'unknown');
		assert.deepStrictEqual(readInput(usable.screen, 'claude-frame-2'), { state: 'unknown', evidence: 'no input adapter "claude-frame-2"' });
		assert.strictEqual(readInput(usable.screen, 'gemini-frame').state, 'unknown');
		assert.strictEqual(readInput(usable.screen, 'toString').state, 'unknown');
	});
});
