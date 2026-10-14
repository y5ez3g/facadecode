/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, EventHelper, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { alert } from '../../../../base/browser/ui/aria/aria.js';
import { IButton } from '../../../../base/browser/ui/button/button.js';
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
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { createWorkbenchDialogOptions } from '../dialogs/dialog.js';
import { FOLDER_COLORS, FOLDER_ICONS, FolderColor, FolderIcon, IFolderCustomization } from './workspaceBarCustomization.js';

interface IDialogServices {
	readonly layoutService: IWorkbenchLayoutService;
	readonly keybindingService: IKeybindingService;
	readonly hostService: IHostService;
	readonly contextViewService: IContextViewService;
	readonly hoverService: IHoverService;
}

/** What the New Worktree dialog says under the branch as it is typed, and whether it can be made. */
export interface IBranchDescription {
	readonly message: string;
	readonly valid: boolean;
	/** Said as an error: a name that cannot be made, rather than where it would go. */
	readonly error?: boolean;
}

/**
 * What has to happen to the folder first, when it has no commit to start from (WORKTREE.md WT-5.8):
 * said at the top of the New Worktree dialog, one sentence to a line, and the button named for doing it.
 */
export interface INewWorktreePreparation {
	readonly notice: readonly string[];
	readonly action: string;
	/** Why it cannot be done here and now, said as an error, with the button held disabled. */
	readonly blocked?: string;
}

/** A row to customize. */
export interface ICustomizeTarget {
	/** What the row shows when nobody has named it: a folder's name, a worktree's branch. */
	readonly defaultName: string;
	readonly worktree: boolean;
}

/** What the New Worktree dialog was answered with. */
export interface INewWorktreeAnswer {
	readonly branch: string;
	readonly customization: IFolderCustomization;
}

export const IWorkspaceBarDialogService = createDecorator<IWorkspaceBarDialogService>('workspaceBarDialogService');

/** The workspace bar's own dialogs. */
export interface IWorkspaceBarDialogService {
	readonly _serviceBrand: undefined;

	/**
	 * Asks for a folder's display name, colour and glyph - or a worktree's name and colour.
	 *
	 * ⚠️ One dialog for both, and it is the only way to rename a row - a second, inline way to change
	 * the same thing is a second set of edge cases for something people do twice a year.
	 *
	 * A worktree is not offered a glyph (WORKTREE.md WT-1.12): its glyph says "worktree", in its colour.
	 */
	showCustomizeDialog(target: ICustomizeTarget, current: IFolderCustomization | undefined): Promise<IFolderCustomization | undefined>;

	/**
	 * Asks for a new worktree's branch, and the name and colour it will have (WORKTREE.md WT-5.2).
	 *
	 * The Customize dialog with the branch above it. Under the branch, `origin` says where it starts and
	 * `describe`, as it is typed, the folder it goes in or why it cannot be made; Create waits until it can.
	 */
	showNewWorktreeDialog(repository: string, origin: string, describe: (branch: string) => IBranchDescription, prepare: INewWorktreePreparation | undefined): Promise<INewWorktreeAnswer | undefined>;
}

export class WorkspaceBarDialogService implements IWorkspaceBarDialogService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IHostService private readonly hostService: IHostService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	async showCustomizeDialog(target: ICustomizeTarget, current: IFolderCustomization | undefined): Promise<IFolderCustomization | undefined> {
		return (await showRowDialog(target, current, this.services()))?.customization;
	}

	async showNewWorktreeDialog(repository: string, origin: string, describe: (branch: string) => IBranchDescription, prepare: INewWorktreePreparation | undefined): Promise<INewWorktreeAnswer | undefined> {
		const answer = await showRowDialog({
			defaultName: '',
			worktree: true,
			create: {
				title: localize('workspaceBar.newWorktreeTitle', "New Worktree in '{0}'", repository),
				description: localize('workspaceBar.newWorktreeAbout', "Create a new Git worktree and branch for '{0}'.", repository),
				origin, describe, notice: prepare?.notice, action: prepare?.action, blocked: prepare?.blocked
			}
		}, undefined, this.services());

		return answer?.branch ? { branch: answer.branch, customization: answer.customization } : undefined;
	}

	private services(): IDialogServices {
		return {
			layoutService: this.layoutService,
			keybindingService: this.keybindingService,
			hostService: this.hostService,
			contextViewService: this.contextViewService,
			hoverService: this.hoverService
		};
	}
}

registerSingleton(IWorkspaceBarDialogService, WorkspaceBarDialogService, InstantiationType.Delayed);

