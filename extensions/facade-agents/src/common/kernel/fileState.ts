/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/*
 * A few values the window keeps for its agents - the pipe's name, the terminals' process ids - in a
 * file next to the workspace's ledger. Not the extension's workspace storage: that one changes when
 * a folder window becomes a workspace, the extension host restarting in the same moment, and the
 * agents still running would lose the pipe they call and the terminals they run in.
 */

/** What `vscode.Memento` offers, as far as the window's agents use it. */
export interface StateStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): PromiseLike<void>;
}

export class JsonFileState implements StateStore {

	private values: Record<string, unknown>;

	constructor(private readonly file: string) {
		try {
			const read = JSON.parse(fs.readFileSync(file, 'utf8'));
			this.values = read && typeof read === 'object' && !Array.isArray(read) ? read : {};
		} catch {
			this.values = {};
		}
	}

	get<T>(key: string, defaultValue: T): T {
		return Object.hasOwn(this.values, key) ? this.values[key] as T : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			delete this.values[key];
		} else {
			this.values[key] = value;
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(this.values, undefined, '\t'), { mode: 0o600 });
		fs.renameSync(temp, this.file);
	}
}
