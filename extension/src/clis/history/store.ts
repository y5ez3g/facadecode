/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Environment } from '../environment';

/** A file of a vendor store that may hold a conversation of the scope: listed with its last change, not yet read. */
export interface Candidate {
	readonly cli: string;
	readonly file: string;
	/** Indexed activity or file mtime: an upper bound on activity before reading native metadata. */
	readonly at: number;
	/** Its session ID where the store names files by it. */
	readonly sessionId?: string;
	/** Its list metadata where the store's index gives it whole: nothing more is read. */
	readonly found?: Found;
}

/** A conversation's list metadata as its file's head gives it. */
export interface Found {
	readonly sessionId: string;
	readonly cwd: string;
	/** Native workspace roots where the vendor did not record which one was the original cwd. */
	readonly cwdChoices?: readonly string[];
	readonly title?: string;
	/** Native conversation activity, when distinct from the candidate's file mtime. */
	readonly activityAt?: number;
}

/** A CLI's own conversation store as Resume reads it (LIFECYCLE-3.2, CLIS-2.4): a fixture-tested compatibility reader. */
export interface VendorStore {
	readonly cli: string;
	/** The store's folder, as the CLI's launches in `directory` with `env` find it (CLIS-1.2). */
	dirOf(env: Environment, directory: string, args?: readonly string[]): string;
	/** What in the store at `dir` may keep a conversation of `directories` or a folder below them: listed with its last change. */
	candidates(dir: string, directories: readonly string[]): Candidate[];
	/** Register additional files before reading them so their creation, removal or changes invalidate cached metadata. */
	read(candidate: Candidate, dependOn?: (file: string) => void): Promise<Found | undefined>;
}
