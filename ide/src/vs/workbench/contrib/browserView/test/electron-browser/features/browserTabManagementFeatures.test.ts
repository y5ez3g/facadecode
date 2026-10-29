/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IResourceEditorInput } from '../../../../../../platform/editor/common/editor.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IBrowserViewWorkbenchService } from '../../../common/browserView.js';
import { LocalhostLinkOpenerContribution } from '../../../electron-browser/features/browserTabManagementFeatures.js';

suite('Browser Tab Management Features', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const links = [
		'https://claude.ai/code/artifact/0b5c',
		'https://claude.ai/artifact/7f3e',
		'https://www.claude.ai/',
		'https://example.com/a',
		'https://api.example.com/a',
		'https://docs.test/guide/intro',
		'https://docs.test/other',
		'http://docs.test/guide/intro',
		'mailto:someone@claude.ai',
		'http://localhost:5173/',
	];

	/**
	 * Gives each of the links to the localhost link opener under the given settings, and returns the view state of
	 * every Integrated Browser it opened.
	 */
	async function openLinks(settings: Record<string, unknown>): Promise<(object | undefined)[]> {
		const opened: (object | undefined)[] = [];
		const editorService = upcastPartial<IEditorService>({
			openEditor: async (editor: IResourceEditorInput) => {
				opened.push(editor.options?.viewState);
				return undefined;
			}
		} as Partial<IEditorService>);
		const opener = store.add(new LocalhostLinkOpenerContribution(
			upcastPartial<IOpenerService>({ registerExternalOpener: () => Disposable.None }),
			new TestConfigurationService(settings),
			editorService,
			NullTelemetryService,
			upcastPartial<IBrowserViewWorkbenchService>({ willUseRemoteProxy: () => false, getPreferredGroup: async () => ACTIVE_GROUP })
		));
		for (const link of links) {
			await opener.openExternal(link, { sourceUri: URI.parse(link) }, CancellationToken.None);
		}
		return opened;
	}

	test('opens the links named in facade.browser.openInIntegratedBrowser whatever the localhost setting is', async () => {
		assert.deepStrictEqual(await openLinks({
			'workbench.browser.openLocalhostLinks': false,
			'facade.browser.openInIntegratedBrowser': ['claude.ai', '*.example.com', 'https://docs.test/guide']
		}), [
			{ url: 'https://claude.ai/code/artifact/0b5c', isDefaultLinkOpen: false },
			{ url: 'https://claude.ai/artifact/7f3e', isDefaultLinkOpen: false },
			{ url: 'https://example.com/a', isDefaultLinkOpen: false },
			{ url: 'https://api.example.com/a', isDefaultLinkOpen: false },
			{ url: 'https://docs.test/guide/intro', isDefaultLinkOpen: false },
		]);
	});

	test('opens localhost links beside the named ones while the localhost setting is on', async () => {
		assert.deepStrictEqual(await openLinks({
			'workbench.browser.openLocalhostLinks': true,
			'facade.browser.openInIntegratedBrowser': ['claude.ai']
		}), [
			{ url: 'https://claude.ai/code/artifact/0b5c', isDefaultLinkOpen: false },
			{ url: 'https://claude.ai/artifact/7f3e', isDefaultLinkOpen: false },
			{ url: 'http://localhost:5173/', isDefaultLinkOpen: false },
		]);
	});

	test('opens no link for a facade.browser.openInIntegratedBrowser that is not a list', async () => {
		assert.deepStrictEqual(await openLinks({ 'facade.browser.openInIntegratedBrowser': 'claude.ai' }), []);
	});
});
