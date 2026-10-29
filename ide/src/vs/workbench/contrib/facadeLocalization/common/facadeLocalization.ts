/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Off, the window never suggests a built-in display language (LOCALIZATION.md LC5). */
export const SuggestDisplayLanguageSettingId = 'facade.localization.suggestDisplayLanguage';

/** The built-in language packs' extension ids start with this (LC2). */
export const BuiltInPackIdPrefix = 'vscode.facade-language-pack-';

/**
 * The display language of the built-in pack that `osLocale`, the operating system's language, takes
 * (LC4), when `available` has it: Chinese and Portuguese by region and script, the rest by language.
 */
export function packLocaleFor(osLocale: string, available: readonly string[]): string | undefined {
	const [language, ...rest] = osLocale.toLowerCase().replace(/_/g, '-').split('-');
	let wanted: string | undefined;
	if (language === 'zh') {
		const traditional = !rest.includes('hans') && rest.some(part => part === 'hant' || part === 'tw' || part === 'hk' || part === 'mo');
		wanted = traditional ? 'zh-tw' : 'zh-cn';
	} else if (language === 'pt') {
		wanted = rest.includes('br') ? 'pt-br' : undefined;
	} else {
		wanted = language;
	}
	return wanted !== undefined && available.includes(wanted) ? wanted : undefined;
}

/**
 * Whether a display language was chosen (LC4): `argv`, the parsed `argv.json`, names one, as Configure
 * Display Language writes it, or `cliLocale`, the `--locale` the window was started with, does.
 */
export function isDisplayLanguageChosen(argv: unknown, cliLocale: string | undefined): boolean {
	return !!cliLocale || (typeof argv === 'object' && argv !== null && typeof (argv as { locale?: unknown }).locale === 'string');
}

/**
 * `english` led by its translation, as VS Code's own language pack suggestion shows it, so a person
 * reads it in the language offered and still recognizes it in English.
 */
export function bilingual(translation: string | undefined, english: string): string {
	return translation && translation !== english ? `${translation} (${english})` : english;
}
