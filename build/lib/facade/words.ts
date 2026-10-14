/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';

/**
 * IDENTITY.md I10 and ID-13: a user-visible string that names the running product says Facade Code,
 * through the product's name. One that still says "VS Code" is about VS Code the project - its
 * documentation, its Marketplace, what Facade Code is built on - and is listed here with why.
 */
export interface IVSCodeWord {
	/** Relative to the repository, with `/`. */
	readonly file: string;
	/** Its localization key; for an extension's `l10n.t`, which has none, its text. */
	readonly key: string;
	readonly text: string;
}

const AI = 'AI features, off by default (I11): upstream chat, Copilot and agent sessions as they stand';
const NO_UPDATER = 'VS Code\'s updates and update channels; Facade Code has no updater (I12)';
const NO_WEB = 'VS Code for the Web; Facade Code has no web build (I12)';
const DOCS = 'VS Code\'s documentation';

/** Whole areas, by the start of their path. */
export const VSCODE_AREAS: readonly { readonly prefix: string; readonly reason: string }[] = [
	{ prefix: 'src/vs/workbench/contrib/chat/', reason: AI },
	{ prefix: 'extensions/copilot/', reason: AI },
	{ prefix: 'src/vs/platform/agentHost/', reason: AI },
	{ prefix: 'src/vs/workbench/contrib/agentsVoice/', reason: AI },
	{ prefix: 'src/vs/sessions/', reason: AI },
	{ prefix: 'src/vs/workbench/contrib/mcp/', reason: AI },
	{ prefix: 'src/vs/workbench/contrib/terminalContrib/chatAgentTools/', reason: AI },
	{ prefix: 'src/vs/workbench/contrib/extensions/common/searchExtensionsTool.ts', reason: AI },
	{ prefix: 'src/vs/workbench/services/extensions/common/extensionsRegistry.ts', reason: 'the extension manifest\'s schema: written for VS Code extensions, their engine and the Marketplace' },
	{ prefix: 'src/vs/workbench/contrib/update/', reason: NO_UPDATER },
	{ prefix: 'src/vs/platform/update/', reason: NO_UPDATER },
];

/** Single strings, by file and key; `*` in a file's path is any one folder, and a key ending in `*` any key it starts. */
export const VSCODE_STRINGS: readonly { readonly file: string; readonly key: string; readonly reason: string }[] = [
	{ file: 'src/vs/platform/product/common/releaseVersion.ts', key: 'releaseVersion', reason: 'what Facade Code is built on (I7)' },
	{ file: 'src/vs/platform/extensionManagement/node/extensionManagementService.ts', key: 'incompatible', reason: 'the engine version extensions are checked against is VS Code\'s (I7)' },
	{ file: 'src/vs/workbench/browser/actions/helpActions.ts', key: 'newsletterSignup', reason: 'VS Code\'s newsletter' },
	{ file: 'src/vs/workbench/contrib/issue/browser/baseIssueReporterService.ts', key: 'extension', reason: 'an extension is a VS Code extension' },
	{ file: 'src/vs/workbench/contrib/issue/browser/issueReporterOverlay.ts', key: 'extensionSource', reason: 'an extension is a VS Code extension' },
	{ file: 'src/vs/workbench/contrib/localization/common/localization.contribution.ts', key: 'vscode.extension.contributes.localizations.translations.id', reason: 'the language pack format names VS Code\'s id, `vscode`' },
	{ file: 'src/vs/workbench/contrib/terminalContrib/voice/browser/terminalVoiceActions.ts', key: 'terminal.voice.installSpeechExtension', reason: 'the extension\'s name, VS Code Speech' },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts', key: 'gettingStarted.setupWeb.title', reason: NO_WEB },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts', key: 'gettingStarted.setupWeb.walkthroughPageTitle', reason: NO_WEB },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts', key: 'gettingStarted.extensionsWeb.description.interpolated', reason: NO_WEB },
	{ file: 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts', key: 'gettingStarted.setup.OpenFolderWeb.description.interpolated', reason: NO_WEB },
	{ file: 'extensions/extension-editing/src/constants.ts', key: 'This activation event can be removed as VS Code generates these automatically from your package.json contribution declarations.', reason: 'extension authoring: about the VS Code extension platform' },
	{ file: 'extensions/extension-editing/src/extensionLinter.ts', key: 'This proposal cannot be used because for this extension the product defines a fixed set of API proposals. You can test your extension but before publishing you MUST reach out to the VS Code team.', reason: 'extension authoring: the VS Code team decides API proposals' },
	{ file: 'extensions/typescript-language-features/src/typescriptServiceClient.ts', key: '*', reason: 'the TypeScript extension is VS Code\'s, and its issues go to VS Code' },
	{ file: 'extensions/git/package.nls.json', key: 'view.workbench.scm.*', reason: DOCS },
	{ file: 'extensions/git/package.nls.json', key: 'view.workbench.learnMore', reason: DOCS },
	{ file: 'extensions/typescript-language-features/package.nls.json', key: 'walkthroughs.nodejsWelcome.learnMoreAboutJs.description', reason: DOCS },
	{ file: 'extensions/*/package.nls.json', key: 'displayName', reason: 'a built-in extension\'s own name, as it is published for VS Code' },
	{ file: 'extensions/*/package.nls.json', key: 'description', reason: 'a built-in extension\'s own description, as it is published for VS Code' },
	{ file: 'extensions/theme-modern-icons/package.nls.json', key: 'themeLabel', reason: 'the icon theme\'s name' },
];

