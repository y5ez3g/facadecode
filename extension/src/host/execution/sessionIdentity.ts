/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { recordedSession, sessionFileOf, sessionFilesIn } from '../../clis/identity';
import { MuseIdentity } from '../../clis/museIdentity';

/** Watches only the hook files of this window's owned runs; never guesses a session from a vendor directory. */
export class SessionIdentity {
	private readonly runs = new Map<string, string | undefined>();
	private readonly muse = new Map<string, MuseIdentity>();
	private readonly errors = new Set<string>();
	private readonly processes = new Map<string, number>();
	private watcher?: fs.FSWatcher;
	private poller?: ReturnType<typeof setInterval>;

	constructor(private readonly home: string, private readonly identified: (run: string, sessionId: string | null, cwd?: string) => void,
		private readonly log: (text: string) => void) { }

	track(run: string): void {
		this.runs.set(run, undefined);
		const native = path.join(sessionFileOf(this.home, run).replace(/\.json$/, '.d'), 'muse.json');
		if (fs.existsSync(native)) { this.muse.set(run, new MuseIdentity(native)); }
		if (!this.watcher && !this.poller) {
			const dir = path.dirname(sessionFileOf(this.home, run));
			fs.mkdirSync(dir, { recursive: true });
			try {
				this.watcher = fs.watch(dir, (_event, name) => {
					if (name === null) {
						for (const id of this.runs.keys()) { this.read(id); }
					} else {
						const id = String(name).replace(/\.session\.json$/, '');
						if (this.runs.has(id)) { this.read(id); }
					}
				});
				this.watcher.on('error', err => this.poll(err.message));
			} catch (err) { this.poll(String(err)); }
		}
		this.startPolling();
		this.read(run);
	}

	untrack(run: string): void {
		this.runs.delete(run);
		this.muse.delete(run);
		this.errors.delete(run);
		this.processes.delete(run);
		if (!this.runs.size) { this.stopWatching(); }
	}

	process(run: string, pid: number): void {
		if (!this.runs.has(run)) { return; }
		this.processes.set(run, pid);
		this.read(run);
	}

	/** Watch quotas and remote filesystems can reject fs.watch; read only our owned run files until they end. */
	private poll(reason: string): void {
		this.watcher?.close(); this.watcher = undefined;
		if (this.poller) { return; }
		this.log(`Session identity uses periodic reads because the file watcher is unavailable: ${reason}`);
		this.startPolling();
	}

	private startPolling(): void {
		if (this.poller) { return; }
		this.poller = setInterval(() => { for (const run of this.runs.keys()) { this.read(run); } }, 1_000);
		this.poller.unref();
	}

	private stopWatching(): void {
		this.watcher?.close(); this.watcher = undefined;
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

	dispose(): void { this.stopWatching(); this.runs.clear(); this.muse.clear(); this.errors.clear(); this.processes.clear(); }
}
