/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { getEventListeners } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise, sleepSync, timeout } from '../base/async';
import { codeOf, messageOf, stackOf } from '../base/errors';
import { canonicalFolder, FileChangedError, formatJson, isEqualPath, JsonFile, jsonLayoutOf, parseJson, readJsonFile, replaceFile, updateJsonFile, writeJsonFile } from '../base/files';
import { isJsonObject, isStringArray } from '../base/json';
import { removeLockIfUnchanged, withFileLock } from '../base/lock';
import { isProcessRunning } from '../base/system';
import { cutNextWriteShort, outcomeOf, replaceFsFunction, tempDir } from './util';

const BOM = String.fromCharCode(0xfeff);

suite('Base: errors, JSON values, processes and promises', () => {

	test('what was thrown is read whatever it is: an Error, a Node error by its code, or a value thrown as it is', () => {
		const coded = Object.assign(new Error('gone'), { code: 'ENOENT' });

		assert.deepStrictEqual({
			messages: [messageOf(new Error('broke')), messageOf('just words'), messageOf(undefined)],
			stacks: [stackOf(new Error('broke')).startsWith('Error: broke'), stackOf(42)],
			codes: [codeOf(coded), codeOf(new Error('no code')), codeOf('ENOENT'), codeOf(Object.assign(new Error('odd'), { code: 7 }))]
		}, {
			messages: ['broke', 'just words', 'undefined'],
			stacks: [true, '42'],
			codes: ['ENOENT', undefined, undefined, undefined]
		});
	});

	test('a parsed JSON value is an object when it is neither null nor a list, and a list of strings when each item is one', () => {
		assert.deepStrictEqual({
			objects: [{}, { a: 1 }, null, [], 'x', 1].map(isJsonObject),
			strings: [[], ['a', 'b'], ['a', 1], 'a', undefined].map(isStringArray)
		}, {
			objects: [true, true, false, false, false, false],
			strings: [true, true, false, false, false]
		});
	});

	test('a process runs while it can be signalled, or is another user\'s; a PID that is no process\'s does not', () => {
		assert.deepStrictEqual([isProcessRunning(process.pid), isProcessRunning(0), isProcessRunning(-1), isProcessRunning(1.5), isProcessRunning(2 ** 30)], [true, false, false, false, false]);
	});

	test('a deferred promise settles once, as the first of complete and error says', async () => {
		const completed = new DeferredPromise<string>();
		completed.complete('first');
		completed.error(new Error('late'));
		completed.complete('second');
		const failed = new DeferredPromise<string>();
		failed.error(new Error('broke'));
		failed.complete('late');

		assert.deepStrictEqual({ completed: await completed.p, failed: await failed.p.catch(messageOf) }, { completed: 'first', failed: 'broke' });
	});

	test('a wait ends as soon as it is cancelled, as cancelled, and one cancelled before it began does not begin; one that runs its course leaves no listener behind', async () => {
		const cancelled = new AbortController();
		const started = Date.now();
		const long = outcomeOf(timeout(10_000, cancelled.signal));
		cancelled.abort();
		const ran = new AbortController();
		await timeout(10, ran.signal);

		assert.deepStrictEqual({
			long: await long,
			atOnce: Date.now() - started < 1000,
			before: await outcomeOf(timeout(10, cancelled.signal)),
			listeners: getEventListeners(ran.signal, 'abort').length
		}, { long: 'CANCELLED: Cancelled', atOnce: true, before: 'CANCELLED: Cancelled', listeners: 0 });
	});

	test('a synchronous wait blocks for as long as it is asked', () => {
		const start = Date.now();
		sleepSync(50);

		assert.strictEqual(Date.now() - start >= 45, true);
	});
});

