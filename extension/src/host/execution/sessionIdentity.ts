/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { recordedSession, sessionDirOf, sessionFileOf, sessionFilesIn } from '../../clis/identity';
import { MuseIdentity } from '../../clis/museIdentity';

/** How often the hook files of the runs watched are read. */
const READ_MS = 1_000;

/**
 * Reads only the hook files of this window's owned runs, once a second while it has any; never guesses a session from a vendor
 * directory. Reading, not a file watcher: it behaves the same on remote and network file systems and needs no watch quota, and a
 * conversation's identity changing is told within a second.
 */
export class SessionIdentity {
	private readonly runs = new Map<string, string | undefined>();
	private readonly muse = new Map<string, MuseIdentity>();
	private readonly errors = new Set<string>();
	private readonly processes = new Map<string, number>();
	private poller?: ReturnType<typeof setInterval>;

	constructor(private readonly home: string, private readonly identified: (run: string, sessionId: string | null, cwd?: string) => void,
		private readonly log: (text: string) => void) { }

	track(run: string): void {
		this.runs.set(run, undefined);
		const native = path.join(sessionDirOf(sessionFileOf(this.home, run)), 'muse.json');
		if (fs.existsSync(native)) { this.muse.set(run, new MuseIdentity(native)); }
		if (!this.poller) {
			this.poller = setInterval(() => { for (const each of this.runs.keys()) { this.read(each); } }, READ_MS);
			this.poller.unref?.();
		}
		this.read(run);
	}

	untrack(run: string): void {
		this.runs.delete(run);
		this.muse.delete(run);
		this.errors.delete(run);
		this.processes.delete(run);
		if (!this.runs.size) { this.stop(); }
	}

	process(run: string, pid: number): void {
		if (!this.runs.has(run)) { return; }
		this.processes.set(run, pid);
		this.read(run);
	}

	private stop(): void {
		clearInterval(this.poller); this.poller = undefined;
	}

	/** Only after the process ended: a reload/detach keeps the hook record for the next host. */
	forget(run: string): void {
		this.untrack(run);
		for (const { file } of sessionFilesIn(this.home).filter(each => each.run === run)) {
			try { fs.rmSync(file, { force: true, recursive: file.endsWith('.session.d') }); }
			catch { this.log(`Could not remove the session record of ${run}.`); }
		}
	}

	private read(run: string): void {
		let session = recordedSession(sessionFileOf(this.home, run));
		try { session = this.muse.get(run)?.read(session?.sessionId, this.processes.get(run)) ?? session; }
		catch (err) {
			if (!this.errors.has(run)) { this.log(`Could not read the native Muse session of ${run}: ${String(err)}`); this.errors.add(run); }
			session = { sessionId: null };
		}
		if (session?.sessionId) { this.errors.delete(run); }
		const key = session && JSON.stringify([session.sessionId, session.cwd]);
		if (session && key !== this.runs.get(run)) {
			this.runs.set(run, key);
			this.identified(run, session.sessionId, session.cwd);
		}
	}

	dispose(): void { this.stop(); this.runs.clear(); this.muse.clear(); this.errors.clear(); this.processes.clear(); }
}
