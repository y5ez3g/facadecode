/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IPutAwayEditorsService } from '../common/putAwayEditors.js';

const STORAGE_KEY = 'workbench.putAwayEditors';

export class PutAwayEditorsService extends Disposable implements IPutAwayEditorsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly held: ResourceMap<readonly URI[]>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();

		this.held = new ResourceMap<readonly URI[]>(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.load();
	}

	set(folder: URI, resources: readonly URI[]): void {
		const before = this.held.get(folder) ?? [];
		if (before.length === resources.length && before.every((resource, i) => this.uriIdentityService.extUri.isEqual(resource, resources[i]))) {
			return;
		}

		if (resources.length) {
			this.held.set(folder, [...resources]);
		} else {
			this.held.delete(folder);
		}

		this.save();
		this._onDidChange.fire();
	}

	get(folder: URI): readonly URI[] {
		return this.held.get(folder) ?? [];
	}

	folders(): readonly URI[] {
		return [...this.held.keys()];
	}

	isPutAway(resource: URI): boolean {
		for (const resources of this.held.values()) {
			if (resources.some(candidate => this.uriIdentityService.extUri.isEqual(candidate, resource))) {
				return true;
			}
		}

		return false;
	}

	private load(): void {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			for (const [folder, resources] of raw ? JSON.parse(raw) as [string, string[]][] : []) {
				this.held.set(URI.parse(folder), resources.map(resource => URI.parse(resource)));
			}
		} catch {
			// A corrupt value costs where they were put away: the backups themselves come back with the window.
			this.held.clear();
		}
	}

	private save(): void {
		const value = [...this.held].map(([folder, resources]) => [folder.toString(), resources.map(resource => resource.toString())]);
		if (value.length) {
			this.storageService.store(STORAGE_KEY, JSON.stringify(value), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

registerSingleton(IPutAwayEditorsService, PutAwayEditorsService, InstantiationType.Delayed);
