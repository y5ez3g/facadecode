/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Muse 1.4.14 drops per-run hook overrides on /clear. Its native schema-v1 runtime registry follows the same process generation
// across session switches. Bind its process generation from this run's hook, then follow that process's leased endpoints; never
// use recency. The execution owner watches this only while its PTY run is live, so a retired run cannot follow a reused PID.

import * as fs from 'fs';
import * as path from 'path';
import { isJsonObject } from '../base/json';
import { SESSION_ID } from './identity';
import { openReadOnly } from './history/sqlite';

function object(file: string): Record<string, unknown> | undefined {
	try {
		if (fs.statSync(file).size > 64 * 1024) { return undefined; }
		const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return isJsonObject(value) ? value : undefined;
	} catch { return undefined; }
}

export class MuseIdentity {
	private readonly data: string | undefined;
	private binding?: { readonly endpoint: string; readonly generation: string };
	private cwd?: string;
	private session?: string;
	private persisted = false;

	constructor(private readonly file: string) {
		const saved = object(file);
		this.data = typeof saved?.data === 'string' && path.isAbsolute(saved.data) ? saved.data : undefined;
		if (typeof saved?.endpoint === 'string' && /^ms-[a-zA-Z0-9_-]+\.sock$/.test(saved.endpoint) && typeof saved.generation === 'string') {
			this.binding = { endpoint: saved.endpoint, generation: saved.generation };
		}
	}

	read(identified?: string | null, pid?: number): { readonly sessionId: string | null; readonly cwd?: string } {
		if (!this.data) { return { sessionId: null }; }
		const runtime = path.join(this.data, 'runtime', 'muse');
		const directory = path.join(runtime, 'sessions');
		// On direct native launches, the PTY's process ID is stronger than waiting for a first-prompt hook (including Resume).
		// Wrapper processes whose PID differs use the process-bound hook as before; no unrelated process is selected.
		if (!this.binding && !identified && pid) {
			try {
				const ids = fs.readdirSync(directory).filter(name => name.endsWith('.json') && SESSION_ID.test(name.slice(0, -5)))
					.filter(name => object(path.join(directory, name))?.process_generation_hint === `pid=${pid}`);
				if (ids.length === 1) { identified = ids[0].slice(0, -5); }
			} catch { /* No live registry yet. */ }
		}
		if (!this.binding && identified && SESSION_ID.test(identified)) {
			const entry = object(path.join(directory, `${identified}.json`));
			if (entry?.schema_version === 1 && entry.session_id === identified && typeof entry.endpoint_hint === 'string'
				&& /^ms-[a-zA-Z0-9_-]+\.sock$/.test(entry.endpoint_hint) && typeof entry.process_generation_hint === 'string') {
				const lease = object(path.join(runtime, `${entry.endpoint_hint}.lease`));
				if (lease?.schema_version === 1 && lease.endpoint_hint === entry.endpoint_hint && lease.process_generation_hint === entry.process_generation_hint
					&& typeof lease.pid === 'number' && lease.pid > 0 && entry.process_generation_hint === `pid=${lease.pid}`) {
					this.binding = { endpoint: entry.endpoint_hint, generation: entry.process_generation_hint };
					const temp = `${this.file}.${process.pid}.tmp`;
					fs.writeFileSync(temp, JSON.stringify({ data: this.data, ...this.binding }), { mode: 0o600 });
					fs.renameSync(temp, this.file);
				}
			}
		}
		if (!this.binding) { return { sessionId: null }; }
		let names: string[];
		try { names = fs.readdirSync(directory); } catch { return { sessionId: null }; }
		const matching: string[] = [];
		for (const name of names) {
			const id = name.endsWith('.json') ? name.slice(0, -5) : '';
			if (!SESSION_ID.test(id)) { continue; }
			const entry = object(path.join(directory, name));
			if (entry?.schema_version !== 1 || entry.session_id !== id || typeof entry.endpoint_hint !== 'string'
				|| !/^ms-[a-zA-Z0-9_-]+\.sock$/.test(entry.endpoint_hint) || entry.process_generation_hint !== this.binding.generation
				|| entry.target_eligibility !== 'message_capable') { continue; }
			const lease = object(path.join(runtime, `${entry.endpoint_hint}.lease`));
			if (lease?.schema_version === 1 && lease.endpoint_hint === entry.endpoint_hint && lease.process_generation_hint === this.binding.generation
				&& typeof lease.pid === 'number' && lease.pid > 0 && this.binding.generation === `pid=${lease.pid}`) { matching.push(id); }
		}
		// Multiple roots for the process are ambiguous: never choose by timestamp, filename or directory order.
		if (matching.length !== 1) { return { sessionId: null }; }
		const sessionId = matching[0];
		if (sessionId !== this.session || !this.cwd || !this.persisted) {
			this.session = sessionId; this.cwd = undefined; this.persisted = false;
			const db = openReadOnly(path.join(this.data, 'session-index.db'));
			try {
				const row = db?.prepare('SELECT workspace_root, status, prompt_count, session_log_path FROM sessions WHERE session_id = ?').get(sessionId);
				const cwd = row?.workspace_root;
				if (typeof cwd === 'string' && path.isAbsolute(cwd)) { this.cwd = cwd; }
				this.persisted = row?.status === 'valid' && typeof row.prompt_count === 'number' && row.prompt_count > 0
					&& typeof row.session_log_path === 'string' && fs.existsSync(row.session_log_path);
			} catch { /* The hook's cwd remains authoritative until the native index has this row. */ }
			finally { db?.close(); }
		}
		return { sessionId: this.persisted ? sessionId : null, ...this.cwd ? { cwd: this.cwd } : {} };
	}
}