/** Whether `entry` lists `word`. */
export function lists(entry: typeof VSCODE_STRINGS[number], word: IVSCodeWord): boolean {
	const file = entry.file.includes('*')
		? new RegExp(`^${entry.file.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`).test(word.file)
		: entry.file === word.file;
	const key = entry.key === '*' || (entry.key.endsWith('*') ? word.key.startsWith(entry.key.slice(0, -1)) : word.key === entry.key);
	return file && key;
}

/** Why `word` still says "VS Code", or `undefined` when nothing says why. */
export function reasonFor(word: IVSCodeWord): string | undefined {
	return VSCODE_AREAS.find(area => word.file.startsWith(area.prefix))?.reason
		?? VSCODE_STRINGS.find(entry => lists(entry, word))?.reason;
}

/**
 * Every user-visible string under `root` that says "VS Code": the messages of `localize` and
 * `localize2` in `src/vs`, of `l10n.t` in the extensions' sources, and the extensions'
 * `package.nls.json`. Tests are not user-visible.
 */
export function vscodeWords(root: string): IVSCodeWord[] {
	const words: IVSCodeWord[] = [];
	const literal = String.raw`("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`)';
	const localizeCall = new RegExp(String.raw`\blocalize2?\(\s*('[^']*'|"[^"]*"|\{[^{}]*\})\s*,\s*` + literal, 'g');
	const l10nCall = new RegExp(String.raw`\bl10n\.t\(\s*` + literal, 'g');
	const relative = (file: string) => path.relative(root, file).replace(/\\/g, '/');

	for (const file of sources(path.join(root, 'src', 'vs'), name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))) {
		const text = fs.readFileSync(file, 'utf8');
		for (const match of text.includes('VS Code') ? text.matchAll(localizeCall) : []) {
			if (match[2].includes('VS Code')) {
				const key = /^'([^']*)'$|^"([^"]*)"$|key:\s*'([^']*)'/.exec(match[1]);
				words.push({ file: relative(file), key: key?.[1] ?? key?.[2] ?? key?.[3] ?? '', text: match[2].slice(1, -1) });
			}
		}
	}

	for (const extension of fs.readdirSync(path.join(root, 'extensions'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		const folder = path.join(root, 'extensions', extension.name);
		for (const file of sources(folder, name => name.endsWith('.ts') && !name.endsWith('.d.ts'), true)) {
			const text = fs.readFileSync(file, 'utf8');
			for (const match of text.includes('VS Code') ? text.matchAll(l10nCall) : []) {
				if (match[1].includes('VS Code')) {
					words.push({ file: relative(file), key: match[1].slice(1, -1), text: match[1].slice(1, -1) });
				}
			}
		}

		const nls = path.join(folder, 'package.nls.json');
		if (fs.existsSync(nls)) {
			for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(nls, 'utf8')) as Record<string, string | { message: string }>)) {
				const text = typeof value === 'string' ? value : value.message;
				if (text.includes('VS Code')) {
					words.push({ file: relative(nls), key, text });
				}
			}
		}
	}

	return words;
}

/** The source files under `folder`, past tests and what is built or installed; only below a `src` folder when `inSrc`. */
function sources(folder: string, accept: (name: string) => boolean, inSrc = false, underSrc = false): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		const full = path.join(folder, entry.name);
		if (entry.isDirectory()) {
			if (!['node_modules', 'test', 'out', 'dist'].includes(entry.name)) {
				files.push(...sources(full, accept, inSrc, underSrc || entry.name === 'src'));
			}
		} else if ((!inSrc || underSrc) && accept(entry.name)) {
			files.push(full);
		}
	}
	return files;
}
