/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** What each layer may import of the others: the boundaries of AGENT-LAUNCHER.md, L8. */
const MAY_IMPORT: { readonly [layer: string]: readonly string[] } = {
	'extension.ts': ['host', 'base'],
	host: ['contract', 'core', 'record', 'clis', 'transport', 'base'],
	contract: ['core', 'record', 'transport', 'base'],
	core: ['record', 'clis', 'base'],
	record: ['base'],
	clis: ['base'],
	transport: ['base'],
	base: []
};

/** Where `vscode` is imported: the activation, and the host - the adapters between VS Code and the rest. */
const MAY_IMPORT_VSCODE: readonly string[] = ['extension.ts', 'host'];

const SRC = path.join(__dirname, '..', '..', 'src');
const IMPORT = /(?:^|\s)(?:import|export)\s(?:[^'";]*?\sfrom\s)?['"](?<module>[^'"]+)['"]|\b(?:require|import)\(\s*['"](?<called>[^'"]+)['"]\s*\)/g;

function sourcesIn(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? sourcesIn(file) : file.endsWith('.ts') ? [file] : [];
	});
}

/** A file's layer: the folder under `src` it is in, or the file itself at the top. */
function layerOf(file: string): string {
	return path.relative(SRC, file).split(path.sep)[0];
}

suite('Layers: what each file may import', () => {

	test('imports point down the layers only, and vscode is imported by the host and the activation alone', () => {
		const wrong: string[] = [];
		for (const file of sourcesIn(SRC).filter(each => layerOf(each) !== 'test')) {
			const layer = layerOf(file);
			const allowed = MAY_IMPORT[layer];
			if (!allowed) {
				wrong.push(`${path.relative(SRC, file)} is in no layer`);
				continue;
			}
			for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
				const specifier = match.groups?.module ?? match.groups?.called ?? '';
				if (specifier === 'vscode') {
					if (!MAY_IMPORT_VSCODE.includes(layer)) {
						wrong.push(`${path.relative(SRC, file)} imports vscode`);
					}
				} else if (specifier.startsWith('.')) {
					const target = layerOf(path.resolve(path.dirname(file), specifier));
					if (target !== layer && !allowed.includes(target)) {
						wrong.push(`${path.relative(SRC, file)} imports ${specifier}`);
					}
				}
			}
		}

		assert.deepStrictEqual(wrong, []);
	});
});

/** The arguments of each call of `name` in `text`, as written: up to its closing parenthesis. */
function callsOf(text: string, name: string): string[] {
	const calls: string[] = [];
	for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
		let depth = 0;
		let end = at + name.length;
		for (; end < text.length; end++) {
			if (text[end] === '(') {
				depth++;
			} else if (text[end] === ')' && --depth === 0) {
				break;
			}
		}
		calls.push(text.slice(at + name.length + 1, end));
	}
	return calls;
}

suite('Notices: how much each matters', () => {

	test('a notification that says something failed, or cannot be done, shows as a warning or an error - never as information (UI-17; N-73)', () => {
		const failure = /could not|cannot|failed|did not start/i;
		const asNews = sourcesIn(SRC).filter(file => layerOf(file) !== 'test').flatMap(file =>
			callsOf(fs.readFileSync(file, 'utf8'), 'showInformationMessage').filter(args => failure.test(args)).map(args => `${path.relative(SRC, file)}: ${args.replace(/\s+/g, ' ').slice(0, 100)}`));

		assert.deepStrictEqual(asNews, []);
	});

	test('the window\'s own notifications, in host/, do not lead with "Facade: ": VS Code shows their source, Facade Agents, with them, as it does for its own extensions\' notifications - a message\'s sender label is no such prefix', () => {
		// host/ alone: a message to the person shows who sent it - an agent, or Facade as `Facade: ` in core/mail.ts - a
		// label of the message, not a prefix of the window's own
		const prefixed = sourcesIn(path.join(SRC, 'host')).flatMap(file =>
			[...fs.readFileSync(file, 'utf8').matchAll(/l10n\.t\(\s*"Facade: [^"]*"/g)].map(match => `${path.relative(SRC, file)}: ${match[0]}`));

		assert.deepStrictEqual(prefixed, []);
	});
});
