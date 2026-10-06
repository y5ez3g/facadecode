/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';

/** The part of `vscode.Memento` the window's agents use. */
export interface StateStore {
	get(key: string): unknown;
	update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Values the window keeps for its agents - the pipe's id, the terminals' process ids - in a file next
 * to the workspace's ledger. Not the extension's workspace storage, which changes when a folder window
 * becomes a workspace while the agents keep running.
 */
export class JsonFileState implements StateStore {

	private readonly values: { [key: string]: unknown };

	constructor(private readonly file: string) {
		let read: unknown;
		try {
			read = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			// Missing or unreadable: start anew.
		}
		this.values = isJsonObject(read) ? { ...read } : {};
	}

	get(key: string): unknown {
		return Object.hasOwn(this.values, key) ? this.values[key] : undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			delete this.values[key];
		} else {
			this.values[key] = value;
		}
		replaceFile(this.file, JSON.stringify(this.values, undefined, '\t'));
	}
}
