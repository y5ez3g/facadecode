/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/facadedialog.css';
import { EventHelper } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IButtonStyles } from '../../../../base/browser/ui/button/button.js';
import { IDialogOptions, IDialogStyles } from '../../../../base/browser/ui/dialog/dialog.js';
import { IInputBoxStyles } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultDialogStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable, asCssVariableWithDefault, buttonBorder, foreground, toolbarHoverBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { FACADE_DIALOG_BORDER, FACADE_DIALOG_CONTROL_BORDER } from './facadeDialogColors.js';
import { releaseVersionLabel } from '../../../../platform/product/common/releaseVersion.js';

const defaultDialogAllowableCommands = new Set([
	'workbench.action.quit',
	'workbench.action.reloadWindow',
	'copy',
	'cut',
	'editor.action.selectAll',
	'editor.action.clipboardCopyAction',
	'editor.action.clipboardCutAction',
	'editor.action.clipboardPasteAction'
]);

/**
 * Facade Code: the inputs of a `facade-dialog` (`media/facadedialog.css`) - no fill, and the control
 * border. In code because an input box writes its colours inline.
 */
export const facadeDialogInputBoxStyles: IInputBoxStyles = {
	...defaultInputBoxStyles,
	inputBackground: 'transparent',
	inputBorder: asCssVariable(FACADE_DIALOG_CONTROL_BORDER)
};

/**
 * Facade Code: the buttons of a `facade-dialog`. Only the primary is filled; the rest are outlined
 * with the control border, and on hover take the toolbar's tint, as the close button does.
 */
export const facadeDialogButtonStyles: IButtonStyles = {
	...defaultButtonStyles,
	// A border even when the theme has none, so outlined and filled buttons are the same size.
	buttonBorder: asCssVariableWithDefault(buttonBorder, 'transparent'),
	buttonSecondaryBackground: 'transparent',
	buttonSecondaryHoverBackground: asCssVariable(toolbarHoverBackground),
	buttonSecondaryForeground: asCssVariable(foreground),
	buttonSecondaryBorder: asCssVariable(FACADE_DIALOG_CONTROL_BORDER)
};

/** Facade Code: the box of a `facade-dialog` - no shadow, and a hairline edge. */
const facadeDialogStyles: IDialogStyles = {
	...defaultDialogStyles,
	dialogShadow: undefined,
	dialogBorder: asCssVariable(FACADE_DIALOG_BORDER)
};

export function createWorkbenchDialogOptions(
	options: Partial<IDialogOptions>,
	keybindingService: IKeybindingService,
	layoutService: ILayoutService,
	hostService: IHostService,
	allowableCommands = defaultDialogAllowableCommands,
	shouldPassThroughCommand?: (commandId: string, event: StandardKeyboardEvent) => boolean,
): IDialogOptions {
	// Facade Code: the fork's own dialogs, the confirms among them, are known by their class.
	const facade = !!options.extraClasses?.includes('facade-dialog');

	return {
		keyEventProcessor: (event: StandardKeyboardEvent) => {
			const resolved = keybindingService.softDispatch(event, layoutService.activeContainer);
			if (resolved.kind === ResultKind.KbFound && resolved.commandId) {
				if (!allowableCommands.has(resolved.commandId) && !shouldPassThroughCommand?.(resolved.commandId, event)) {
					EventHelper.stop(event, true);
				}
			}
		},
		buttonStyles: facade ? facadeDialogButtonStyles : defaultButtonStyles,
		checkboxStyles: defaultCheckboxStyles,
		inputBoxStyles: facade ? facadeDialogInputBoxStyles : defaultInputBoxStyles,
		dialogStyles: facade ? facadeDialogStyles : defaultDialogStyles,
		// Facade Code: not for the fork's own dialogs, which dim the window by 10%. The native window
		// controls are dimmed separately, by the host's fixed 50%, and were the darkest thing on screen.
		onVisibilityChange: facade ? undefined : (window, visible) => hostService.setWindowDimmed(window, visible),
		// Facade Code: the primary on the trailing side on Windows as well, in the buttons' own order,
		// and the keyboard through the controls these dialogs put in their bodies.
		primaryButtonLast: facade,
		navigateBody: facade,
		...options,
		// Facade Code: the dim behind the fork's own dialogs is theirs as well (`facade-dialog-block`).
		modalBlockExtraClasses: facade ? [...options.modalBlockExtraClasses ?? [], 'facade-dialog-block'] : options.modalBlockExtraClasses
	};
}

export function createBrowserAboutDialogDetails(productService: IProductService): { title: string; details: string; detailsToCopy: string } {
	const detailString = (useAgo: boolean): string => {
		return localize('aboutDetail',
			"Version: {0}\nCommit: {1}\nDate: {2}\nBrowser: {3}",
			// Facade Code: the release version, the engine's beside it (IDENTITY.md I7)
			productService.version ? releaseVersionLabel(productService) : 'Unknown',
			productService.commit || 'Unknown',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown',
			navigator.userAgent
		);
	};

	const details = detailString(true);
	const detailsToCopy = detailString(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
