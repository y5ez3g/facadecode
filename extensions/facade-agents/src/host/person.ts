/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { EndedAgent, EndTold, Notification, Person, Severity } from '../core/ports';
import { agentRef } from '../record/events';
import { openRoom } from './rooms';
import { ScreenDocuments } from './screenDocuments';
import { HostTerminals } from './terminals';

/** How much of a notice's first line a notification shows. */
const SHOWN_CHARS = 200;

/**
 * A notice or notification shown with a key: its text - and, by its identity, that very showing of it, which the next
 * shown with the key takes the place of.
 */
interface Shown {
	readonly text: string;
}

/**
 * The core's Person port: Facade's notices and notifications, from which the person goes to the agent's
 * terminal, its last screen or a chat room. Notifications kept by key are the workbench's
 * (`_facade.notification.show`): the next with a key takes the place of the one up, as Do Not Disturb
 * has it, and goes quietly into the notification center while the terminal of the agent it is from has
 * the person's focus (AGENT-MESSAGES.md, M9); without Facade's workbench each is a new one.
 */
export class HostPerson implements Person {

	/** Whether the window keeps Facade's notifications by key: asked once. */
	private keeps: Promise<boolean> | undefined;
	/** What was last shown with each key - a notice, or a notification - while it may be up: for `close` to close only that. */
	private readonly shownWith = new Map<string, Shown>();

	/**
	 * `endedOf` says where the last screen of an agent that ended is; `log` says why a terminal the person asked
	 * for could not be shown.
	 */
	constructor(
		private readonly terminals: HostTerminals,
		private readonly screens: ScreenDocuments,
		private readonly endedOf: (id: number) => EndedAgent | undefined,
		private readonly log: (message: string) => void
	) { }

	tell(text: string, agent: number | undefined, severity: Severity, key?: string): void {
		const shown: Shown = { text };
		if (key !== undefined) {
			this.shownWith.set(key, shown);
		}
		void this.show(text, agent, severity, key !== undefined ? { key, shown } : undefined).catch(err => this.log(`Could not show a notification or bring its agent's terminal to the foreground: ${messageOf(err)}`));
	}

	close(key: string, text: string): void {
		if (this.shownWith.get(key)?.text !== text) {
			return;
		}
		this.shownWith.delete(key);
		void this.closeKept(key).catch(err => this.log(`Could not close a notification: ${messageOf(err)}`));
	}

	tellEnded(batch: string, ends: readonly EndTold[]): void {
		void this.showEnds(batch, ends).catch(err => this.log(`Could not show notifications about the person's ended agents or bring their terminals to the foreground: ${messageOf(err)}`));
	}

	async notify({ key, text, buttons, quietIn }: Notification): Promise<string | undefined> {
		this.shownWith.set(key, { text });
		if (!await this.keepsNotifications()) {
			return vscode.window.showInformationMessage(text, ...buttons);
		}
		const pressed = await vscode.commands.executeCommand<unknown>('_facade.notification.show', key, text, buttons, quietIn === undefined ? null : this.terminals.runOf(quietIn));
		return typeof pressed === 'string' ? pressed : undefined;
	}

	openRoom(file: string, message: number): Promise<void> {
		return openRoom(file, message);
	}

	async showEnded(agent: EndedAgent): Promise<void> {
		if (!await this.terminals.reveal(agent.id)) {
			await this.screens.open(agent);
		}
	}

	/**
	 * Tells the person that an agent they started did not start, `text` saying why: Show goes to what its CLI
	 * showed as it ended, often the reason, where `agent` ended with a terminal.
	 */
	tellNotStarted(text: string, agent: EndedAgent | undefined): void {
		void this.showNotStarted(text, agent).catch(err => this.log(`Could not show the final screen of the agent whose launch failed: ${messageOf(err)}`));
	}

	/**
	 * Shows a notice: one still open as the window goes is rejected with it, nobody there to see it. Its Show goes
	 * to the agent's terminal while there is one, else to its last screen, once it ended (D6; N-33). One `kept` with a
	 * key is the notification up with it, where the window keeps them by key - none once it was closed - and else a
	 * notice of its own. Its message is the notice alone: VS Code names its source, Facade Agents, beside it.
	 */
	private async show(text: string, agent: number | undefined, severity: Severity, kept?: { readonly key: string; readonly shown: Shown }): Promise<void> {
		const show = vscode.l10n.t("Show");
		const showable = agent !== undefined && (await this.terminals.hasTerminal(agent) || this.endedOf(agent) !== undefined);
		const message = firstLineOf(text);
		const items = showable ? [show] : [];
		const choice = kept && await this.keepsNotifications()
			? await this.showKept(kept.key, kept.shown, message, items, severity)
			: await (severity === 'error' ? vscode.window.showErrorMessage(message, ...items) : severity === 'warning' ? vscode.window.showWarningMessage(message, ...items) : vscode.window.showInformationMessage(message, ...items));
		if (choice !== show || agent === undefined || await this.terminals.reveal(agent)) {
			return;
		}
		const ended = this.endedOf(agent);
		if (ended) {
			await this.screens.open(ended);
		} else {
			this.log(`Could not bring ${agentRef(agent)}'s terminal to the foreground: it no longer exists, or the window did not switch to it.`);
		}
	}

	/**
	 * Shows a notice as the notification up with `key`, unless it was closed before it came up: answers with the
	 * button pressed; undefined once it closed, or another took its place.
	 */
	private async showKept(key: string, shown: Shown, message: string, buttons: readonly string[], severity: Severity): Promise<string | undefined> {
		if (this.shownWith.get(key) !== shown) {
			return undefined;
		}
		try {
			const pressed = await vscode.commands.executeCommand<unknown>('_facade.notification.show', key, message, buttons, null, severity);
			return typeof pressed === 'string' ? pressed : undefined;
		} finally {
			if (this.shownWith.get(key) === shown) {
				this.shownWith.delete(key);
			}
		}
	}

	/** Closes the notification up with `key`, where the window keeps Facade's notifications by key. */
	private async closeKept(key: string): Promise<void> {
		if (await this.keepsNotifications()) {
			await vscode.commands.executeCommand('_facade.notification.close', key);
		}
	}

	/**
	 * Shows the ends of the person's agents that came together as one notification, `ended:<batch>`, which the next
	 * end of the batch replaces, as the most severe of them says (AGENT-MESSAGES.md, M11). Its Show goes to each one's
	 * terminal while there is one, else to its last screen. Without Facade's workbench, the newest is a notice of its own.
	 */
	private async showEnds(batch: string, ends: readonly EndTold[]): Promise<void> {
		const newest = ends[ends.length - 1];
		if (!await this.keepsNotifications()) {
			return this.show(newest.text, newest.agent, newest.severity);
		}
		const show = vscode.l10n.t("Show");
		const severity = ends.some(end => end.severity === 'error') ? 'error' : ends.some(end => end.severity === 'warning') ? 'warning' : 'information';
		const text = ends.length === 1
			? firstLineOf(newest.text)
			: vscode.l10n.t("{0} of your agents ended. {1}", ends.length, ends.map(end => firstLineOf(end.text)).join(' '));
		const pressed = await vscode.commands.executeCommand<unknown>('_facade.notification.show', `ended:${batch}`, text, [show], null, severity);
		if (pressed !== show) {
			return;
		}
		for (const end of ends) {
			if (await this.terminals.reveal(end.agent)) {
				continue;
			}
			const ended = this.endedOf(end.agent);
			if (ended) {
				await this.screens.open(ended);
			}
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
