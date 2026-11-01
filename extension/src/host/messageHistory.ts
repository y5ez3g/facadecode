/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Messages } from '../core/messagePorts';
import { conversationsOf, conversationText, conversationTitle, pickConversation } from '../ui/pickers/messageHistory';

/** The command of UX-3.1 that Message History is opened by. */
export const MESSAGE_HISTORY_COMMAND = 'facade.messageHistory';

const SCHEME = 'facade-message-history';

export interface MessageHistoryDeps {
	readonly messages: Pick<Messages, 'history' | 'onDidRecord'>;
	readonly language?: string;
}

/**
 * Message History (COLLABORATION-3.2, UX-3.1): `Message History...` lists this window's one-to-one conversations, and each opens as a
 * read-only document - text only, kept current as its records change. Nothing in it sends, replays, deletes or hides.
 */
export function registerMessageHistory(deps: MessageHistoryDeps): vscode.Disposable[] {
	const language = deps.language ?? vscode.env.language;
	const changed = new vscode.EventEmitter<vscode.Uri>();
	const shown = new Map<string, vscode.Uri>();
	const provider: vscode.TextDocumentContentProvider = {
		onDidChange: changed.event,
		provideTextDocumentContent: uri => {
			const conversation = conversationsOf(deps.messages.history()).find(each => each.key === uri.query);
			return conversation ? conversationText(conversation, language) : `${vscode.l10n.t("These messages are no longer available.")}\n`;
		}
	};
	const open = async (conversation: ReturnType<typeof conversationsOf>[number]) => {
		// The tab is titled by the conversation's sides; its key decides what it shows
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${conversationTitle(conversation).replace(/[\\/]/g, '-')}`, query: conversation.key });
		shown.set(uri.toString(), uri);
		changed.fire(uri);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
	};
	return [
		changed,
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
		vscode.workspace.onDidCloseTextDocument(document => void shown.delete(document.uri.toString())),
		deps.messages.onDidRecord(() => shown.forEach(uri => changed.fire(uri))),
		vscode.commands.registerCommand(MESSAGE_HISTORY_COMMAND, () => pickConversation({ history: () => deps.messages.history(), onDidRecord: deps.messages.onDidRecord, open, language }))
	];
}
