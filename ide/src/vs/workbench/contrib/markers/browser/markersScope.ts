/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IMarker, IMarkerService, MarkerSeverity, MarkerStatistics } from '../../../../platform/markers/common/markers.js';
import { FolderScope, IFolderScopeService } from '../../../services/folderScope/common/folderScope.js';

/** How many problems the window shows: counted in the active folder, or the marker service's own statistics when widened. */
export function scopedMarkerStatistics(markerService: IMarkerService, folderScopeService: IFolderScopeService): MarkerStatistics {
	if (folderScopeService.scope === FolderScope.Workspace) {
		return markerService.getStatistics();
	}

	const statistics: MarkerStatistics = { errors: 0, warnings: 0, infos: 0, unknowns: 0 };
	for (const marker of markerService.read()) {
		if (!folderScopeService.covers(marker.resource)) {
			continue;
		}

		switch (marker.severity) {
			case MarkerSeverity.Error: statistics.errors++; break;
			case MarkerSeverity.Warning: statistics.warnings++; break;
			case MarkerSeverity.Info: statistics.infos++; break;
			default: statistics.unknowns++; break;
		}
	}

	return statistics;
}

/** The problems the window lists, narrowed here rather than in the marker service that extensions read too. */
export function scopedMarkers(markerService: IMarkerService, folderScopeService: IFolderScopeService, resource?: URI): IMarker[] {
	return markerService
		.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info })
		.filter(marker => folderScopeService.covers(marker.resource));
}
