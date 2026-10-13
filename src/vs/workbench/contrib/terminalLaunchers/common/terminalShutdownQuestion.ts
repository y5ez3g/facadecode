/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** What VS Code's question before shutdown is told by {@link setTerminalShutdownQuestion}. */
export interface ITerminalShutdownQuestion {
	/** What would stop among `terminals`, by name and folder, for the question's detail; undefined for nothing. */
	describe(terminals: readonly object[]): string | undefined;
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
