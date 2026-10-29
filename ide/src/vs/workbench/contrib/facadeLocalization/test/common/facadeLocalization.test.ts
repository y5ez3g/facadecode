/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bilingual, isDisplayLanguageChosen, packLocaleFor } from '../../common/facadeLocalization.js';

suite('facadeLocalization', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const builtIn = ['zh-cn', 'zh-tw', 'pt-br', 'es', 'ru', 'de', 'ja', 'fr', 'ko', 'tr', 'pl'];

	test('an operating system language takes the pack of its language, Chinese and Portuguese by region (LC4)', () => {
		const locales = ['zh-cn', 'zh-sg', 'zh-hans', 'zh-hans-hk', 'zh', 'zh-tw', 'zh-hk', 'zh-mo', 'zh-hant', 'zh_TW', 'pt-br', 'pt-pt', 'pt', 'de-ch', 'ja', 'fr-ca', 'es-419', 'it', 'en-us', 'id', 'vi'];
		assert.deepStrictEqual(Object.fromEntries(locales.map(locale => [locale, packLocaleFor(locale, builtIn) ?? null])), {
			'zh-cn': 'zh-cn', 'zh-sg': 'zh-cn', 'zh-hans': 'zh-cn', 'zh-hans-hk': 'zh-cn', 'zh': 'zh-cn',
			'zh-tw': 'zh-tw', 'zh-hk': 'zh-tw', 'zh-mo': 'zh-tw', 'zh-hant': 'zh-tw', 'zh_TW': 'zh-tw',
			'pt-br': 'pt-br', 'pt-pt': null, 'pt': null,
			'de-ch': 'de', 'ja': 'ja', 'fr-ca': 'fr', 'es-419': 'es',
			'it': null, 'en-us': null, 'id': null, 'vi': null,
		});
	});

	test('only a pack that is there is offered', () => {
		assert.deepStrictEqual([packLocaleFor('zh-tw', ['zh-cn']), packLocaleFor('de', [])], [undefined, undefined]);
	});

	test('a language chosen in argv.json or with --locale, English included, is never questioned (LC4)', () => {
		assert.deepStrictEqual([
			isDisplayLanguageChosen({ locale: 'en' }, undefined),
			isDisplayLanguageChosen({ locale: 'zh-cn' }, undefined),
			isDisplayLanguageChosen({}, 'en'),
			isDisplayLanguageChosen(undefined, 'de'),
			isDisplayLanguageChosen({ 'enable-crash-reporter': true }, undefined),
			isDisplayLanguageChosen(undefined, undefined),
			isDisplayLanguageChosen({ locale: 1 }, ''),
		], [true, true, true, true, false, false, false]);
	});

	test('the question leads with its translation and keeps the English', () => {
		assert.deepStrictEqual([
			bilingual('切换并重启', 'Change and Restart'),
			bilingual(undefined, 'Change and Restart'),
			bilingual('', 'Change and Restart'),
			bilingual('Change and Restart', 'Change and Restart'),
		], [
			'切换并重启 (Change and Restart)',
			'Change and Restart',
			'Change and Restart',
			'Change and Restart',
		]);
	});
});
