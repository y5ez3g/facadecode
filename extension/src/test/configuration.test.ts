/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse as parseJsonc, ParseError } from 'jsonc-parser';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { refusedArguments, takeChoices } from '../clis/args';
import { BUILT_IN_NAMES } from '../base/names';
import { ROBOT_ICONS } from '../base/robot';
import { BUILT_IN_ADAPTERS, BUILT_IN_FACTS, iconOf } from '../clis/catalog';
import { entrySetting, readEntries, readEntry } from '../clis/entries';
import { Migration, migrationOf, settingsText } from '../clis/migration';
import { parseSettings } from '../clis/settingsFile';
import { FacadeSettings, shownFile } from '../host/facadeSettings';
import { catalogFrom, TEST_SETTINGS_FILE } from './settingsFixtures';
import { tempDir } from './util';
import { withModules } from './withModules';

const FILE = TEST_SETTINGS_FILE;

/** `value` as plain JSON: what a file read gives, its objects without a prototype, compared by content. */
function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** The kinds and values of `problems`, as the person's language says them. */
function saidOf(problems: readonly { readonly said: { readonly kind: string; readonly values: readonly string[] } }[]): [string, ...string[]][] {
	return problems.map(each => [each.said.kind, ...each.said.values]);
}

suite('The settings file: its text (CONFIGURATION-1.1, 1.4, 4.1)', () => {

	test('nothing in it - empty, blank or whole comments alone - is every default: yolo on and the built-ins alone', () => {
		for (const text of ['', '  \n\t', '// Facade\n/* settings */\n']) {
			assert.deepStrictEqual(parseSettings(text, FILE), { file: FILE, yolo: true, clis: [], problems: [] }, JSON.stringify(text));
		}
		assert.deepStrictEqual(catalogFrom('').entries.map(entry => entry.adapter.id), BUILT_IN_ADAPTERS.map(adapter => adapter.id));
	});

	test('it is JSON with comments and trailing commas; yolo, clis in the file\'s order - a name that is a number too - and an editor\'s $schema are read', () => {
		const read = parseSettings(`{
	// my settings
	"$schema": "./settings.schema.json",
	"yolo": false,
	"clis": {
		"zeta": { "type": "custom", "command": "zeta", },
		"2": { "type": "codex" },
		"codex": { "enabled": false }, /* off for now */
	},
}`, FILE);
		assert.deepStrictEqual([read.yolo, read.problems, read.clis.map(member => member.name), plain(read.clis.map(member => member.value))], [
			false, [], ['zeta', '2', 'codex'], [{ type: 'custom', command: 'zeta' }, { type: 'codex' }, { enabled: false }]
		]);
	});

	test('a file wrong as a whole - not JSON with comments, a key twice in one object, a root that is no object, a top-level value of the wrong kind or a key Facade does not have - is said where, as an editor counts, and holds nothing', () => {
		const wrong = (text: string) => { const read = parseSettings(text, FILE); return [read.yolo, read.clis.length, saidOf(read.problems)]; };
		assert.deepStrictEqual([
			wrong('{ "yolo": tru }'),
			wrong('{ "yolo": true } /* not closed'),
			wrong('{\n  "clis": {\n    "codex": {},\n    "codex": { "enabled": false }\n  }\n}'),
			wrong('{ "clis": { "pi": { "env": { "A": "1", "A": "2" } } } }'),
			wrong('[]'),
			wrong('"yolo"'),
			wrong('{\n\t"yolo": "yes",\n\t"clis": [],\n\t"$schema": 7,\n\t"tools": false\n}')
		], [
			[true, 0, [['settings_syntax', FILE, '1', '11']]],
			[true, 0, [['settings_syntax', FILE, '1', '18']]],
			[true, 0, [['settings_duplicate', FILE, '4', '5', '"codex"']]],
			[true, 0, [['settings_duplicate', FILE, '1', '40', '"A"']]],
			[true, 0, [['settings_root', FILE, 'array']]],
			[true, 0, [['settings_root', FILE, 'string']]],
			[true, 0, [
				['settings_yolo', FILE, '2', '2', 'string'],
				['settings_clis', FILE, '3', '2', 'array'],
				['settings_schema', FILE, '4', '2', 'number'],
				['settings_key', FILE, '5', '2', '"tools"']
			]]
		]);
		// A byte order mark is no part of the settings; lines end at CR LF, LF or CR alone, as an editor counts them
		assert.deepStrictEqual([parseSettings('\uFEFF{ "yolo": false }', FILE).yolo, saidOf(parseSettings('{\r"yolo": true,\r"bad": 1\r}', FILE).problems), saidOf(parseSettings('{\r\n"bad": 1\r\n}', FILE).problems)],
			[false, [['settings_key', FILE, '3', '1', '"bad"']], [['settings_key', FILE, '2', '1', '"bad"']]]);
		// Its English names the place and the kind received, never the value
		assert.deepStrictEqual(parseSettings('{"yolo": "sk-secret"}', FILE).problems.map(each => each.text), [`${FILE}:1:2: yolo must be true or false; received string`]);
	});

	test('LIFECYCLE-2.1: names is a list of names, each trimmed, an empty list too; one that is not, or a name that is blank, is said where and stops every start - the file holds none of its settings then', () => {
		const read = (text: string) => { const settings = parseSettings(text, FILE); return [settings.names, saidOf(settings.problems)]; };
		assert.deepStrictEqual([
			read('{}'),
			read('{ "names": [" Ada ", "Bo"] }'),
			read('{ "names": [] }'),
			read('{\n\t"names": "Ada"\n}'),
			read('{\n\t"names": [\n\t\t"Ada",\n\t\t7,\n\t\t"  "\n\t]\n}')
		], [
			[undefined, []],
			[['Ada', 'Bo'], []],
			[[], []],
			[undefined, [['settings_names', FILE, '2', '2', 'string']]],
			// Its place in the list counts every item, from 1: the blank one is the third
			[undefined, [['settings_names', FILE, '4', '3', 'number'], ['settings_name_blank', FILE, '5', '3', '3']]]
		]);
		// Wrong as a whole: no CLI is listed, and the catalog's problems stop every start
		const catalog = catalogFrom('{ "names": [""] }');
		assert.deepStrictEqual([catalog.entries.length, saidOf(catalog.problems)], [0, [['settings_name_blank', FILE, '1', '13', '1']]]);
		// A new file holds the built-in names, each read back as written
		assert.deepStrictEqual([parseSettings(settingsText(undefined, []), FILE).names, BUILT_IN_NAMES.length], [BUILT_IN_NAMES, 140]);
	});

	test('a file wrong as a whole lists no CLI: its problems are the catalog\'s, which stop every start', () => {
		const catalog = catalogFrom('{ "yolo": 1, "clis": { "codex": {} } }');
		assert.deepStrictEqual([catalog.entries.length, saidOf(catalog.problems), catalog.file], [0, [['settings_yolo', FILE, '1', '3', 'number']], FILE]);
	});
});

