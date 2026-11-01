/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { plainText } from '../presentation';

/** What a step answers when the person went back to the one before. */
export const BACK = Symbol('back');

/** A native header button that acts without accepting or leaving the current step. */
export interface StepAction {
	readonly button: vscode.QuickInputButton;
	readonly run: () => void;
}

interface TextCheckResult {
	readonly problem?: string;
	readonly prompt?: string;
	readonly actions?: readonly StepAction[];
}

interface PickOptions<T extends vscode.QuickPickItem> {
	readonly title: string;
	readonly placeholder: string;
	readonly items: readonly T[];
	readonly active?: T;
	/** Whether the step has Back: it returns to the one before, which keeps what was chosen there (UX-1.1). */
	readonly back?: boolean;
	readonly matchOnDescription?: boolean;
	readonly busy?: boolean;
	readonly actions?: readonly StepAction[];
	/** Whether choosing an item takes it; one that cannot be taken - its reason shown - leaves the step up. */
	readonly accepts?: (item: T) => boolean;
	/** Keeps the step current while it is up - items that load or change - until the disposable it answers goes with the step. */
	readonly live?: (picker: vscode.QuickPick<T>) => vscode.Disposable | undefined;
}

interface TextOptions {
	readonly title: string;
	readonly value: string;
	/** What is selected of `value` as the step shows: all of it unless said. */
	readonly valueSelection?: readonly [number, number];
	readonly placeholder?: string;
	readonly prompt?: string;
	readonly back?: boolean;
	/** Whether `value` is only where typing starts, as a branch prefix: nothing is said of it until it is edited or Enter is pressed. */
	readonly pristine?: boolean;
	/** Why the text cannot be taken, shown under the field as it is typed; Enter takes only a text without one (UX-1.1). */
	readonly validate?: (value: string) => string | undefined;
	/**
	 * A slower check of a valid text, once typing pauses: busy meanwhile and Enter waiting for it (UX-1.1). Answers why it cannot be
	 * taken, or the prompt that says what it would make.
	 */
	readonly check?: (value: string) => Promise<TextCheckResult>;
}

/** How long typing pauses before a slower check runs. */
const CHECK_DELAY_MS = 150;

/** A message of an input box word for word (PANEL-3.2); none as none. */
function plainOf(text: string | undefined): string | undefined {
	return text === undefined ? undefined : plainText(text);
}

/**
 * One flow of the editor's own pickers and input boxes (UX-1.1): each step shows over the one before - the box never closes between
 * them - Back returns, and Escape, hiding the step up, ends the whole flow with nothing done. A step the flow is over before shows
 * nothing and answers none.
 */
export class Flow {
	private current: vscode.QuickInput | undefined;
	private over = false;

	/** A choice: the item picked, or the item whose button was pressed with it; `BACK`; or none where the flow ended. */
	pick<T extends vscode.QuickPickItem>(options: PickOptions<T>): Promise<{ readonly item: T; readonly button?: vscode.QuickInputButton } | typeof BACK | undefined> {
		const picker = vscode.window.createQuickPick<T>();
		picker.title = options.title;
		picker.placeholder = options.placeholder;
		picker.matchOnDescription = options.matchOnDescription ?? false;
		picker.buttons = [...options.back ? [vscode.QuickInputButtons.Back] : [], ...options.actions?.map(action => action.button) ?? []];
		picker.busy = options.busy ?? false;
		picker.items = options.items;
		if (options.active) {
			picker.activeItems = [options.active];
		}
		return this.show<{ readonly item: T; readonly button?: vscode.QuickInputButton } | typeof BACK>(picker, finish => {
			const subscriptions = [
				picker.onDidAccept(() => {
					const chosen = picker.activeItems[0];
					if (chosen && (options.accepts?.(chosen) ?? true)) {
						finish({ item: chosen });
					}
				}),
				picker.onDidTriggerButton(button => {
					if (button === vscode.QuickInputButtons.Back) {
						finish(BACK);
					} else {
						options.actions?.find(action => action.button === button)?.run();
					}
				}),
				picker.onDidTriggerItemButton(({ item, button }) => finish({ item, button })),
				...[options.live?.(picker)].filter((each): each is vscode.Disposable => each !== undefined)
			];
			return () => subscriptions.forEach(each => each.dispose());
		});
	}

