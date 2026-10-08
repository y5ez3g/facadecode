/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { EndedAgent, Person } from '../core/ports';
import { ScreenDocuments } from './screenDocuments';
import { HostTerminals } from './terminals';

/** How much of a notice's first line a notification shows. */
const SHOWN_CHARS = 200;

/** The core's Person port: Facade's notices as notifications, from which the person goes to the agent's terminal, or its last screen. */
export class HostPerson implements Person {

	/** `log` says why a terminal the person asked for could not be shown. */
	constructor(private readonly terminals: HostTerminals, private readonly screens: ScreenDocuments, private readonly log: (message: string) => void) { }

	tell(text: string, terminal: string | undefined): void {
		void this.show(text, terminal).catch(err => this.log(`A notice could not be shown, or its terminal put in front: ${messageOf(err)}`));
	}

	tellEnded(text: string, agent: EndedAgent): void {
		void this.showEnded(text, agent).catch(err => this.log(`A notice could not be shown, or the last screen of @${agent.name} #${agent.id} opened: ${messageOf(err)}`));
	}

	/**
	 * Tells the person that an agent they started did not come up, `text` saying why: Show goes to what its
	 * CLI showed as it ended, often the reason, where `agent` ended with a terminal.
	 */
	tellNotStarted(text: string, agent: EndedAgent | undefined): void {
		void this.showNotStarted(text, agent).catch(err => this.log(`The last screen of the agent that did not start could not be shown: ${messageOf(err)}`));
	}

	/** Shows a notice: one still open as the window goes is rejected with it, nobody there to see it. */
	private async show(text: string, terminal: string | undefined): Promise<void> {
		const showTerminal = vscode.l10n.t("Show Terminal");
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Facade: {0}", firstLineOf(text)), ...(terminal ? [showTerminal] : []));
		if (choice === showTerminal && terminal && !await this.terminals.reveal(terminal)) {
			this.log(`${terminal} could not be put in front: it is gone, or the window did not go to it.`);
		}
	}

	/** Shows a notice about an agent that ended, whose Show goes to its terminal while that is open, else to its last screen. */
	private async showEnded(text: string, agent: EndedAgent): Promise<void> {
		const show = vscode.l10n.t("Show");
		if (await vscode.window.showInformationMessage(vscode.l10n.t("Facade: {0}", firstLineOf(text)), show) === show) {
			await this.showLastScreen(agent);
		}
	}

	/** Shows that an agent did not start, as an error, whose Show goes to its last screen where it has one. */
	private async showNotStarted(text: string, agent: EndedAgent | undefined): Promise<void> {
		const show = vscode.l10n.t("Show");
		if (await vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", firstLineOf(text)), ...(agent ? [show] : [])) === show && agent) {
			await this.showLastScreen(agent);
		}
	}

	/** The terminal an agent ran in while it is still open, showing how its process ended; else its last screen, read-only. */
	private async showLastScreen(agent: EndedAgent): Promise<void> {
		if (!await this.terminals.reveal(agent.terminal)) {
			await this.screens.open(agent);
		}
	}
}

/** A notice's first line, cut to what a notification shows. */
function firstLineOf(text: string): string {
	const firstLine = text.split('\n')[0];
	return firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
}
