/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Tests compile to build/out/test (or another build/<dir>/test); the repository is three levels up.
const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'l10n.mjs');

/** The translated languages of UX-2.4. */
const LOCALES = ['zh-cn', 'zh-tw', 'pt-br', 'es', 'ru', 'de', 'ja', 'fr', 'ko', 'tr', 'pl'] as const;

function run(command: 'check' | 'export', root?: string): { readonly status: number | null; readonly output: string } {
	const result = spawnSync(process.execPath, [SCRIPT, command, ...root ? ['--root', root] : []], { cwd: ROOT, encoding: 'utf8' });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

type Json = Record<string, unknown>;

const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8')) as Json;

const textOf = (value: unknown): string => typeof value === 'string' ? value : String((value as { message?: unknown }).message);

interface Text { readonly id: string; readonly english: string; readonly text: string; readonly file: string }

/** A language's texts, each beside its English: the runtime bundle's (by key) and the manifest's (by package.nls key). */
function textsOf(locale: string): Text[] {
	const english = readJson(path.join(ROOT, 'l10n', 'bundle.l10n.json'));
	const englishNls = readJson(path.join(ROOT, 'l10n', 'package.nls.json'));
	const bundle = readJson(path.join(ROOT, 'l10n', `bundle.l10n.${locale}.json`));
	const nls = readJson(path.join(ROOT, 'l10n', `package.nls.${locale}.json`));
	return [
		...Object.entries(bundle).map(([key, text]) => ({ id: key, english: textOf(english[key] ?? key), text: textOf(text), file: `bundle.l10n.${locale}.json` })),
		...Object.entries(nls).map(([key, text]) => ({ id: key, english: textOf(englishNls[key] ?? key), text: textOf(text), file: `package.nls.${locale}.json` }))
	];
}

const shown = ({ file, english, text }: Text): string => `${file}: ${JSON.stringify(english)} -> ${JSON.stringify(text)}`;

/** What is kept as written in every language - `code`, setting and tool IDs, file and Git names - removed before words are compared. */
const IDS = /`[^`]*`|\b[\w-]+(?:\.[\w-]+)+\b|\.worktreeinclude|\.facade\/worktrees\.json|git worktree(?: [a-z]+)?|\b[a-z]+_worktrees?\b/g;
const words = (text: string): string => text.replace(IDS, ' ');

suite('Localization: every text in every language (ARCHITECTURE-4.4, UX-5.1)', () => {

	test('the repository passes `node scripts/l10n.mjs check`: keys, placeholders and manifest strings complete in all languages', () => {
		const { status, output } = run('check');
		assert.strictEqual(status, 0, output);
	});

	test('no runtime text holds a placeholder inside other braces, which VS Code leaves unfilled: `${env:{1}}` shows as written', () => {
		// VS Code fills `{name}` with /{([^}]+)}/g, so `{env:{1}` is read as one placeholder and the `{1}` inside it never filled
		const nested = /\{[^{}]*\{\d+\}/;
		for (const file of ['bundle.l10n.json', ...LOCALES.map(locale => `bundle.l10n.${locale}.json`)]) {
			const bundle = readJson(path.join(ROOT, 'l10n', file)) as { readonly [key: string]: unknown };
			const texts = Object.entries(bundle).flatMap(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]);
			assert.deepStrictEqual(texts.filter(text => nested.test(text)), [], file);
		}
	});

	test('PANEL-1.4: the card\'s renamed words are in every bundle under their new English texts, and no bundle keeps an old one', () => {
		const renamed: readonly (readonly [old: string, now: string])[] = [
			['New conversation started', 'New session started'],
			['Resumed', 'Agent resumed'],
			['Conversation resumed', 'Session continued'],
			['Needs permission', 'Permission needed'],
			['Needs sign-in', 'Sign-in needed'],
			['Needs an answer', 'Answer needed'],
			['Needs attention', 'Attention needed'],
			['Exited with code {0}', 'Process exited · code {0}'],
			['Terminated by signal {0}', 'Process terminated · {0}'],
			['Disconnected: exit cause unknown', 'Process lost · reason unknown'],
			['Could not confirm that it stopped', 'Stop unconfirmed · check process'],
			['Can\'t collaborate: set the path to the CLI program in Configure Agents, not to a .cmd file', 'Collaboration off · replace .cmd with CLI in facade.json'],
			['Can\'t collaborate: Facade tools stopped', 'Collaboration stopped · end and resume'],
			['Can\'t collaborate: move or rename {0}', 'Collaboration off · move or rename {0}'],
			['Can\'t collaborate: could not read {0}', 'Collaboration off · {0} unreadable'],
			['Can\'t collaborate: could not create files', 'Collaboration off · file creation failed'],
			['Not connected to other agents yet', 'Collaboration not connected yet'],
			['Waiting for first CLI activity report', 'No initial status · check terminal'],
			['CLI has not reported activity', 'No status from CLI · check terminal'],
			['CLI cleared activity report', 'Status cleared · check terminal'],
			['The CLI\'s current screen is not recognized', 'Status unrecognized · check terminal'],
			['The terminal was reset; waiting for activity', 'Status reset · check terminal'],
			['Activity unavailable', 'Status unavailable · check terminal'],
			['Error: {0}', 'Error · {0}']
		];
		const wrong: string[] = [];
		for (const locale of ['', ...LOCALES]) {
			const name = locale ? `bundle.l10n.${locale}.json` : 'bundle.l10n.json';
			const bundle = readJson(path.join(ROOT, 'l10n', name));
			for (const [old, now] of renamed) {
				if (!Object.hasOwn(bundle, now)) {
					wrong.push(`${name}: missing ${JSON.stringify(now)}`);
				}
				if (Object.hasOwn(bundle, old)) {
					wrong.push(`${name}: still has ${JSON.stringify(old)}`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

	test('Continue Session and custom CLI help use the same session terminology in each language', () => {
		const sessionWords = {
			'zh-cn': /会话/, 'zh-tw': /工作階段/, 'pt-br': /sess(?:ão|ões)/i, es: /sesi(?:ón|ones)/i,
			ru: /бесед/i, de: /Sitzung/, ja: /セッション/, fr: /session/i, ko: /세션/, tr: /oturum/i, pl: /sesj/i,
		};
		const ids = new Set([
			'Untitled session',
			"No saved sessions in this window's folders",
			'Could not read the saved sessions: {0}',
			"{0} runs another CLI now, but this session is {1}'s; it cannot be resumed with it",
			'Its CLI cannot resume this exact session, so it cannot be pinned.',
			'config.custom.launch',
			'config.custom.launch.start',
			'config.custom.launch.resume',
		]);
		for (const locale of LOCALES) {
			const texts = textsOf(locale).filter(each => ids.has(each.id));
			assert.strictEqual(texts.length, ids.size, locale);
			for (const each of texts) {
				assert.match(each.text, sessionWords[locale], shown(each));
				if (each.id === 'config.custom.launch.resume') {
					assert.ok(each.text.includes('`${sessionId}`'), shown(each));
				}
			}
		}
		const traditional = textsOf('zh-tw');
		assert.match(traditional.find(each => each.id === 'config.custom.launch.resume')!.text, /用於恢復/);
		assert.strictEqual(traditional.find(each => each.id === 'Open a folder to continue a saved session.')!.text,
			'請開啟資料夾以接續已儲存的工作階段。');
		assert.match(textsOf('ru').find(each => each.id === 'config.custom.launch.resume')!.text, /идентификатором этой беседы/);
	});

	test('settings repairs keep the quoted type and say which line or item to remove in Chinese and Korean', () => {
		const typeChange = '{0} cannot change the {1} entry\'s type: it is {2}\'s; set it back to "{1}" or remove the line';
		const checks = {
			'zh-cn': [/请改回 "\{1\}" 或删掉该行/, /请删掉该项/],
			ko: [/"\{1\}"\(으\)로 다시 설정하거나 해당 줄을 지우세요/, /해당 항목을 지우세요/],
		} as const;
		for (const [locale, [line, item]] of Object.entries(checks)) {
			const texts = textsOf(locale);
			assert.match(texts.find(each => each.id === typeChange)!.text, line);
			assert.match(texts.find(each => each.id === '{0}[{1}] is {2}, which Facade sets or decides itself; remove it')!.text, item);
		}
	});

	suite('the checker finds each problem it owns', () => {
		let root: string;
		const write = (file: string, content: unknown): void => {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, undefined, '\t')}\n`);
		};
		const CODE = 'import * as vscode from \'vscode\';\nvscode.l10n.t("Hello {0}", name);\nvscode.l10n.t({ message: "Bye", comment: ["a farewell"] });\n';

		setup(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-l10n-'));
			write('src/a.ts', CODE);
			write('src/test/b.ts', 'import * as vscode from \'vscode\';\nvscode.l10n.t("Only a test says this");\n');
			write('package.json', { displayName: '%displayName%', contributes: { commands: [{ command: 'x', title: '%command.x%' }] } });
			write('l10n/bundle.l10n.json', { 'Hello {0}': 'Hello {0}', 'Bye/a farewell': { message: 'Bye', comment: ['a farewell'] } });
			write('l10n/package.nls.json', { displayName: 'Facade Code', 'command.x': 'Do X' });
			for (const locale of LOCALES) {
				write(`l10n/bundle.l10n.${locale}.json`, { 'Hello {0}': `[${locale}] {0}`, 'Bye/a farewell': `[${locale}] bye` });
				write(`l10n/package.nls.${locale}.json`, { displayName: 'Facade Code', 'command.x': `[${locale}] X` });
			}
		});

		teardown(() => fs.rmSync(root, { recursive: true, force: true }));

		/** Applies one change to the clean fixture and expects the check to fail naming `expected`. */
		function fails(file: string, change: (json: Json) => void, expected: string): void {
			const json = readJson(path.join(root, file));
			change(json);
			write(file, json);
			const { status, output } = run('check', root);
			assert.strictEqual(status, 1, output);
			assert.ok(output.includes(expected), `expected ${JSON.stringify(expected)} in:\n${output}`);
		}

		test('a clean fixture passes, a text said only in src/test is not required, and the object form keeps its comment', () => {
			const { status, output } = run('check', root);
			assert.strictEqual(status, 0, output);
		});

		test('an English bundle a Windows checkout holds with CRLF line endings (Git\'s core.autocrlf) is laid out as export writes it', () => {
			const bundle = path.join(root, 'l10n', 'bundle.l10n.json');
			fs.writeFileSync(bundle, fs.readFileSync(bundle, 'utf8').replace(/\n/g, '\r\n'));
			const { status, output } = run('check', root);
			assert.strictEqual(status, 0, output);
		});

		test('a translated bundle missing a text, or keeping an obsolete one', () => {
			fails('l10n/bundle.l10n.de.json', json => delete json['Hello {0}'], 'bundle.l10n.de.json: missing text "Hello {0}"');
			fails('l10n/bundle.l10n.fr.json', json => json['Gone'] = 'Parti', 'bundle.l10n.fr.json: obsolete text "Gone"');
			fails('l10n/bundle.l10n.zh-cn.json', json => json['Hello {0}'] = ' ', 'bundle.l10n.zh-cn.json: "Hello {0}" has no translation');
		});

		test('a translation whose placeholders differ from its English', () => {
			fails('l10n/bundle.l10n.ja.json', json => json['Hello {0}'] = 'こんにちは {1}', 'bundle.l10n.ja.json: "Hello {0}" has placeholders {1}, the English {0}');
			fails('l10n/bundle.l10n.ko.json', json => json['Hello {0}'] = '안녕하세요', 'has placeholders none, the English {0}');
		});

		test('a translated package.nls with other keys than the English, or other `code` spans', () => {
			fails('l10n/package.nls.ko.json', json => delete json['command.x'], 'package.nls.ko.json: missing key "command.x"');
			fails('l10n/package.nls.tr.json', json => json['command.old'] = 'Eski', 'package.nls.tr.json: obsolete key "command.old"');
			fails('l10n/package.nls.json', json => json['command.x'] = 'Do `x`', 'package.nls.pl.json: "command.x" changes the `code` spans');
		});

		test('a %key% the manifest uses that package.nls.json lacks, and a key it never uses', () => {
			fails('package.json', json => (json.contributes as { commands: Json[] }).commands.push({ command: 'y', title: '%command.y%' }), 'package.nls.json: missing "command.y", which package.json uses as %command.y%');
			fails('l10n/package.nls.json', json => json['command.unused'] = 'Unused', 'package.nls.json: "command.unused" is not used by package.json');
		});

		test('an English bundle unlike what export writes, which export then fixes', () => {
			write('src/a.ts', `${CODE}vscode.l10n.t('New text');\n`);
			let { status, output } = run('check', root);
			assert.strictEqual(status, 1, output);
			assert.ok(output.includes('bundle.l10n.json: missing "New text" (src/a.ts:4:1)'), output);
			({ status, output } = run('export', root));
			assert.strictEqual(status, 0, output);
			({ status, output } = run('check', root));
			assert.ok(!output.includes('bundle.l10n.json:') && output.includes('bundle.l10n.es.json: missing text "New text"'), output);
			fails('l10n/bundle.l10n.json', json => json['Hello {0}'] = 'Hi {0}', 'bundle.l10n.json: "Hello {0}" is not its English text');
		});

		test('a message the code computes, which neither check nor export can read', () => {
			write('src/a.ts', `${CODE}vscode.l10n.t(message);\nconst t = vscode.l10n.t;\n`);
			const checked = run('check', root);
			assert.strictEqual(checked.status, 1, checked.output);
			assert.ok(checked.output.includes('src/a.ts:4:1: the message is not a string literal but an expression (Identifier): vscode.l10n.t(message)'), checked.output);
			assert.ok(checked.output.includes('src/a.ts:5:11: vscode.l10n.t is used other than by calling it directly'), checked.output);
			const exported = run('export', root);
			assert.strictEqual(exported.status, 1, exported.output);
		});
	});
});