suite('The settings file: its CLIs (CONFIGURATION-2.1, 2.2, 2.3)', () => {

	test('every built-in, by its name, its defaults where the file names it not, in the built-ins\' order; then the added CLIs in the file\'s order', () => {
		const catalog = catalogFrom({ clis: { 'Codex · work': { type: 'codex' }, pi: { enabled: false }, aider: { type: 'custom', command: 'aider' } } });
		assert.deepStrictEqual(catalog.entries.map(entry => [entry.adapter.id, entry.entry.setting, entry.entry.type, entry.enabled, entry.entry.builtIn]), [
			['claude', 'clis.claude', 'claude', true, true],
			['codex', 'clis.codex', 'codex', true, true],
			['agy', 'clis.agy', 'agy', true, true],
			['muse', 'clis.muse', 'muse', true, true],
			['opencode', 'clis.opencode', 'opencode', true, true],
			['pi', 'clis.pi', 'pi', false, true],
			['Codex · work', 'clis["Codex · work"]', 'codex', true, false],
			['aider', 'clis.aider', 'custom', true, false]
		]);
		assert.deepStrictEqual(['codex', 'my-cli', '_x1', 'my cli', '2', 'a.b', 'Ünïcode'].map(entrySetting), ['clis.codex', 'clis.my-cli', 'clis._x1', 'clis["my cli"]', 'clis["2"]', 'clis["a.b"]', 'clis["Ünïcode"]']);
	});

	test('an entry\'s fields as written: its command, literal args in order, env with null removing, model, effort and enabled', () => {
		const [entry] = catalogFrom({ clis: { codex: { command: '/opt/codex', args: ['--search', '-c', 'model_provider="qwen"'], env: { CODEX_HOME: '/q', OPENAI_API_KEY: null }, model: 'qwen3', effort: 'high', enabled: false } } })
			.entries.filter(each => each.adapter.id === 'codex');
		assert.deepStrictEqual(plain([entry.path, entry.extra, entry.extraSetting, entry.environment, entry.model, entry.effort, entry.enabled, entry.problems]), [
			'/opt/codex', ['--search', '-c', 'model_provider="qwen"'], 'clis.codex.args', { CODEX_HOME: '/q', OPENAI_API_KEY: null }, 'qwen3', 'high', false, []
		]);
	});

	test('an added CLI stands alone: it takes nothing from its type\'s own entry, which stays as it is', () => {
		const catalog = catalogFrom({ clis: { codex: { command: '/opt/codex', args: ['--search'], env: { A: '1' }, model: 'm', enabled: false }, 'qwen codex': { type: 'codex' } } });
		const added = catalog.entries.find(entry => entry.adapter.id === 'qwen codex')!;
		assert.deepStrictEqual([added.path, added.extra, plain(added.environment), added.model, added.enabled, added.adapter.builtIn, added.adapter.displayName], ['', [], {}, undefined, true, 'codex', 'qwen codex']);
	});

	test('a name cannot be blank, start or end with a space, hold a control character, or be a built-in\'s ID or name in any letter case', () => {
		const names = ['', '​', ' padded', 'tab\there', 'CODEX', 'claude code', 'Muse Code', 'Antigravity', 'agy2'];
		const problems = names.map(name => saidOf(readEntry(name, { type: 'custom', command: 'x' }, BUILT_IN_FACTS).problems));
		assert.deepStrictEqual(problems, [
			[['entry_name_empty', 'clis[""]']],
			[['entry_name_empty', 'clis["​"]']],
			[['entry_name_space', 'clis[" padded"]']],
			[['entry_name_control', 'clis["tab\\there"]']],
			[['entry_name_builtin', 'clis.CODEX', 'Codex']],
			[['entry_name_builtin', 'clis["claude code"]', 'Claude Code']],
			[['entry_name_builtin', 'clis["Muse Code"]', 'Muse Code']],
			[['entry_name_builtin', 'clis.Antigravity', 'Antigravity']],
			[]
		]);
	});


	test('CONFIGURATION-1.2, 2.1: the editor underlines, as it is typed, the name of an entry the reader refuses for its name, and no other: the schema\'s rule for names is the reader\'s', () => {
		const rule = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'settings.schema.json'), 'utf8')).properties.clis.propertyNames;
		// As the editor's JSON checker compiles a pattern
		const underlined = (name: string) => !new RegExp(rule.pattern, 'u').test(name);
		const cases = (word: string) => [word, word.toLowerCase(), word.toUpperCase(), word[0].toUpperCase() + word.slice(1).toLowerCase()];
		const names = [
			...BUILT_IN_FACTS.flatMap(each => [...cases(each.id), ...cases(each.displayName)]),
			'', '\u200b', ' ', ' padded', 'padded ', '\ufeffbom', 'tab\there', 'line\nbreak', 'del\u007f', 'a\u2028b', 'Claude  Code',
			'aider', 'Qwen Codex', 'Codex · Other', 'Claude · Other', 'agy2', 'Ünïcode', '2', 'my-cli', 'Claude Code 2', 'Pi work', 'Kelvin\u212a', 'Pİ'
		];
		// A built-in's own entry is named by its ID; any other name is an added entry's
		const refused = (name: string) => !BUILT_IN_FACTS.some(each => each.id === name)
			&& readEntry(name, { type: 'custom', command: 'x' }, BUILT_IN_FACTS).problems.some(each => each.said.kind.startsWith('entry_name_'));
		assert.deepStrictEqual(names.map(name => [name, underlined(name)]), names.map(name => [name, refused(name)]));
		assert.deepStrictEqual([names.filter(refused).length, typeof rule.patternErrorMessage], [42, 'string']);
	});
	test('an entry\'s type: a built-in\'s is its own, which type may repeat but not change; an added one names a built-in or custom, and custom needs a command', () => {
		const catalog = catalogFrom({ clis: { codex: { type: 'codex' }, claude: { type: 'custom' }, a: {}, b: { type: 'gpt' }, c: { type: 7 }, d: { type: 'custom' } } });
		assert.deepStrictEqual(catalog.entries.filter(entry => entry.problems.length).map(entry => [entry.adapter.id, saidOf(entry.problems)]), [
			['claude', [['entry_type_builtin', 'clis.claude.type', 'claude', 'Claude Code']]],
			['a', [['entry_type_missing', 'clis.a.type', 'claude, codex, agy, muse, opencode, pi, custom']]],
			['b', [['entry_type_unknown', 'clis.b.type', 'claude, codex, agy, muse, opencode, pi, custom', 'string']]],
			['c', [['entry_type_unknown', 'clis.c.type', 'claude, codex, agy, muse, opencode, pi, custom', 'number']]],
			['d', [['entry_command_missing', 'clis.d.command']]]
		]);
	});

	test('a wrong type is said by the types it can be, never by what it holds, which may be a secret pasted in the wrong place (CONFIGURATION-4.1)', () => {
		const catalog = catalogFrom({ clis: { claude: { type: 'sk-live-1' }, mine: { type: 'sk-live-2' } } });
		assert.ok(!JSON.stringify(catalog.entries.map(entry => entry.problems)).includes('sk-live'));
	});

	test('a value of the wrong kind is said by its setting path and its JSON type, in the order read, and nothing of it is used or replaced by a default', () => {
		const entry = readEntry('pi', {
			type: 'pi', command: '   ', args: ['ok', 2, 'nul\0'], env: { GOOD: 'x', BAD: 1, '': 'y', 'TOKEN=sk-live': 'z', NUL: 'a\0' },
			model: 7, effort: '', enabled: 'yes', trust: true
		}, BUILT_IN_FACTS);
		assert.deepStrictEqual(saidOf(entry.problems), [
			['entry_field', 'clis.pi', 'trust', 'type, icon, command, args, env, model, effort, enabled'],
			['entry_text_empty', 'clis.pi.command'],
			['argument_type', 'clis.pi.args', '1', 'number'],
			['argument_nul', 'clis.pi.args', '2'],
			['environment_value', 'clis.pi.env', 'BAD', 'number'],
			['environment_name', 'clis.pi.env', '""'],
			['environment_name', 'clis.pi.env', '"TOKEN=…"'],
			['environment_nul', 'clis.pi.env', 'NUL'],
			['entry_text_type', 'clis.pi.model', 'number'],
			['entry_text_empty', 'clis.pi.effort'],
			['entry_enabled_type', 'clis.pi.enabled', 'string']
		]);
		assert.deepStrictEqual([entry.command, entry.args, plain(entry.env), entry.model, entry.effort, entry.enabled], ['', [], {}, undefined, undefined, true]);
		assert.ok(!/sk-live/.test(JSON.stringify(entry.problems)));
		assert.deepStrictEqual([
			saidOf(readEntry('codex', [], BUILT_IN_FACTS).problems),
			saidOf(readEntry('codex', { args: '--search', env: null }, BUILT_IN_FACTS).problems),
			saidOf(readEntry('codex', { env: ['A=1'] }, BUILT_IN_FACTS).problems)
		], [
			[['entry_type_object', 'clis.codex', 'array']],
			[['arguments_type', 'clis.codex.args', 'string'], ['environment_type', 'clis.codex.env', 'null']],
			[['environment_type', 'clis.codex.env', 'array']]
		]);
	});

	test('model and effort are taken by the built-ins that take them; OpenCode sets both in its own configuration, and a program takes options in args alone', () => {
		const catalog = catalogFrom({ clis: { opencode: { model: 'x' }, pi: { model: 'p', effort: 'high' }, tool: { type: 'custom', command: 'tool', effort: 'high' }, oc: { type: 'opencode', effort: 'low' } } });
		assert.deepStrictEqual(catalog.entries.filter(entry => ['opencode', 'pi', 'tool', 'oc'].includes(entry.adapter.id)).map(entry => [entry.adapter.id, entry.model, entry.effort, saidOf(entry.problems)]), [
			['opencode', undefined, undefined, [['entry_choice_unsupported', 'clis.opencode.model', 'OpenCode']]],
			['pi', 'p', 'high', []],
			['tool', undefined, undefined, [['entry_choice_program', 'clis.tool.effort']]],
			['oc', undefined, undefined, [['entry_choice_unsupported', 'clis.oc.effort', 'OpenCode']]]
		]);
	});

	test('CONFIGURATION-2.4: an icon is a built-in\'s own or one of Facade\'s robots, said by the icons there are and never by what it holds; without one an entry shows its type\'s, a program the whitest robot', () => {
		const catalog = catalogFrom({ clis: { codex: { icon: 'facade-sky' }, claude: { icon: 'claude' }, pi: { icon: 'facade-cyan' }, muse: { icon: 7 }, mine: { type: 'custom', command: 'mine', icon: 'codex' }, other: { type: 'codex' }, tool: { type: 'custom', command: 'tool' } } });
		const ids = BUILT_IN_ADAPTERS.map(adapter => adapter.id);
		const icons = [...ids, ...ROBOT_ICONS].join(', ');
		assert.deepStrictEqual(catalog.entries.map(entry => [entry.adapter.id, entry.entry.icon, saidOf(entry.problems)]), [
			['claude', 'claude', []],
			['codex', 'facade-sky', []],
			['agy', 'agy', []],
			['muse', 'muse', [['entry_icon', 'clis.muse.icon', icons, 'number']]],
			['opencode', 'opencode', []],
			['pi', 'pi', [['entry_icon', 'clis.pi.icon', icons, 'string']]],
			['mine', 'codex', []],
			['other', 'codex', []],
			['tool', 'facade-pearl', []]
		]);
		// Where the file has no entry of that name now: a built-in's own, else a program's
		assert.deepStrictEqual(['codex', 'other', 'agy', 'gone'].map(cli => iconOf(catalog, cli)), ['facade-sky', 'codex', 'agy', 'facade-pearl']);
	});

	test('UX-2.4: every problem of the file and its entries says the same English to the person as to the log: its words in the person\'s language are its logged words in English', () => {
		const vscode = {
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) },
			ThemeIcon: class { constructor(readonly id: string) { } }, ThemeColor: class { constructor(readonly id: string) { } },
			Uri: { joinPath: () => ({}) }, env: { language: 'en' }
		};
		const { reasonText } = withModules({ vscode })<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		const problems = [
			...['{ "yolo": tru }', '{ "a": 1, "a": 2 }', '[]', '{ "yolo": "x", "clis": [], "$schema": 7, "names": "x", "other": 1 }', '{ "names": [7, " "] }']
				.flatMap(text => parseSettings(text, FILE).problems),
			...readEntry('pi', { type: 'codex', command: ' ', args: ['ok', 2, 'nul\0'], env: { BAD: 1, '': 'y', NUL: 'a\0' }, model: 7, effort: '', enabled: 'yes', icon: 'facade-cyan', trust: true }, BUILT_IN_FACTS).problems,
			...readEntry('codex', [], BUILT_IN_FACTS).problems,
			...readEntry('codex', { args: '--search', env: null }, BUILT_IN_FACTS).problems,
			...readEntry(' CODEX', { type: 'gpt', icon: 7 }, BUILT_IN_FACTS).problems,
			...['CODEX', '', 'tab\there'].flatMap(name => readEntry(name, { type: 'custom', command: 'x' }, BUILT_IN_FACTS).problems),
			...readEntry('mine', { type: 'custom', model: 'm' }, BUILT_IN_FACTS).problems,
			...readEntry('oc', { type: 'opencode', effort: 'low' }, BUILT_IN_FACTS).problems,
			...readEntry('none', {}, BUILT_IN_FACTS).problems
		];
		const kinds = new Set(problems.map(problem => problem.said?.kind));
		for (const kind of ['settings_syntax', 'settings_duplicate', 'settings_root', 'settings_names', 'settings_name_blank', 'entry_type_object', 'entry_icon', 'entry_type_builtin', 'entry_type_missing', 'entry_type_unknown', 'entry_field',
			'entry_name_empty', 'entry_name_space', 'entry_name_control', 'entry_name_builtin']) {
			assert.ok(kinds.has(kind), `${kind} is among the problems compared`);
		}
		assert.deepStrictEqual(problems.filter(problem => reasonText(problem.said, '') !== problem.text).map(problem => [problem.said?.kind, problem.text, reasonText(problem.said, '')]), []);
	});

	test('one entry wrong leaves it alone unavailable: every other CLI reads as it would without it', () => {
		const catalog = catalogFrom({ clis: { codex: { args: [42] }, mine: { type: 'custom', command: 'mine' } } });
		assert.deepStrictEqual(catalog.entries.map(entry => [entry.adapter.id, entry.problems.length]), [
			['claude', 0], ['codex', 1], ['agy', 0], ['muse', 0], ['opencode', 0], ['pi', 0], ['mine', 0]
		]);
		assert.deepStrictEqual(readEntries([], BUILT_IN_FACTS).map(entry => entry.name), BUILT_IN_ADAPTERS.map(adapter => adapter.id));
	});
});

