/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { withFileLock } from '../base/lock';
import { facadeHome } from './paths';

/**
 * `#aN` aliases from one counter per execution environment, never reused (RULES-2.2): every window of this environment draws
 * from it under a lock.
 */
export class AliasCounter {
	private readonly file: string;

	constructor(home: string = facadeHome()) {
		fs.mkdirSync(home, { recursive: true });
		this.file = path.join(home, 'agent-aliases.json');
	}

	next(): string {
		const n = withFileLock(this.file, () => {
			let last = 0;
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
				last = typeof (parsed as { last?: unknown }).last === 'number' ? (parsed as { last: number }).last : 0;
			} catch {
				last = 0;
			}
			replaceFile(this.file, `${JSON.stringify({ last: last + 1 })}\n`);
			return last + 1;
		});
		return `#a${n}`;
	}
}
