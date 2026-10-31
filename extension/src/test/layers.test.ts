/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** What each layer may import of the others (ARCHITECTURE-1.3): business rules depend on ports, never on the editor or a socket. */
const MAY_IMPORT: { readonly [layer: string]: readonly string[] } = {
	'extension.ts': ['host'],
	host: ['ui', 'contract', 'core', 'record', 'clis', 'transport', 'schema', 'ptyd', 'base'],
	ui: ['core', 'webview', 'base'],
	webview: [],
	contract: ['core', 'record', 'schema', 'base'],
	core: ['base'],
	record: ['base'],
	clis: ['base'],
	ptyd: ['base'],
	transport: ['schema', 'base'],
	schema: ['base'],
	base: []
};

/** Where `vscode` is imported: the activation, the host and the UI alone. */
const MAY_IMPORT_VSCODE: readonly string[] = ['extension.ts', 'host', 'ui'];

/** The only module of `webview` that other layers may import: plain types shared by host and page (PANEL-3.1). */
const WEBVIEW_PROTOCOL = path.join('webview', 'protocol');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
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

function importsOf(file: string): string[] {
	return [...fs.readFileSync(file, 'utf8').matchAll(IMPORT)].map(match => match.groups?.module ?? match.groups?.called ?? '');
}

suite('Layers: what each file may import (ARCHITECTURE-1.3)', () => {

	test('imports point down the layers only, and vscode is imported by the host, the UI and the activation alone', () => {
		const wrong: string[] = [];
		for (const file of sourcesIn(SRC).filter(each => layerOf(each) !== 'test')) {
			const layer = layerOf(file);
			const allowed = MAY_IMPORT[layer];
			const shown = path.relative(SRC, file);
			if (!allowed) {
				wrong.push(`${shown} is in no layer`);
				continue;
			}
			for (const specifier of importsOf(file)) {
				if (specifier === 'vscode') {
					if (!MAY_IMPORT_VSCODE.includes(layer)) {
						wrong.push(`${shown} imports vscode`);
					}
				} else if (specifier.startsWith('.')) {
					const resolved = path.relative(SRC, path.resolve(path.dirname(file), specifier));
					const target = layerOf(path.resolve(path.dirname(file), specifier));
					if (target === 'test') {
						wrong.push(`${shown} imports test code ${specifier}`);
					} else if (target !== layer && !allowed.includes(target)) {
						wrong.push(`${shown} imports ${specifier}`);
					} else if (target === 'webview' && layer !== 'webview' && resolved !== WEBVIEW_PROTOCOL) {
						wrong.push(`${shown} imports webview code other than its protocol: ${specifier}`);
					}
				} else if (layer === 'webview') {
					wrong.push(`${shown} imports the module ${specifier}: the page bundles nothing but its own code`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

	test('production modules have no import cycles, including type-only dependencies', () => {
		const files = sourcesIn(SRC).filter(file => layerOf(file) !== 'test');
		const known = new Set(files);
		const dependencies = new Map(files.map(file => [file, importsOf(file)
			.filter(specifier => specifier.startsWith('.'))
			.map(specifier => path.resolve(path.dirname(file), `${specifier}.ts`))
			.filter(target => known.has(target))]));
		const visited = new Set<string>();
		const visiting: string[] = [];
		const cycles: string[] = [];
		const visit = (file: string): void => {
			const at = visiting.indexOf(file);
			if (at >= 0) {
				cycles.push([...visiting.slice(at), file].map(each => path.relative(SRC, each)).join(' -> '));
				return;
			}
			if (visited.has(file)) {
				return;
			}
			visiting.push(file);
			for (const target of dependencies.get(file) ?? []) {
				visit(target);
			}
			visiting.pop();
			visited.add(file);
		};
		files.forEach(visit);
		assert.deepStrictEqual(cycles, []);
	});

	test('execution depends on shared presentation, never a picker or command flow', () => {
		const wrong: string[] = [];
		for (const file of sourcesIn(path.join(SRC, 'host', 'execution'))) {
			for (const specifier of importsOf(file).filter(each => each.startsWith('.'))) {
				const target = path.relative(SRC, path.resolve(path.dirname(file), specifier));
				if (target.startsWith(`ui${path.sep}`) && target !== path.join('ui', 'presentation')) {
					wrong.push(`${path.relative(SRC, file)} imports ${specifier}`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

});
