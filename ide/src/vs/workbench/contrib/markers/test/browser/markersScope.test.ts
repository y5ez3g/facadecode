/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarkerData, MarkerSeverity, MarkerStatistics } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { FolderScope, IFolderScopeService } from '../../../../services/folderScope/common/folderScope.js';
import { scopedMarkers, scopedMarkerStatistics } from '../../browser/markersScope.js';

suite('Markers - what the window is looking at', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const marker = (severity: MarkerSeverity, message: string): IMarkerData => ({ severity, message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 });

	/** The window on `folder`, narrowed to it, or widened to every folder. */
	const scope = (folder: string, widened = false) => ({
		scope: widened ? FolderScope.Workspace : FolderScope.Folder,
		covers: (resource: URI) => widened || resource.path.startsWith(folder)
	}) as unknown as IFolderScopeService;

	/** The four counts, without whatever else the object answering them carries. */
	const counts = ({ errors, warnings, infos, unknowns }: MarkerStatistics) => ({ errors, warnings, infos, unknowns });

	/** One problem in `api` and two in `web`, once the service has notified its listeners. */
	async function markersInTwoFolders(): Promise<MarkerService> {
		const markerService = disposables.add(new MarkerService());
		const told = Event.toPromise(markerService.onMarkerChanged);
		markerService.changeOne('test', URI.file('/w/api/index.ts'), [marker(MarkerSeverity.Error, 'api')]);
		markerService.changeOne('test', URI.file('/w/web/app.ts'), [marker(MarkerSeverity.Warning, 'web'), marker(MarkerSeverity.Error, 'web too')]);
		await told;
		return markerService;
	}

	test('WS-26 Problems counts what the window is looking at - the folder it is on, or every folder once widened - and nothing is taken out of the marker service', async () => {
		const markerService = await markersInTwoFolders();

		assert.deepStrictEqual({
			onApi: counts(scopedMarkerStatistics(markerService, scope('/w/api/'))),
			onWeb: counts(scopedMarkerStatistics(markerService, scope('/w/web/'))),
			widened: counts(scopedMarkerStatistics(markerService, scope('/w/api/', true))),
			stillHeld: markerService.read().length
		}, {
			onApi: { errors: 1, warnings: 0, infos: 0, unknowns: 0 },
			onWeb: { errors: 1, warnings: 1, infos: 0, unknowns: 0 },
			widened: { errors: 2, warnings: 1, infos: 0, unknowns: 0 },
			stillHeld: 3
		});
	});

	test('WS-26 and lists the same: a file in a folder the window is not on lists nothing, though its problems are still held', async () => {
		const markerService = await markersInTwoFolders();
		const listed = (folderScope: IFolderScopeService, resource?: URI) => scopedMarkers(markerService, folderScope, resource).map(marker => marker.message);

		assert.deepStrictEqual({
			onApi: listed(scope('/w/api/')),
			onWeb: listed(scope('/w/web/')),
			widened: listed(scope('/w/api/', true)),
			webFileFromApi: listed(scope('/w/api/'), URI.file('/w/web/app.ts')),
			stillHeld: markerService.read().length
		}, {
			onApi: ['api'],
			onWeb: ['web', 'web too'],
			widened: ['api', 'web', 'web too'],
			webFileFromApi: [],
			stillHeld: 3
		});
	});
});
