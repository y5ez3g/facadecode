/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import type { OwnedWrite } from '../base/ownership';

/**
 * Launches that failed before a process existed, kept red until closed (LIFECYCLE-1.5), and request-bearing run metadata for
 * one hour (MCP-1.1). Request-only records never restore a pair; ptyd owns live processes. One JSON file per workspace.
 */
export class RetainedFile<T extends { readonly id: string; readonly name: string; readonly alias: string }> {
	private readonly file: string;

	constructor(dir: string, private readonly writeIfOwned: OwnedWrite = write => write()) {
		this.file = path.join(dir, 'retained.json');
	}

	list(): readonly T[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			return Array.isArray(parsed) ? parsed.filter((each): each is T => isRetained(each)) : [];
		} catch {
			return [];
		}
	}

	put(run: T): void {
		this.write([...this.list().filter(each => each.id !== run.id), run]);
	}

	remove(run: string): void {
		const kept = this.list();
		if (kept.some(each => each.id === run)) {
			this.write(kept.filter(each => each.id !== run));
		}
	}

	private write(runs: readonly T[]): void {
		this.writeIfOwned(() => {
			if (!runs.length) {
				fs.rmSync(this.file, { force: true });
				return;
			}
			replaceFile(this.file, `${JSON.stringify(runs)}\n`);
		});
	}
}

function isRetained(value: unknown): boolean {
	const run = value as { id?: unknown; name?: unknown; alias?: unknown } | null;
	return !!run && typeof run.id === 'string' && /^run-[0-9a-f]{32}$/.test(run.id) && typeof run.name === 'string' && typeof run.alias === 'string';
}
