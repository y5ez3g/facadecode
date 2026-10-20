/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks `locales/<folder>/facade.i18n.json` against `locales/facade.i18n.en.json` without a build:
 * every entry there and nothing else, placeholders, code, links and mnemonics kept, VS Code not named
 * where the English does not (LOCALIZATION.md LC7). The build checks the same and more.
 *
 * node build/lib/facade/checkTranslations.ts [folder...]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkEntries, findBrandLeaks, findBrokenParts, packLanguages, readFacadeStrings, type Strings } from './languagePacks.ts';

const root = path.join(import.meta.dirname, '..', '..', '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'facade.i18n.en.json'), 'utf8')) as Strings;
const folders = process.argv.slice(2).length ? process.argv.slice(2) : packLanguages.map(language => language.folder);

let failed = false;
for (const folder of folders) {
	const translations = readFacadeStrings(root, folder);
	const { missing, extra } = checkEntries(source, source, translations);
	const broken = findBrokenParts(source, translations);
	const leaks = findBrandLeaks(source, translations);
	const empty = Object.values(translations).flatMap(sections => Object.values(sections).flatMap(entries => Object.entries(entries).filter(([, value]) => !value.trim())));
	const count = missing.length + extra.length + broken.length + leaks.length + empty.length;
	console.log(`${folder}: ${count ? `${missing.length} missing, ${extra.length} extra, ${broken.length} broken, ${leaks.length} naming VS Code, ${empty.length} empty` : 'ok'}`);
	for (const ref of [...missing, ...extra].slice(0, 5)) {
		console.log(`  ${ref.id} ${ref.section} ${JSON.stringify(ref.key)}`);
	}
	for (const ref of [...broken, ...leaks].slice(0, 5)) {
		console.log(`  ${ref.id} ${ref.section} ${JSON.stringify(ref.key)}\n    en: ${ref.english}\n    tr: ${ref.translation}`);
	}
	failed ||= count > 0;
}
process.exitCode = failed ? 1 : 0;
