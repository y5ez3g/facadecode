/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as vscode from 'vscode';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import type { OwnedWrite } from '../base/ownership';

/**
 * The window's workspace state - known locations, last launch, panel order, the workspace key - kept beside its runs as well
 * (ARCHITECTURE-2.2, D70). A folder window that becomes a multi-root workspace gets an empty workspace state from the editor, which
 * does not carry an extension's over: a window that `carried` its runs over that way takes what it kept in `file` where its
 * workspace state belongs to an older visit to the destination. The state of the continuing window wins.
 */
export class KeptWorkspaceState implements vscode.Memento {

	private readonly values = new Map<string, unknown>();

	constructor(private readonly state: vscode.Memento, private readonly file: string, carried: boolean, private readonly log: (text: string) => void, private readonly writeIfOwned: OwnedWrite = write => write()) {
		this.writeIfOwned(() => {
			for (const key of state.keys()) {
				this.values.set(key, state.get(key));
			}
			const kept = carried ? this.read() : undefined;
			if (kept) {
				for (const key of new Set([...this.values.keys(), ...Object.keys(kept)])) {
					const value = kept[key];
					if (value === undefined) { this.values.delete(key); } else { this.values.set(key, value); }
					void Promise.resolve(state.update(key, value)).catch(err => this.log(`Could not keep ${key} in the workspace: ${String(err)}`));
				}
			} else {
				this.write();
			}
		});
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.values.has(key) ? this.values.get(key) as T : defaultValue;
	}

	update(key: string, value: unknown): Thenable<void> {
		let result: Thenable<void> = Promise.resolve();
		try {
			this.writeIfOwned(() => {
				const next = new Map(this.values);
				if (value === undefined) { next.delete(key); } else { next.set(key, value); }
				// Persist the handover source before confirming it in memory or the editor. A failed sidecar write must not
				// acknowledge a newer Memento value that a subsequent handover would overwrite with the old sidecar.
				this.write(next);
				this.values.clear();
				for (const [name, kept] of next) { this.values.set(name, kept); }
				result = this.state.update(key, value);
			});
		} catch (error) {
			return Promise.reject(error);
		}
		return result;
	}

	/** What was kept, where it can be read. */
	private read(): { readonly [key: string]: unknown } | undefined {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			return isJsonObject(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}

	private write(values: ReadonlyMap<string, unknown> = this.values): void {
		try {
			replaceFile(this.file, `${JSON.stringify(Object.fromEntries(values))}\n`);
		} catch (err) {
			this.log(`Could not keep the workspace state beside its agents: ${String(err)}`);
			throw err;
		}
	}
}
