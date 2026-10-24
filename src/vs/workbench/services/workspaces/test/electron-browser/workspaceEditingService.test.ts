/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService, IWorkspaceIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { ILifecycleService, InternalBeforeShutdownEvent, ShutdownReason, WillShutdownEvent } from '../../../lifecycle/common/lifecycle.js';
import { NativeWorkspaceEditingService } from '../../electron-browser/workspaceEditingService.js';
import { workbenchInstantiationService } from '../../../../test/electron-browser/workbenchTestServices.js';

suite('NativeWorkspaceEditingService - an untitled workspace as the window closes', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('it is deleted once the window does close, not as its question is answered: another question cancelled - the agents\' - keeps the window on it, with its folders (WORKSPACE.md W11; REMOTE.md RM-39)', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables.add(new DisposableStore()));
		const untitled = joinPath(instantiationService.invokeFunction(accessor => accessor.get(IWorkbenchEnvironmentService)).untitledWorkspacesHome, '1792', 'workspace.json');
		const deleted: string[] = [];
		instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService) as TestContextService).setWorkspace({ id: '1792', folders: [], configuration: untitled });
		instantiationService.stub(IWorkspacesService, { deleteUntitledWorkspace: async (workspace: IWorkspaceIdentifier) => { deleted.push(workspace.id); } } as Partial<IWorkspacesService>);
		// VS Code's question answered Don't Save
		instantiationService.stub(IDialogService, { prompt: async ({ buttons }: IPrompt<boolean>) => ({ result: await buttons!.find(button => button.label.includes('n\'t Save'))!.run({ checkboxChecked: false }) }) } as unknown as Partial<IDialogService>);
		const beforeShutdown = disposables.add(new Emitter<InternalBeforeShutdownEvent>());
		const shutdownVeto = disposables.add(new Emitter<void>());
		const willShutdown = disposables.add(new Emitter<WillShutdownEvent>());
		instantiationService.stub(ILifecycleService, { onBeforeShutdown: beforeShutdown.event, onShutdownVeto: shutdownVeto.event, onWillShutdown: willShutdown.event } as Partial<ILifecycleService>);
		disposables.add(instantiationService.createInstance(NativeWorkspaceEditingService));

		/** Closes the workspace, as File > Close Workspace does, and answers whether this service kept the window. */
		const close = async () => {
			const vetos: (boolean | Promise<boolean>)[] = [];
			beforeShutdown.fire({ reason: ShutdownReason.LOAD, veto: value => { vetos.push(value); }, finalVeto: () => { } });
			return (await Promise.all(vetos)).some(veto => veto);
		};

		// Answered, but the agents' question is cancelled: the window stays
		const keptByIt = await close();
		shutdownVeto.fire();
		const afterCancelled = [...deleted];

		// Answered again, and nothing keeps the window
		await close();
		const joiners: Promise<void>[] = [];
		willShutdown.fire({ reason: ShutdownReason.LOAD, join: promise => { joiners.push(typeof promise === 'function' ? promise() : promise); }, joiners: () => [], force: () => { }, token: CancellationToken.None });
		await Promise.all(joiners);

		assert.deepStrictEqual({ keptByIt, afterCancelled, afterClosed: deleted }, { keptByIt: false, afterCancelled: [], afterClosed: ['1792'] });
	});
});
