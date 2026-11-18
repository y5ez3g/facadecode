/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export * from 'vscode';

export const RESUME_PICKER_STATE = 'facade.testResumePicker';

export interface ResumePickerState {
	readonly busy: boolean;
	readonly labels: readonly string[];
	readonly active: number;
}

/** The integration bundle can read the Resume picker's labels and its active row. */
function createQuickPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T> {
	const picker = vscode.window.createQuickPick<T>();
	const observe = vscode.commands.registerCommand(RESUME_PICKER_STATE, (): ResumePickerState => ({
		busy: picker.busy,
		labels: picker.items.map(item => item.label),
		active: picker.items.indexOf(picker.activeItems[0])
	}));
	picker.onDidHide(() => observe.dispose());
	return picker;
}

export const window = new Proxy(vscode.window, {
	get(target, property, receiver) {
		return property === 'createQuickPick' ? createQuickPick : Reflect.get(target, property, receiver);
	}
});
