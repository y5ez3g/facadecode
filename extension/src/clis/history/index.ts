/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Vendor conversation discovery for the Resume picker (LIFECYCLE-3.2, CLIS-2.4): the CLIs' own stores, for the window's
// directories and every folder below them, recent activity first, in batches of 100. A picker session lists each store's files
// once and reads each file's head at most once; a bound on the reads of one batch only ends that batch early - the next one goes
// on, so older matches stay reachable. No age cutoff, no hiding, no store of Facade's own. Each directory's stores are the ones
// its CLIs' launches there find, by the same environment (CLIS-1.2). Only stores with fixture-tested readers are advertised.

import * as fs from 'fs';
import type { Environment } from '../environment';
import { CLAUDE_STORE } from './claude';
import { ANTIGRAVITY_STORE } from './antigravity';
import { CODEX_STORE } from './codex';
import { MUSE_STORE } from './muse';
import { OPENCODE_STORE } from './opencode';
import { PI_STORE } from './pi';
import { inScope } from './scope';
import type { Candidate, Found, VendorStore } from './store';

/** How many conversations a batch holds (LIFECYCLE-3.2). */
export const BATCH = 100;

/** The most file heads one batch reads; past it the batch ends early and the next goes on (LIFECYCLE-3.2). */
export const MOST_READS_PER_BATCH = 1_000;

/** A conversation as the picker lists it: the same facts as the core's ConversationEntry. */
export interface DiscoveredConversation {
	readonly key: { readonly environment: string; readonly cli: string; readonly sessionId: string };
	readonly title?: string;
	readonly cwd: string;
	readonly cwdChoices?: readonly string[];
	readonly activityAt?: number;
	readonly unavailable?: string;
}

/** The stores Resume reads, a fixture-tested reader each (CLIS-2.4). */
export const VENDOR_STORES: readonly VendorStore[] = [CLAUDE_STORE, CODEX_STORE, ANTIGRAVITY_STORE, MUSE_STORE, OPENCODE_STORE, PI_STORE];

/**
 * The environments a directory's stores are found by, by CLI - CLAUDE_CONFIG_DIR, CODEX_HOME, the home folder... - as each CLI's
 * launches there have them (CLIS-1.2), so that the picker lists the conversations their Resume finds. A CLI named by none has no
 * store read for the directory.
 */
export interface StoreEnvironments {
	readonly [cli: string]: Environment | undefined;
}

/** Where the stores are and what may keep a conversation from being resumed. */
export interface VendorHistoryOptions {
	/** The environments the stores of a directory of the scope are found by (CLIS-1.2): this process's by default. */
	readonly environment?: (directory: string) => StoreEnvironments;
	readonly arguments?: () => Readonly<Record<string, readonly string[]>>;
	readonly knownCwd?: (key: DiscoveredConversation['key']) => string | undefined;
	/** The stores read: every one Facade has a reader for by default. */
	readonly stores?: readonly VendorStore[];
	/** Why a CLI cannot resume a conversation of a folder in this window now - not installed, turned off - or undefined where it can. */
	readonly unavailable?: (cli: string, cwd: string) => string | undefined;
}

/** A file of a store, with the directories of the scope whose launches find that store. */
interface ScopedCandidate extends Candidate {
	readonly scope: readonly string[];
}

interface ResolvedCandidate {
	readonly candidate: ScopedCandidate;
	readonly found: Found;
	readonly at: number;
}

/** One picker session's reading of the stores. */
class VendorPager {

	private candidates: ScopedCandidate[] | undefined;
	private next$ = 0;
	/** Enriched entries waiting until unread candidates can no longer precede them. Earliest activity first. */
	private readonly pending: ResolvedCandidate[] = [];
	private readonly seen = new Set<string>();
	private disposed = false;

	constructor(private readonly history: VendorHistory, private readonly scope: { readonly environment: string; readonly directories: readonly string[] }) { }

