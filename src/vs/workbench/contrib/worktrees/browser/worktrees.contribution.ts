/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { NewWorktreeAction } from './worktrees.js';

// The workspace bar's worktrees: making one (WORKTREE.md section 7).
registerAction2(NewWorktreeAction);
