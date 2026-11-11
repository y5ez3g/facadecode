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

	/**
	 * Records the entry `cli` that started the conversation `sessionId` of the built-in store `store` (CONFIGURATION-3.4), so that it
	 * is found by the store's conversation alone, as Resume reads stores.
	 */
	associate(environment: string, store: string, sessionId: string, cli: string): void {
		replaceFile(this.associationOf(environment, store, sessionId), `${JSON.stringify({ cli })}\n`);
	}

	/** The entry that started the conversation `sessionId` of the store `store`, where Facade recorded one (CONFIGURATION-3.4). */
	associated(environment: string, store: string, sessionId: string): string | undefined {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(this.associationOf(environment, store, sessionId), 'utf8'));
			return isJsonObject(value) && typeof value.cli === 'string' && value.cli ? value.cli : undefined;
		} catch { return undefined; }
	}

	private fileOf(key: Key): string {
		return path.join(this.dir, `${createHash('sha256').update(idOf(key)).digest('hex')}.json`);
	}

	private associationOf(environment: string, store: string, sessionId: string): string {
		return path.join(this.dir, `${createHash('sha256').update(`store\u0000${environment}\u0000${store}\u0000${sessionId}`).digest('hex')}.store.json`);
	}
}

function idOf(key: Key): string {
	return `${key.environment}\u0000${key.cli}\u0000${key.sessionId}`;
}