suite('The settings file: what args may hold (CONFIGURATION-3.1)', () => {
	const grammar = (id: string) => BUILT_IN_ADAPTERS.find(adapter => adapter.id === id)!.grammar!;
	const refused = (id: string, args: readonly string[]) => refusedArguments(args, grammar(id)).map(each => each.kind === 'option' ? `${each.index}:${each.option}` : each.kind === 'key' ? `${each.index}:${each.key}` : `${each.index}:positional`);

	test('an option Facade sets or decides is refused in every spelling its CLI takes: alone with its value, after =, a short one with its value attached, an alias', () => {
		assert.deepStrictEqual([
			refused('codex', ['--yolo']),
			refused('codex', ['--sandbox', 'read-only', '--search']),
			refused('codex', ['--sandbox=read-only']),
			refused('codex', ['-s', 'danger-full-access']),
			refused('codex', ['-sread-only']),
			refused('codex', ['-m', 'gpt-5', '--model=gpt-5', '-mgpt-5']),
			refused('codex', ['--not-so-yolo', '--approve-for-me', '-C', '/elsewhere']),
			refused('claude', ['--permission-mode', 'plan', '--model', 'x', '--effort', 'max', '-p']),
			refused('claude', ['--resume', 'abc', '-rabc', '--continue', '--worktree', 'w', '-ww']),
			refused('agy', ['--mode', 'plan', '--sandbox']),
			refused('muse', ['--disable-sandbox', '--approval-mode', 'yolo', '-w']),
			refused('opencode', ['--yolo', '--dangerously-skip-permissions', '-sabc']),
			refused('pi', ['--approve', '-na', '--session', 's'])
		], [
			['0:--yolo'],
			['0:--sandbox'],
			['0:--sandbox'],
			['0:-s'],
			['0:-s'],
			['0:-m', '2:--model', '3:-m'],
			['0:--not-so-yolo', '1:--approve-for-me', '2:-C'],
			['0:--permission-mode', '2:--model', '4:--effort', '6:-p'],
			['0:--resume', '2:-r', '3:--continue', '4:--worktree', '6:-w'],
			['0:--mode', '2:--sandbox'],
			['0:--disable-sandbox', '1:--approval-mode', '3:-w'],
			['0:--yolo', '1:--dangerously-skip-permissions', '2:-s'],
			['0:--approve', '1:-na', '2:--session']
		]);
	});

	test('an option that would leave a run without Facade\'s tools or session hooks, or decide its approvals, is refused too', () => {
		assert.deepStrictEqual([
			refused('claude', ['--bare', '--safe-mode', '--restricted']),
			refused('pi', ['--no-mcp', '--no-tools', '-nt', '--no-extensions']),
			refused('muse', ['--permission-profile', 'strict', '--approval-judge', 'off', '--disable-write'])
		], [['0:--bare', '1:--safe-mode', '2:--restricted'], ['0:--no-mcp', '1:--no-tools', '2:-nt'], ['0:--permission-profile', '2:--approval-judge']]);
	});

	test('a CLI that reads a long option after one dash - Antigravity, a Go program - has it refused so too; one that reads a run of short options has each of them checked, up to one that takes the rest as its value', () => {
		assert.deepStrictEqual([
			refused('agy', ['-mode', 'plan', '-model=x', '-sandbox', '-print', '-continue', '-c']),
			refused('agy', ['-add-dir', '/a']),
			refused('claude', ['-cp']),
			refused('claude', ['-np', 'task']),
			refused('codex', ['-xs', 'read-only']),
			refused('codex', ['-pwork', '-pmy-model']),
			refused('opencode', ['-cs', 'abc']),
			refused('muse', ['-wc'])
		], [
			['0:--mode', '2:--model', '3:--sandbox', '4:--print', '5:--continue', '6:-c'],
			[],
			['0:-c'],
			['1:positional'],
			['0:-s'],
			[],
			['0:-c'],
			['0:-w']
		]);
	});

	test('a configuration override is refused where its key is one Facade sets, the parent of one or below one - in either option and either spelling, its key quoted or not; another key is the person\'s', () => {
		assert.deepStrictEqual([
			refused('codex', ['-c', 'model="gpt-5"']),
			refused('codex', ['--config=model_reasoning_effort=high']),
			refused('codex', ['-csandbox_mode=read-only']),
			refused('codex', ['-c', 'projects."/repo".trust_level="trusted"']),
			refused('codex', ['-c', 'mcp_servers={}']),
			refused('codex', ['-c', 'mcp_servers."facade".command="x"']),
			refused('codex', ['-c', 'model_provider="qwen"', '-c', 'mcp_servers.other.command="x"', '--config', 'model_providers.qwen.base_url="https://example.com"']),
			refused('muse', ['-c', 'mcpServers.facade={}', '-c', 'model="x"', '-c', 'theme="dark"'])
		], [
			['0:model'], ['0:model_reasoning_effort'], ['0:sandbox_mode'], ['0:projects."/repo".trust_level'], ['0:mcp_servers'], ['0:mcp_servers."facade".command'],
			[],
			['0:mcpServers.facade', '2:model']
		]);
	});

	test('an argument that is no option\'s value is a task, a file or a folder to the CLI, refused - the end of the options, Facade\'s to place, and every one after it too; an option Facade does not know takes the next argument as its value, and a list option every one up to the next option', () => {
		assert.deepStrictEqual([
			refused('codex', ['fix the bug']),
			refused('codex', ['--search', 'resume']),
			refused('codex', ['--profile', 'resume', 'more']),
			refused('codex', ['-', '--', '--search', 'x']),
			refused('claude', ['--add-dir', '/a', '/b', '--verbose', '--', 'task']),
			refused('claude', ['--some-new-flag', '--other', 'value']),
			refused('codex', ['--image', 'a.png', 'b.png'])
		], [
			['0:positional'],
			[],
			['2:positional'],
			['0:positional', '1:--', '2:positional', '3:positional'],
			['4:--', '5:positional'],
			[],
			[]
		]);
	});

	test('CLIS-3.1: Antigravity, a Go program, reads each option after one dash or two and a value after = - a reserved one is refused in every such spelling, short aliases too, unless another option takes it as its value', () => {
		assert.deepStrictEqual(['-c=true', '-p=true', '-i=true', '--c', '--p', '--i', '--c=true', '--p=true', '--i=true', '-print=true', '--mode=plan', '-continue', '-sandbox=false'].map(arg => refused('agy', [arg])),
			[['0:-c'], ['0:-p'], ['0:-i'], ['0:-c'], ['0:-p'], ['0:-i'], ['0:-c'], ['0:-p'], ['0:-i'], ['0:--print'], ['0:--mode'], ['0:--continue'], ['0:--sandbox']]);
		// Go gives a flag that is no switch the next argument whatever it looks like: then it is that flag's value
		assert.deepStrictEqual([refused('agy', ['--project', '-c=true']), refused('agy', ['-log-file', '--p']), refused('agy', ['-add-dir', '-i', '-i'])], [[], [], ['2:-i']]);
	});

	test('a refused argument is said by its place and option, never a value that may be a secret', () => {
		const entry = catalogFrom({ clis: { codex: { args: ['-c', 'model="sk-secret"', 'sk-positional'] } } }).entries.find(each => each.adapter.id === 'codex')!;
		assert.deepStrictEqual(saidOf(entry.problems), [['args_reserved_key', 'clis.codex.args', '0', 'model'], ['args_positional', 'clis.codex.args', '2']]);
		assert.ok(!/sk-/.test(JSON.stringify(entry.problems)));
	});

	test('an empty string is an argument too: an option\'s value, else no option\'s, refused for a built-in and passed to a program as it is', () => {
		assert.deepStrictEqual([refused('claude', ['--append-system-prompt', '']), refused('claude', ['', '--verbose'])], [[], ['0:positional']]);
		const program = catalogFrom({ clis: { tool: { type: 'custom', command: 'tool', args: ['', 'x', ''] } } }).entries.find(entry => entry.adapter.id === 'tool')!;
		assert.deepStrictEqual([program.extra, program.problems], [['', 'x', ''], []]);
	});

	test('a program\'s args are its own, passed unchanged; an added CLI of a built-in\'s type has its type\'s rules', () => {
		const catalog = catalogFrom({ clis: { tool: { type: 'custom', command: 'tool', args: ['run', '--yolo', '--', 'x'] }, mine: { type: 'codex', args: ['--yolo'] } } });
		assert.deepStrictEqual(catalog.entries.filter(entry => ['tool', 'mine'].includes(entry.adapter.id)).map(entry => [entry.extra, saidOf(entry.problems)]), [
			[['run', '--yolo', '--', 'x'], []],
			[['--yolo'], [['args_reserved', 'clis.mine.args', '0', '--yolo']]]
		]);
	});
});

