/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { codeOf, messageOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';

/** The part of `vscode.Memento` the window's agents use. */
export interface StateStore {
	get(key: string): unknown;
	update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Values the window keeps for its agents - the pipe's id - in a file next to the workspace's ledger. Not the extension's workspace storage, which changes when a folder window
 * becomes a workspace while the agents keep running.
 */
export class JsonFileState implements StateStore {

	private readonly values: { [key: string]: unknown };
	/** Why the file, there, could not be read - its values lost, the pipe's id with them (C-REC-19); undefined where it was read, or is not there. */
	readonly unreadable: string | undefined;

	constructor(private readonly file: string) {
		let read: unknown;
		let why: string | undefined;
		try {
			read = JSON.parse(fs.readFileSync(file, 'utf8'));
			why = isJsonObject(read) ? undefined : 'it does not contain a JSON object';
		} catch (err) {
			// Missing: a new window's. Unreadable: started anew all the same, and said.
			why = codeOf(err) === 'ENOENT' ? undefined : messageOf(err);
		}
		this.unreadable = why;
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
