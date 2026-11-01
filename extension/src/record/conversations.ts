/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';

interface Key {
	readonly environment: string;
	readonly cli: string;
	readonly sessionId: string;
}

interface Meta {
	readonly location?: string;
	readonly cwd: string;
	readonly name: string;
}

/**
 * Facade's own conversations - their place and name - kept in the execution environment's Facade directory so
 * Resume and Pin restore them, pinned or not (RULES-4.2, ARCHITECTURE-3.1). Message expiry never touches it.
 */
export class ConversationFile {
	private readonly dir: string;

	constructor(home: string) {
		this.dir = path.join(home, 'conversations');
		fs.mkdirSync(this.dir, { recursive: true });
	}

	get(key: Key): Meta | undefined {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(this.fileOf(key), 'utf8'));
			return isJsonObject(value) && typeof value.name === 'string' && typeof value.cwd === 'string' && path.isAbsolute(value.cwd)
				&& (value.location === undefined || typeof value.location === 'string') ? value as unknown as Meta : undefined;
		} catch { return undefined; }
	}

	put(key: Key, meta: Meta): void {
		// Different windows save different conversations independently, without a shared read/modify/write race.
		replaceFile(this.fileOf(key), `${JSON.stringify(meta)}\n`);
	}

	private fileOf(key: Key): string {
		return path.join(this.dir, `${createHash('sha256').update(idOf(key)).digest('hex')}.json`);
	}
}

function idOf(key: Key): string {
	return `${key.environment}\u0000${key.cli}\u0000${key.sessionId}`;
}
