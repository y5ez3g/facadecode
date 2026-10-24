/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, WorkspaceTrustRequestOptions } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { WorkspaceTrustRequestHandler } from '../../browser/workspace.contribution.js';

suite('Workspace trust - asking to trust the workspace', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a request made before the trust is worked out - a remote window\'s terminals coming back before its remote is resolved - waits for it, and asks nothing once the workspace is trusted: its worktree is its trusted repository\'s (REMOTE.md R7)', async () => {
		const initialized = new DeferredPromise<void>();
		let trusted = false;
		const requests = disposables.add(new Emitter<WorkspaceTrustRequestOptions | undefined>());
		const asked: string[] = [];
		const completed: (boolean | undefined)[] = [];

		disposables.add(new WorkspaceTrustRequestHandler(
			upcastPartial<IDialogService>({ prompt: async (prompt: IPrompt<unknown>) => { asked.push(prompt.message); return { result: 'Cancel' }; } }),
			upcastPartial<ICommandService>({}),
			upcastPartial<ILabelService>({}),
			upcastPartial<IWorkspaceContextService>({ getWorkspace: () => testWorkspace(URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+host', path: '/wt' })) }),
			upcastPartial<IWorkspaceTrustManagementService>({ workspaceResolved: Promise.resolve(), workspaceTrustInitialized: initialized.p, isWorkspaceTrusted: () => trusted }),
			upcastPartial<IWorkspaceTrustRequestService>({
				onDidInitiateOpenFilesTrustRequest: Event.None,
				onDidInitiateResourcesTrustRequest: Event.None,
				onDidInitiateWorkspaceTrustRequest: requests.event,
				completeWorkspaceTrustRequest: async (answer?: boolean) => { completed.push(answer); },
				cancelWorkspaceTrustRequest: () => { completed.push(undefined); }
			}),
			upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: 'ssh-remote+host' }),
			upcastPartial<IProductService>({})
		));

		requests.fire(undefined);
		await timeout(0);
		const whileWorkedOut = [...asked];
		trusted = true;
		initialized.complete();
		await timeout(0);

		assert.deepStrictEqual({ whileWorkedOut, asked, completed }, { whileWorkedOut: [], asked: [], completed: [true] });
	});
});
