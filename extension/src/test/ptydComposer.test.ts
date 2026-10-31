/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { INPUT_ADAPTERS, InputCell, InputScreen, InputState, readInput } from '../ptyd/composer';

/** The rendered screens of real signed-in CLIs, probed in a 120x40 headless terminal on 2026-10-29 (VERIFICATION G3). */
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'composer');

/** Each fixture folder - the CLI and the version it was probed with - and the input reader that recognizes its layout. */
const FOLDERS: { readonly [folder: string]: { readonly adapter: string } } = {
	'claude-2.1.312': { adapter: 'claude-frame' },
	'codex-0.165.0': { adapter: 'codex-prompt' }
};

/** A screen as a fixture keeps it: each row's cells - a string of one character each, trailing spaces cut - and its dim and inverse runs. */
interface Fixture {
	readonly name: string;
	readonly expect: InputState;
	readonly cols: number;
	readonly cursor: { readonly x: number; readonly y: number };
	readonly rows: readonly { readonly cells: string | readonly string[]; readonly dim?: readonly [number, number][]; readonly inverse?: readonly [number, number][] }[];
}

interface Probed {
	readonly folder: string;
	readonly adapter: string;
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

const PROBED: readonly Probed[] = Object.entries(FOLDERS).flatMap(([folder, { adapter }]) => fs.readdirSync(path.join(FIXTURES, folder)).sort().map(file => {
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, folder, file), 'utf8')) as Fixture;
	return { folder, adapter, fixture, screen: screenOf(fixture) };
}));

const blank = (screen: InputScreen, rows: (y: number) => boolean): InputScreen => ({
	...screen,
	rows: screen.rows.map((row, y) => rows(y) ? row.map(cell => ({ ...cell, chars: ' ', dim: false, inverse: false })) : row)
});

const label = ({ folder, fixture }: Probed) => `${folder}/${fixture.name}`;

suite('Composer: ordinary-message input read from the screen (CLIS-2.1, 2.3, RULES-1.4; VERIFICATION G3)', () => {

	test('every fixture folder is read by one of ptyd\'s input readers, and every reader has its CLI\'s probed screens', () => {
		assert.deepStrictEqual(fs.readdirSync(FIXTURES).sort(), Object.keys(FOLDERS).sort());
		assert.deepStrictEqual([...INPUT_ADAPTERS].sort(), Object.values(FOLDERS).map(each => each.adapter).sort());
	});

	test('each probed screen reads as what it showed: usable empty input, a draft, or a native question in its place', () => {
		assert.ok(PROBED.length >= 50, `${PROBED.length} fixtures`);
		const read = PROBED.map(each => `${label(each)}: ${readInput(each.screen, each.adapter).state}`);
		assert.deepStrictEqual(read, PROBED.map(each => `${label(each)}: ${each.fixture.expect}`));
		// Each kind of screen is among them, for each CLI
		for (const folder of Object.keys(FOLDERS)) {
			const kinds = new Set(PROBED.filter(each => each.folder === folder).map(each => each.fixture.expect));
			assert.deepStrictEqual([...kinds].sort(), ['draft', 'interaction', 'usable'], folder);
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

	test('a screen cut off below the cursor, its cursor elsewhere or its prompt garbled reads unknown', () => {
		const inputs = PROBED.filter(each => each.fixture.expect !== 'interaction');
		for (const each of inputs) {
			const { cursor } = each.screen;
			const cutBelow = blank(each.screen, y => y > cursor.y);
			const moved = { ...each.screen, cursor: { x: 0, y: 0 } };
			const garbled = { ...each.screen, rows: each.screen.rows.map(row => row.map(cell => /[❯›]/.test(cell.chars) ? { ...cell, chars: '>' } : cell)) };
			for (const [what, screen] of [['cut below', cutBelow], ['cursor moved', moved], ['prompt garbled', garbled]] as const) {
				assert.strictEqual(readInput(screen, each.adapter).state, 'unknown', `${label(each)}, ${what}: ${readInput(screen, each.adapter).evidence}`);
			}
		}
		// A frame cut off above the cursor has no upper rule; Codex's input is found from its footer, so the top does not matter to it
		for (const each of inputs.filter(input => input.adapter !== 'codex-prompt')) {
			const prompt = each.screen.rows.findIndex((row, y) => y <= each.screen.cursor.y && row[0].chars === '❯' && each.screen.rows.slice(y + 1, each.screen.cursor.y + 1).every(below => below[0].chars === ' '));
			assert.strictEqual(readInput(blank(each.screen, y => y < prompt), each.adapter).state, 'unknown', `${label(each)}, cut above`);
		}
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
		assert.strictEqual(readInput(usable.screen, 'muse-frame').state, 'unknown');
		assert.strictEqual(readInput(usable.screen, 'toString').state, 'unknown');
	});
});
