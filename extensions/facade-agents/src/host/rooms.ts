/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describe } from '../record/events';
import { ChatRoom } from '../record/rooms';

/** Opens a chat room in an editor, at the heading of the message `message` where it has it - else at its end. */
export async function openRoom(file: string, message?: number): Promise<void> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
	let line = Math.max(0, document.lineCount - 1);
	if (message !== undefined) {
		const heading = `## #m${message} `;
		for (let i = 0; i < document.lineCount; i++) {
			if (document.lineAt(i).text.startsWith(heading)) {
				line = i;
				break;
			}
		}
	}
	const at = new vscode.Position(line, 0);
	await vscode.window.showTextDocument(document, { selection: new vscode.Range(at, at), preview: false });
}

/**
 * Facade: Open Chat Room. The rooms, the one with the latest message first, each by the agent the person
 * started; the one picked opens at its end.
 */
export async function pickRoom(rooms: readonly ChatRoom[]): Promise<void> {
	if (!rooms.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t("No chat room has a message yet: each agent you start has one, from its task on."));
		return;
	}
	const picked = await vscode.window.showQuickPick(rooms.map(room => {
		const time = new Date(room.lastTime).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' });
		return {
			label: describe(room.root),
			description: room.live ? room.root.worktree : vscode.l10n.t("{0}, ended", room.root.worktree),
			detail: room.messages === 1
				? vscode.l10n.t("1 message, at {0}", time)
				: vscode.l10n.t("{0} messages, the last at {1}", room.messages, time),
			room
		};
	}), { title: vscode.l10n.t("Open Chat Room"), placeHolder: vscode.l10n.t("The chat room of an agent you started: every message of it and the agents it started") });
	if (picked) {
		await openRoom(picked.room.file);
	}
}

/**
 * Facade: Delete Chat Rooms asks once, saying it cannot be undone, and that the agents keep the messages
 * of this session: answers whether the person said to delete them.
 */
export async function confirmDeleteRooms(): Promise<boolean> {
	const remove = vscode.l10n.t("Delete");
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t("Delete the chat rooms of this workspace?"),
		{ modal: true, detail: vscode.l10n.t("They are the record of every message between your agents and you, and go for good, with the files of long messages only they still need. The agents keep the messages of this session: they can still fetch them. This cannot be undone.") },
		remove
	);
	return answer === remove;
}
