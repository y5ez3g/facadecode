/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { LogPort } from '../../core/ports';
import { facadeHome } from '../../record/paths';
import { watchGitDirectory } from './gitEvents';
import { editorNativeGit } from './nativeGit';
import { LocationService } from './service';
import { editorEnvironment, editorFolders, editorGit, editorGitCreationSettings, editorUriOf } from './workspaceFolders';
import { WorktreeService } from './worktrees';

/** The workspace-storage key of what the window last knew of its locations (RULES-2.4). */
const KNOWN_LOCATIONS = 'facade.locations.known';

/**
 * The window's location service wired to the editor (WORKTREES-4.1). `workspaceState` keeps the known locations across
 * extension-host restarts; subscribe to `onDidRemove` right after creating it, as removals found by reconciliation follow.
 */
export function createLocationService(workspaceState: vscode.Memento, log: LogPort): LocationService {
	return new LocationService({
		environment: editorEnvironment(),
		folders: editorFolders(),
		git: editorGit(),
		watch: watchGitDirectory,
		uriOf: editorUriOf,
		known: {
			get: () => workspaceState.get<unknown>(KNOWN_LOCATIONS),
			set: state => {
				workspaceState.update(KNOWN_LOCATIONS, state).then(undefined, err => log.event(`Could not save the known working locations: ${messageOf(err)}`));
			}
		},
		log
	});
}

/**
 * New worktrees for the window's locations (WORKTREES-2), through the editor's Git extension, serialized per destination folder
 * across the environment's windows by locks in its Facade directory.
 */
export function createWorktreeService(locations: LocationService, log: LogPort): WorktreeService {
	return new WorktreeService({ locations, git: editorGit(), native: editorNativeGit(), settings: editorGitCreationSettings(), locks: path.join(facadeHome(), 'locks', 'worktrees'), log });
}
