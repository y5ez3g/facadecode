/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as vscode from 'vscode';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import type { OwnedWrite } from '../base/ownership';

/**
 * How long a change through `update` waits to be written with those after it: a burst of them - the panel's order as a window
 * restores its cards one by one - is one write of the file, not a flushed write each.
 */
const COALESCE_MS = 100;

/** A change through `update`, written with the others waiting, and who waits for it. */
interface Waiting {
	readonly key: string;
	resolve(): void;
	reject(err: unknown): void;
}

/** A successor activation of this workspace owns its state now: this one keeps nothing more of it (ARCHITECTURE-2.2). */
export class NotOwnedError extends Error {
	constructor() {
		super('Another window owns this workspace now: its state was not kept.');
	}
}

/**
 * The window's workspace state - known locations, last launch, panel order, the workspace key - kept beside its runs as well
 * (ARCHITECTURE-2.2, D70). A folder window that becomes a multi-root workspace gets an empty workspace state from the editor, which
 * does not carry an extension's over: a window that `carried` its runs over that way takes what it kept in `file` where its
 * workspace state belongs to an older visit to the destination. The state of the continuing window wins.
 */
export class KeptWorkspaceState implements vscode.Memento {

	/** What it holds as read: what the file holds, with the changes waiting to be written over it. */
	private values = new Map<string, unknown>();
	/** What the file holds, as written last. */
	private written = new Map<string, unknown>();
	private waiting: Waiting[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

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
				this.write(this.values);
			}
		});
		this.written = new Map(this.values);
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.values.has(key) ? this.values.get(key) as T : defaultValue;
	}

	/**
	 * Read as it is at once, and written with the changes that come within {@link COALESCE_MS}: settles once the file and the editor
	 * keep it. One the file cannot keep, or that a successor activation's ownership refuses, is taken back, and rejects.
	 */
	update(key: string, value: unknown): Thenable<void> {
		return new Promise<void>((resolve, reject) => {
			this.set(this.values, key, value);
			this.waiting.push({ key, resolve, reject });
			if (!this.timer) {
				this.timer = setTimeout(() => this.flush(), COALESCE_MS);
				this.timer.unref?.();
			}
		});
	}

	/**
	 * Commit to the owned sidecar before a synchronous action acknowledges it - with the changes waiting - and then to the editor;
	 * disk failures, and a successor activation's ownership, throw (LIFECYCLE-3.4).
	 */
	keep(key: string, value: unknown): Thenable<void> {
		const next = new Map(this.values);
		this.set(next, key, value);
		return this.commit(next, [{ key, resolve: () => undefined, reject: () => undefined }], true);
	}

	/** Writes the changes waiting now: as the window goes, none waits for a write that would come too late. */
	flush(): void {
		const next = new Map(this.values);
		void this.commit(next, [], false);
	}

	/**
	 * Writes `next` with the changes waiting and `changes`: the file first, so that a handover never reads an older file than the
	 * editor's state, then the editor's. Not written, the changes waiting are taken back and rejected, and `rethrow` throws.
	 */
	private commit(next: Map<string, unknown>, changes: readonly Waiting[], rethrow: boolean): Thenable<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const all = [...this.waiting.splice(0), ...changes];
		if (!all.length) {
			return Promise.resolve();
		}
		try {
			let wrote = false;
			// Persist the handover source before confirming it in memory or the editor. A failed sidecar write must not
			// acknowledge a newer Memento value that a subsequent handover would overwrite with the old sidecar.
			this.writeIfOwned(() => {
				this.write(next);
				wrote = true;
			});
			if (!wrote) {
				throw new NotOwnedError();
			}
		} catch (err) {
			this.values = new Map(this.written);
			for (const change of all) {
				change.reject(err);
			}
			if (rethrow) {
				throw err;
			}
			return Promise.resolve();
		}
		this.written = new Map(next);
		this.values = new Map(next);
		const updates = new Map<string, Thenable<void>>();
		for (const { key } of all) {
			if (!updates.has(key)) {
				updates.set(key, Promise.resolve(this.state.update(key, next.get(key))));
			}
		}
		for (const change of all) {
			updates.get(change.key)!.then(() => change.resolve(), err => change.reject(err));
		}
		return updates.get(changes.at(-1)?.key ?? '') ?? Promise.resolve();
	}

	private set(values: Map<string, unknown>, key: string, value: unknown): void {
		if (value === undefined) { values.delete(key); } else { values.set(key, value); }
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

	private write(values: ReadonlyMap<string, unknown>): void {
		try {
			replaceFile(this.file, `${JSON.stringify(Object.fromEntries(values))}\n`);
		} catch (err) {
			this.log(`Could not keep the workspace state beside its agents: ${String(err)}`);
			throw err;
		}
	}
}
