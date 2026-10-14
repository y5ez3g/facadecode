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
		void vscode.window.showInformationMessage(vscode.l10n.t("No chat rooms have messages yet. A chat room is created when an agent is started."));
		return;
	}
	const picked = await vscode.window.showQuickPick(rooms.map(room => {
		const time = new Date(room.lastTime).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' });
		return {
			label: describe(room.root),
			description: room.live ? room.root.worktree : vscode.l10n.t("{0} (ended)", room.root.worktree),
			detail: room.messages === 1
				? vscode.l10n.t("1 message, at {0}", time)
				: vscode.l10n.t("{0} messages, latest at {1}", room.messages, time),
			room
		};
	}), { title: vscode.l10n.t("Open Chat Room"), placeHolder: vscode.l10n.t("Each chat room holds every message of an agent you started and of the agents it started") });
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
	// As VS Code asks before deleting what cannot be restored: a question, then what goes and that it is for good
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t("Are you sure you want to delete all chat rooms in this workspace?"),
		{ modal: true, detail: vscode.l10n.t("All messages between you and your agents in this workspace will be deleted. This action cannot be undone.") },
		remove
	);
	return answer === remove;
}
