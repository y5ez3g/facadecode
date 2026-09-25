/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions, facadeDialogButtonStyles, facadeDialogInputBoxStyles } from '../../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../../services/host/browser/host.js';

suite('Workbench dialogs - the options they are built with', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a facade dialog gets its own styles, button order, keyboard walk and overlay; any other is built as upstream builds it', () => {
		const describe = (extraClasses: string[]) => {
			const options = createWorkbenchDialogOptions(
				{ extraClasses, modalBlockExtraClasses: ['theirs'] },
				upcastPartial<IKeybindingService>({}),
				upcastPartial<ILayoutService>({}),
				upcastPartial<IHostService>({ setWindowDimmed: async () => { } })
			);
			return {
				buttonStyles: options.buttonStyles === facadeDialogButtonStyles ? 'facade' : options.buttonStyles === defaultButtonStyles ? 'default' : 'other',
				inputBoxStyles: options.inputBoxStyles === facadeDialogInputBoxStyles ? 'facade' : options.inputBoxStyles === defaultInputBoxStyles ? 'default' : 'other',
				dialogStyles: options.dialogStyles === defaultDialogStyles ? 'default' : { shadow: options.dialogStyles.dialogShadow, border: options.dialogStyles.dialogBorder },
				primaryButtonLast: !!options.primaryButtonLast,
				navigateBody: !!options.navigateBody,
				dimsWindowControls: !!options.onVisibilityChange,
				modalBlockExtraClasses: options.modalBlockExtraClasses,
			};
		};

		assert.deepStrictEqual({ facade: describe(['facade-dialog', 'mine']), upstream: describe(['theirs']) }, {
			facade: { buttonStyles: 'facade', inputBoxStyles: 'facade', dialogStyles: { shadow: undefined, border: 'var(--vscode-facadeDialog-border)' }, primaryButtonLast: true, navigateBody: true, dimsWindowControls: false, modalBlockExtraClasses: ['theirs', 'facade-dialog-block'] },
			upstream: { buttonStyles: 'default', inputBoxStyles: 'default', dialogStyles: 'default', primaryButtonLast: false, navigateBody: false, dimsWindowControls: true, modalBlockExtraClasses: ['theirs'] },
		});
	});
});
