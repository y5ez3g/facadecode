/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebardrop.css';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { $, addDisposableListener, append, EventHelper, EventType, isHTMLElement, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { CodeWindow, mainWindow } from '../../../../base/browser/window.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { containsDragType, extractEditorsAndFilesDropData, IDraggedResourceEditorInput } from '../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { hasWorkspaceFileExtension } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkspaceBarService } from './workspaceBarService.js';

/**
 * Room for any `.code-workspace` anyone actually writes, and a stop if something else is dropped.
 * The same 1MB `sessions/services/sessions/browser/sessionsRecentWorkspacesService.ts` reads with.
 */

/**
 * Whether what is being dragged came from outside the application.
 *
 * ⚠️ `Files` is set by the operating system and cannot be set from script, so it is the one type
 * that separates a drag from the file manager from a drag the workbench started itself. Everything
 * dragged inside - an editor to another group, a view to another panel, a file to another folder -
 * carries `CodeEditors`, `CodeFiles` or `ResourceURLs` instead and keeps its own drop target.
 */
function isExternalDrag(e: DragEvent): boolean {
	return containsDragType(e, DataTransfers.FILES);
}

const BAR = '.part.workspacebar';
const EDITOR = '.monaco-editor';
const TERMINAL = '.terminal-wrapper';
const TEXT_FIELD = 'input, textarea, [contenteditable="true"]';

/**
 * Whether the drop is asking for the path as text rather than for somewhere to go, which is not this
 * handler's business. Three ways to ask:
 *
 * - the terminal, which sends it to the shell (`terminalInstance.ts`, `onDropFile`)
 * - a text field, which takes it as typing
 * - `Shift` over a document, the editor's own gesture for writing the path in
 *   (`editor.dropIntoEditor.enabled`, "Insert Relative Path" and the rest of `defaultProviders.ts`)
 *
 * ⚠️ `Shift` is a modifier, not a place, so it does not break the one rule: where a drag is released
 * still decides nothing, and what was asked for still decides everything.
 *
 * ⚠️ `dropIntoEditor` is the same setting `editorDropTarget` gates its own bypass on. Stepping over a
 * `Shift` drop it is not going to take hands a folder to `ResourcesDropHandler`, which opens a
 * second window.
 *
 * ⚠️ Not any `textarea`. The editor keeps IME helpers in its own DOM - a visible, 161x31,
 * pointer-events-auto `textarea.ime-text-area` sits behind the text today. Behind is not a
 * guarantee, and a folder falling through from there reaches `editorDropTarget`, which opens a
 * second window.
 */
export function takesThePathAsText(e: DragEvent, dropIntoEditor: boolean): boolean {
	const target = e.target;
	if (!isHTMLElement(target)) {
		return false;
	}

	if (target.closest(TERMINAL)) {
		return true;
	}

	if (e.shiftKey && dropIntoEditor && target.closest(EDITOR)) {
		return true;
	}

	const field = target.closest(TEXT_FIELD);

	return !!field && !field.closest(EDITOR);
}

/**
 * Whether this drop is the bar's to answer.
 *
 * ⚠️ Only over the bar. The rest of the window already has an answer for a file from outside, and
 * each one is different: the explorer copies it into the folder it was dropped on, the chat input
 * attaches it, the Extensions view installs a `.vsix`, a webview hands it to its extension, and the
 * editor area opens it - or, for a folder, takes it into the workspace and moves onto it. Stopping
 * every one of those to answer "added to the workspace" would take four upstream features away to
 * pay for one, and the one is already reachable everywhere it should be.
 */
export function isTheBars(e: DragEvent): boolean {
	const target = e.target;

	return isHTMLElement(target) && !!target.closest(BAR);
}

/**
 * Splits what was dropped into editors to open and folders to add, each in the order it arrived.
 *
 * `standsFor` answers, for the item at the same index, which folders that item stands for, or
 * nothing if it is a file. A workspace file expands where it was dropped rather than at the end.
 */
/** What a dropped resource turns out to be: folders to take in, a window to open, or a file to open. */
export type DroppedThing = URI[] | 'window' | undefined;

