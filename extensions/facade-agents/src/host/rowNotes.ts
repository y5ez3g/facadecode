/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Kernel } from '../common/kernel/kernel';
import { Participant } from '../common/kernel/model';

/*
 * The agents working in each folder, on the folder's row of the workspace bar (L2-PLAN, step 31): a
 * robot, the agent's name and its state, as the note after the row's name. The notes are sent all at
 * once, every time: rows of folders nobody works in any more lose theirs, even ones an extension host
 * before this one noted.
 */

const DEBOUNCE_MS = 200;

export class RowNotes implements vscode.Disposable {

	/** The notes last sent, to send nothing when they are the same. */
	private shown: string | undefined;
	private readonly subscription: { dispose(): void };
	private timer: ReturnType<typeof setTimeout> | undefined;
	private available = true;

	constructor(private readonly kernel: Kernel, private readonly log: (message: string) => void) {
		this.subscription = kernel.onDidAppend(event => {
			if (event.type === 'participant.joined' || event.type === 'participant.state') {
				this.schedule();
			}
		});
		this.schedule();
	}

	dispose(): void {
		this.subscription.dispose();
		clearTimeout(this.timer);
		// Facade's notes go with Facade's agents.
		if (this.available && this.shown !== '[]') {
			void vscode.commands.executeCommand('_facade.row.notes', []).then(undefined, () => undefined);
		}
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.update(), DEBOUNCE_MS);
	}

	private async update(): Promise<void> {
		if (!this.available) {
			return;
		}
		const byFolder = new Map<string, { folder: vscode.Uri; parts: string[] }>();
		for (const participant of this.kernel.state.participants.values()) {
			if (!working(participant)) {
				continue;
			}
			const key = comparable(participant.place!);
			let entry = byFolder.get(key);
			if (!entry) {
				entry = { folder: vscode.Uri.file(participant.place!), parts: [] };
				byFolder.set(key, entry);
			}
			entry.parts.push(`$(robot) ${participant.name} ${participant.state}`);
		}
		const notes = [...byFolder.values()].map(({ folder, parts }) => ({ folder, note: parts.join('  ') }));
		const sent = JSON.stringify(notes.map(({ folder, note }) => [folder.fsPath, note]));
		if (sent === this.shown) {
			return;
		}
		try {
			await vscode.commands.executeCommand('_facade.row.notes', notes);
			this.shown = sent;
		} catch (err) {
			// A window without Facade's workbench commands has no rows to note.
			this.available = false;
			this.log(`Rows are not noted with their agents: ${(err as Error).message}`);
		}
	}
}

function working(participant: Participant): boolean {
	return participant.kind === 'agent' && !!participant.place && participant.state !== 'stopped' && participant.state !== 'failed';
}

function comparable(folder: string): string {
	const resolved = path.resolve(folder);
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}
