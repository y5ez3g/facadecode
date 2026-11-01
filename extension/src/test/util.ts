/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';

/** A temporary folder, real path, removed by the returned function. */
export function tempDir(prefix: string): { dir: string; remove(): void } {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	// A Git process a test started may hold its folder a moment after it answered, longer on a busy Windows machine
	return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }) };
}

/**
 * Replaces the function `name` of Node's `fs` module with what `replace` makes of the original, until the
 * returned function puts the original back: for a failure no disk gives at will, as one filling up halfway
 * through a write. The code under test calls each function through the module itself, as compiled; what
 * `import * as fs` gives is a copy whose functions cannot be replaced.
 */
export function replaceFsFunction<K extends keyof typeof fs>(name: K, replace: (original: (typeof fs)[K]) => (typeof fs)[K]): () => void {
	const nodeFs: typeof fs = require('fs');
	const original = nodeFs[name];
	nodeFs[name] = replace(original);
	return () => {
		nodeFs[name] = original;
	};
}

/** An error as Node gives it for a call on a file that failed: `code`, and the call. */
export function fsError(code: string, syscall: string): Error {
	return Object.assign(new Error(`${code}: ${syscall} failed`), { code, syscall });
}

/**
 * Makes the next `fs.writeFileSync` write only the first characters it is given, then fail as on a full
 * disk; those after it write as ever. Returns what puts the original back, should that write not come.
 */
export function cutNextWriteShort(): () => void {
	const restore = replaceFsFunction('writeFileSync', original => (file, data) => {
		restore();
		original(file, String(data).slice(0, 3));
		throw fsError('ENOSPC', 'write');
	});
	return restore;
}

/** What a promise came to: `fulfilled`, or its error's message, after its code when it has one. */
export async function outcomeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'fulfilled';
	} catch (err) {
		const code = codeOf(err);
		return code ? `${code}: ${messageOf(err)}` : messageOf(err);
	}
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new Error('Cancelled'));
		}, { once: true });
	});
}

/**
 * Waits until `test` holds, in real time, for `ms` at most: for what happens past the test's own
 * memory - the other end of a pipe, another process, a timer of the code under test.
 */
export async function waitFor(test: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) {
			throw new Error(`What the test waited for did not come within ${ms} ms.`);
		}
		await sleep(10);
	}
}