/** Names no language translates (UX-2.4), and the built-in CLIs' product names. */
const NAMES = ['Facade Code', 'Facade', 'CLI', 'YOLO', 'Claude Code', 'Codex', 'Antigravity', 'Muse Code', 'OpenCode', 'Pi'];

/**
 * Whether `text` says `name` as a word of its own: `Pi`, never the start of `Pick`. Only Latin letters and digits join a name, as a
 * Korean particle or a CJK character follows one directly: `Codex를`.
 */
const says = (text: string, name: string): boolean => new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text);

/**
 * Each language's word for a Git worktree - Microsoft's, which the Git extension's commands use - and for a working location,
 * which may be a plain folder (UX-1.3); each as its forms are found in a text. `not` is what a text of that language must
 * never say for either.
 */
const TERMS: { readonly [locale in typeof LOCALES[number]]: { readonly worktree: RegExp; readonly location: RegExp; readonly not: RegExp } } = {
	'zh-cn': { worktree: /工作树/, location: /工作位置/, not: /worktree|工作樹/i },
	'zh-tw': { worktree: /工作樹/, location: /工作位置/, not: /worktree|工作树/i },
	'pt-br': { worktree: /árvores? de trabalho/i, location: /(?:local|locais) de trabalho/i, not: /worktree/i },
	'es': { worktree: /árbol(?:es)? de trabajo/i, location: /ubicaci(?:ón|ones) de trabajo/i, not: /worktree/i },
	'ru': { worktree: /рабоч\S* дерев/i, location: /рабоч\S* расположени/i, not: /worktree/i },
	'de': { worktree: /Worktree/, location: /Arbeitsort/, not: /Arbeitsbaum|Arbeitsverzeichnisbaum/i },
	'ja': { worktree: /作業ツリー/, location: /作業場所/, not: /worktree|ワークツリー/i },
	'fr': { worktree: /arborescences? de travail/i, location: /emplacements? de travail/i, not: /worktree/i },
	'ko': { worktree: /작업 트리/, location: /작업 위치/, not: /worktree|워크트리/i },
	'tr': { worktree: /çalışma ağa[cç]/i, location: /çalışma konum/i, not: /worktree/i },
	'pl': { worktree: /drzew\S* robocz|robocz\S* drzew/i, location: /lokalizac\S* robocz/i, not: /worktree/i }
};

