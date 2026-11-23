/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as vscode from 'vscode';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';
import type { OwnedWrite } from '../base/ownership';
import { FacadeError, OWNERSHIP_LOST } from '../core/errors';

/**
 * How long a change through `update` waits to be written with those after it: a burst of them - the panel's order as a window
 * restores its cards one by one - is one write of the file, not a flushed write each.
 */
const COALESCE_MS = 100;

/** A change through `update`, written with the others waiting, and who waits for it. */
interface Change {
	readonly key: string;
	apply(current: unknown): unknown;
}

interface Waiting extends Change {
	resolve(): void;
	reject(err: unknown): void;
}

/** A successor activation of this workspace owns its state now: this one keeps nothing more of it (ARCHITECTURE-2.2). */
export class NotOwnedError extends FacadeError {
	constructor() {
		// Said to the person in their language, as every refusal for another window's ownership is (UX-2.4)
		super('INVALID', 'ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST);
	}
}

/**
 * The shared workspace sidecar (ARCHITECTURE-3.1). A Framework activation reads it directly. The legacy implementation also keeps its editor
 * Memento mirror. Each write takes its claim first, then the sidecar lock, and applies only this activation's changes.
 */
export class KeptWorkspaceState implements vscode.Memento {

	/** What it holds as read: what the file holds, with the changes waiting to be written over it. */
	private values = new Map<string, unknown>();
	/** What the file holds, as written last. */
	private written = new Map<string, unknown>();
	private waiting: Waiting[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly state: vscode.Memento | undefined, private readonly file: string, carried: boolean, private readonly log: (text: string) => void, private readonly writeIfOwned: OwnedWrite = write => write()) {
		this.writeIfOwned(() => {
			withFileLock(this.file, () => {
				const kept = this.read(state !== undefined);
				if (kept) {
					this.values = new Map(Object.entries(kept));
					if (state && carried) {
						for (const key of new Set([...state.keys(), ...this.values.keys()])) {
							void Promise.resolve(state.update(key, this.values.get(key))).catch(err => this.log(`Could not keep ${key} in the workspace: ${String(err)}`));
						}
					}
				} else {
					for (const key of state?.keys() ?? []) {
						this.values.set(key, state?.get(key));
					}
					this.write(this.values);
				}
			}, { keepLive: true });
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
			this.waiting.push({ key, apply: () => value, resolve, reject });
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
		return this.commit({ key, apply: () => value });
	}

	/** Applies an edit to the latest committed value. A disk or ownership failure is reported synchronously. */
	mutate<T>(key: string, change: (current: T | undefined) => T | undefined): void {
		void this.commit({ key, apply: current => change(current as T | undefined) })
			.catch(err => this.log(`Could not keep ${key} in the workspace: ${String(err)}`));
	}

	/** Writes the changes waiting now: as the window goes, none waits for a write that would come too late. */
	flush(): void {
		try {
			void this.commit();
		} catch {
			// Rejected the waiting updates below; each caller reports its own failure.
		}
	}

	/**
	 * Applies queued and immediate edits while holding both locks. Only a committed sidecar write reaches the editor mirror.
	 */
	private commit(change?: Change): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const waiting = this.waiting.splice(0);
		const all = change ? [...waiting, change] : waiting;
		if (!all.length) {
			return Promise.resolve();
		}
		const keys = new Set(all.map(edit => edit.key));
		try {
			let committed: Map<string, unknown> | undefined;
			this.writeIfOwned(() => {
				committed = withFileLock(this.file, () => {
					const latest = this.read() ?? {};
					const next = new Map(Object.entries(latest));
					for (const { key, apply } of all) {
						this.set(next, key, apply(next.get(key)));
					}
					if ([...keys].some(key => next.get(key) !== latest[key])) {
						this.write(next);
					}
					return next;
				}, { keepLive: true });
			});
			if (!committed) {
				throw new NotOwnedError();
			}
			this.written = committed;
			this.values = new Map(committed);
		} catch (err) {
			this.values = new Map(this.written);
			for (const edit of waiting) {
				edit.reject(err);
			}
			throw err;
		}
		const updates = new Map<string, Promise<void>>();
		const editor = this.state;
		if (editor) {
			for (const key of keys) {
				const value = this.values.get(key);
				updates.set(key, Promise.resolve().then(() => editor.update(key, value)));
			}
		}
		for (const edit of waiting) {
			const update = updates.get(edit.key);
			if (update) {
				void update.then(edit.resolve, edit.reject);
			} else {
				edit.resolve();
			}
		}
		return updates.get(change?.key ?? '') ?? Promise.resolve();
	}

	private set(values: Map<string, unknown>, key: string, value: unknown): void {
		if (value === undefined) { values.delete(key); } else { values.set(key, value); }
	}

	/** Legacy implementation initialization can recover a damaged sidecar from the existing editor state. */
	private read(recoverDamaged = false): Readonly<Record<string, unknown>> | undefined {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (isJsonObject(value)) { return value; }
			if (recoverDamaged) { return undefined; }
			throw new Error('Invalid workspace state record.');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (recoverDamaged && err instanceof SyntaxError)) {
				return undefined;
			}
			throw err;
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