suite('Base: files', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-files-');
	});

	teardown(() => {
		temp.remove();
	});

	test('two paths name the same file however they are written, and whatever their case where case does not matter; a folder\'s real path is its own', () => {
		const caseless = process.platform === 'win32' || process.platform === 'darwin';
		const folder = path.join(temp.dir, 'Lab');
		fs.mkdirSync(folder);

		assert.deepStrictEqual({
			same: [isEqualPath('/lab/a/../b', '/lab/b'), isEqualPath('/Lab/B', '/lab/b'), isEqualPath('/lab/b', '/lab/c')],
			real: canonicalFolder(caseless ? folder.toLowerCase() : folder) === folder,
			missing: canonicalFolder(path.join(temp.dir, 'gone', '..', 'none')) === path.join(temp.dir, 'none')
		}, { same: [true, caseless, false], real: true, missing: true });
	});

	test('a file replaced in one step holds the new content, keeps its permissions, and leaves nothing beside it; a new one is made with its folder', () => {
		const file = path.join(temp.dir, 'settings.json');
		fs.writeFileSync(file, 'old', { mode: 0o644 });
		replaceFile(file, 'new');
		const made = path.join(temp.dir, 'deep', 'er', 'made.json');
		replaceFile(made, 'made');

		assert.deepStrictEqual({
			content: fs.readFileSync(file, 'utf8'),
			mode: process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o644,
			made: fs.readFileSync(made, 'utf8'),
			left: fs.readdirSync(temp.dir).sort()
		}, { content: 'new', mode: true, made: 'made', left: ['deep', 'settings.json'] });
	});

	test('a file whose new content the disk took only part of is left as it was, with nothing beside it', () => {
		const file = path.join(temp.dir, 'settings.json');
		fs.writeFileSync(file, 'old');
		const restore = cutNextWriteShort();
		let failed = 'replaced';
		try {
			replaceFile(file, 'new content');
		} catch (err) {
			failed = codeOf(err) ?? messageOf(err);
		} finally {
			restore();
		}

		assert.deepStrictEqual({ failed, content: fs.readFileSync(file, 'utf8'), left: fs.readdirSync(temp.dir) }, { failed: 'ENOSPC', content: 'old', left: ['settings.json'] });
	});

	test('a link is followed: what it points to is replaced, and it stays a link', function () {
		const real = path.join(temp.dir, 'real.json');
		const link = path.join(temp.dir, 'link.json');
		fs.writeFileSync(real, 'old');
		try {
			fs.symlinkSync(real, link, 'file');
		} catch (err) {
			// Windows lets only an administrator, or Developer Mode, make one.
			if (codeOf(err) === 'EPERM') {
				this.skip();
			}
			throw err;
		}
		replaceFile(link, 'new');

		assert.deepStrictEqual({ real: fs.readFileSync(real, 'utf8'), link: fs.lstatSync(link).isSymbolicLink(), left: fs.readdirSync(temp.dir).sort() }, { real: 'new', link: true, left: ['link.json', 'real.json'] });
	});

	test('on Windows, a file another program holds open for a moment is replaced once it lets go', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		this.timeout(10_000);
		const file = path.join(temp.dir, 'held.json');
		fs.writeFileSync(file, 'old');
		// Opened sharing nothing, as a scanner may hold it, for a quarter of a second: until then it cannot be replaced.
		const script = '$file = [System.IO.File]::Open($env:HELD, \'Open\', \'Read\', \'None\'); [Console]::Out.Write(\'held\'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250; $file.Close()';
		const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, HELD: file } });
		await new Promise(resolve => holder.stdout.once('data', resolve));
		const exited = new Promise(resolve => holder.once('exit', resolve));
		// A rename over it fails while it is held: replaceFile gets through only by trying again.
		const probe = path.join(temp.dir, 'probe');
		fs.writeFileSync(probe, 'probe');
		let whileHeld = 'renamed';
		try {
			fs.renameSync(probe, file);
		} catch (err) {
			whileHeld = codeOf(err) ?? messageOf(err);
		}
		fs.rmSync(probe, { force: true });
		replaceFile(file, 'new');
		await exited;

		assert.deepStrictEqual({ whileHeld, content: fs.readFileSync(file, 'utf8'), left: fs.readdirSync(temp.dir) }, { whileHeld: 'EPERM', content: 'new', left: ['held.json'] });
	});

	test('a JSON file is read with the layout it has - its byte order mark, line endings, indentation and final newline - and written back in it', () => {
		const file = path.join(temp.dir, 'theirs.json');
		const theirs = `${BOM}{\r\n    "a": 1,\r\n    "b": [\r\n        "x"\r\n    ]\r\n}`;
		fs.writeFileSync(file, theirs);
		const read = readJsonFile(file);
		if (read.kind !== 'object') {
			assert.fail(`read as ${read.kind}`);
		}
		writeJsonFile(file, { ...read.value, c: true }, read.layout);

		assert.deepStrictEqual({
			layout: read.layout,
			written: fs.readFileSync(file, 'utf8'),
			tabs: jsonLayoutOf('{\n\t"a": 1\n}\n'),
			flat: jsonLayoutOf('{}'),
			parsed: parseJson(`${BOM}{"a":1}`),
			fresh: formatJson({ a: 1 })
		}, {
			layout: { byteOrderMark: true, lineEnding: '\r\n', indent: 4, finalNewline: false },
			written: `${BOM}{\r\n    "a": 1,\r\n    "b": [\r\n        "x"\r\n    ],\r\n    "c": true\r\n}`,
			tabs: { byteOrderMark: false, lineEnding: '\n', indent: '\t', finalNewline: true },
			flat: { byteOrderMark: false, lineEnding: '\n', indent: 2, finalNewline: false },
			parsed: { a: 1 },
			fresh: '{\n  "a": 1\n}\n'
		});
	});

	/** Makes another program write `file` as Facade writes its new one, `times` times, each time to a size it did not have. */
	function writtenMeanwhile(file: string, times: number): () => void {
		let count = 0;
		return replaceFsFunction('writeFileSync', original => (target, data, options) => {
			original(target, data, options);
			if (typeof target === 'number' && count < times) {
				count++;
				original(file, `{"theirs": ${'9'.repeat(count + 1)}}\n`);
			}
		});
	}

	test('a JSON file another program writes too is read again when it wrote the file meanwhile, so that what it wrote is kept; one that goes on changing throws, and Facade writes nothing', () => {
		const file = path.join(temp.dir, 'settings.json');
		fs.writeFileSync(file, '{"theirs": 1}\n');
		const ours = (read: JsonFile) => read.kind === 'object' ? { outcome: 'written', write: { ...read.value, ours: true } } : { outcome: read.kind };
		let restore = writtenMeanwhile(file, 1);
		let once: string;
		try {
			once = updateJsonFile(file, ours);
		} finally {
			restore();
		}
		const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
		restore = writtenMeanwhile(file, 10);
		let always = 'written';
		try {
			updateJsonFile(file, ours);
		} catch (err) {
			always = err instanceof FileChangedError ? 'changed' : messageOf(err);
		} finally {
			restore();
		}

		assert.deepStrictEqual({ once, kept, always, theirs: JSON.parse(fs.readFileSync(file, 'utf8')), left: fs.readdirSync(temp.dir) }, {
			once: 'written',
			kept: { theirs: 99, ours: true },
			always: 'changed',
			theirs: { theirs: 9999 },
			left: ['settings.json']
		});
	});

	test('a JSON file written while it is read is read again', () => {
		const file = path.join(temp.dir, 'settings.json');
		fs.writeFileSync(file, '{"theirs": 1}\n');
		let once = true;
		const restore = replaceFsFunction('readFileSync', original => ((...args: Parameters<typeof fs.readFileSync>) => {
			const text = original(...args);
			if (once && args[0] === file) {
				once = false;
				fs.writeFileSync(file, '{"theirs": 22}\n');
			}
			return text;
		}) as typeof fs.readFileSync);
		let read: JsonFile;
		try {
			read = readJsonFile(file);
		} finally {
			restore();
		}

		assert.deepStrictEqual(read.kind === 'object' ? read.value : read.kind, { theirs: 22 });
	});

	test('a JSON file that is missing, not JSON, not an object or not readable is told apart', () => {
		const at = (name: string, content?: string) => {
			const file = path.join(temp.dir, name);
			if (content !== undefined) {
				fs.writeFileSync(file, content);
			}
			return readJsonFile(file).kind;
		};
		fs.mkdirSync(path.join(temp.dir, 'folder.json'));

		assert.deepStrictEqual([at('missing.json'), at('broken.json', '{"a":'), at('list.json', '[1]'), at('folder.json'), at('object.json', '{}')], ['missing', 'other', 'other', 'other', 'object']);
	});
});