/** The built-ins as a new settings file has them, in their order: each on, its own program, nothing added (CONFIGURATION-1.3). */
const DEFAULTS = ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'].map(name => ({ name, value: { type: name, args: [], env: {}, enabled: true, icon: name } }));

/** The settings `text` holds, as Facade reads them. */
function written(text: string): unknown {
	const settings = parseSettings(text, FILE);
	return { problems: settings.problems, yolo: settings.yolo, clis: plain(settings.clis) };
}

/** `text` with the commented-out examples named `names` taken out of their `//`, as a person does: each line of one loses its first `// `. */
function uncommented(text: string, names: readonly string[]): string {
	let inExample = false;
	return text.split('\n').map(line => {
		const start = /^(\t*)\/\/ ("([^"]+)": \{)$/.exec(line);
		if (start && names.includes(start[3])) {
			inExample = true;
			return `${start[1]}${start[2]}`;
		}
		const body = inExample ? /^(\t*)\/\/ (.*)$/.exec(line) : null;
		if (!body) {
			return line;
		}
		inExample = !body[2].startsWith('}');
		return `${body[1]}${body[2]}`;
	}).join('\n');
}

/** Every built-in with its defaults, `changes` over the named ones', then the `added` entries. */
function builtInsWith(changes: { readonly [name: string]: object }, added: readonly { readonly name: string; readonly value: object }[] = []): unknown {
	return [...DEFAULTS.map(each => ({ name: each.name, value: { ...each.value, ...changes[each.name] } })), ...added];
}