	/** A line of text, checked as it is typed; `BACK`; or none where the flow ended. */
	text(options: TextOptions): Promise<string | typeof BACK | undefined> {
		const input = vscode.window.createInputBox();
		input.title = options.title;
		input.value = options.value;
		input.valueSelection = options.valueSelection ? [...options.valueSelection] : [0, options.value.length];
		input.placeholder = options.placeholder;
		input.prompt = plainOf(options.prompt);
		input.buttons = options.back ? [vscode.QuickInputButtons.Back] : [];
		/** The text the slower check last answered for, and whether it can be taken; a newer check supersedes an older one. */
		let checked: { readonly value: string; readonly ok: boolean } | undefined;
		let asked = 0;
		let active = true;
		let actions: readonly StepAction[] = [];
		const setActions = (next: readonly StepAction[]) => {
			actions = next;
			input.buttons = [...options.back ? [vscode.QuickInputButtons.Back] : [], ...actions.map(action => action.button)];
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const runCheck = async (value: string) => {
			if (!active) {
				return;
			}
			const mine = ++asked;
			setActions([]);
			input.busy = true;
			let found: TextCheckResult;
			try {
				found = await options.check!(value);
			} catch (err) {
				found = { problem: messageOf(err) };
			}
			if (!active || mine !== asked || input.value !== value) {
				return;
			}
			input.busy = false;
			checked = { value, ok: !found.problem };
			input.validationMessage = plainOf(found.problem);
			input.prompt = plainOf(found.prompt ?? options.prompt);
			setActions(found.problem ? [] : found.actions ?? []);
		};
		const changed = (value: string) => {
			checked = undefined;
			asked++;
			setActions([]);
			clearTimeout(timer);
			input.busy = false;
			input.prompt = plainOf(options.prompt);
			const problem = options.validate?.(value);
			input.validationMessage = plainOf(problem);
			if (problem || !options.check) {
				checked = { value, ok: !problem };
			} else {
				timer = setTimeout(() => void runCheck(value), CHECK_DELAY_MS);
			}
		};
		// An empty field is no mistake yet, nor one that holds only where typing starts: what is wrong is said as the person types
		if (options.value && !options.pristine) {
			changed(options.value);
		}
		return this.show<string | typeof BACK>(input, finish => {
			const subscriptions = [
				input.onDidChangeValue(changed),
				input.onDidAccept(async () => {
					const value = input.value;
					if (checked?.value !== value) {
						clearTimeout(timer);
						if (options.validate?.(value) === undefined && options.check) {
							await runCheck(value);
						} else {
							changed(value);
						}
					}
					if (input.value === value && checked?.value === value && checked.ok) {
						finish(value);
					}
				}),
				input.onDidTriggerButton(button => {
					if (button === vscode.QuickInputButtons.Back) {
						finish(BACK);
					} else if (active && !input.busy && checked?.ok && checked.value === input.value) {
						actions.find(action => action.button === button)?.run();
					}
				})
			];
			return () => {
				active = false;
				asked++;
				actions = [];
				clearTimeout(timer);
				subscriptions.forEach(each => each.dispose());
			};
		});
	}

	/**
	 * Runs `work` - one of the editor's own dialogs, and what it asked for - with the step up hidden but the flow going on: the step
	 * after it shows once it is done. A dialog would take the focus, and the step losing it would end the flow.
	 */
	async aside<T>(work: () => Thenable<T>): Promise<T> {
		const up = this.current;
		this.current = undefined;
		up?.hide();
		return await work();
	}

	/**
	 * Runs `check` - Git asked about what the step up chose - with that step busy until it answers (UX-1.1): the step after it then
	 * shows over it as usual. Answers none where the person ended the flow meanwhile.
	 */
	async checking<T>(check: () => Promise<T>): Promise<T | undefined> {
		const up = this.current;
		if (up) {
			up.busy = true;
		}
		try {
			const answer = await check();
			return this.over ? undefined : answer;
		} finally {
			if (up && this.current === up) {
				up.busy = false;
			}
		}
	}

	/** Ends the flow, the step up hidden: accepted, it closes at once as the choice takes effect (UX-1.1). */
	close(): void {
		this.over = true;
		const up = this.current;
		this.current = undefined;
		up?.hide();
	}

	private show<T>(input: vscode.QuickInput, wire: (finish: (value: T) => void) => () => void): Promise<T | undefined> {
		if (this.over) {
			input.dispose();
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => {
			let done = false;
			const finish = (value: T | undefined) => {
				if (!done) {
					done = true;
					resolve(value);
				}
			};
			const unwire = wire(finish);
			input.onDidHide(() => {
				// Hidden while it is the step up: the person ended the flow. Hidden by the next step: the flow goes on
				if (this.current === input) {
					this.over = true;
					this.current = undefined;
				}
				unwire();
				finish(undefined);
				input.dispose();
			});
			const before = this.current;
			this.current = input;
			input.show();
			before?.hide();
		});
	}
}