suite('Localization: the words each language has for Facade\'s things (UX-2.4)', () => {

	test('PANEL-1.5: each label a screen reader says before a card\'s details\' facts, from a `Label: {0}` text, keeps its one value last, after its colon, in every language - so that taking the value away leaves the label', () => {
		const labels = ['Title: {0}', 'Location: {0}', 'Path: {0}'];
		const wrong: string[] = [];
		for (const locale of ['', ...LOCALES]) {
			const bundle = readJson(path.join(ROOT, 'l10n', locale ? `bundle.l10n.${locale}.json` : 'bundle.l10n.json'));
			for (const label of labels) {
				const text = textOf(bundle[label]);
				// Its words, then a colon - full-width, or with spaces round it, a no-break one among them - then its value alone
				if (text.split('{0}').length !== 2 || !/^[^{}]*[^\s:：{}][^{}]*?\s*[:：]\s*\{0\}$/u.test(text)) {
					wrong.push(`${locale || 'en'}: ${JSON.stringify(label)} -> ${JSON.stringify(text)}`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

	test('Facade Code, Facade, CLI, YOLO and the CLIs\' names stay as they are in every language', () => {
		const wrong = LOCALES.flatMap(locale => textsOf(locale).filter(text => NAMES.some(name => says(text.english, name) && !says(text.text, name)))).map(shown);
		assert.deepStrictEqual(wrong, []);
		// A name is a word: Pick and Pipe do not say Pi
		assert.deepStrictEqual([says('Pick a CLI', 'Pi'), says('Use Pi.', 'Pi'), says('Pi の', 'Pi'), says('Codex-Agenten', 'Codex'), says('Codex를', 'Codex'), says('OpenCodex', 'Codex')], [false, true, true, true, true, false]);
	});

	test('Chinese says agent, untranslated, wherever the English does', () => {
		const wrong = (['zh-cn', 'zh-tw'] as const).flatMap(locale => textsOf(locale).filter(text =>
			/代理|智能体|智能體/.test(text.text) || (/\bagents?\b/i.test(words(text.english)) && !/agent/i.test(words(text.text))))).map(shown);
		assert.deepStrictEqual(wrong, []);
	});

	test('Chinese writes that English word as Agent, capitalized, in titles and sentences alike - never agent - its IDs and code kept as they are (UX-2.4)', () => {
		const wrong = (['zh-cn', 'zh-tw'] as const).flatMap(locale => textsOf(locale).filter(text => /(?<![A-Za-z0-9_])agents?(?![A-Za-z0-9_])/.test(words(text.text)))).map(shown);
		assert.deepStrictEqual(wrong, []);
	});

	test('a worktree is called by its language\'s word for it exactly where the English says worktree; IDs and file names kept as they are', () => {
		const wrong: string[] = [];
		for (const locale of LOCALES) {
			const { worktree, not } = TERMS[locale];
			for (const text of textsOf(locale)) {
				const says = words(text.text);
				if (not.test(says) || /\bworktrees?\b/i.test(words(text.english)) !== worktree.test(says)) {
					wrong.push(shown(text));
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

	test('a working location is called by one word in each language, wherever the English says it', () => {
		const wrong = LOCALES.flatMap(locale => textsOf(locale).filter(text => /working locations?/i.test(text.english) && !TERMS[locale].location.test(text.text))).map(shown);
		assert.deepStrictEqual(wrong, []);
	});

	test('a command\'s title is the same words in the palette, its pickers, buttons and the settings that name it (UX-1.3)', () => {
		const englishNls = readJson(path.join(ROOT, 'l10n', 'package.nls.json'));
		const english = readJson(path.join(ROOT, 'l10n', 'bundle.l10n.json'));
		const bare = (title: string): string => title.replace(/(?:\.\.\.|…)$/, '');
		const titles = Object.keys(englishNls).filter(key => key.startsWith('command.') && key !== 'command.category');
		const wrong: string[] = [];
		for (const locale of LOCALES) {
			const nls = readJson(path.join(ROOT, 'l10n', `package.nls.${locale}.json`));
			const bundle = readJson(path.join(ROOT, 'l10n', `bundle.l10n.${locale}.json`));
			for (const key of titles) {
				const title = bare(textOf(englishNls[key]));
				const translated = bare(textOf(nls[key]));
				for (const text of Object.keys(english).filter(text => bare(text) === title)) {
					if (bare(textOf(bundle[text])) !== translated) {
						wrong.push(`${locale}: ${JSON.stringify(text)} is ${JSON.stringify(bundle[text])}, the command ${key} ${JSON.stringify(nls[key])}`);
					}
				}
				for (const setting of Object.keys(englishNls).filter(setting => textOf(englishNls[setting]).includes(`**${title}**`))) {
					if (!textOf(nls[setting]).includes(`**${translated}**`)) {
						wrong.push(`${locale}: ${setting} does not name the command ${key} as **${translated}**`);
					}
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});
});