suite('Moving the editor\'s earlier settings into the file (CONFIGURATION-6)', () => {
	const read = (values: { readonly [name: string]: unknown }) => (name: string) => values[name];
	const problemsOf = (migration: Migration) => migration.kind === 'conflict' ? migration.problems : assert.fail(`no conflict: ${migration.kind}`);

	test('nothing the person set is no migration; a new file then holds every built-in with its defaults, each said with what Facade gives it, and three entries of the person\'s own to start from - Claude Code and Codex on another provider, a program of its own - commented out (CONFIGURATION-1.3)', () => {
		assert.deepStrictEqual(migrationOf(read({})), { kind: 'none' });
		const text = settingsText(undefined, []);
		assert.deepStrictEqual(written(text), { problems: [], yolo: true, clis: DEFAULTS });
		assert.ok(['Claude Code', 'Codex', 'Antigravity', 'Muse Code', 'OpenCode', 'Pi'].every(name => text.includes(`// ${name}`)), text);
		assert.ok(text.split('\n').every(line => !line.startsWith(' ')), 'written with tabs');
		// Taken out of their //, any of the examples and all of them are entries of their own, their notes still comments
		const examples = [
			{ name: 'Claude · Other', value: { type: 'claude', icon: 'facade-blue', model: 'deepseek/deepseek-v4.1-flash', env: {
				ANTHROPIC_BASE_URL: 'YOUR_PROVIDER_URL', ANTHROPIC_AUTH_TOKEN: 'YOUR_API_KEY', ANTHROPIC_API_KEY: null,
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek/deepseek-v4.1-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-v4.1-flash',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek/deepseek-v4.1-flash'
			} } },
			{ name: 'Codex · Other', value: { type: 'codex', icon: 'facade-lime', model: 'deepseek/deepseek-v4.1-flash', args: [
				'-c', 'model_provider=provider', '-c', 'model_providers.provider.name=Provider',
				'-c', 'model_providers.provider.base_url=YOUR_PROVIDER_URL',
				'-c', 'model_providers.provider.wire_api=responses', '-c', 'model_providers.provider.env_key=PROVIDER_API_KEY'
			], env: { PROVIDER_API_KEY: 'YOUR_API_KEY' } } },
			{ name: 'Aider', value: { type: 'custom', icon: 'facade-pink', command: 'aider', args: ['--model', 'sonnet'] } }
		];
		for (const chosen of [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]].map(each => each.map(index => examples[index]))) {
			const names = chosen.map(each => each.name);
			assert.deepStrictEqual(written(uncommented(text, names)), { problems: [], yolo: true, clis: builtInsWith({}, chosen) }, names.join(', '));
		}
	});

	test('CONFIGURATION-1.3: each built-in\'s entry shows its eight fields; command, model and effort commented out with a value it takes, which removing the // sets, and OpenCode a line saying where its are set', () => {
		const text = settingsText(undefined, []);
		const entry = (id: string) => {
			const start = text.indexOf(`\t\t"${id}": {\n`);
			return text.slice(start, text.indexOf('\n\t\t},', start) + 5);
		};
		// Its icon right after its type, saying the line where the field list gives every icon
		const iconLine = text.split('\n').findIndex(line => line.startsWith('\t// - icon:')) + 1;
		assert.ok(iconLine > 0 && text.split('\n')[iconLine].includes('claude, codex, agy, muse, opencode, or pi'));
		assert.strictEqual(entry('claude'), [
			'\t\t"claude": {', '\t\t\t"type": "claude",', `\t\t\t"icon": "claude", // or values on line ${iconLine}`, '\t\t\t// "command": "/path/to/claude",', '\t\t\t"args": [],',
			'\t\t\t"env": {},', '\t\t\t// "model": "opus",', '\t\t\t// "effort": "high",', '\t\t\t"enabled": true,', '\t\t},'
		].join('\n'));
		assert.deepStrictEqual(text.match(/"icon": "facade-\w+", \/\/ or values on line \d+/g)?.map(each => each.endsWith(` ${iconLine}`)), [true, true, true]);
		assert.ok(entry('opencode').includes('\t\t\t// Model and effort are set in OpenCode\'s own configuration, not in this file.\n') && !/"model"|"effort"/.test(entry('opencode')));
		// Taken out of their //, the samples are values each entry takes
		const samples = text.replace(/^(\t\t\t)\/\/ ("(?:command|model|effort)": .*)$/gm, '$1$2');
		const entries = readEntries(parseSettings(samples, FILE).clis, BUILT_IN_FACTS);
		assert.deepStrictEqual(entries.map(each => [each.name, each.command, each.model, each.effort, saidOf(each.problems)]), [
			['claude', '/path/to/claude', 'opus', 'high', []], ['codex', '/path/to/codex', 'gpt-6-astra', 'high', []], ['agy', '/path/to/agy', 'gemini-4-argon', 'high', []],
			['muse', '/path/to/muse', 'muse-spark-1.3', 'high', []], ['opencode', '/path/to/opencode', undefined, undefined, []], ['pi', '/path/to/pi', 'anthropic/claude-opus-5-5', 'high', []]
		]);
		// What the editor's old settings set is written out over a sample, as it was
		const moved = settingsText(undefined, [['codex', { command: '/opt/codex', model: 'gpt-x' }], ['opencode', { model: 'm' }]]);
		assert.deepStrictEqual(plain(parseSettings(moved, FILE).clis.slice(1, 2).concat(parseSettings(moved, FILE).clis.slice(4, 5))), [
			{ name: 'codex', value: { type: 'codex', command: '/opt/codex', args: [], env: {}, model: 'gpt-x', enabled: true, icon: 'codex' } },
			{ name: 'opencode', value: { type: 'opencode', args: [], env: {}, model: 'm', enabled: true, icon: 'opencode' } }
		]);
		assert.ok(!moved.includes('// "model": "gpt-6-astra"') && moved.includes('// "effort": "high"'));
	});

	test('CONFIGURATION-6.2: a value is written as it was, whatever it holds - a replacement\'s $$, $&, $` and $\' patterns, a token of the file\'s template - in a built-in\'s env, an added entry\'s args and a wrong yolo', () => {
		const odd = ['a$$b', '--sep=$&', 'p$`q', 'x$\'y', '{{codex}}', '{{added}}', '{{yolo}}'];
		const text = settingsText(odd[3], [
			['claude', { env: { A: odd[0], B: odd[2], C: odd[4] } }],
			['my cli', { type: 'custom', command: 'my-cli', args: odd }]
		]);
		const errors: ParseError[] = [];
		const raw = parseJsonc(text, errors, { allowTrailingComma: true }) as { yolo: unknown; clis: { [name: string]: unknown } };
		assert.deepStrictEqual([errors, raw.yolo, Object.keys(raw.clis), raw.clis], [[], odd[3], ['claude', 'codex', 'agy', 'muse', 'opencode', 'pi', 'my cli'], {
			claude: { type: 'claude', args: [], env: { A: odd[0], B: odd[2], C: odd[4] }, enabled: true, icon: 'claude' },
			...Object.fromEntries(['codex', 'agy', 'muse', 'opencode', 'pi'].map(name => [name, { type: name, args: [], env: {}, enabled: true, icon: name }])),
			'my cli': { type: 'custom', command: 'my-cli', args: odd }
		}]);
	});

	test('each earlier setting goes to its field - Antigravity\'s to agy, a path trimmed as it was read, an empty one left out - over the built-ins\' defaults in their order, then the custom CLIs, written with tabs', () => {
		const migration = migrationOf(read({
			'facade.yolo': false,
			'facade.pi.enabled': false,
			'facade.antigravity.path': ' /opt/agy ',
			'facade.codex.path': '',
			'facade.claude.launch': { arguments: ['--verbose'], environment: { ANTHROPIC_BASE_URL: 'https://example.com', DROP: null } },
			'facade.custom': { 'my cli': { path: 'my-cli', launch: { start: ['--fast'], resume: ['resume', '${sessionId}'], environment: { X: '1' } } } }
		}));
		assert.deepStrictEqual(migration.kind === 'file' ? migration.notes : migration, []);
		const text = (migration as { text: string }).text;
		assert.deepStrictEqual(written(text), { problems: [], yolo: false, clis: builtInsWith({
			claude: { args: ['--verbose'], env: { ANTHROPIC_BASE_URL: 'https://example.com', DROP: null } },
			agy: { command: '/opt/agy' },
			pi: { enabled: false }
		}, [{ name: 'my cli', value: { type: 'custom', command: 'my-cli', args: ['--fast'], env: { X: '1' } } }]) });
		assert.ok(text.split('\n').every(line => !line.startsWith(' ')), 'written with tabs');
	});

	test('a model or effort the arguments said plainly moves into its field, said in the notes; two of one, or one without a plain value, stay in args for the rules to say', () => {
		const migration = migrationOf(read({
			'facade.codex.launch': { arguments: ['-m', 'gpt-5', '-c', 'model_reasoning_effort="high"', '--search'] },
			'facade.claude.launch': { arguments: ['--model=opus', '--effort', 'max'] },
			'facade.muse.launch': { arguments: ['-c', 'reasoning_effort="low"', '--model', 'a', '--model', 'b'] },
			// Pi gives --thinking the argument after it whatever it is: last, it has none
			'facade.pi.launch': { arguments: ['--model', 'p', '--thinking'] }
		}));
		assert.strictEqual(migration.kind, 'file');
		const { text, notes } = migration as { text: string; notes: unknown };
		assert.deepStrictEqual((written(text) as { clis: unknown }).clis, builtInsWith({
			claude: { args: [], model: 'opus', effort: 'max' },
			codex: { args: ['--search'], model: 'gpt-5', effort: 'high' },
			muse: { args: ['--model', 'a', '--model', 'b'], effort: 'low' },
			pi: { args: ['--thinking'], model: 'p' }
		}));
		assert.deepStrictEqual(notes, [
			{ kind: 'choice_moved', from: 'facade.claude.launch.arguments', to: 'clis.claude.model' },
			{ kind: 'choice_moved', from: 'facade.claude.launch.arguments', to: 'clis.claude.effort' },
			{ kind: 'choice_moved', from: 'facade.codex.launch.arguments', to: 'clis.codex.model' },
			{ kind: 'choice_moved', from: 'facade.codex.launch.arguments', to: 'clis.codex.effort' },
			{ kind: 'choice_moved', from: 'facade.muse.launch.arguments', to: 'clis.muse.effort' },
			{ kind: 'choice_moved', from: 'facade.pi.launch.arguments', to: 'clis.pi.model' }
		]);
		// Each read as its CLI reads its arguments (CLIS-3.1)
		const choices = (args: string[], type: string) => takeChoices(args, type, BUILT_IN_FACTS.find(each => each.id === type)?.grammar ?? { reserved: [] });
		assert.deepStrictEqual([
			choices(['--model'], 'claude'),
			choices(['-c', 'model=gpt-5'], 'codex'),
			choices(['--config=model=["x"]'], 'codex'),
			choices(['-mgpt-5', '--search'], 'codex'),
			choices(['--', '--model=literal'], 'codex'),
			choices(['-model', 'gpt-five', '-effort=high', '--sandbox'], 'agy'),
			choices(['--model', 'x'], 'custom')
		], [
			{ args: ['--model'] },
			{ args: [], model: 'gpt-5' },
			{ args: ['--config=model=["x"]'] },
			{ args: ['--search'], model: 'gpt-5' },
			{ args: ['--', '--model=literal'] },
			{ args: ['--sandbox'], model: 'gpt-five', effort: 'high' },
			{ args: ['--model', 'x'] }
		]);
		// A value of another option that looks like a model's is that option's: Claude Code appends the text `--model=literal` to its
		// system prompt, and Commander gives `--model` the next argument whatever it is, which says no model plainly. Pi reads no
		// `--model=x` as its model, nor Codex a value after `-c` that starts with a dash.
		assert.deepStrictEqual([
			choices(['--append-system-prompt', '--model=literal'], 'claude'),
			choices(['--append-system-prompt', '--', '--model', 'opus'], 'claude'),
			choices(['--model', '--verbose'], 'claude'),
			choices(['--verbose', '--model', 'opus'], 'claude'),
			choices(['--system-prompt', '--model', '--model', 'x'], 'pi'),
			choices(['--model=x'], 'pi'),
			choices(['-settings', '-model', '-model', 'gemini'], 'agy'),
			choices(['--profile', '-m', 'gpt-5'], 'codex')
		], [
			{ args: ['--append-system-prompt', '--model=literal'] },
			{ args: ['--append-system-prompt', '--'], model: 'opus' },
			{ args: ['--model', '--verbose'] },
			{ args: ['--verbose'], model: 'opus' },
			{ args: ['--system-prompt', '--model'], model: 'x' },
			{ args: ['--model=x'] },
			{ args: ['-settings', '-model'], model: 'gemini' },
			{ args: ['--profile'], model: 'gpt-5' }
		]);
	});

	test('the tools switch turned off is said once to be gone; turned on it is nothing to say', () => {
		assert.deepStrictEqual([migrationOf(read({ 'facade.collaboration.enabled': false })), migrationOf(read({ 'facade.collaboration.enabled': true }))], [
			{ kind: 'file', text: settingsText(undefined, []), notes: [{ kind: 'tools_always', from: 'facade.collaboration.enabled' }] },
			{ kind: 'file', text: settingsText(undefined, []), notes: [] }
		]);
	});

	test('a value wrong then is written as it was, for the file\'s rules to say; one with no place in an entry, or two that would be one entry, make no file and say each by its earlier path', () => {
		const kept = migrationOf(read({ 'facade.codex.launch': { arguments: ['--yolo', 7] }, 'facade.pi.path': '   ', 'facade.custom': { codex2: { path: '' } } }));
		assert.deepStrictEqual((written((kept as { text: string }).text) as { clis: unknown }).clis, builtInsWith({
			codex: { args: ['--yolo', 7] },
			pi: { command: '   ' }
		}, [{ name: 'codex2', value: { type: 'custom', command: '' } }]));
		const conflict = migrationOf(read({
			'facade.codex.enabled': false,
			'facade.pi.launch': ['--x'],
			'facade.muse.launch': { arguments: [], trust: true },
			'facade.custom': { codex: { path: 'x' }, odd: 'x', more: { path: 'm', resume: [] } }
		}));
		assert.deepStrictEqual([conflict.kind, saidOf(problemsOf(conflict))], ['conflict', [
			['migration_shape', 'facade.muse.launch.trust'],
			['migration_shape', 'facade.pi.launch'],
			['migration_collision', 'facade.custom.codex', 'facade.codex', 'clis.codex'],
			['migration_shape', 'facade.custom.odd'],
			['migration_shape', 'facade.custom.more.resume']
		]]);
		// An explicit null is a value too: kept, never replaced by the field's default, for the entry's rules to say
		const nulls = migrationOf(read({ 'facade.codex.enabled': null, 'facade.codex.launch': { arguments: null, environment: null } }));
		const codex = parseSettings((nulls as { text: string }).text, FILE).clis.find(each => each.name === 'codex');
		assert.deepStrictEqual(plain(codex?.value), { type: 'codex', icon: 'codex', args: null, env: null, enabled: null });
		assert.deepStrictEqual(saidOf(readEntry('codex', codex?.value, BUILT_IN_FACTS).problems).map(([kind]) => kind).sort(), ['arguments_type', 'entry_enabled_type', 'environment_type']);
		// A custom CLI under a built-in's ID alone - which earlier builds refused - is kept as it was, for the file's rules to say
		const alone = migrationOf(read({ 'facade.custom': { codex: { path: 'x' } } }));
		assert.deepStrictEqual((written((alone as { text: string }).text) as { clis: unknown }).clis, builtInsWith({ codex: { type: 'custom', command: 'x' } }));
		assert.deepStrictEqual(saidOf(problemsOf(migrationOf(read({ 'facade.custom': [] })))), [['migration_shape', 'facade.custom']]);
	});
});

