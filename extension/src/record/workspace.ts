/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';
import { facadeHome } from './paths';

/**
 * A workspace's folder in the execution environment's Facade directory (ARCHITECTURE-3.1): keyed by the workspace's URI, so
 * every window of the same workspace shares it and finds its runs again after a reload. The key is the one the workspace kept
 * where it has one (ARCHITECTURE-2.2, D65): a folder window that became a multi-root workspace keeps the folder's.
 */
/** A workspace key as `workspaceRecord` makes it. */
const WORKSPACE_KEY = /^[0-9a-f]{16}$/;

export interface WorkspaceRecord {
	/** The key ptyd claims runs under. */
	readonly key: string;
	readonly dir: string;
	/** What resolution observed; a later registration cannot overwrite a concurrent move or binding. */
	readonly binding: { readonly uri: string; readonly key?: string; readonly previousUri?: string };
	/** Handover validated against the same ledger snapshot used for URI resolution. */
	readonly handedOver?: string;
	/**
	 * A window without folders: it starts no agent (RULES-2.1), and its URI - `untitled:` with its session, a new one each - is kept in
	 * no ledger, which would grow by one at each such window and reload (RULES-5.3).
	 */
	readonly folderless?: true;
}

interface WorkspaceUris {
	readonly version: 1;
	readonly bindings: Record<string, string>;
	/** Retains moved/displaced keys, so an old Memento or the original URI hash cannot reuse them. */
	readonly owners: Record<string, string>;
}

function normalizedUri(uri: string): string {
	const value = uri.replace(/\/+$/, '');
	return process.platform === 'linux' ? value : value.toLowerCase();
}

function uriFile(home: string): string {
	return path.join(home, 'workspace-uris.json');
}

function readUris(home: string): WorkspaceUris {
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(uriFile(home), 'utf8')) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { version: 1, bindings: {}, owners: {} };
		}
		throw error;
	}
	if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.bindings) || !isJsonObject(value.owners)
		|| Object.entries(value.owners).some(([key, uri]) => !WORKSPACE_KEY.test(key) || typeof uri !== 'string' || !uri || normalizedUri(uri) !== uri)
		|| Object.entries(value.bindings).some(([uri, key]) => !uri || normalizedUri(uri) !== uri || typeof key !== 'string'
			|| !WORKSPACE_KEY.test(key) || (value.owners as Record<string, unknown>)[key] !== uri)) {
		throw new Error('Invalid workspace URI ownership record.');
	}
	return value as unknown as WorkspaceUris;
}

function validKey(value: unknown): value is string {
	return typeof value === 'string' && WORKSPACE_KEY.test(value);
}

