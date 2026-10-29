/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getL10nJson } from '@vscode/l10n-dev';

/**
 * A language the application is built with (LOCALIZATION.md LC1).
 */
export interface PackLanguage {
	/** The display language id, as `--locale` and a `localizations` contribution name it. */
	readonly id: string;
	/** The vscode-loc pack it starts from: `i18n/vscode-language-pack-<pack>`, in vscode-loc's case. */
	readonly pack: string;
	/** Its folder under `locales/`, which holds Facade Code's translations. */
	readonly folder: string;
}

export const packLanguages: readonly PackLanguage[] = [
	{ id: 'zh-cn', pack: 'zh-hans', folder: 'zh-CN' },
	{ id: 'zh-tw', pack: 'zh-hant', folder: 'zh-TW' },
	{ id: 'pt-br', pack: 'pt-BR', folder: 'pt-BR' },
	{ id: 'es', pack: 'es', folder: 'es' },
	{ id: 'ru', pack: 'ru', folder: 'ru' },
	{ id: 'de', pack: 'de', folder: 'de' },
	{ id: 'ja', pack: 'ja', folder: 'ja' },
	{ id: 'fr', pack: 'fr', folder: 'fr' },
	{ id: 'ko', pack: 'ko', folder: 'ko' },
	{ id: 'tr', pack: 'tr', folder: 'tr' },
	{ id: 'pl', pack: 'pl', folder: 'pl' },
];

/**
 * The microsoft/vscode-loc commit Microsoft's translations are taken from (LC6): the last one that
 * updated the strings when this was pinned.
 */
export const vscodeLocCommit = '0f157dee0cdcbf58cdf51a221ee94751c7f35e75';

/**
 * Strings by translation id - `vscode` for the window, an extension id for an extension - then by
 * section - a module for the window, `package` or `bundle` for an extension - then by key. A pack's
 * translation files, Facade Code's files under `locales/` and the build's English all take this shape.
 */
export type Strings = Record<string, Record<string, Record<string, string>>>;

/** One string, as a check reports it. */
export interface StringRef {
	readonly id: string;
	readonly section: string;
	readonly key: string;
	readonly english: string;
}

/**
 * The parts of the product that are off by default and keep only Microsoft's coverage (LC3): chat,
 * agent sessions, the agent host and the Copilot extension.
 */
const excludedModule = /^vs\/sessions\/|\/(chat|chatSessions|inlineChat|sessions|agentHost|agentsVoice|mcp|aiStats|remoteCodingAgents|copilot)(\/|$)/i;
const excludedExtension = new Set(['github.copilot-chat']);

export function isExcluded(id: string, section: string): boolean {
	return id === 'vscode' ? excludedModule.test(section) : excludedExtension.has(id);
}

/** `base` with `overlay`'s strings over it; neither is changed. */
export function mergeStrings(base: Strings, overlay: Strings): Strings {
	const merged: Strings = {};
	for (const source of [base, overlay]) {
		for (const [id, sections] of Object.entries(source)) {
			for (const [section, strings] of Object.entries(sections)) {
				Object.assign((merged[id] ??= {})[section] ??= {}, strings);
			}
		}
	}
	return merged;
}

function* eachString(strings: Strings): Generator<{ id: string; section: string; key: string; value: string }> {
	for (const [id, sections] of Object.entries(strings)) {
		for (const [section, entries] of Object.entries(sections)) {
			for (const [key, value] of Object.entries(entries)) {
				yield { id, section, key, value };
			}
		}
	}
}

/** The English strings `translated` has no translation for, or a blank one, less the excluded ones. */
export function findUntranslated(english: Strings, translated: Strings): StringRef[] {
	const missing: StringRef[] = [];
	for (const { id, section, key, value } of eachString(english)) {
		const translation = translated[id]?.[section]?.[key];
		if (!isExcluded(id, section) && (translation === undefined || (!translation.trim() && !!value.trim()))) {
			missing.push({ id, section, key, english: value });
		}
	}
	return missing;
}

const otherProduct = /\bVS ?Code\b|\bVisual Studio Code\b/i;

/** The translations that name VS Code where the English does not (LC3). */
export function findBrandLeaks(english: Strings, translated: Strings): Array<StringRef & { readonly translation: string }> {
	const leaks: Array<StringRef & { readonly translation: string }> = [];
	for (const { id, section, key, value } of eachString(english)) {
		const translation = translated[id]?.[section]?.[key];
		if (translation !== undefined && otherProduct.test(translation) && !otherProduct.test(value)) {
			leaks.push({ id, section, key, english: value, translation });
		}
	}
	return leaks;
}

