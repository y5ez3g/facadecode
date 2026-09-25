/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/terminalLaunchers.css';
import { $, append, clearNode, hide, show } from '../../../../base/browser/dom.js';
import { Button, IButtonStyles } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions, facadeDialogButtonStyles, facadeDialogInputBoxStyles } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ITerminalLauncher, uniqueLauncherId } from '../common/terminalLaunchers.js';

/**
 * A button with no box of its own.
 *
 * `Button` writes its colours as inline styles, which a stylesheet cannot take back, so the way to
 * a flat control is to hand it nothing to write.
 */
const FLAT_BUTTON_STYLES: IButtonStyles = {
	...defaultButtonStyles,
	buttonBackground: undefined,
	buttonHoverBackground: undefined,
	buttonBorder: undefined,
	buttonSecondaryBackground: undefined,
	buttonSecondaryHoverBackground: undefined,
	buttonSecondaryBorder: undefined
};

export interface ITerminalLauncherDialogServices {
	readonly layoutService: IWorkbenchLayoutService;
	readonly keybindingService: IKeybindingService;
	readonly hostService: IHostService;
	readonly contextViewService: IContextViewService;
}

/**
 * A row being edited. An existing row keeps its `id`, so that renaming an agent does not make it a
 * different one; a row somebody just added has none until it is saved and has a name to take it from.
 */
interface IRow {
	readonly id: string | undefined;
	label: string;
	command: string;
}

/**
 * The list of agents, as a form.
 *
 * Rows rather than a fixed set of slots with ticks: the table this fork ships is a place to start,
 * not the set of agents that exist. Nothing here checks whether a command is on the machine - a
 * command that is not there says so in the terminal, in its own words, which is a better answer
 * than this dialog guessing and a worse one than it guessing wrong.
 *
 * @returns the agents to keep, in the order shown, or `undefined` if the dialog was dismissed.
 */