export function splitDrop(dropped: readonly IDraggedResourceEditorInput[], standsFor: readonly DroppedThing[]): { editors: IDraggedResourceEditorInput[]; folders: URI[]; workspaces: URI[] } {
	const editors: IDraggedResourceEditorInput[] = [];
	const folders: URI[] = [];
	const workspaces: URI[] = [];

	for (let index = 0; index < dropped.length; index++) {
		const found = standsFor[index];
		if (found === 'window') {
			const resource = dropped[index].resource;
			if (resource) {
				workspaces.push(resource);
			}
		} else if (found) {
			folders.push(...found);
		} else {
			editors.push(dropped[index]);
		}
	}

	return { editors, folders, workspaces };
}

/**
 * What the window looks like while something from outside is over it.
 *
 * ⚠️ The message cannot name what was picked up: a `DataTransferItem` will not give up a path until
 * the drop, so file and folder are indistinguishable for as long as this is on screen.
 */
class DropOverlay extends Disposable {

	private element: HTMLElement | undefined;

	constructor(private readonly container: () => HTMLElement | undefined) {
		super();

		this._register(toDisposable(() => this.element?.remove()));
	}

	show(): void {
		if (!this.element) {
			// Built on the first drag rather than up front: an auxiliary window registers itself
			// before its workbench container is in the document.
			const container = this.container();
			if (!container) {
				return;
			}

			this.element = append(container, $('.workspacebar-drop-overlay'));
			this.element.setAttribute('aria-hidden', 'true');
			append(this.element, $('.workspacebar-drop-overlay-message')).textContent = localize('workspaceBarDrop.message', "Drop files to open, folders to add to the workspace");
		}

		this.element.classList.add('visible');
	}

	hide(): void {
		this.element?.classList.remove('visible');
	}
}

/**
 * What a drop from outside the application means - the same thing everywhere in the window.
 *
 * ⚠️ One handler in the capture phase, not a target per part: upstream answers this five different
 * ways depending on where the pointer was released, and two of them - a second window, and
 * `createAndEnterWorkspace` - are closed to us, since this window keeps one workspace identity.
 */
