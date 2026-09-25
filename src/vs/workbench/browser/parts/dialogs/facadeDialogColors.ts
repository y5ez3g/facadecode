/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { contrastBorder, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { registerColor, transparent } from '../../../../platform/theme/common/colorUtils.js';

/*
 * The colours of the product's own dialogs (`facade-dialog`, `media/facadedialog.css`): strokes and a
 * band off the foreground, so they stand the same step from the dialog in light and dark themes, and
 * the contrast border in high contrast. Not `widget.border` or `input.border`: themes draw those next
 * to a fill, and these controls have none.
 */

export const FACADE_DIALOG_BORDER = registerColor('facadeDialog.border',
	{ dark: transparent(foreground, 0.1), light: transparent(foreground, 0.1), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('facadeDialogBorder', "Border color of the product's own dialogs."));

export const FACADE_DIALOG_DIVIDER = registerColor('facadeDialog.divider',
	{ dark: transparent(foreground, 0.15), light: transparent(foreground, 0.15), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('facadeDialogDivider', "Color of the lines inside the product's own dialogs: above the buttons, and around a notice."));

export const FACADE_DIALOG_CONTROL_BORDER = registerColor('facadeDialog.controlBorder',
	{ dark: transparent(foreground, 0.2), light: transparent(foreground, 0.2), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('facadeDialogControlBorder', "Border color of the inputs, outlined buttons and choices in the product's own dialogs."));

export const FACADE_DIALOG_FOOTER_BACKGROUND = registerColor('facadeDialog.footerBackground',
	{ dark: transparent(foreground, 0.04), light: transparent(foreground, 0.04), hcDark: null, hcLight: null },
	localize('facadeDialogFooterBackground', "Background color of the band the buttons of the product's own dialogs sit on."));
