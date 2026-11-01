/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AliasCounter } from '../record/aliases';
import { MESSAGE_RETENTION_MS, MessageCounter, MessageFile } from '../record/messages';
import { pruneResults, resultsFolder, writeResult } from '../record/results';
import { tempDir } from './util';

interface Row {
	readonly id: string;
	readonly at: number;
	readonly text: string;
}

const DAY = 24 * 60 * 60 * 1000;

suite('Message records in the Facade directory (RULES-1.1, 5.3, COLLABORATION-3.3, 4.2)', () => {
	let home: string;
	let remove: () => void;
	let now: number;

	setup(() => {
		({ dir: home, remove } = tempDir('facade-code-messages-'));
		now = Date.now();
	});

	teardown(() => remove());

	test('each record is one file, replaced whole; a new store - a reloaded window - reads them back oldest first', () => {
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-10', at: now, text: 'ten' });
		store.put({ id: 'm-2', at: now - 1, text: 'two' });
		store.put({ id: 'm-10', at: now, text: 'ten, delivered' });
		assert.deepStrictEqual(fs.readdirSync(path.join(home, 'messages')).sort(), ['m-10.json', 'm-2.json']);
		const again = new MessageFile<Row>(home, () => now);
		assert.deepStrictEqual(again.list().map(row => [row.id, row.text]), [['m-2', 'two'], ['m-10', 'ten, delivered']]);
		// Another window's write is seen without a reload
		store.put({ id: 'm-11', at: now, text: 'eleven' });
		assert.deepStrictEqual(again.list().map(row => row.id), ['m-2', 'm-10', 'm-11']);
	});

	test('a record that cannot be read, or a file of another name, is left out rather than failing the store', () => {
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-1', at: now, text: 'one' });
		fs.writeFileSync(path.join(home, 'messages', 'm-2.json'), '{"id":');
		fs.writeFileSync(path.join(home, 'messages', 'm-3.json'), JSON.stringify({ id: 'm-4', at: now }));
		fs.writeFileSync(path.join(home, 'messages', 'notes.txt'), 'x');
		assert.deepStrictEqual(store.list().map(row => row.id), ['m-1']);
		assert.throws(() => store.put({ id: '../escape', at: now, text: '' }), /not a message ID/);
	});

	test('records go thirty days after they were sent, without being asked; a long-lived store notices as time passes', () => {
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-1', at: now - 31 * DAY, text: 'old' });
		store.put({ id: 'm-2', at: now - 29 * DAY, text: 'recent' });
		// Past the cutoff it is no longer listed, even before its file goes
		assert.deepStrictEqual(store.list().map(row => row.id), ['m-2']);
		new MessageFile<Row>(home, () => now);
		assert.deepStrictEqual(fs.readdirSync(path.join(home, 'messages')), ['m-2.json']);
		now += 2 * DAY;
		assert.deepStrictEqual(store.list(), []);
		assert.deepStrictEqual(fs.readdirSync(path.join(home, 'messages')), []);
		assert.strictEqual(MESSAGE_RETENTION_MS, 30 * DAY);
	});

	test('message numbers are unique across stores and restarts, and never reused once their records expired', () => {
		const first = new MessageCounter(home);
		const second = new MessageCounter(home);
		assert.deepStrictEqual([first.next(), second.next(), first.next()], [1, 2, 3]);
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-3', at: now - 40 * DAY, text: 'expired' });
		store.prune();
		assert.strictEqual(new MessageCounter(home).next(), 4);
		// A counter lost behind records still kept moves past them
		store.put({ id: 'm-9', at: now, text: 'kept' });
		fs.rmSync(path.join(home, 'message-aliases.json'));
		assert.strictEqual(new MessageCounter(home).next(), 10);
	});

	test('the counter never moves back: records written after it was made count, and one it cannot read is an error, never a count from nothing', () => {
		const counter = new MessageCounter(home);
		assert.strictEqual(counter.next(), 1);
		// Another window's record, written since: the next number is past it
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-40', at: now, text: 'elsewhere' });
		assert.strictEqual(counter.next(), 41);
		const file = path.join(home, 'message-aliases.json');
		for (const content of ['{"last":', '{"last":"7"}', '[]']) {
			fs.writeFileSync(file, content);
			assert.throws(() => counter.next(), /does not hold a number; Facade gives no message number it may have given before/, content);
		}
		assert.strictEqual(fs.readFileSync(file, 'utf8'), '[]', 'nothing written over what could not be read');
		fs.rmSync(file);
		fs.mkdirSync(file);
		assert.throws(() => counter.next(), /cannot be read/);
	});

	test('agent aliases: one counter for the environment; a counter that cannot be read stops them, never counting from #a1 again (RULES-2.2)', () => {
		const first = new AliasCounter(home);
		assert.deepStrictEqual([first.next(), new AliasCounter(home).next(), first.next()], ['#a1', '#a2', '#a3']);
		const file = path.join(home, 'agent-aliases.json');
		for (const content of ['{"last":', '{"last":"7"}', '{"last":-2}', '[]', 'null']) {
			fs.writeFileSync(file, content);
			assert.throws(() => first.next(), /does not hold a number; Facade gives no agent number it may have given before/, content);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), content, 'nothing written over what could not be read');
		}
		fs.rmSync(file);
		fs.mkdirSync(file);
		assert.throws(() => first.next(), /cannot be read/);
		fs.rmSync(file, { recursive: true });
		fs.writeFileSync(file, '{"last":41}');
		assert.strictEqual(first.next(), '#a42');
	});

	test('a new record is never written over one of its ID', () => {
		const store = new MessageFile<Row>(home, () => now);
		store.create({ id: 'm-5', at: now, text: 'first' });
		assert.throws(() => store.create({ id: 'm-5', at: now, text: 'second' }), /A message m-5 is kept already/);
		assert.deepStrictEqual(new MessageFile<Row>(home, () => now).list().map(row => row.text), ['first']);
		store.put({ id: 'm-5', at: now, text: 'first, delivered' });
		assert.deepStrictEqual(store.list().map(row => row.text), ['first, delivered']);
	});

	test('a long result is a complete UTF-8 file under results/, with its path and size in bytes', () => {
		const text = `${'é'.repeat(5000)}\n终\n${'x'.repeat(4000)}`;
		const written = writeResult(home, 'screen', text);
		assert.strictEqual(path.dirname(written.path), resultsFolder(home));
		assert.match(path.basename(written.path), /^screen-\d{8}T\d{6}Z-[0-9a-f]{12}\.txt$/);
		assert.deepStrictEqual([fs.readFileSync(written.path, 'utf8'), written.size], [text, Buffer.byteLength(text, 'utf8')]);
	});

	test('a messages file goes as soon as any message in it expires; a screen file after thirty days', () => {
		const store = new MessageFile<Row>(home, () => now);
		store.put({ id: 'm-1', at: now - 29 * DAY, text: 'older' });
		store.put({ id: 'm-2', at: now - DAY, text: 'newer' });
		const both = writeResult(home, 'messages', 'older\nnewer', ['m-1', '#m2']);
		const newer = writeResult(home, 'messages', 'newer', ['m-2']);
		const screen = writeResult(home, 'screen', 'screen');
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${both.path}.ids.json`, 'utf8')), ['m-1', 'm-2']);
		store.prune();
		assert.deepStrictEqual([both, newer, screen].map(each => fs.existsSync(each.path)), [true, true, true]);
		now += 2 * DAY;
		store.prune();
		assert.deepStrictEqual([both, newer, screen].map(each => fs.existsSync(each.path)), [false, true, true]);
		assert.ok(!fs.existsSync(`${both.path}.ids.json`));
		const old = (now - 31 * DAY) / 1000;
		fs.utimesSync(screen.path, old, old);
		pruneResults(home, now);
		assert.deepStrictEqual([newer, screen].map(each => fs.existsSync(each.path)), [true, false]);
		// Other files there are not Facade's to remove
		fs.writeFileSync(path.join(resultsFolder(home), 'notes.txt'), 'x');
		fs.utimesSync(path.join(resultsFolder(home), 'notes.txt'), old, old);
		pruneResults(home, now, () => false);
		assert.deepStrictEqual(fs.readdirSync(resultsFolder(home)).sort(), ['notes.txt']);
	});
});
