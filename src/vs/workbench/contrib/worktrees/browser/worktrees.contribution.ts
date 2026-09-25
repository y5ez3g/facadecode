/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { DeleteWorktreeAction, IWorktreeService, NewWorktreeAction, WorktreeService } from './worktrees.js';

// The workspace bar's worktrees: making one (WORKTREE.md section 7) and deleting one (section 10).
registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);
registerAction2(NewWorktreeAction);
registerAction2(DeleteWorktreeAction);