export async function showAgentsDialog(
	launchers: readonly ITerminalLauncher[],
	detect: () => Promise<readonly ITerminalLauncher[]>,
	services: ITerminalLauncherDialogServices
): Promise<ITerminalLauncher[] | undefined> {
	const disposables = new DisposableStore();
	const rows: IRow[] = launchers.map(launcher => ({ ...launcher }));

	const save = localize('terminalLaunchers.save', "Save");
	const cancel = localize('terminalLaunchers.cancel', "Cancel");

	const dialog = disposables.add(new Dialog(
		services.layoutService.activeContainer,
		localize('terminalLaunchers.title', "Agents"),
		[save, cancel],
		createWorkbenchDialogOptions({
			type: 'none',
			extraClasses: ['facade-dialog', 'terminal-launchers-dialog'],
			cancelId: 1,
			renderBody: container => {
				container.classList.add('terminal-launchers-body');

				append(container, $('.terminal-launchers-hint', undefined,
					localize('terminalLaunchers.hint', "Configure detected agents and custom commands. Items appear in the Agent menu and launch in a new terminal at the workspace root.")));

				const list = append(container, $('.terminal-launchers-list'));

				// Assigned once the button below exists; `draw` runs before that and has nothing to sync
				let syncAction = () => { };

				// Rebuilt whenever a row is added or removed: an input box owns its own DOM, and there
				// is no cheaper way to take one out of the middle of a list than to lay the list again
				const rowDisposables = disposables.add(new DisposableStore());

				// The first name field, for the focus the dialog takes when it opens
				let firstBox: InputBox | undefined;
				const draw = (focusRow?: number) => {
					rowDisposables.clear();
					clearNode(list);
					firstBox = undefined;

					if (rows.length === 0) {
						append(list, $('.terminal-launchers-empty', undefined,
							localize('terminalLaunchers.empty', "No agents configured yet.")));
					}

					rows.forEach((row, index) => {
						const line = append(list, $('.terminal-launchers-row'));

						const labelBox = rowDisposables.add(new InputBox(append(line, $('.terminal-launchers-name')), services.contextViewService, {
							inputBoxStyles: facadeDialogInputBoxStyles,
							placeholder: localize('terminalLaunchers.namePlaceholder', "Agent Name"),
							ariaLabel: localize('terminalLaunchers.nameAria', "Name of agent {0}", index + 1)
						}));
						labelBox.value = row.label;
						rowDisposables.add(labelBox.onDidChange(value => { row.label = value; }));

						if (index === 0) {
							firstBox = labelBox;
						}

						const commandBox = rowDisposables.add(new InputBox(append(line, $('.terminal-launchers-command')), services.contextViewService, {
							inputBoxStyles: facadeDialogInputBoxStyles,
							// An example rather than a description of the empty case: the field is the one
							// thing somebody is here to fill in, and a blank one still opens a plain shell
							placeholder: localize('terminalLaunchers.commandPlaceholder', "Terminal Command (e.g. claude)"),
							ariaLabel: localize('terminalLaunchers.commandAria', "Command for agent {0}", index + 1)
						}));
						commandBox.value = row.command;
						rowDisposables.add(commandBox.onDidChange(value => { row.command = value; }));

						// Flat, because a Button writes its colours inline and a bordered box on every row
						// reads as a third field rather than as the row's own control
						const remove = rowDisposables.add(new Button(append(line, $('.terminal-launchers-remove')), {
							...FLAT_BUTTON_STYLES,
							secondary: true,
							title: localize('terminalLaunchers.remove', "Remove this agent")
						}));
						remove.icon = Codicon.close;
						rowDisposables.add(remove.onDidClick(() => {
							rows.splice(index, 1);
							draw(Math.min(index, rows.length - 1));
						}));

						if (index === focusRow) {
							rowDisposables.add(disposableTimeout(() => { labelBox.focus(); labelBox.select(); }, 0));
						}
					});

					syncAction();
				};

				draw();

				// `supportIcons` rather than `Button.icon`, which puts the codicon class on the button
				// itself and hands its font to the label - measured, `Add Agent` came out 16px of
				// `codicon` against the 12px the dialog's own buttons use.
				//
				// Outlined, as Cancel is: in these dialogs only the button the dialog is for is filled.
				const actions = append(container, $('.terminal-launchers-actions'));
				const outlined = { ...facadeDialogButtonStyles, secondary: true, supportIcons: true };

				// Add first, so the one button that is always there starts where the rows start. The
				// other way round left it indented by the row's gap whenever Detect was away.
				const addButton = disposables.add(new Button(append(actions, $('.terminal-launchers-action')), {
					...outlined,
					title: localize('terminalLaunchers.addTitle', "Add an agent")
				}));
				addButton.label = `$(add) ${localize('terminalLaunchers.add', "Add Agent")}`;

				// Offered beside Add rather than instead of it. A machine can have nothing on its
				// `PATH` to find, and a list that can only be filled by looking would leave somebody
				// there with one button that does nothing for them.
				const detectSlot = append(actions, $('.terminal-launchers-action'));
				const detectButton = disposables.add(new Button(detectSlot, {
					...outlined,
					title: localize('terminalLaunchers.detectTitle', "Look for agents installed on this machine")
				}));
				detectButton.label = `$(search) ${localize('terminalLaunchers.detect', "Detect Agents")}`;

				// Detecting is only the thing to do while there is nothing to detect into.
				//
				// The slot and not the button: a hidden button leaves its slot laid out, and the row's
				// gap goes on counting it - measured, 8px of it.
				syncAction = () => {
					if (rows.length === 0) {
						show(detectSlot);
					} else {
						hide(detectSlot);
					}
				};
				syncAction();

				disposables.add(addButton.onDidClick(() => {
					// No id yet: it is taken from the name at save, so `Antigravity` becomes
					// `antigravity` rather than whatever placeholder the row appeared with
					rows.push({ id: undefined, label: '', command: '' });
					draw(rows.length - 1);
				}));

				disposables.add(detectButton.onDidClick(async () => {
					// Disabled while it looks, so a second click cannot start a second scan
					detectButton.enabled = false;
					try {
						rows.push(...(await detect()).map(launcher => ({ ...launcher })));
						draw();
					} catch (error) {
						// Caught rather than left to fall out of the handler: an event listener's promise
						// is nobody's, so a throw here is an unhandled rejection and the dialog just sits
						// there. The scan swallows its own file-system errors, so this is something else.
						onUnexpectedError(error);
					} finally {
						detectButton.enabled = true;
					}
				}));

				// A tick later, because the host moves focus into the dialog after `renderBody` returns
				disposables.add(disposableTimeout(() => firstBox?.focus(), 0));
			}
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

	// A row with no name is one somebody started and left, not an agent
	const taken = new Set<string>();
	return rows
		.filter(row => row.label.trim())
		.map(row => {
			const id = row.id && !taken.has(row.id) ? row.id : uniqueLauncherId(row.label, taken);
			taken.add(id);

			return { id, label: row.label.trim(), command: row.command.trim() };
		});
}
