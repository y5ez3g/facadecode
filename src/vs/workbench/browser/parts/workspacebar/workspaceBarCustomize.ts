/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, EventHelper, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { createWorkbenchDialogOptions } from '../dialogs/dialog.js';
import { FOLDER_COLORS, FOLDER_ICONS, FolderColor, FolderIcon, IFolderCustomization } from './workspaceBarCustomization.js';

/**
 * Asks for a folder's display name, colour and glyph.
 *
 * ⚠️ One dialog for both, and it is the only way to rename a row - a second, inline way to change the
 * same thing is a second set of edge cases for something people do twice a year.
 */
export async function showCustomizeDialog(
	folder: IWorkspaceFolder,
	current: IFolderCustomization | undefined,
	services: {
		layoutService: IWorkbenchLayoutService;
		keybindingService: IKeybindingService;
		hostService: IHostService;
		contextViewService: IContextViewService;
	}
): Promise<IFolderCustomization | undefined> {
	const disposables = new DisposableStore();

	let name = current?.name ?? '';
	let color: FolderColor | undefined = current?.color;
	let icon: FolderIcon | undefined = current?.icon;

	// ⚠️ The host's own button row, not one built here. Remove Folder goes through
	// `dialogService.confirm`, which builds this row, and it comes out right; a hand-rolled footer for
	// this one dialog put Cancel 450px outside the box and left the two dialogs shaped differently for
	// no reason anybody could name. The host also knows the platform's button order.
	const save = localize('workspaceBar.save', "Save");
	const cancel = localize('workspaceBar.cancel', "Cancel");

	const dialog = disposables.add(new Dialog(
		services.layoutService.activeContainer,
		localize('workspaceBar.customizeTitle', "Customize Folder"),
		[save, cancel],
		createWorkbenchDialogOptions({
			type: 'none',
			// ⚠️ No severity glyph: nothing here is destroyed and nothing is irreversible.
			extraClasses: ['facade-dialog', 'workspacebar-customize'],
			cancelId: 1,
			renderBody: container => {
				container.classList.add('workspacebar-customize-body');

				// --- the name -------------------------------------------------------------------
				append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.displayName', "Display Name")));

				const nameBox = disposables.add(new InputBox(append(container, $('.workspacebar-customize-input')), services.contextViewService, {
					inputBoxStyles: defaultInputBoxStyles,
					// ⚠️ The folder's real name, greyed, so the field shows what leaving it blank gets you
					// without spending a line on it. The line under it is still there for a screen reader,
					// which does not read a placeholder as an answer.
					placeholder: folder.name,
					ariaLabel: localize('workspaceBar.displayNameAria', "Display name for this folder")
				}));
				nameBox.value = name;
				disposables.add(nameBox.onDidChange(value => { name = value; }));

				// ⚠️ The real folder name is said out loud. "Leave blank to use the folder name" makes
				// somebody go and look; naming it answers the question where it was asked. And it is
				// said to be the default, or the name on its own reads as an instruction to type it.
				append(container, $('.workspacebar-customize-hint', undefined,
					localize('workspaceBar.displayNameHint', "Leave blank to use default name ({0}).", folder.name)));

				// --- the colour -----------------------------------------------------------------
				append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.color', "Color")));

				const swatches = append(container, $('.workspacebar-customize-swatches'));
				swatches.setAttribute('role', 'radiogroup');
				swatches.setAttribute('aria-label', localize('workspaceBar.colorAria', "Folder color"));

				const buttons: HTMLElement[] = [];
				const paint = () => {
					for (const button of buttons) {
						const mine = button.dataset.color || undefined;
						const on = mine === color;
						button.classList.toggle('selected', on);
						button.setAttribute('aria-checked', String(on));
						button.tabIndex = on ? 0 : -1;
					}

					// ⚠️ Nothing selected at all cannot happen - "no colour" is a choice like the others -
					// but a list where every `tabIndex` is -1 is a list the keyboard cannot enter.
					if (!buttons.some(button => button.tabIndex === 0) && buttons.length) {
						buttons[0].tabIndex = 0;
					}
				};

				const addSwatch = (value: FolderColor | undefined, label: string) => {
					const button = append(swatches, $('.workspacebar-swatch'));
					button.setAttribute('role', 'radio');
					button.setAttribute('aria-label', label);
					button.title = label;
					if (value) {
						button.dataset.color = value;
						button.classList.add(`workspacebar-swatch-${value}`);
					} else {
						button.classList.add('workspacebar-swatch-none');
					}

					// The tick is a codicon, not a mask over a CSS variable: the icon font is what every
					// other check mark in the workbench is drawn with, and it follows the theme's ink.
					append(button, $(`.workspacebar-swatch-tick${ThemeIcon.asCSSSelector(Codicon.check)}`));
					buttons.push(button);

					disposables.add(addDisposableListener(button, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						color = value;
						paint();
					}));
					disposables.add(addDisposableListener(button, EventType.KEY_DOWN, e => {
						const event = new StandardKeyboardEvent(e);
						if (event.equals(KeyCode.Space) || event.equals(KeyCode.Enter)) {
							EventHelper.stop(e, true);
							color = value;
							paint();
							return;
						}

						const step = event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow) ? 1
							: event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow) ? -1 : 0;
						if (step === 0) {
							return;
						}

						EventHelper.stop(e, true);
						const at = buttons.indexOf(button);
						const next = buttons[(at + step + buttons.length) % buttons.length];
						color = (next.dataset.color as FolderColor | undefined) ?? undefined;
						paint();
						next.focus();
					}));
				};

				addSwatch(undefined, localize('workspaceBar.colorNone', "No color"));
				for (const value of FOLDER_COLORS) {
					addSwatch(value, colorLabel(value));
				}
				paint();

				// --- the glyph ------------------------------------------------------------------
				//
				// ⚠️ A row of its own under the colours, because they are two different questions about
				// the same folder and a single row of twenty-one targets is a row nobody reads.
				//
				// ⚠️ No "no icon" choice to match the colours' "no color": `folder` **is** that choice.
				// It is what an untagged row already draws, so a second way of saying the same thing
				// would be a state that looks identical to another one.
				append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.icon', "Icon")));

				const icons = append(container, $('.workspacebar-customize-icons'));
				icons.setAttribute('role', 'radiogroup');
				icons.setAttribute('aria-label', localize('workspaceBar.iconAria', "Folder icon"));

				const iconButtons: HTMLElement[] = [];
				const paintIcons = () => {
					for (const button of iconButtons) {
						const mine = button.dataset.icon as FolderIcon;
						const on = mine === (icon ?? FOLDER_ICONS[0]);
						button.classList.toggle('selected', on);
						button.setAttribute('aria-checked', String(on));
						button.tabIndex = on ? 0 : -1;
					}

					if (!iconButtons.some(button => button.tabIndex === 0) && iconButtons.length) {
						iconButtons[0].tabIndex = 0;
					}
				};

				const pickIcon = (value: FolderIcon) => {
					// ⚠️ The first one is stored as nothing at all, so a folder that was never customised
					// and one that was set back to a plain folder are the same record rather than two.
					icon = value === FOLDER_ICONS[0] ? undefined : value;
					paintIcons();
				};

				for (const value of FOLDER_ICONS) {
					const button = append(icons, $('.workspacebar-icon-choice'));
					button.setAttribute('role', 'radio');
					button.dataset.icon = value;
					button.title = iconLabel(value);
					button.setAttribute('aria-label', iconLabel(value));
					append(button, $(ThemeIcon.asCSSSelector(ThemeIcon.fromId(value))));
					iconButtons.push(button);

					disposables.add(addDisposableListener(button, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						pickIcon(value);
					}));
					disposables.add(addDisposableListener(button, EventType.KEY_DOWN, e => {
						const event = new StandardKeyboardEvent(e);
						if (event.equals(KeyCode.Space) || event.equals(KeyCode.Enter)) {
							EventHelper.stop(e, true);
							pickIcon(value);
							return;
						}

						const step = event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow) ? 1
							: event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow) ? -1 : 0;
						if (step === 0) {
							return;
						}

						EventHelper.stop(e, true);
						const at = iconButtons.indexOf(button);
						const next = iconButtons[(at + step + iconButtons.length) % iconButtons.length];
						pickIcon(next.dataset.icon as FolderIcon);
						next.focus();
					}));
				}
				paintIcons();

				// The name is what somebody came here to change, so that is what has focus.
				//
				// ⚠️ A tick later, because the host moves focus into the dialog after `renderBody`
				// returns - and through the store, so a dialog dismissed inside that tick does not
				// come back to focus an input that is no longer in the document.
				disposables.add(disposableTimeout(() => { nameBox.focus(); nameBox.select(); }, 0));
			},
				}, services.keybindingService, services.layoutService, services.hostService)
	));

	let chosen: number;
	try {
		chosen = (await dialog.show()).button;
	} finally {
		disposables.dispose();
	}

	if (chosen !== 0) {
		return undefined;
	}

	return { name: name.trim() || undefined, color, icon };
}

