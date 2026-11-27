/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { DaemonOperations } from '../../base/frameworkProtocol';
import { messageOf } from '../../base/errors';
import { folderKeyOf, isEqualPath } from '../../base/files';
import type { Catalog, Disposable, Event, Location, LocationId, LocationPort, LocationRemoval, LogPort, WorkspaceFolderInfo } from '../../core/ports';
import { editorUriOf } from '../locations/workspaceFolders';

type LocationListArgs = DaemonOperations['location.list']['args'];
type LocationListResult = DaemonOperations['location.list']['result'];

interface LocationOptions {
	readonly folders: () => readonly WorkspaceFolderInfo[];
	readonly onDidChangeFolders: Event<void>;
	readonly list: (args: LocationListArgs) => Promise<LocationListResult>;
	readonly log: LogPort;
}

/** Facade Code Framework's locations for this workspace, associated with their source roots (RULES-6.5). */
export class FrameworkLocations implements LocationPort, Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly removed = new vscode.EventEmitter<LocationRemoval>();
	readonly onDidChange = this.changed.event;
	readonly onDidRemove = this.removed.event;
	private readonly subscription: Disposable;
	private readonly removals = new Map<LocationId, LocationRemoval['cause']>();
	private rows: LocationListResult['locations'] = [];
	private pending?: Promise<void>;
	private catalog: Catalog;

	constructor(private readonly options: LocationOptions) {
		this.catalog = { folders: options.folders(), locations: [], pending: false };
		this.subscription = options.onDidChangeFolders(() => {
			void this.refresh().catch(error => options.log.event(`Could not refresh the working locations: ${messageOf(error)}`));
		});
	}

	snapshot(): Catalog {
		return this.catalog;
	}

	resolve(id: LocationId): Location | undefined {
		return this.catalog.locations.find(location => location.id === id);
	}

	locationAt(directory: string): Location | undefined {
		const key = folderKeyOf(directory);
		return this.catalog.locations.find(location => isEqualPath(location.path, key));
	}

	removalOf(id: LocationId): LocationRemoval['cause'] | undefined {
		return this.removals.get(id);
	}

	refresh(): Promise<void> {
		const folders = this.options.folders();
		if (!folders.length) {
			this.rows = [];
			this.pending = undefined;
			this.publish(folders, false);
			return Promise.resolve();
		}
		const request: Promise<void> = Promise.resolve().then(async () => {
			try {
				const rows = await this.readLocations(folders);
				if (this.pending === request) {
					this.rows = rows;
				}
			} catch (error) {
				if (this.pending === request) { throw error; }
			} finally {
				// A folder change can supersede a read before it returns.
				if (this.pending === request) {
					this.pending = undefined;
					this.publish(folders, false);
				}
			}
			// Callers resolving a path after refresh need the catalog published by any superseding read.
			await this.pending;
		});
		this.pending = request;
		this.publish(folders, true);
		return request;
	}

	private async readLocations(folders: readonly WorkspaceFolderInfo[]): Promise<LocationListResult['locations']> {
		try {
			return (await this.options.list({ folders: folders.map(folder => folder.path) })).locations;
		} catch (error) {
			if (folders.length === 1) { throw error; }
			const results = await Promise.allSettled(folders.map(folder => this.options.list({ folders: [folder.path] })));
			if (results.every(result => result.status === 'rejected')) { throw error; }
			return results.flatMap((result, index) => {
				if (result.status === 'fulfilled') { return result.value.locations; }
				this.options.log.event(`Could not read working locations for ${folders[index].path}: ${messageOf(result.reason)}`);
				return [];
			});
		}
	}

	dispose(): void {
		this.pending = undefined;
		this.subscription.dispose();
		this.changed.dispose();
		this.removed.dispose();
	}

	private publish(folders: readonly WorkspaceFolderInfo[], pending: boolean): void {
		const locations = locationsOf(folders, this.rows);
		const before = this.catalog.locations;
		this.catalog = { folders, locations, pending };
		const present = new Set(locations.map(location => location.id));
		for (const id of present) {
			this.removals.delete(id);
		}
		const folderUris = new Set(folders.map(folder => folder.uri));
		const gone: Record<LocationRemoval['cause'], LocationId[]> = { folder: [], deleted: [] };
		for (const location of before) {
			if (!present.has(location.id)) {
				const cause = location.folders.some(folder => folderUris.has(folder.uri)) ? 'deleted' : 'folder';
				gone[cause].push(location.id);
				this.removals.set(location.id, cause);
			}
		}
		for (const cause of ['folder', 'deleted'] as const) {
			if (gone[cause].length) {
				this.removed.fire({ ids: gone[cause], cause });
			}
		}
		this.changed.fire();
	}
}

/** Recent successful New Agent destinations in this workspace, independently keyed by machine identity (LIFECYCLE-5.1). */
export class LaunchLocationHistory {
	constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>, private readonly log: LogPort) { }

	recent(machine: string): readonly string[] {
		const value = this.state.get<unknown>(this.key(machine));
		return Array.isArray(value) ? value.filter((folder): folder is string => typeof folder === 'string' && folder.length > 0) : [];
	}

	remember(machine: string, folder: string): void {
		const failed = (error: unknown) => this.log.event(`Could not save the last launch directory: ${messageOf(error)}`);
		try {
			const history = [folder, ...this.recent(machine).filter(previous => previous !== folder)].slice(0, 20);
			void Promise.resolve(this.state.update(this.key(machine), history)).catch(failed);
		} catch (error) {
			failed(error);
		}
	}

	private key(machine: string): string {
		return `facade.orchestrator.launchLocations.${machine}`;
	}
}

function locationsOf(folders: readonly WorkspaceFolderInfo[], rows: LocationListResult['locations']): Location[] {
	const sources = new Map<LocationId, { row: LocationListResult['locations'][number]; folders: WorkspaceFolderInfo[] }>();
	const folderKeys = folders.map(folder => ({ folder, key: folderKeyOf(folder.path) }));
	for (const { folder } of folderKeys) {
		for (const row of rows) {
			if (row.source_folder === undefined || !isEqualPath(row.source_folder, folder.path)) {
				continue;
			}
			const previous = sources.get(row.location_id);
			if (!previous) {
				sources.set(row.location_id, { row, folders: [folder] });
			} else if (previous.folders.at(-1) !== folder) {
				previous.folders.push(folder);
			}
		}
	}
	return Array.from(sources.values(), ({ row, folders }): Location => {
		const opened = folderKeys.find(each => folders.includes(each.folder) && isEqualPath(row.path, each.key))?.folder;
		return {
			id: row.location_id, path: row.path, uri: opened?.uri ?? editorUriOf(folders[0].uri, row.path),
			environment: 'local', label: row.label, folders, kind: row.kind === 'folder' ? 'folder' : 'checkout',
			isMain: row.kind === 'main' || undefined, opened: opened !== undefined, git: row.kind === 'folder' ? 'none' : 'ok'
		};
	});
}
