/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** What VS Code's question before shutdown is told by {@link setTerminalShutdownQuestion}. */
export interface ITerminalShutdownQuestion {
	/**
	 * The question about `terminals`, every one of which would stop: its message where it is not VS Code's own, its
	 * detail - what would stop, one to a line - and its button where it is not VS Code's Terminate: where confirming
	 * stops nothing (REMOTE.md R4).
	 */
	describe(terminals: readonly object[]): { readonly message: string | undefined; readonly detail: string; readonly primaryButton?: string };
}

let question: ITerminalShutdownQuestion | undefined;

/**
 * What lets VS Code's question before shutdown (`terminal.integrated.confirmOnExit`) also count background
 * terminals and name what would stop (WORKSPACE.md W11); without it the question is stock's.
 */
export function terminalShutdownQuestion(): ITerminalShutdownQuestion | undefined {
	return question;
}

/** Answers {@link terminalShutdownQuestion} from now on, until disposed. */
export function setTerminalShutdownQuestion(value: ITerminalShutdownQuestion): IDisposable {
	question = value;
	return toDisposable(() => {
		if (question === value) {
			question = undefined;
		}
	});
}
