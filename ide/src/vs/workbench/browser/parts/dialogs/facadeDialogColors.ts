/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { localize } from '../../../../nls.js';
import { contrastBorder, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { registerColor, transparent } from '../../../../platform/theme/common/colorUtils.js';

// Colours for the parts of a `facade-dialog` frame VS Code has none for, as steps off the foreground

export const FACADE_DIALOG_BORDER = registerColor('facadeDialog.border',
	{ dark: transparent(foreground, 0.1), light: transparent(foreground, 0.1), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('facadeDialogBorder', "Border color in Facade dialogs: the dialog outline, the separator above the buttons, and notice boxes."));

export const FACADE_DIALOG_CONTROL_BORDER = registerColor('facadeDialog.controlBorder',
	{ dark: transparent(foreground, 0.2), light: transparent(foreground, 0.2), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('facadeDialogControlBorder', "Border color of icon selectors and color reset buttons in Facade dialogs."));

/* A fill in dark themes only, as shadcn's `dark:bg-input/30`: on a light dialog the choices are its own white. */
export const FACADE_DIALOG_CONTROL_BACKGROUND = registerColor('facadeDialog.controlBackground',
	{ dark: transparent(foreground, 0.06), light: Color.transparent, hcDark: Color.transparent, hcLight: Color.transparent },
	localize('facadeDialogControlBackground', "Background color of icon selectors in Facade dialogs."));

export const FACADE_DIALOG_FOOTER_BACKGROUND = registerColor('facadeDialog.footerBackground',
	{ dark: transparent(foreground, 0.04), light: transparent(foreground, 0.04), hcDark: null, hcLight: null },
	localize('facadeDialogFooterBackground', "Background color of the footer button area in Facade dialogs."));
