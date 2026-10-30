/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { FileStamp, replaceFile } from '../base/files';

export const AGENTS_LOG = 'agents.log';

/** Lines older than this go when the log is opened (ARCHITECTURE-3.3). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The agents log: one UTC-stamped line per operation or lifecycle fact, without secrets or message text (ARCHITECTURE-3.3),
 * pruned to thirty days.
 */
export class AgentLog {
	readonly file: string;

	constructor(dir: string, private readonly now: () => number = Date.now) {
		this.file = path.join(dir, AGENTS_LOG);
		this.prune();
	}

	event(text: string): void {
		const line = `${new Date(this.now()).toISOString()} ${text.replace(/[\r\n]+/g, ' ')}\n`;
		try {
			fs.appendFileSync(this.file, line);
		} catch {
			// The log is diagnostic: a full disk must not fail the operation it describes.
		}
	}

	private prune(): void {
		let text: string;
		let stamp: FileStamp;
		try {
			const { size, mtimeMs, ino } = fs.statSync(this.file);
			stamp = { size, mtimeMs, ino };
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return;
		}
		const cutoff = this.now() - RETENTION_MS;
		const kept = text.split('\n').filter(line => {
			const at = Date.parse(line.slice(0, 24));
			return line && (Number.isNaN(at) || at >= cutoff);
		});
		const next = kept.length ? `${kept.join('\n')}\n` : '';
		if (next !== text) {
			try {
				// Preserve the old log if pruning fails or another host appended after the read.
				replaceFile(this.file, next, stamp);
			} catch {
				// Retention is best effort: diagnostics must not prevent the extension from activating.
			}
		}
	}
}
