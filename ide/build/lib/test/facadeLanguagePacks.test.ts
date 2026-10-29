/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { checkEntries, findBrandLeaks, findBrokenParts, findUntranslated, fixedParts, isExcluded, mergeStrings, packLanguages, packName, windowEnglish } from '../facade/languagePacks.ts';

suite('facade language packs', () => {

	test('Facade\'s strings win over Microsoft\'s and add what Microsoft has no file for', () => {
		const microsoft = { vscode: { 'vs/a': { one: 'eins', two: 'zwei' } }, 'vscode.git': { package: { p: 'P' } } };
		const facade = { vscode: { 'vs/a': { two: 'ZWEI' }, 'vs/b': { three: 'drei' } }, 'vscode.facade-agents': { bundle: { 'Start Agent': 'Agent starten' } } };
		assert.deepStrictEqual(mergeStrings(microsoft, facade), {
			vscode: { 'vs/a': { one: 'eins', two: 'ZWEI' }, 'vs/b': { three: 'drei' } },
			'vscode.git': { package: { p: 'P' } },
			'vscode.facade-agents': { bundle: { 'Start Agent': 'Agent starten' } },
		});
		assert.deepStrictEqual(microsoft.vscode['vs/a'].two, 'zwei');
	});

	test('every visible string needs a translation; chat, sessions and Copilot keep Microsoft\'s coverage (LC3)', () => {
		const english = {
			vscode: { 'vs/workbench/browser/parts/workspacebar/workspaceBarPart': { title: 'Workspace' }, 'vs/workbench/contrib/chat/browser/chat': { ask: 'Ask' }, 'vs/sessions/contrib/x': { y: 'Y' } },
			'github.copilot-chat': { package: { c: 'C' } },
			'vscode.git': { bundle: { 'Create Worktree': 'Create Worktree' } },
		};
		const missing = findUntranslated(english, {});
		assert.deepStrictEqual(missing.map(ref => `${ref.id} ${ref.section} ${ref.key}`), [
			'vscode vs/workbench/browser/parts/workspacebar/workspaceBarPart title',
			'vscode.git bundle Create Worktree',
		]);
		const blank = findUntranslated({ vscode: { m: { a: 'Open', b: 'Close', c: '' } } }, { vscode: { m: { a: ' ', b: '关闭', c: '' } } });
		assert.deepStrictEqual(blank.map(ref => ref.key), ['a']);
		assert.deepStrictEqual([isExcluded('vscode', 'vs/workbench/contrib/mcp/browser/mcp'), isExcluded('vscode', 'vs/workbench/contrib/search/browser/search'), isExcluded('github.copilot-chat', 'package')], [true, false, true]);
	});

	test('a translation may not name VS Code where the English does not (LC3)', () => {
		const english = { vscode: { m: { a: 'Restart {0}', b: 'Open VS Code settings', c: 'Shows events which VS code collects' } } };
		const translated = { vscode: { m: { a: '重新启动 VS Code', b: '打开 VS Code 设置', c: '显示 Facade Code 收集的事件' } } };
		assert.deepStrictEqual(findBrandLeaks(english, translated).map(ref => ref.key), ['a']);
	});

	test('placeholders, code, link targets and mnemonics are carried over unchanged (LC7)', () => {
		assert.deepStrictEqual(fixedParts('Run `git init` in {0} or [read more](https://aka.ms/x) with ${appName}: &&Remove'), ['${appName}', '&&', 'https://aka.ms/x', '`git init`', '{0}'].sort());
		const source = { vscode: { m: { ok: 'Open {0}', lost: 'Delete {0} in {1}', code: 'Set `git.enabled`', menu: '&&Remove' } } };
		const translations = { vscode: { m: { ok: '{0} öffnen', lost: '{0} löschen', code: '`git.aktiviert` festlegen', menu: 'Entfernen' } } };
		assert.deepStrictEqual(findBrokenParts(source, translations).map(ref => ref.key), ['lost', 'code', 'menu']);
	});

	test('Facade\'s entries follow the build\'s English and the English file (LC7)', () => {
		const source = { vscode: { m: { same: 'Same', moved: 'Old text', gone: 'Gone' } } };
		const english = { vscode: { m: { same: 'Same', moved: 'New text' } } };
		const translations = { vscode: { m: { same: 'Gleich', moved: 'Alter Text', stray: 'Streuner' } } };
		const problems = checkEntries(source, english, translations);
		assert.deepStrictEqual({
			moved: problems.moved.map(ref => `${ref.key}: ${ref.english}`),
			gone: problems.gone.map(ref => ref.key),
			missing: problems.missing.map(ref => ref.key),
			extra: problems.extra.map(ref => ref.key),
		}, { moved: ['moved: New text'], gone: ['gone'], missing: ['gone'], extra: ['stray'] });
	});

	test('the window\'s English pairs nls.keys.json with nls.messages.json, and they have to agree', () => {
		assert.deepStrictEqual(windowEnglish([['vs/a', ['x', 'y']], ['vs/b', ['z']]], ['X', 'Y', 'Z']), { vscode: { 'vs/a': { x: 'X', y: 'Y' }, 'vs/b': { z: 'Z' } } });
		assert.throws(() => windowEnglish([['vs/a', ['x']]], ['X', 'Y']), /names 1 strings and nls.messages.json holds 2/);
	});

	test('eleven languages, one folder under locales/ and one built-in extension each (LC1, LC2)', () => {
		assert.deepStrictEqual(packLanguages.map(language => `${language.id} ${language.folder} ${packName(language)}`), [
			'zh-cn zh-CN facade-language-pack-zh-hans',
			'zh-tw zh-TW facade-language-pack-zh-hant',
			'pt-br pt-BR facade-language-pack-pt-br',
			'es es facade-language-pack-es',
			'ru ru facade-language-pack-ru',
			'de de facade-language-pack-de',
			'ja ja facade-language-pack-ja',
			'fr fr facade-language-pack-fr',
			'ko ko facade-language-pack-ko',
			'tr tr facade-language-pack-tr',
			'pl pl facade-language-pack-pl',
		]);
	});
});
