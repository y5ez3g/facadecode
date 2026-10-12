/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { Person, Severity } from '../core/ports';
import { agentRef } from '../record/events';
import { HostTerminals } from './terminals';

/** How much of a notice's first line a notification shows. */
const SHOWN_CHARS = 200;

/** The core's Person port: Facade's notices as notifications, from which the person goes to the agent's terminal. */
export class HostPerson implements Person {

	/** `log` says why a terminal the person asked for could not be shown. */
	constructor(private readonly terminals: HostTerminals, private readonly log: (message: string) => void) { }

	tell(text: string, agent: number | undefined, severity: Severity): void {
		void this.show(text, agent, severity).catch(err => this.log(`A notice could not be shown, or its terminal put in front: ${messageOf(err)}`));
	}

	/** Shows a notice: one still open as the window goes is rejected with it, nobody there to see it. */
	private async show(text: string, agent: number | undefined, severity: Severity): Promise<void> {
		const firstLine = text.split('\n')[0];
		const shown = firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
		const showTerminal = vscode.l10n.t("Show");
		// Show only while there is a terminal to show: an agent's that ended has closed (N-33)
		const showable = agent !== undefined && await this.terminals.hasTerminal(agent);
		const message = vscode.l10n.t("Facade: {0}", shown);
		const items = showable ? [showTerminal] : [];
		const choice = await (severity === 'error' ? vscode.window.showErrorMessage(message, ...items) : severity === 'warning' ? vscode.window.showWarningMessage(message, ...items) : vscode.window.showInformationMessage(message, ...items));
		if (choice === showTerminal && agent !== undefined && !await this.terminals.reveal(agent)) {
			this.log(`${agentRef(agent)}'s terminal could not be put in front: it is gone, or the window did not go to it.`);
		}
	}
}
