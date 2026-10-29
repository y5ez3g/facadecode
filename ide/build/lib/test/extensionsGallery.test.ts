/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { namesMicrosoftGallery } from '../extensionsGallery.ts';

suite('extensionsGallery', () => {

	test('Microsoft\'s marketplace is named, wherever it appears', () => {
		const microsoft = [
			{ serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery' },
			{ itemUrl: 'https://marketplace.visualstudio.com/items' },
			{ resourceUrlTemplate: 'https://{publisher}.gallerycdn.vsassets.io/extensions/{publisher}/{name}/{version}/{path}' },
			{ resourceUrlTemplate: 'https://{publisher}.gallerycdn.azure.cn/extensions/{path}' },
			{ controlUrl: 'https://az764295.vo.msecnd.net/extensions/marketplace.json', nlsBaseUrl: 'https://www.vsassets.io/nls' },
			// a fork's own service with Microsoft's cdn behind it is still Microsoft's cdn
			{ serviceUrl: 'https://open-vsx.org/vscode/gallery', resourceUrlTemplate: 'https://x.vsassets.io/{path}' }
		];

		for (const gallery of microsoft) {
			assert.strictEqual(namesMicrosoftGallery(gallery), true, JSON.stringify(gallery));
		}
	});

	test('a registry a fork may use is not', () => {
		const allowed = [
			{
				serviceUrl: 'https://open-vsx.org/vscode/gallery',
				itemUrl: 'https://open-vsx.org/vscode/item',
				resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
				controlUrl: '',
				nlsBaseUrl: ''
			},
			{ serviceUrl: 'https://extensions.example.com/gallery' },
			// ⚠️ The host has to end in one of them: a name that merely contains one does not count
			{ serviceUrl: 'https://vsassets.io.example.com/gallery' },
			{ serviceUrl: 'https://not-marketplace.visualstudio.com.evil.test/gallery' }
		];

		for (const gallery of allowed) {
			assert.strictEqual(namesMicrosoftGallery(gallery), false, JSON.stringify(gallery));
		}
	});

	test('no gallery at all is not one', () => {
		assert.strictEqual(namesMicrosoftGallery(undefined), false);
		assert.strictEqual(namesMicrosoftGallery({}), false);
		assert.strictEqual(namesMicrosoftGallery({ serviceUrl: '' }), false);
	});

	test('userinfo and a port do not hide the host', () => {
		assert.strictEqual(namesMicrosoftGallery({ serviceUrl: 'https://user:pw@marketplace.visualstudio.com:443/gallery' }), true);
	});
});