/**
 * What a translation has to carry over from its English unchanged: `{0}` and `${name}` placeholders,
 * code spans, link targets and `command:` links, and a menu's `&&` mnemonic, each as often as the
 * English has it.
 */
export function fixedParts(text: string): string[] {
	const parts = [
		...text.matchAll(/\{\d+\}|\$\{[\w.]+\}|&&/g),
		...text.matchAll(/`[^`\n]+`/g),
		...text.matchAll(/\]\(([^)\s]+)\)/g),
	].map(match => match[1] ?? match[0]);
	return parts.sort();
}

/** The translations of Facade Code's entries that dropped or added a fixed part (LC7). */
export function findBrokenParts(source: Strings, translations: Strings): Array<StringRef & { readonly translation: string }> {
	const broken: Array<StringRef & { readonly translation: string }> = [];
	for (const { id, section, key, value } of eachString(source)) {
		const translation = translations[id]?.[section]?.[key];
		if (translation !== undefined && fixedParts(translation).join('\n') !== fixedParts(value).join('\n')) {
			broken.push({ id, section, key, english: value, translation });
		}
	}
	return broken;
}

/** What is wrong with Facade Code's translations against their English (LC7). */
export interface EntryProblems {
	/** Entries whose English is no longer the build's: translate again. */
	readonly moved: StringRef[];
	/** Entries the build no longer has: drop them. */
	readonly gone: StringRef[];
	/** Entries of the English file this language lacks. */
	readonly missing: StringRef[];
	/** Entries this language has that the English file does not. */
	readonly extra: StringRef[];
}

/**
 * Compares `source`, the English Facade Code's entries were translated from, with the build's
 * `english` and with one language's `translations`.
 */
export function checkEntries(source: Strings, english: Strings, translations: Strings): EntryProblems {
	const problems: EntryProblems = { moved: [], gone: [], missing: [], extra: [] };
	for (const { id, section, key, value } of eachString(source)) {
		const current = english[id]?.[section]?.[key];
		if (current === undefined) {
			problems.gone.push({ id, section, key, english: value });
		} else if (current !== value) {
			problems.moved.push({ id, section, key, english: current });
		}
		if (translations[id]?.[section]?.[key] === undefined) {
			problems.missing.push({ id, section, key, english: value });
		}
	}
	for (const { id, section, key, value } of eachString(translations)) {
		if (source[id]?.[section]?.[key] === undefined) {
			problems.extra.push({ id, section, key, english: value });
		}
	}
	return problems;
}

/**
 * The window's English, from the build's `nls.keys.json` - `[module, keys[]][]` - and
 * `nls.messages.json`, the messages in the same order.
 */
export function windowEnglish(keys: Array<[string, string[]]>, messages: string[]): Strings {
	const sections: Record<string, Record<string, string>> = {};
	let index = 0;
	for (const [module, moduleKeys] of keys) {
		for (const key of moduleKeys) {
			(sections[module] ??= {})[key] = messages[index++];
		}
	}
	if (index !== messages.length) {
		throw new Error(`nls.keys.json names ${index} strings and nls.messages.json holds ${messages.length}`);
	}
	return { vscode: sections };
}

function readJson<T>(file: string): T {
	const text = fs.readFileSync(file, 'utf8');
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function listFiles(dir: string, pattern: RegExp): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules' && entry.name !== 'test') {
				found.push(...listFiles(file, pattern));
			}
		} else if (pattern.test(entry.name)) {
			found.push(file);
		}
	}
	return found;
}

/**
 * The built-in extensions' English: `package` from each one's `package.nls.json` in `extensionsFolder`,
 * `bundle` from the `vscode.l10n.t` calls in its sources under `sourcesFolder`, keyed as the extension
 * host looks them up.
 */
export async function extensionsEnglish(extensionsFolder: string, sourcesFolder: string): Promise<Strings> {
	const english: Strings = {};
	for (const name of fs.readdirSync(extensionsFolder)) {
		const manifestFile = path.join(extensionsFolder, name, 'package.json');
		if (!fs.existsSync(manifestFile)) {
			continue;
		}
		const manifest = readJson<{ publisher: string; name: string }>(manifestFile);
		const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
		const sections: Record<string, Record<string, string>> = {};
		const nlsFile = path.join(extensionsFolder, name, 'package.nls.json');
		if (fs.existsSync(nlsFile)) {
			const nls = readJson<Record<string, string | { message: string }>>(nlsFile);
			sections.package = Object.fromEntries(Object.entries(nls).map(([key, value]) => [key, typeof value === 'string' ? value : value.message]));
		}
		const sources = path.join(sourcesFolder, name, 'src');
		if (fs.existsSync(sources) && !excludedExtension.has(id)) {
			const files = listFiles(sources, /\.tsx?$/).filter(file => fs.readFileSync(file, 'utf8').includes('l10n.t('));
			if (files.length) {
				const bundle = await getL10nJson(files.map(file => ({ extension: path.extname(file), contents: fs.readFileSync(file, 'utf8') })));
				sections.bundle = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, typeof value === 'string' ? value : value.message]));
			}
		}
		if (Object.keys(sections).length) {
			english[id] = sections;
		}
	}
	return english;
}

interface PackManifest {
	readonly displayName: string;
	readonly description: string;
	readonly contributes: {
		readonly localizations: Array<{
			readonly languageId: string;
			readonly languageName: string;
			readonly localizedLanguageName: string;
			readonly translations: Array<{ readonly id: string; readonly path: string }>;
		}>;
	};
}

interface TranslationFile {
	readonly contents: Record<string, Record<string, string>>;
}

const rawBase = `https://raw.githubusercontent.com/microsoft/vscode-loc/${vscodeLocCommit}`;

async function fetchCached(cacheRoot: string, relativePath: string): Promise<string> {
	const cached = path.join(cacheRoot, vscodeLocCommit, relativePath);
	if (fs.existsSync(cached)) {
		return fs.readFileSync(cached, 'utf8');
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const response = await fetch(`${rawBase}/${relativePath}`);
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText} for ${relativePath}`);
			}
			const text = await response.text();
			fs.mkdirSync(path.dirname(cached), { recursive: true });
			fs.writeFileSync(cached, text);
			return text;
		} catch (error) {
			lastError = error;
			await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
		}
	}
	throw lastError;
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += size) {
		results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
	}
	return results;
}

/** Microsoft's pack for `language` at the pinned commit: its manifest and its translations as `Strings`. */
export async function downloadPack(language: PackLanguage, cacheRoot: string): Promise<{ manifest: PackManifest; strings: Strings }> {
	const folder = `i18n/vscode-language-pack-${language.pack}`;
	const manifest = JSON.parse(await fetchCached(cacheRoot, `${folder}/package.json`)) as PackManifest;
	const localization = manifest.contributes.localizations[0];
	const files = await inBatches(localization.translations, 16, async translation => {
		const file = JSON.parse(await fetchCached(cacheRoot, path.posix.join(folder, translation.path))) as TranslationFile;
		return [translation.id.toLowerCase(), file.contents] as const;
	});
	return { manifest, strings: Object.fromEntries(files) };
}

/** Facade Code's translations for `language`, or none yet. */
export function readFacadeStrings(root: string, folder: string): Strings {
	const file = path.join(root, 'locales', folder, 'facade.i18n.json');
	return fs.existsSync(file) ? readJson<Strings>(file) : {};
}

/** The built-in extension's name, which is also its folder: `facade-language-pack-zh-hans`. */
export function packName(language: PackLanguage): string {
	return `facade-language-pack-${language.pack.toLowerCase()}`;
}

/** The pack as a built-in extension in `outFolder`: Microsoft's contribution, Facade's identity. */
function writePack(language: PackLanguage, manifest: PackManifest, strings: Strings, license: string, outFolder: string, version: string, engine: string): void {
	fs.rmSync(outFolder, { recursive: true, force: true });
	const localization = manifest.contributes.localizations[0];
	const translations = Object.keys(strings).sort().map(id => ({
		id,
		path: id === 'vscode' ? './translations/main.i18n.json' : `./translations/extensions/${id}.i18n.json`,
	}));
	for (const { id, path: relative } of translations) {
		const file = path.join(outFolder, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', contents: strings[id] }));
	}
	const packManifest = {
		name: packName(language),
		displayName: manifest.displayName.replace(/Visual Studio Code|VS Code/g, 'Facade Code'),
		description: manifest.description.replace(/Visual Studio Code|VS Code/g, 'Facade Code'),
		version,
		publisher: 'vscode',
		license: 'MIT',
		engines: { vscode: `^${engine}` },
		categories: ['Language Packs'],
		contributes: {
			localizations: [{
				languageId: localization.languageId,
				languageName: localization.languageName,
				localizedLanguageName: localization.localizedLanguageName,
				translations,
			}],
		},
	};
	fs.writeFileSync(path.join(outFolder, 'package.json'), JSON.stringify(packManifest, null, '\t'));
	fs.writeFileSync(path.join(outFolder, 'LICENSE.md'), license);
}

/** Everything a language's pack fails on, empty when it is fine to ship. */
export interface PackReport {
	readonly language: PackLanguage;
	readonly untranslated: StringRef[];
	readonly brandLeaks: Array<StringRef & { readonly translation: string }>;
	readonly brokenParts: Array<StringRef & { readonly translation: string }>;
	readonly entries: EntryProblems;
}

function problems(report: PackReport): StringRef[] {
	const { untranslated, brandLeaks, brokenParts, entries } = report;
	return [...untranslated, ...brandLeaks, ...brokenParts, ...entries.moved, ...entries.gone, ...entries.missing, ...entries.extra];
}

export function isClean(report: PackReport): boolean {
	return problems(report).length === 0;
}

export interface BuildOptions {
	/** The repository. */
	readonly root: string;
	/** The bundled application's `out` folder, with `nls.keys.json` and `nls.messages.json`. */
	readonly outFolder: string;
	/** `.build/extensions`, where the built-in extensions are and the packs go. */
	readonly extensionsFolder: string;
	/** Builds and reports on these languages only; all of them when absent. */
	readonly languages?: readonly PackLanguage[];
	/** Writes the packs even when a check fails, for looking at them. */
	readonly force?: boolean;
}

function describe(ref: StringRef): string {
	return `${ref.id} ${ref.section} ${JSON.stringify(ref.key)}: ${JSON.stringify(ref.english).slice(0, 120)}`;
}

/**
 * Builds each language's pack into the extensions folder (LC6) and fails, naming the strings, when a
 * check of LC7 does (unless `force`).
 */
export async function buildLanguagePacks(options: BuildOptions): Promise<PackReport[]> {
	const { root, outFolder, extensionsFolder } = options;
	const cacheRoot = path.join(root, '.build', 'facade', 'vscode-loc');
	const product = readJson<{ facadeVersion?: string }>(path.join(root, 'product.json'));
	const engine = readJson<{ version: string }>(path.join(root, 'package.json')).version;
	const version = product.facadeVersion ?? engine;

	const english = mergeStrings(
		windowEnglish(readJson(path.join(outFolder, 'nls.keys.json')), readJson(path.join(outFolder, 'nls.messages.json'))),
		await extensionsEnglish(extensionsFolder, path.join(root, 'extensions')),
	);
	const sourceFile = path.join(root, 'locales', 'facade.i18n.en.json');
	const source = fs.existsSync(sourceFile) ? readJson<Strings>(sourceFile) : {};
	const license = await fetchCached(cacheRoot, 'LICENSE.md');

	const reports: PackReport[] = [];
	for (const language of options.languages ?? packLanguages) {
		const { manifest, strings } = await downloadPack(language, cacheRoot);
		const facade = readFacadeStrings(root, language.folder);
		const merged = mergeStrings(strings, facade);
		const report: PackReport = {
			language,
			untranslated: findUntranslated(english, merged),
			brandLeaks: findBrandLeaks(english, merged),
			brokenParts: findBrokenParts(source, facade),
			entries: checkEntries(source, english, facade),
		};
		reports.push(report);
		if (isClean(report) || options.force) {
			writePack(language, manifest, merged, license, path.join(extensionsFolder, packName(language)), version, engine);
		}
	}

	const failing = reports.filter(report => !isClean(report));
	if (failing.length && !options.force) {
		const lines = failing.flatMap(report => {
			const { language, untranslated, brandLeaks, brokenParts, entries } = report;
			return [
				`${language.id}: ${untranslated.length} untranslated, ${brandLeaks.length} naming VS Code, ${brokenParts.length} with a placeholder, code or link changed, ${entries.moved.length} moved, ${entries.gone.length} gone, ${entries.missing.length} missing, ${entries.extra.length} extra`,
				...problems(report).slice(0, 10).map(ref => `  ${describe(ref)}`),
			];
		});
		throw new Error(`Language packs are not ready (LOCALIZATION.md LC7):\n${lines.join('\n')}`);
	}
	return reports;
}
