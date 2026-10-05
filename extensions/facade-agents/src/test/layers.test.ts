/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** What each layer may import of the others: the table in AGENT-FRAMEWORK.md, Code. */
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