async function showRowDialog(
	target: ICustomizeTarget & {
		/** Makes it the New Worktree dialog: a branch asked first, and a button that makes it. */
		readonly create?: {
			readonly title: string;
			/** The sentence under the title: what the dialog makes. */
			readonly description: string;
			/** Where the branch starts: said under it, and the same whatever is typed. */
			readonly origin: string;
			readonly describe: (branch: string) => IBranchDescription;
			/** Said above everything else - what Create will do to the folder before the worktree. */
			readonly notice?: readonly string[];
			/** The first button's name, when it does more than create. */
			readonly action?: string;
			/** Said last in the notice as an error; while there is one, the first button stays disabled. */
			readonly blocked?: string;
		};
	},
	current: IFolderCustomization | undefined,
	services: IDialogServices
): Promise<{ readonly customization: IFolderCustomization; readonly branch: string | undefined } | undefined> {
	const disposables = new DisposableStore();
	const create = target.create;

	let branch = '';
	let name = current?.name ?? '';
	let color: FolderColor | undefined = current?.color;
	let icon: FolderIcon | undefined = current?.icon;

	// Whether the first button may be pressed - by a click or by Enter. Only New Worktree ever says no.
	let valid = !create;
	let primaryButton: IButton | undefined;

	// ⚠️ The host's own button row, not one built here. Remove Folder goes through
	// `dialogService.confirm`, which builds this row, and it comes out right; a hand-rolled footer for
	// this one dialog put Cancel 450px outside the box and left the two dialogs shaped differently for
	// no reason anybody could name. The host also knows the platform's button order.
	const primary = create ? create.action ?? localize('workspaceBar.create', "Create") : localize('workspaceBar.save', "Save");
	const cancel = localize('workspaceBar.cancel', "Cancel");

	const dialog = disposables.add(new Dialog(
		services.layoutService.activeContainer,
		create?.title ?? (target.worktree ? localize('workspaceBar.customizeWorktreeTitle', "Customize Worktree") : localize('workspaceBar.customizeTitle', "Customize Folder")),
		[primary, cancel],
		createWorkbenchDialogOptions({
			type: 'none',
			// ⚠️ No severity glyph: nothing here is destroyed and nothing is irreversible.
			extraClasses: ['facade-dialog', 'workspacebar-customize'],
			// The sentence under the title, in the quiet ink (`facadedialog.css`): what this dialog is for.
			detail: create
				? create.description
				: target.worktree
					? localize('workspaceBar.customizeWorktreeAbout', "Configure the display name and color for '{0}'. The branch and folder on disk are not renamed.", current?.name || target.defaultName)
					: localize('workspaceBar.customizeAbout', "Configure the display name, color, and icon for '{0}'. The folder on disk is not renamed.", current?.name || target.defaultName),
			cancelId: 1,
			buttonOptions: [{
				styleButton: button => {
					primaryButton = button;
					button.enabled = valid;
				}
			}],
			renderBody: container => {
				container.classList.add('workspacebar-customize-body');

				// Enter presses the first button, as the host's dialogs do for their own inputs.
				const onEnter = (box: InputBox) => disposables.add(addDisposableListener(box.inputElement, EventType.KEY_DOWN, e => {
					if (new StandardKeyboardEvent(e).equals(KeyCode.Enter)) {
						EventHelper.stop(e, true);
						if (valid) {
							primaryButton?.element.click();
						}
					}
				}));

				// --- what happens to the folder first, when anything does -------------------------
				//
				// First, and in the dialog's own ink: the one thing here that changes the folder itself.
				if (create?.notice?.length || create?.blocked) {
					const notice = append(container, $('.workspacebar-customize-notice'));
					for (const line of create.notice ?? []) {
						append(notice, $('p', undefined, line));
					}
					if (create.blocked) {
						append(notice, $('p.error', undefined, create.blocked));
					}
				}

				// --- the branch, when a worktree is being made ------------------------------------
				let branchBox: InputBox | undefined;
				let describeBranch = () => { };
				if (create) {
					append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.branch', "Branch")));

					branchBox = disposables.add(new InputBox(append(container, $('.workspacebar-customize-input')), services.contextViewService, {
						inputBoxStyles: defaultInputBoxStyles,
						placeholder: localize('workspaceBar.branchPlaceholder', "Branch name"),
						ariaLabel: localize('workspaceBar.branchAria', "Branch for the new worktree")
					}));
					onEnter(branchBox);

					// Where it starts, and below that the folder it goes in or why it cannot be made (WT-5.2):
					// two lines, each held to one line (`workspacebardialog.css`) so the dialog never grows
					// as the branch is typed.
					const originLine = append(container, $('.workspacebar-customize-hint.workspacebar-customize-line', undefined, create.origin));
					disposables.add(services.hoverService.setupDelayedHover(originLine, { content: create.origin }));
					const where = append(container, $('.workspacebar-customize-hint.workspacebar-customize-line.workspacebar-customize-where'));
					disposables.add(services.hoverService.setupDelayedHover(where, () => ({ content: where.textContent ?? '' })));
					let announced: string | undefined;
					describeBranch = () => {
						const description = create.describe(branch);
						where.textContent = description.message;
						where.classList.toggle('error', !!description.error);

						// Announced only when it becomes an error; a live region read the path at every letter.
						const problem = description.error ? description.message : undefined;
						if (problem && problem !== announced) {
							alert(problem);
						}
						announced = problem;

						valid = description.valid && !create.blocked;
						if (primaryButton) {
							primaryButton.enabled = valid;
						}
					};
					describeBranch();
				}

				// --- the name -------------------------------------------------------------------
				append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.displayName', "Display Name")));

				const nameBox = disposables.add(new InputBox(append(container, $('.workspacebar-customize-input')), services.contextViewService, {
					inputBoxStyles: defaultInputBoxStyles,
					// ⚠️ The folder's real name, greyed, so the field shows what leaving it blank gets you
					// without spending a line on it. The line under it is still there for a screen reader,
					// which does not read a placeholder as an answer.
					placeholder: target.defaultName,
					ariaLabel: target.worktree ? localize('workspaceBar.worktreeDisplayNameAria', "Display name for this worktree") : localize('workspaceBar.displayNameAria', "Display name for this folder")
				}));
				nameBox.value = name;
				disposables.add(nameBox.onDidChange(value => { name = value; }));
				onEnter(nameBox);

				// ⚠️ The real folder name is said out loud. "Leave empty to use the folder name" makes
				// somebody go and look; naming it answers the question where it was asked. And it is
				// said to be the default, or the name on its own reads as an instruction to type it.
				// Making a worktree, the default is the branch being typed above, so it follows it -
				// and is held to one line for the same reason the lines under the branch are.
				const nameHint = append(container, $('.workspacebar-customize-hint.workspacebar-customize-line'));
				disposables.add(services.hoverService.setupDelayedHover(nameHint, () => ({ content: nameHint.textContent ?? '' })));
				const sayDefault = (defaultName: string) => {
					nameBox.setPlaceHolder(defaultName);
					nameHint.textContent = defaultName
						? localize('workspaceBar.displayNameDefault', "Leave empty to use the default name '{0}'.", defaultName)
						: localize('workspaceBar.displayNameHintBranch', "Leave empty to use the branch name.");
				};
				sayDefault(target.defaultName);

				if (branchBox) {
					disposables.add(branchBox.onDidChange(value => {
						branch = value;
						describeBranch();
						sayDefault(value.trim());
					}));
				}

				// --- the colour -----------------------------------------------------------------
				append(container, $('.workspacebar-customize-label', undefined, localize('workspaceBar.color', "Color")));

				const swatches = append(container, $('.workspacebar-customize-swatches'));
				swatches.setAttribute('role', 'radiogroup');
				swatches.setAttribute('aria-label', target.worktree ? localize('workspaceBar.worktreeColorAria', "Worktree color") : localize('workspaceBar.colorAria', "Folder color"));

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
					disposables.add(services.hoverService.setupDelayedHover(button, { content: label }));
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

				addSwatch(undefined, localize('workspaceBar.colorNone', "No Color"));
				for (const value of FOLDER_COLORS) {
					addSwatch(value, colorLabel(value));
				}
				paint();

				if (!target.worktree) {
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
						disposables.add(services.hoverService.setupDelayedHover(button, { content: iconLabel(value) }));
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
				}

				// The name is what somebody came here to change, so that is what has focus.
				//
				// ⚠️ A tick later, because the host moves focus into the dialog after `renderBody`
				// returns - and through the store, so a dialog dismissed inside that tick does not
				// come back to focus an input that is no longer in the document.
				// Making a worktree, it is the branch - the one thing that has to be answered.
				disposables.add(disposableTimeout(() => {
					const first = branchBox ?? nameBox;
					first.focus();
					first.select();
				}, 0));
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

	return {
		customization: { name: name.trim() || undefined, color, icon: target.worktree ? undefined : icon },
		branch: branch.trim() || undefined
	};
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
