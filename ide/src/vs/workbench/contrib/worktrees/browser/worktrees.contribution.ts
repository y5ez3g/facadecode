/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { DeleteWorktreeAction, IWorktreeService, NewWorktreeAction, UnfinishedWorktreeSetup, WorktreeService } from './worktrees.js';

// The workspace bar's worktrees: making one (WORKTREE.md WT-5) and deleting one (WT-8).
registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);
registerAction2(NewWorktreeAction);
registerAction2(DeleteWorktreeAction);
registerWorkbenchContribution2(UnfinishedWorktreeSetup.ID, UnfinishedWorktreeSetup, WorkbenchPhase.Eventually);
