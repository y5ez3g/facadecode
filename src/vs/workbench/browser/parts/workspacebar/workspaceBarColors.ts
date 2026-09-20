/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_BORDER, SIDE_BAR_FOREGROUND, SIDE_BAR_TITLE_FOREGROUND } from '../../../common/theme.js';

/**
 * The bar's own colours: the side bar's, taken whole.
 *
 * ⚠️ The side bar's, because that is what is next to it - the activity bar has moved into the title
 * bar, so `EXPLORER` and its rows are what a reader compares these rows to, eight pixels away.
 *
 * ⚠️ Taken whole. The background, the ink and the title ink are one set the theme tuned together,
 * and nothing here is derived from them: a bar that derives its own ink has to re-answer, for every
 * theme, a question the theme already answered. So a row's name is not styled by this bar at all -
 * it inherits, which is what the explorer's rows do, which is why the two come out the same.
 */
export const FACADE_BAR_BACKGROUND = registerColor('facadeBar.background',
	SIDE_BAR_BACKGROUND,
	localize('facadeBarBackground', "Background colour of the workspace bar, the column of folders along the left edge of the window."));

export const FACADE_BAR_FOREGROUND = registerColor('facadeBar.foreground',
	SIDE_BAR_FOREGROUND,
	localize('facadeBarForeground', "Foreground colour of the workspace bar."));

export const FACADE_BAR_TITLE_FOREGROUND = registerColor('facadeBar.titleForeground',
	SIDE_BAR_TITLE_FOREGROUND,
	localize('facadeBarTitleForeground', "Foreground colour of the workspace bar's header."));

export const FACADE_BAR_BORDER = registerColor('facadeBar.border',
	SIDE_BAR_BORDER,
	localize('facadeBarBorder', "Border colour separating the workspace bar from what is beside it."));
