/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export * from 'vscode';

export const RESUME_PICKER_STATE = 'facade.testResumePicker';

export interface ResumePickerState {
	readonly title?: string;
	readonly busy: boolean;
	readonly labels: readonly string[];
	readonly descriptions: readonly (string | undefined)[];
	readonly active: number;
}

/** The integration bundle can read the native picker's rows and its active row. */
let observed: vscode.Disposable | undefined;

function createQuickPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T> {
	const picker = vscode.window.createQuickPick<T>();
	observed?.dispose();
	const observe = vscode.commands.registerCommand(RESUME_PICKER_STATE, (): ResumePickerState => ({
		title: picker.title,
		busy: picker.busy,
		labels: picker.items.map(item => item.label),
		descriptions: picker.items.map(item => item.description),
		active: picker.items.indexOf(picker.activeItems[0])
	}));
	observed = observe;
	picker.onDidHide(() => {
		if (observed === observe) {
			observe.dispose();
			observed = undefined;
		}
	});
	return picker;
}

export const window = new Proxy(vscode.window, {
	get(target, property, receiver) {
		return property === 'createQuickPick' ? createQuickPick : Reflect.get(target, property, receiver);
	}
});
