/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { displayLine } from '../base/text';
import type { HumanContactPort, MessageRecord } from '../core/messagePorts';
import { recordText, sideName } from '../ui/pickers/messageHistory';
import { notificationText } from './notify';

const SCHEME = 'facade-message';

/**
 * An agent's explicit message to the person (COLLABORATION-2.3, UX-1.2): an information notification in this window alone, naming the
 * source agent with a short plain-text summary, and Show opening the complete message as a read-only document - the saved record as it
 * is when shown, looked up by its ID. It is shown even while that agent's terminal is visible; no urgency is inferred, nothing goes to
 * another window, and dismissing it changes nothing.
 */
export class WindowContact implements HumanContactPort, vscode.Disposable {
	private readonly registration: vscode.Disposable;
	/** Where the saved records are read, as the message service gives it with each contact. */
	private saved: (id: string) => MessageRecord | undefined = () => undefined;

	/** `reveal` shows an agent's own terminal and card in this window. */
	constructor(private readonly reveal: (run: string) => Promise<unknown>, private readonly language: string = vscode.env.language) {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
			provideTextDocumentContent: uri => {
				const record = this.saved(uri.query);
				return record
					? `${vscode.l10n.t("Message {0} from {1}", record.alias, sideName(record.from))}\n\n${recordText(record, this.language)}`
					: `${vscode.l10n.t("This message is no longer available.")}\n`;
			}
		});
	}

	dispose(): void {
		this.registration.dispose();
	}

	contact(record: MessageRecord, saved: (id: string) => MessageRecord | undefined): boolean {
		this.saved = saved;
		const open = vscode.l10n.t("Open Message");
		const show = vscode.l10n.t("Show Agent");
		// {0} is the agent that wrote, {1} the first line of what it wrote (COLLABORATION-2.3, UX-1.2)
		const first = record.text.split(/\r?\n/).find(line => line.trim()) ?? record.text;
		const text = vscode.l10n.t("{0}: {1}", sideName(record.from), displayLine(first, 300));
		const sender = record.from.run;
		void vscode.window.showInformationMessage(notificationText(text), open, show).then(choice => {
			// What it opens failing to open changes nothing else, and is no unhandled failure of the window's
			if (choice === open) {
				this.open(record).catch(err => console.error(`Could not open message ${record.alias}: ${messageOf(err)}`));
			} else if (choice === show && sender !== 'facade' && sender !== '@human') {
				this.reveal(sender).catch(err => console.error(`Could not show the agent of message ${record.alias}: ${messageOf(err)}`));
			}
		});
		return true;
	}

	private async open(record: MessageRecord): Promise<void> {
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${record.alias} ${sideName(record.from).replace(/[\\/]/g, '-')}`, query: record.id });
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
	}
}