function hashKey(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Proven same-window handover, then exact URI binding, then a still-valid kept key, then a new URI key. */
export function workspaceRecord(workspaceUri: string, home: string = facadeHome(), kept?: unknown, window?: { readonly token: string; readonly folders: readonly string[] }): WorkspaceRecord {
	const uri = normalizedUri(workspaceUri);
	const state = readUris(home);
	const handedOver = window && windowKey(state, window.token, window.folders, home, uri);
	const usableKept = validKey(kept) && (state.owners[kept] === undefined || (state.owners[kept] === uri && state.bindings[uri] === kept));
	let key = validKey(handedOver) ? handedOver : state.bindings[uri] ?? (usableKept ? kept : hashKey(uri));
	if (!validKey(handedOver) && state.bindings[uri] === undefined && !usableKept) {
		// The original folder's hash may now name runs moved to a saved workspace. Reopening that folder starts separately.
		while (state.owners[key] !== undefined) {
			key = hashKey(`${uri}\0${key}`);
		}
	}
	const dir = path.join(home, 'workspaces', key);
	fs.mkdirSync(dir, { recursive: true });
	const identity = path.join(dir, 'identity.json');
	if (!fs.existsSync(identity)) {
		replaceFile(identity, `${JSON.stringify({ workspace: workspaceUri }, undefined, '\t')}\n`);
	}
	return { key, dir, binding: { uri, key: state.bindings[uri], previousUri: state.owners[key] }, handedOver, ...window && !window.folders.length ? { folderless: true } : {} };
}

/**
 * Called inside this activation's writeAsOwner fence. One atomic ledger moves A's binding to B on Save As; A's old local
 * state cannot recover B's runs. The former key remains reserved, including when another owner replaces its destination.
 */
export function keepWorkspaceUri(workspaceUri: string, record: WorkspaceRecord, home: string = facadeHome()): void {
	const uri = normalizedUri(workspaceUri);
	if (record.binding.uri !== uri || !validKey(record.key)) {
		throw new Error('Workspace URI registration does not match its resolved identity.');
	}
	if (record.folderless) {
		return;
	}
	const file = uriFile(home);
	withFileLock(file, () => {
		const state = readUris(home);
		if (state.bindings[uri] === record.key && state.owners[record.key] === uri) {
			return;
		}
		if (state.bindings[uri] !== record.binding.key || state.owners[record.key] !== record.binding.previousUri) {
			throw new Error('Workspace URI ownership changed before this window could register it.');
		}
		const previous = state.owners[record.key];
		if (previous !== undefined && state.bindings[previous] === record.key) {
			delete state.bindings[previous];
		}
		state.bindings[uri] = record.key;
		state.owners[record.key] = uri;
		replaceFile(file, `${JSON.stringify(state)}\n`);
	}, { keepLive: true });
}

/** How long a window's handover record is kept in the execution environment. */
const WINDOW_RECORD_MS = 30 * 24 * 60 * 60_000;

/** What a window said of the runs it claims (ARCHITECTURE-2.2, D70): their workspace key and the folders it had then. */
/** The identity comes from the local window component, including when the execution component runs remotely. */
function windowFile(home: string, window: string): string {
	return path.join(home, 'windows', `${crypto.createHash('sha256').update(window).digest('hex').slice(0, 16)}.json`);
}

/**
 * The workspace key this window claimed its runs under before its extensions restarted - a folder window becoming a multi-root
 * workspace, or Save Workspace As, without carrying the extension's workspace state (D70) - where it still has
 * the folder it had first then. None in a window that said nothing yet, or whose folders are others now.
 */
function windowKey(state: WorkspaceUris, window: string, folders: readonly string[], home: string, workspaceUri?: string): string | undefined {
	let said: unknown;
	try {
		said = JSON.parse(fs.readFileSync(windowFile(home, window), 'utf8')) as unknown;
	} catch {
		return undefined;
	}
	if (!isJsonObject(said)) {
		return undefined;
	}
	const first = Array.isArray(said.folders) ? said.folders[0] : undefined;
	if (!validKey(said.key) || typeof first !== 'string' || !folders.includes(first)) {
		return undefined;
	}
	if (workspaceUri !== undefined) {
		const uri = normalizedUri(workspaceUri);
		const previous = typeof said.uri === 'string' ? normalizedUri(said.uri) : undefined;
		if (previous !== undefined && state.owners[said.key] !== undefined) {
			// A stale window cannot move or reclaim runs after another window moved/replaced its previous URI binding.
			if (state.owners[said.key] !== previous || state.bindings[previous] !== said.key) {
				return undefined;
			}
		} else if ((state.owners[said.key] !== undefined && (state.owners[said.key] !== uri || state.bindings[uri] !== said.key))
			|| (state.bindings[uri] !== undefined && state.bindings[uri] !== said.key)) {
			// A pre-ledger window record has no proof that it is moving an existing binding to this URI.
			return undefined;
		}
	}
	return said.key;
}

/** Says that this window, with `folders`, claims its runs under `key`; records older than a month go. */
export function keepWindowKey(window: string, key: string, folders: readonly string[], home: string = facadeHome(), now = Date.now(), workspaceUri?: string): void {
	const dir = path.join(home, 'windows');
	fs.mkdirSync(dir, { recursive: true });
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name);
		try {
			if (now - fs.statSync(file).mtimeMs > WINDOW_RECORD_MS) {
				fs.rmSync(file, { force: true });
			}
		} catch {
			// Gone already
		}
	}
	replaceFile(windowFile(home, window), `${JSON.stringify({ key, folders, at: now, ...(workspaceUri !== undefined ? { uri: normalizedUri(workspaceUri) } : {}) })}\n`);
}