suite('The settings file on disk (CONFIGURATION-1.1, 1.3, 6.3)', () => {

	test('the first read makes a missing file, its user\'s alone, holding every built-in\'s defaults where nothing was set; later reads read it as it is saved', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			const settings = new FacadeSettings({ root });
			const made = settings.snapshot();
			assert.deepStrictEqual([made.file, made.yolo, plain(made.clis), made.problems], [settings.shown, true, DEFAULTS, []]);
			assert.strictEqual(fs.readFileSync(settings.file, 'utf8'), settingsText(undefined, []));
			if (process.platform !== 'win32') {
				assert.deepStrictEqual([fs.statSync(settings.file).mode & 0o777, fs.statSync(root).mode & 0o777], [0o600, 0o700]);
			}
			fs.writeFileSync(settings.file, '{ "yolo": false }');
			assert.strictEqual(settings.snapshot().yolo, false);
			assert.deepStrictEqual(settings.ensure(), { kind: 'exists' });
			assert.deepStrictEqual(fs.readdirSync(root), ['facade.json'], 'no temporary file is left');
		} finally {
			temp.remove();
		}
	});

	test('a migration makes the file from the earlier settings once, telling the window that made it alone; a file already there is never written over', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			const told: unknown[] = [];
			const legacy = (name: string) => ({ 'facade.yolo': false, 'facade.codex.launch': { arguments: ['--model', 'm', '--yolo'] } } as { [name: string]: unknown })[name];
			const first = new FacadeSettings({ root, legacy, migrated: (file, notes) => told.push([file, notes]) });
			const second = new FacadeSettings({ root, legacy, migrated: (file, notes) => told.push(['again', file, notes]) });
			assert.deepStrictEqual(first.ensure(), { kind: 'created', migrated: true, notes: [
				{ kind: 'choice_moved', from: 'facade.codex.launch.arguments', to: 'clis.codex.model' },
				{ kind: 'needs_fix', from: 'clis.codex' }
			] });
			assert.deepStrictEqual([second.ensure(), second.snapshot().yolo, told.length], [{ kind: 'exists' }, false, 1]);
			// A moved file wrong as a whole - an earlier yolo that is no true or false - is one to fix as a whole, said of the file
			const wrong = path.join(temp.dir, 'wrong');
			const made = new FacadeSettings({ root: wrong, legacy: name => (name === 'facade.yolo' ? 'yes' : undefined) }).ensure();
			assert.deepStrictEqual(made, { kind: 'created', migrated: true, notes: [{ kind: 'file_needs_fix', from: shownFile(path.join(wrong, 'facade.json')) }] });
			// A file the person made first is theirs
			const mine = path.join(temp.dir, 'mine');
			fs.mkdirSync(mine);
			fs.writeFileSync(path.join(mine, 'facade.json'), '{ "yolo": true }');
			assert.deepStrictEqual([new FacadeSettings({ root: mine, legacy }).ensure(), fs.readFileSync(path.join(mine, 'facade.json'), 'utf8')], [{ kind: 'exists' }, '{ "yolo": true }']);
		} finally {
			temp.remove();
		}
	});

	test('a file removed between its making and its reading is made again, never read as every default', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			const settings = new FacadeSettings({ root, legacy: name => name === 'facade.yolo' ? false : undefined });
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(settings.file, '{}');
			const ensure = settings.ensure.bind(settings);
			let removing = true;
			settings.ensure = () => { const made = ensure(); if (removing) { removing = false; fs.rmSync(settings.file); } return made; };
			assert.deepStrictEqual([settings.snapshot().yolo, settings.snapshot().problems], [false, []]);
		} finally {
			temp.remove();
		}
	});

	test('the notice of a migration lists an entry whose env reads a variable this environment has not, which an earlier build read as empty', () => {
		const temp = tempDir('fd-settings-');
		try {
			const notes: unknown[] = [];
			const legacy = (name: string) => ({ 'facade.claude.launch': { environment: { HTTPS_PROXY: '${env:CORP_PROXY}' } }, 'facade.pi.launch': { environment: { A: '${env:HOME}' } } } as { [name: string]: unknown })[name];
			new FacadeSettings({ root: path.join(temp.dir, '.facade'), legacy, host: { HOME: '/home/ada' }, platform: 'linux', migrated: (_, each) => notes.push(...each) }).ensure();
			assert.deepStrictEqual(notes, [{ kind: 'needs_fix', from: 'clis.claude' }]);
		} finally {
			temp.remove();
		}
	});

	test('a file deleted is made again by the next read - from the earlier settings where they are still set - and one holding {} is every default too', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			const settings = new FacadeSettings({ root, legacy: name => name === 'facade.yolo' ? false : undefined });
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(settings.file, '{}');
			assert.deepStrictEqual([settings.snapshot().yolo, fs.readFileSync(settings.file, 'utf8')], [true, '{}']);
			fs.rmSync(settings.file);
			assert.deepStrictEqual([settings.snapshot().yolo, fs.readFileSync(settings.file, 'utf8')], [false, settingsText(false, [])]);
		} finally {
			temp.remove();
		}
	});

	test('earlier settings that cannot all have a place make no file: every read says why, by the file and each earlier path, until they are fixed or the file is written by hand', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			const values: { [name: string]: unknown } = { 'facade.codex.enabled': false, 'facade.custom': { tool: { path: 'x', icon: 'T' } } };
			const settings = new FacadeSettings({ root, legacy: name => values[name] });
			const read = settings.snapshot();
			assert.deepStrictEqual([fs.existsSync(settings.file), read.clis, saidOf(read.problems), read.problems[0].text], [false, [], [['migration_shape', 'facade.custom.tool.icon']],
				`${settings.shown} was not made from the editor's Facade settings: facade.custom.tool.icon has no place in facade.json; fix it or remove it, or write facade.json yourself`]);
			delete values['facade.custom'];
			assert.deepStrictEqual([settings.snapshot().problems, plain(settings.snapshot().clis)], [[], builtInsWith({ codex: { enabled: false } })]);
		} finally {
			temp.remove();
		}
	});

	test('a file system that cannot link a file into place gives no settings file, never one another window could read half written; a write cut short leaves nothing behind', () => {
		const temp = tempDir('fd-settings-');
		// The module itself, whose functions the settings file calls through: an import's namespace only reads them
		const nodeFs: typeof fs = require('fs');
		const { linkSync, writeFileSync } = nodeFs;
		const failing = (code: string) => Object.assign(new Error(`${code}: as the test has it`), { code });
		const patched = nodeFs as unknown as { linkSync: unknown; writeFileSync: unknown };
		try {
			const root = path.join(temp.dir, '.facade');
			patched.linkSync = () => { throw failing('ENOTSUP'); };
			const unlinked = new FacadeSettings({ root, legacy: name => name === 'facade.yolo' ? false : undefined }).snapshot();
			patched.linkSync = linkSync;
			patched.writeFileSync = (target: string, data: string, options: object) => { writeFileSync(target, data.slice(0, 3), options); throw failing('ENOSPC'); };
			const short = new FacadeSettings({ root }).snapshot();
			assert.deepStrictEqual([saidOf(unlinked.problems).map(each => each[0]), saidOf(short.problems).map(each => each[0]), fs.readdirSync(root)], [['settings_create'], ['settings_create'], []]);
		} finally {
			patched.linkSync = linkSync;
			patched.writeFileSync = writeFileSync;
			temp.remove();
		}
	});

	test('a file that cannot be read or made is said with why, and stops every start; earlier settings that cannot be read make no file', () => {
		const temp = tempDir('fd-settings-');
		try {
			const root = path.join(temp.dir, '.facade');
			fs.mkdirSync(path.join(root, 'facade.json'), { recursive: true });
			const unreadable = new FacadeSettings({ root }).snapshot();
			assert.deepStrictEqual([unreadable.problems.length, unreadable.problems[0].said.kind, unreadable.problems[0].said.values[0]], [1, 'settings_read', shownFile(path.join(root, 'facade.json'))]);
			const blocked = path.join(temp.dir, 'blocked');
			fs.writeFileSync(blocked, '');
			const unmade = new FacadeSettings({ root: path.join(blocked, '.facade') }).snapshot();
			assert.deepStrictEqual([unmade.problems.length, unmade.problems[0].said.kind], [1, 'settings_create']);
			const failing = new FacadeSettings({ root: path.join(temp.dir, 'other'), legacy: () => { throw new Error('no editor'); } }).snapshot();
			assert.deepStrictEqual([saidOf(failing.problems), fs.existsSync(path.join(temp.dir, 'other', 'facade.json'))], [[['settings_migration_read', shownFile(path.join(temp.dir, 'other', 'facade.json')), 'no editor']], false]);
		} finally {
			temp.remove();
		}
	});

	test('the file is named from the home folder as ~ where it is under it, else by its full path', () => {
		assert.deepStrictEqual([shownFile('/home/ada/.facade/facade.json', '/home/ada'), shownFile('/srv/facade/facade.json', '/home/ada')], [
			`~${path.sep}.facade${path.sep}facade.json`, '/srv/facade/facade.json'
		]);
	});
});

