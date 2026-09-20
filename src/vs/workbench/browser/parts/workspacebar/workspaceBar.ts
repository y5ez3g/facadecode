/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError } from '../../../../base/common/json.js';
import { basename, dirname, IExtUri, isEqual, joinPath } from '../../../../base/common/resources.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { isStoredWorkspaceFolder, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';

/**
 * Whether two paths name one folder. ⚠️ Not `uri.toString()`: a file system that ignores case gives
 * every directory a family of spellings. `canonicalUri` handles symlinks, this the rest.
 */
export type FolderKey = (uri: URI) => string;

export function folderKey(uriIdentityService: IUriIdentityService, uri: URI): string {
	return uriIdentityService.extUri.getComparisonKey(uri);
}

/** Deep enough for any path, and a stop if a file system answers a parent with itself. */
const MAX_CANONICAL_DEPTH = 32;

/**
 * One spelling per directory, resolved once when a folder enters the workspace.
 *
 * ⚠️ On macOS `/tmp` is a symlink to `/private/tmp`, so the folder the window was opened with and
 * the same folder picked from a dialog arrive under different names.
 *
 * ⚠️ Resolved from the nearest ancestor that does exist, not abandoned when the folder itself does
 * not. A `.code-workspace` can list folders nobody has cloned yet; taking the spelling those arrived
 * with leaves a row that stops matching the moment the folder appears, and adding it again makes a
 * second row for one directory.
 */
export async function canonicalUri(fileService: IFileService, uri: URI): Promise<URI> {
	const missing: string[] = [];
	let candidate = uri;

	for (let depth = 0; depth < MAX_CANONICAL_DEPTH; depth++) {
		try {
			const real = await fileService.realpath(candidate);
			if (real) {
				return missing.length ? joinPath(real, ...missing.reverse()) : real;
			}
		} catch {
			// Not there, or a file system that cannot answer. Either way, try its parent.
		}

		const parent = dirname(candidate);
		if (isEqual(parent, candidate)) {
			break;	// the root, and it did not answer either
		}

		missing.push(basename(candidate));
		candidate = parent;
	}

	// Nothing on the way up could be resolved. The uri as given still makes a row, and a folder that
	// is gone shows as one that is gone.
	return uri;
}

/**
 * The folders a `.code-workspace` lists, resolved against where the file is. ⚠️ Read, never entered:
 * entering replaces this window's workspace identity, which every folder's editors are stored
 * under. Throws rather than answering with an empty list, so the caller can open the file instead.
 */
export function foldersInWorkspaceFile(contents: string, resource: URI, extUri: IExtUri): URI[] {
	const errors: ParseError[] = [];
	const stored: { folders?: unknown } | undefined = parse(contents, errors);
	if (errors.length || !isObject(stored) || !Array.isArray(stored.folders)) {
		throw new Error(`Not a workspace file: ${resource.toString(true)}`);
	}

	return toWorkspaceFolders(stored.folders.filter(isStoredWorkspaceFolder), resource, extUri).map(folder => folder.uri);
}

/**
 * `text` as a markdown code span. ⚠️ Not `escapeMarkdownSyntaxTokens`: inside a span a backslash is
 * a literal, so escaping there prints them - `ios_app` renders as `ios\_app`. Only a backtick ends
 * a span, and it is carried by a longer fence.
 */
export function asCodeSpan(text: string): string {
	const longestRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
	const fence = '`'.repeat(longestRun + 1);

	// A span drops one leading and one trailing space when it has both, which is how a backtick is
	// kept off the fence.
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';

	return `${fence}${pad}${text}${pad}${fence}`;
}