suite('Base: a lock windows take turns at', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-lock-');
	});

	teardown(() => {
		temp.remove();
	});

	test('one holder at a time: another process\'s lock is waited for, and taken only once that process let it go, as it says itself', async function () {
		this.timeout(10_000);
		const file = path.join(temp.dir, 'shared.json');
		const lock = `${file}.lock`;
		// Another window holds it for half a second, and says when it took it and when it let it go.
		const other = spawn(process.execPath, ['-e', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(lock)}, 'other', { flag: 'wx' }); console.log('took', Date.now()); setTimeout(() => { fs.rmSync(${JSON.stringify(lock)}); console.log('let go', Date.now()); }, 500);`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		let said = '';
		other.stdout.on('data', (chunk: Buffer) => said += chunk.toString('utf8'));
		const exited = new Promise(resolve => other.on('exit', resolve));
		while (!said.includes('took')) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}

		const held = withFileLock(file, () => ({ at: Date.now(), mark: fs.readFileSync(lock, 'utf8') }));
		await exited;
		const letGo = Number(/let go (\d+)/.exec(said)?.[1]);

		assert.deepStrictEqual({ afterItLetGo: held.at >= letGo, mine: held.mark.startsWith(`${process.pid} `), gone: fs.existsSync(lock) }, { afterItLetGo: true, mine: true, gone: false });
	});

	test('a lock in the form another program takes it - a folder, as Claude Code locks its configuration - is waited for while its holder has it, and broken once it is older than such a holder keeps one', async function () {
		this.timeout(10_000);
		const file = path.join(temp.dir, '.claude.json');
		const lock = `${file}.lock`;
		// Claude Code holds it for half a second, as proper-lockfile does: a folder of its own.
		const claude = spawn(process.execPath, ['-e', `const fs = require('fs'); fs.mkdirSync(${JSON.stringify(lock)}); console.log('took', Date.now()); setTimeout(() => { fs.rmdirSync(${JSON.stringify(lock)}); console.log('let go', Date.now()); }, 500);`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		let said = '';
		claude.stdout.on('data', (chunk: Buffer) => said += chunk.toString('utf8'));
		const exited = new Promise(resolve => claude.on('exit', resolve));
		while (!said.includes('took')) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const heldAt = withFileLock(file, () => Date.now());
		await exited;
		const letGo = Number(/let go (\d+)/.exec(said)?.[1]);
		// One a Claude Code killed as it saved left behind, untouched since.
		fs.mkdirSync(lock);
		const longAgo = new Date(Date.now() - 20_000);
		fs.utimesSync(lock, longAgo, longAgo);
		const leftBehind = withFileLock(file, () => 'took');

		assert.deepStrictEqual({ afterItLetGo: heldAt >= letGo, leftBehind, left: fs.existsSync(lock) }, { afterItLetGo: true, leftBehind: 'took', left: false });
	});

	test('a lock goes only by its holder: one that is another\'s by the time it lets go - its own broken as stale, and taken since - stays', () => {
		const file = path.join(temp.dir, 'shared.json');
		const lock = `${file}.lock`;
		withFileLock(file, () => fs.writeFileSync(lock, '4242 another'));

		assert.deepStrictEqual({ left: fs.readFileSync(lock, 'utf8'), aside: fs.readdirSync(temp.dir).filter(name => name.endsWith('.stale')) }, { left: '4242 another', aside: [] });
	});

	test('a lock found left behind goes only while it is that one: one taken anew in the meantime is put back', () => {
		const lock = path.join(temp.dir, 'shared.json.lock');
		fs.writeFileSync(lock, '4242 taken anew');
		removeLockIfUnchanged(lock, '4242 left behind');
		const kept = fs.readFileSync(lock, 'utf8');
		removeLockIfUnchanged(lock, '4242 taken anew');

		assert.deepStrictEqual({ kept, left: fs.readdirSync(temp.dir) }, { kept: '4242 taken anew', left: [] });
	});

	test('a lock left behind by a process that ended goes once it is older than any holder keeps one; a holder\'s error lets it go', () => {
		const file = path.join(temp.dir, 'shared.json');
		const lock = `${file}.lock`;
		fs.writeFileSync(lock, '4242');
		const longAgo = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, longAgo, longAgo);

		const took = withFileLock(file, () => 'took');
		let failed = '';
		try {
			withFileLock(file, () => {
				throw new Error('Broke.');
			});
		} catch (err) {
			failed = messageOf(err);
		}

		assert.deepStrictEqual({ took, failed, gone: fs.existsSync(lock) }, { took: 'took', failed: 'Broke.', gone: false });
	});

	test('a lock whose holder still runs - slowed by a disk, a scanner - is not broken as stale: it is waited for, and the wait ends in an error; one that old for half a minute is broken all the same', function () {
		this.timeout(15_000);
		const file = path.join(temp.dir, 'shared.json');
		const lock = `${file}.lock`;
		// This test's own process holds it, as a window does, its mark the holder's process id first.
		const held = `${process.pid} a1b2c3d4e5f6`;
		fs.writeFileSync(lock, held);
		const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);
		fs.utimesSync(lock, secondsAgo(5), secondsAgo(5));
		let slow = '';
		try {
			slow = withFileLock(file, () => 'took');
		} catch (err) {
			slow = messageOf(err);
		}
		const left = fs.readFileSync(lock, 'utf8');
		fs.utimesSync(lock, secondsAgo(40), secondsAgo(40));
		const abandoned = withFileLock(file, () => 'took');

		assert.deepStrictEqual({ slow, left, abandoned }, { slow: `${file} stayed locked by another window for 5 seconds.`, left: held, abandoned: 'took' });
	});
});
