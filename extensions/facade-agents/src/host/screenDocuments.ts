/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { EndedAgent } from '../core/ports';
import { FinalScreen, readFinalScreen, SCREEN_LANGUAGE } from '../record/screens';

/** The scheme of an agent's last screen, as an editor shows it. */
const SCREEN_SCHEME = 'facade-screen';

/**
 * The agents' last screens as read-only documents, named after the agent - `@name #a7 · last screen` -
 * holding the final screen the window kept as the terminal ended, in the editor's own find, selection and
 * copy. Where none was kept, how the agent ended. Registered as the extension starts, they open with Facade
 * agents off too.
 */
export class ScreenDocuments implements vscode.TextDocumentContentProvider {

	/** Registers the documents' scheme in the window: until the extension stops. */
	static register(): { readonly documents: ScreenDocuments; readonly registration: vscode.Disposable } {
		const documents = new ScreenDocuments();
		return { documents, registration: vscode.workspace.registerTextDocumentContentProvider(SCREEN_SCHEME, documents) };
	}

	/** Opens the last screen of `agent` in the editor. */
	async open(agent: EndedAgent): Promise<void> {
		const title = vscode.l10n.t("@{0} #a{1} · last screen", agent.name, agent.id);
		const uri = vscode.Uri.from({ scheme: SCREEN_SCHEME, path: `/${title}`, query: new URLSearchParams({ file: agent.finalScreen, ending: agent.ending }).toString() });
		const document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), SCREEN_LANGUAGE);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const query = new URLSearchParams(uri.query);
		const title = uri.path.replace(/^\//, '');
		const ending = query.get('ending') ?? '';
		const file = query.get('file') ?? '';
		let screen: FinalScreen | undefined;
		try {
			screen = file ? readFinalScreen(file) : undefined;
		} catch (err) {
			return vscode.l10n.t("{0}: its file, {1}, could not be read: {2}. It ended - {3}.", title, file, messageOf(err), ending);
		}
		if (!screen) {
			return vscode.l10n.t("{0}: no last screen was kept. It ended - {1}. The window keeps one as an agent's terminal closes or its process ends - not of an agent that ended before its terminal was made, nor while no window was there, nor as the whole window closed.", title, ending);
		}
		const parts = [vscode.l10n.t("{0}, kept as its terminal closed. It ended - {1}.", title, ending)];
		if (screen.frame) {
			parts.push(vscode.l10n.t("The last full-screen frame it drew, before it left it:"), screen.frame.join('\n'));
		}
		parts.push(screen.frame ? vscode.l10n.t("Its screen as its terminal ended:") : '', screen.final.lines.join('\n'));
		return parts.filter(part => part !== '').join('\n\n');
	}
}