function iconLabel(icon: FolderIcon): string {
	switch (icon) {
		case 'folder': return localize('workspaceBar.iconFolder', "Folder");
		case 'rocket': return localize('workspaceBar.iconRocket', "Rocket");
		case 'beaker': return localize('workspaceBar.iconBeaker', "Beaker");
		case 'server': return localize('workspaceBar.iconServer', "Server");
		case 'database': return localize('workspaceBar.iconDatabase', "Database");
		case 'globe': return localize('workspaceBar.iconGlobe', "Globe");
		case 'device-mobile': return localize('workspaceBar.iconDevice', "Device");
		case 'book': return localize('workspaceBar.iconBook', "Book");
		case 'tools': return localize('workspaceBar.iconTools', "Tools");
		case 'package': return localize('workspaceBar.iconPackage', "Package");
	}
}

function colorLabel(color: FolderColor): string {
	switch (color) {
		case 'red': return localize('workspaceBar.colorRed', "Red");
		case 'orange': return localize('workspaceBar.colorOrange', "Orange");
		case 'yellow': return localize('workspaceBar.colorYellow', "Yellow");
		case 'lime': return localize('workspaceBar.colorLime', "Lime");
		case 'green': return localize('workspaceBar.colorGreen', "Green");
		case 'teal': return localize('workspaceBar.colorTeal', "Teal");
		case 'blue': return localize('workspaceBar.colorBlue', "Blue");
		case 'indigo': return localize('workspaceBar.colorIndigo', "Indigo");
		case 'purple': return localize('workspaceBar.colorPurple', "Purple");
		case 'pink': return localize('workspaceBar.colorPink', "Pink");
	}
}