suite('What the person is told of a migration (CONFIGURATION-6.2, 6.3)', () => {
	const vscode = { l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) } };
	const { migratedText, notMadeText } = withModules({ vscode })<typeof import('../host/settingsNotice')>(require.resolve('../host/settingsNotice'));

	test('the one notice says where the settings went, each choice moved into its field, that the tools switch is gone, and each entry to fix', () => {
		const moved = "Facade's settings moved to ~/.facade/facade.json. Your earlier settings are in it; the editor's Facade settings are no longer read.";
		assert.deepStrictEqual([
			migratedText(FILE, []),
			migratedText(FILE, [
				{ kind: 'choice_moved', from: 'facade.codex.launch.arguments', to: 'clis.codex.model' },
				{ kind: 'choice_moved', from: 'facade.claude.launch.arguments', to: 'clis.claude.effort' },
				{ kind: 'tools_always', from: 'facade.collaboration.enabled' },
				{ kind: 'needs_fix', from: 'clis.pi' },
				{ kind: 'needs_fix', from: 'clis["My CLI"]' }
			])
		], [moved, [
			moved,
			"A model or effort set in a CLI's arguments moved into its own field: clis.codex.model, clis.claude.effort.",
			"Facade's tools are now always given to agents; the setting that turned them off is gone.",
			'Fix these in the file before they can start: clis.pi, clis["My CLI"]. New Agent says what is wrong with each.'
		].join(' ')]);
		// The moved file wrong as a whole: said of the file, which stops every start
		assert.strictEqual(migratedText(FILE, [{ kind: 'file_needs_fix', from: FILE }]), `${moved} ${FILE} has errors; no agent can start until they are fixed.`);
	});

	test('a file not made says each earlier path, in the person\'s words', () => {
		const migration = migrationOf(name => ({ 'facade.claude.launch': { arguments: [], trust: true }, 'facade.custom': { odd: 1 } } as { [name: string]: unknown })[name]);
		const problems = migration.kind === 'conflict' ? migration.problems : assert.fail(migration.kind);
		assert.strictEqual(notMadeText(FILE, problems), `${FILE} could not be made from the editor's Facade settings: `
			+ 'facade.claude.launch.trust has no place in facade.json; fix it or remove it, or write facade.json yourself; '
			+ 'facade.custom.odd has no place in facade.json; fix it or remove it, or write facade.json yourself');
		// The English the log keeps says the same
		assert.deepStrictEqual(problems.map(each => each.text), [
			'facade.claude.launch.trust has no place in facade.json; fix it or remove it, or write facade.json yourself',
			'facade.custom.odd has no place in facade.json; fix it or remove it, or write facade.json yourself'
		]);
	});
});
