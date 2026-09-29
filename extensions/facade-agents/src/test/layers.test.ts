/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** What each layer may import of the others (WORKTREE-AGENTS.md, WA-18.1). */
const MAY_IMPORT: { readonly [layer: string]: readonly string[] } = {
	'extension.ts': ['host'],
	host: ['contract', 'core', 'record', 'clis', 'transport'],
	contract: ['core', 'record'],
	core: ['record', 'clis'],
	record: [],
	clis: [],
	transport: []
};

/** The layers that may import `vscode` (WA-18.2). */
const MAY_IMPORT_VSCODE = ['extension.ts', 'host'];

const SRC = path.join(__dirname, '..', '..', 'src');
const IMPORT = /(?:^|\s)(?:import|export)\s(?:[^'";]*?\sfrom\s)?['"](?<module>[^'"]+)['"]|\brequire\(\s*['"](?<required>[^'"]+)['"]\s*\)/g;

function sources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
	});
}

/** A file's layer: the folder under `src` it is in, or the file itself at the top. */
function layerOf(file: string): string {
	return path.relative(SRC, file).split(path.sep)[0];
}

suite('The layers, held to their rules by every import of every source file', () => {

	test('imports point down only, and only the host imports vscode', () => {
		const files = sources(SRC).filter(file => layerOf(file) !== 'test');
		const wrong: string[] = [];
		for (const file of files) {
			const layer = layerOf(file);
			const allowed = MAY_IMPORT[layer];
			if (!allowed) {
				wrong.push(`${path.relative(SRC, file)} is in no layer`);
				continue;
			}
			for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
				const specifier = match.groups?.module ?? match.groups?.required ?? '';
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

		assert.deepStrictEqual({ enoughFilesRead: files.length > 20, wrong }, { enoughFilesRead: true, wrong: [] });
	});
});