export class WorkspaceBarDropTarget extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspaceBarDrop';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IHostService private readonly hostService: IHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(this.registerWindow(window));
		}, { window: mainWindow, disposables: this._store }));
	}

	private get dropIntoEditorEnabled(): boolean {
		return this.configurationService.getValue<boolean>('editor.dropIntoEditor.enabled');
	}

	private registerWindow(targetWindow: CodeWindow): IDisposable {
		const disposables = new DisposableStore();
		// ⚠️ Over the bar, not over the window: the overlay is a promise about what letting go will
		// do, and letting go anywhere else is somebody else's promise to make.
		const overlay = disposables.add(new DropOverlay(() => this.layoutService.getContainer(targetWindow, Parts.WORKSPACEBAR_PART)));

		// Every element the pointer crosses fires its own enter and leave, so leaving one of them is
		// not leaving the window. ⚠️ Counted outside `listen`, below, so that a surface this handler
		// steps over still pairs its enter with its leave - counting only what is handled strands the
		// tally at one and the overlay never comes down again.
		let depth = 0;

		// ⚠️ And a backstop, because a drag does not always end with a leave or a drop: Escape, or the
		// system taking it away, can stop the events dead with the tally still standing. The cost of
		// being wrong here is an overlay covering the whole window until the next drag.
		const hideEventually = disposables.add(new RunOnceScheduler(() => {
			depth = 0;
			overlay.hide();
		}, 1000));

		// ⚠️ On the body, in the capture phase. Capture so that this runs before the bar's own list
		// lights up a row, and on the body so that it is always after the listeners the webviews and
		// the drag tracker put on the window itself - those have to keep seeing the drag.
		const listen = (type: string, handler: (e: DragEvent) => void) => {
			disposables.add(addDisposableListener(targetWindow.document.body, type, (e: DragEvent) => {
				if (!isExternalDrag(e) || !isTheBars(e)) {
					return;
				}

				// ⚠️ Left alone, not just left unhandled: the surface underneath has its own drop
				// target, and stopping the event here would take the drag away from it. The overlay
				// comes down with it, being a promise about what letting go will do. Not counted
				// either, so crossing a terminal mid-drag reads as leaving and re-entering.
				if (takesThePathAsText(e, this.dropIntoEditorEnabled)) {
					hideEventually.cancel();
					overlay.hide();

					return;
				}

				EventHelper.stop(e, true);
				handler(e);
			}, true));
		};

		// The tally, kept for every external drag and never stopping one.
		const count = (type: string, by: number) => {
			disposables.add(addDisposableListener(targetWindow.document.body, type, (e: DragEvent) => {
				if (!isExternalDrag(e) || !isTheBars(e)) {
					return;
				}

				depth = Math.max(0, depth + by);
				if (depth === 0) {
					hideEventually.cancel();
					overlay.hide();
				}
			}, true));
		};

		count(EventType.DRAG_ENTER, 1);
		count(EventType.DRAG_LEAVE, -1);

		// ⚠️ Shown here rather than on enter: `Shift` goes down and up in the middle of a drag, and
		// this is the only event still arriving while it does.
		listen(EventType.DRAG_OVER, e => {
			overlay.show();
			hideEventually.schedule();

			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
		});

		listen(EventType.DROP, e => {
			// No `dragleave` follows a drop, so the tally is cleared here or the overlay never goes.
			depth = 0;
			hideEventually.cancel();
			overlay.hide();

			this.handleDrop(e, targetWindow).then(undefined, onUnexpectedError);
		});

		return disposables;
	}

	private async handleDrop(e: DragEvent, targetWindow: Window): Promise<void> {
		const dropped = await this.instantiationService.invokeFunction(accessor => extractEditorsAndFilesDropData(accessor, e));
		if (!dropped.length) {
			return;
		}

		await this.hostService.focus(targetWindow);

		return this.apply(dropped);
	}

	/**
	 * What a drop turns into, once it is known what was dropped.
	 *
	 * ⚠️ Split from `handleDrop` so a test can say what a drop of folders does: a `DragEvent`
	 * carrying real file paths cannot be synthesised, so a test that had to start from one could only
	 * ever assert on nothing being dropped.
	 */
	async apply(dropped: readonly IDraggedResourceEditorInput[]): Promise<void> {
		const { editors, folders, workspaces } = await this.sort(dropped);

		if (workspaces.length) {
			await this.hostService.openWindow(workspaces.map((workspaceUri: URI) => ({ workspaceUri })));
		}

		if (folders.length) {
			// ⚠️ `add`, not `addAndShow`: this handler only ever sees what landed **on the bar**,
			// and the bar is the list. Dropping a folder there is filling the list - often several
			// at once - and being walked to the last of them is a switch nobody asked for. A folder
			// dropped anywhere else in the window reaches `ResourcesDropHandler`, which does mean
			// "show me this" and calls `addAndShow`.
			await this.workspaceBarService.add(folders);
		}

		if (editors.length) {
			this.workspacesService.addRecentlyOpened(coalesce(editors.map(editor => editor.resource)).map(fileUri => ({ fileUri })));

			await this.editorService.openEditors(editors.map(editor => ({
				...editor,
				options: { ...editor.options, pinned: true }
			})), undefined, { validateTrust: true });
		}
	}

	private async sort(dropped: readonly IDraggedResourceEditorInput[]): Promise<{ editors: IDraggedResourceEditorInput[]; folders: URI[]; workspaces: URI[] }> {
		return splitDrop(dropped, await Promise.all(dropped.map(editor => this.standsFor(editor.resource))));
	}

	/** What a dropped resource stands for: folders, a window, or a file to open. */
	private async standsFor(resource: URI | undefined): Promise<DroppedThing> {
		if (!resource || !this.fileService.hasProvider(resource)) {
			return undefined;
		}

		// ⚠️ A `.code-workspace` is a window, not a handful of folders. Taking its folders and leaving
		// its `settings`, `extensions`, `launch` and `tasks` behind would be the dangerous half of
		// "merge" wearing the word "add", and after it the file being written to would no longer be
		// the one the folders came from.
		if (hasWorkspaceFileExtension(resource)) {
			return 'window';
		}

		try {
			return (await this.fileService.stat(resource)).isDirectory ? [resource] : undefined;
		} catch (error) {
			// Gone between the drop and now. Opening it says so; guessing here would not.
			return undefined;
		}
	}

}

// ⚠️ Before the workbench restores, not after: the editor's own drop target is live as soon as a
// group is, and a drop landing in the gap takes the upstream path and opens a second window.
registerWorkbenchContribution2(WorkspaceBarDropTarget.ID, WorkspaceBarDropTarget, WorkbenchPhase.BlockRestore);
