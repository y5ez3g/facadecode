/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { Person } from '../core/ports';
import { HostTerminals } from './terminals';

/** How much of a notice's first line a notification shows. */
const SHOWN_CHARS = 200;

/** The core's Person port: Facade's notices as notifications, from which the person goes to the agent's terminal. */
export class HostPerson implements Person {

	/** `log` says why a terminal the person asked for could not be shown. */
	constructor(private readonly terminals: HostTerminals, private readonly log: (message: string) => void) { }

	tell(text: string, terminal: string | undefined): void {
		void this.show(text, terminal).catch(err => this.log(`A notice could not be shown, or its terminal put in front: ${messageOf(err)}`));
	}

	/** Shows a notice: one still open as the window goes is rejected with it, nobody there to see it. */
	private async show(text: string, terminal: string | undefined): Promise<void> {
		const firstLine = text.split('\n')[0];
		const shown = firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
		const showTerminal = vscode.l10n.t("Show Terminal");
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Facade: {0}", shown), ...(terminal ? [showTerminal] : []));
		if (choice === showTerminal && terminal && !await this.terminals.reveal(terminal)) {
			this.log(`${terminal} could not be put in front: it is gone, or the window did not go to it.`);
		}
	}
}
