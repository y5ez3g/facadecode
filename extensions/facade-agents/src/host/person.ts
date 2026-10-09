/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { EndedAgent, Notification, Person } from '../core/ports';
import { openRoom } from './rooms';
import { ScreenDocuments } from './screenDocuments';
import { HostTerminals } from './terminals';

/** How much of a notice's first line a notification shows. */
const SHOWN_CHARS = 200;

/**
 * The core's Person port: Facade's notices and notifications, from which the person goes to the agent's
 * terminal, its last screen or a chat room. Notifications kept by key are the workbench's
 * (`_facade.notification.show`): the next with a key takes the place of the one up, as Do Not Disturb
 * has it, and goes quietly into the notification center while the terminal of the agent it is from has
 * the person's focus; without Facade's workbench each is a new one.
 */
export class HostPerson implements Person {

	/** Whether the window keeps Facade's notifications by key: asked once. */
	private keeps: Promise<boolean> | undefined;

	/** `log` says why a terminal the person asked for could not be shown. */
	constructor(private readonly terminals: HostTerminals, private readonly screens: ScreenDocuments, private readonly log: (message: string) => void) { }

	tell(text: string, terminal: string | undefined): void {
		void this.show(text, terminal).catch(err => this.log(`A notice could not be shown, or its terminal put in front: ${messageOf(err)}`));
	}

	async notify({ key, text, buttons, quietIn }: Notification): Promise<string | undefined> {
		if (!await this.keepsNotifications()) {
			return vscode.window.showInformationMessage(text, ...buttons);
		}
		const quietFor = quietIn === undefined ? undefined : await this.terminals.processId(quietIn);
		const pressed = await vscode.commands.executeCommand<unknown>('_facade.notification.show', key, text, buttons, quietFor ?? null);
		return typeof pressed === 'string' ? pressed : undefined;
	}

	openRoom(file: string, message: number): Promise<void> {
		return openRoom(file, message);
	}

	async showEnded(agent: EndedAgent): Promise<void> {
		if (!await this.terminals.reveal(agent.terminal)) {
			await this.screens.open(agent);
		}
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

	/** Shows that an agent did not start, as an error, whose Show goes to its last screen where it has one. */
	private async showNotStarted(text: string, agent: EndedAgent | undefined): Promise<void> {
		const show = vscode.l10n.t("Show");
		if (await vscode.window.showErrorMessage(vscode.l10n.t("The agent could not start: {0}", firstLineOf(text)), ...(agent ? [show] : [])) === show && agent) {
			await this.showEnded(agent);
		}
	}

	private keepsNotifications(): Promise<boolean> {
		this.keeps ??= Promise.resolve(vscode.commands.getCommands()).then(commands => commands.includes('_facade.notification.show'));
		return this.keeps;
	}
}

/** A notice's first line, cut to what a notification shows. */
function firstLineOf(text: string): string {
	const firstLine = text.split('\n')[0];
	return firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
}
