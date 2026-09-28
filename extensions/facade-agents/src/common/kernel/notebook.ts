/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/*
 * The notebook's pages on disk: one Markdown file per page under `notes/`, `p1/plan` at
 * `notes/p1/plan.md`. Plain files, so the person opens them in the editor and an agent may `cat`
 * them. Versions and authors live in the ledger; the files hold only the text.
 */

export const NOTES_DIR = 'notes';
const EXTENSION = '.md';

export function pageFile(notesDir: string, page: string): string {
	return path.join(notesDir, ...page.split('/')) + EXTENSION;
}

export function hashText(text: string): string {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The page's text, or undefined when it has no file. */
export function readPageFile(notesDir: string, page: string): string | undefined {
	try {
		return fs.readFileSync(pageFile(notesDir, page), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
			return undefined;
		}
		throw err;
	}
}

/** Writes a page's file whole, so a reader never sees half of it. */
export function writePageFile(notesDir: string, page: string, text: string): void {
	const file = pageFile(notesDir, page);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(temp, text, { mode: 0o600 });
	try {
		fs.renameSync(temp, file);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}

/** Removes a page's file and the folders it leaves empty. */
export function removePageFile(notesDir: string, page: string): void {
	const file = pageFile(notesDir, page);
	fs.rmSync(file, { force: true });
	let dir = path.dirname(file);
	while (dir.length > notesDir.length && dir.startsWith(notesDir)) {
		try {
			fs.rmdirSync(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

/** Every page that has a file, by path. Temporary files of a write in progress are not pages. */
export function listPageFiles(notesDir: string): string[] {
	const pages: string[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
			} else if (entry.isFile() && entry.name.endsWith(EXTENSION) && !entry.name.endsWith(`.tmp${EXTENSION}`)) {
				pages.push(`${prefix}${entry.name.slice(0, -EXTENSION.length)}`);
			}
		}
	};
	walk(notesDir, '');
	return pages;
}
