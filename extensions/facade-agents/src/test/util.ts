/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A temporary folder, real path, removed by the returned function. */
export function tempDir(prefix: string): { dir: string; remove(): void } {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

/** What a promise came to: `fulfilled`, or its error's message, after its code when it has one. */
export async function outcomeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'fulfilled';
	} catch (err) {
		const error = err as Error & { code?: string };
		return error.code ? `${error.code}: ${error.message}` : error.message;
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