	async next(): Promise<{ readonly entries: readonly DiscoveredConversation[]; readonly done: boolean }> {
		if (this.disposed) {
			return { entries: [], done: true };
		}
		// Listed once: every file a store may keep a conversation of the scope in, most recently active first
		this.candidates ??= this.history.candidatesOf(this.scope.directories).sort((a, b) => b.at - a.at || (a.file < b.file ? -1 : 1));
		const entries: DiscoveredConversation[] = [];
		let reads = 0;
		while (!this.disposed && entries.length < BATCH) {
			const unread = this.candidates[this.next$];
			const recent = this.pending.at(-1);
			// File mtime is only an upper bound. Read ahead before returning an old conversation that was recently touched.
			if (unread && (!recent || unread.at >= recent.at)) {
				if (reads >= MOST_READS_PER_BATCH) {
					break;
				}
				this.next$++;
				reads++;
				const found = await this.history.read(unread);
				if (this.disposed) {
					break;
				}
				// Only a directory whose launches find this store: another's Resume would not find the conversation there.
				if (found && inScope(found.cwd, unread.scope)) {
					const at = Math.min(found.activityAt ?? unread.at, unread.at);
					let low = 0, high = this.pending.length;
					while (low < high) {
						const middle = (low + high) >>> 1;
						if (this.pending[middle].at <= at) { low = middle + 1; } else { high = middle; }
					}
					this.pending.splice(low, 0, { candidate: unread, found, at });
				}
				continue;
			}
			if (!recent) { break; }
			this.pending.pop();
			const { candidate, found, at } = recent;
			// One entry per environment, CLI and session: its most recently active file
			const key = `${candidate.cli}\u0000${found.sessionId}`;
			if (this.seen.has(key)) {
				continue;
			}
			this.seen.add(key);
			const conversation = { environment: this.scope.environment, cli: candidate.cli, sessionId: found.sessionId };
			const known = found.cwdChoices && this.history.knownCwd(conversation);
			const choices = known ? undefined : found.cwdChoices?.filter(folder => !this.history.unavailableOf(candidate.cli, folder));
			const cwd = known || choices?.[0] || found.cwd;
			const unavailable = this.history.unavailableOf(candidate.cli, cwd);
			entries.push({
				key: conversation,
				...found.title ? { title: found.title } : {},
				cwd,
				...choices?.length ? { cwdChoices: choices } : {},
				activityAt: at,
				...unavailable ? { unavailable } : {}
			});
		}
		return { entries, done: this.next$ >= this.candidates.length && !this.pending.length };
	}

	dispose(): void {
		this.disposed = true;
		this.candidates = [];
		this.pending.length = 0;
	}
}

/** ConversationDiscoveryPort over the CLIs' own stores in this execution environment. */
export class VendorHistory {

	private readonly environment: (directory: string) => StoreEnvironments;
	private readonly stores: ReadonlyMap<string, VendorStore>;
	private readonly unavailable: (cli: string, cwd: string) => string | undefined;
	private readonly arguments: () => Readonly<Record<string, readonly string[]>>;
	readonly knownCwd: (key: DiscoveredConversation['key']) => string | undefined;
	/** Each file's head as read, by file and when it last changed: reused within and across picker sessions. */
	private readonly heads = new Map<string, { readonly at: number; readonly found: Found | undefined; readonly files: ReadonlyMap<string, string> }>();

	constructor(options: VendorHistoryOptions = {}) {
		const stores = options.stores ?? VENDOR_STORES;
		this.stores = new Map(stores.map(store => [store.cli, store]));
		this.environment = options.environment ?? (() => Object.fromEntries(stores.map(store => [store.cli, process.env])));
		this.unavailable = options.unavailable ?? (() => undefined);
		this.arguments = options.arguments ?? (() => ({}));
		this.knownCwd = options.knownCwd ?? (() => undefined);
	}

	/** Vendor histories for `scope`'s directories and the folders below them. */
	open(scope: { readonly environment: string; readonly directories: readonly string[] }): VendorPager {
		return new VendorPager(this, scope);
	}

	/**
	 * The files of every store that may keep a conversation of `directories`, each store found with the environment of the
	 * directories whose launches use it (CLIS-1.2): a store is listed once, however many directories find it.
	 */
	candidatesOf(directories: readonly string[]): ScopedCandidate[] {
		const found = new Map<string, { readonly store: VendorStore; readonly dir: string; readonly directories: string[] }>();
		const args = this.arguments();
		for (const directory of directories) {
			const environments = this.environment(directory);
			for (const store of this.stores.values()) {
				const env = environments[store.cli];
				if (!env) {
					continue;
				}
				const dir = store.dirOf(env, directory, args[store.cli]);
				const key = `${store.cli}\u0000${dir}`;
				const each = found.get(key) ?? { store, dir, directories: [] };
				each.directories.push(directory);
				found.set(key, each);
			}
		}
		return [...found.values()].flatMap(({ store, dir, directories: scope }) => store.candidates(dir, scope).map(candidate => ({ ...candidate, scope })));
	}

	/** A candidate's metadata: read once per version of its file. */
	async read(candidate: Candidate): Promise<Found | undefined> {
		if (candidate.found) {
			return candidate.found;
		}
		const known = this.heads.get(candidate.file);
		if (known && known.at === candidate.at && [...known.files].every(([file, stamp]) => stamp === fileStamp(file))) {
			return known.found;
		}
		const files = new Map<string, string>();
		const dependOn = (file: string) => files.set(file, fileStamp(file));
		dependOn(candidate.file);
		const found = await this.stores.get(candidate.cli)?.read(candidate, dependOn);
		this.heads.set(candidate.file, { at: candidate.at, found, files });
		return found;
	}

	/** Why a conversation of `cli` in `cwd` cannot be resumed now, where it cannot. */
	unavailableOf(cli: string, cwd: string): string | undefined {
		if (!fs.existsSync(cwd)) {
			return `Its working directory no longer exists: ${cwd}`;
		}
		return this.unavailable(cli, cwd);
	}
}

/** Missing files are dependencies too: a new title sidecar or continuation target changes the metadata. */
function fileStamp(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
	} catch {
		return 'missing';
	}
}
