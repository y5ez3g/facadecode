/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { productionGraph, sourceCycles } from './sourceGraph';

/** What each layer may import of the others (ARCHITECTURE-1.3): business rules depend on ports, never on the editor or a socket. */
const MAY_IMPORT: { readonly [layer: string]: readonly string[] } = {
	'extension.ts': ['host'],
	host: ['ui', 'core', 'record', 'base'],
	ui: ['core', 'webview', 'base'],
	webview: [],
	core: ['base'],
	record: ['base'],
	base: []
};

/** Where `vscode` is imported: the activation, the host and the UI alone. */
const MAY_IMPORT_VSCODE: readonly string[] = ['extension.ts', 'host', 'ui'];

/** The only module of `webview` that other layers may import: plain types shared by host and page (PANEL-3.1). */
const WEBVIEW_PROTOCOL = 'webview/protocol.ts';

/** A file's layer: the folder under `src` it is in, or the file itself at the top. */
function layerOf(file: string): string {
	return file.split('/')[0];
}

suite('Layers: what each file may import (ARCHITECTURE-1.3)', () => {

	const graph = productionGraph();

	test('imports point down the layers only, and vscode is imported by the host, the UI and the activation alone', () => {
		const wrong: string[] = [];
		for (const [file, dependencies] of graph) {
			const layer = layerOf(file);
			const allowed = MAY_IMPORT[layer];
			if (!allowed) {
				wrong.push(`${file} is in no layer`);
				continue;
			}
			for (const { specifier, target } of dependencies) {
				if (specifier === 'vscode') {
					if (!MAY_IMPORT_VSCODE.includes(layer)) {
						wrong.push(`${file} imports vscode`);
					}
				} else if (target) {
					const targetLayer = layerOf(target);
					if (!graph.has(target)) {
						wrong.push(`${file} imports outside production source: ${specifier}`);
					} else if (targetLayer !== layer && !allowed.includes(targetLayer)) {
						wrong.push(`${file} imports ${specifier}`);
					} else if (targetLayer === 'webview' && layer !== 'webview' && target !== WEBVIEW_PROTOCOL) {
						wrong.push(`${file} imports webview code other than its protocol: ${specifier}`);
					}
				} else if (layer === 'webview') {
					wrong.push(`${file} imports the module ${specifier}: the page bundles nothing but its own code`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

	test('production modules have no import cycles, including type-only dependencies', () => {
		assert.deepStrictEqual(sourceCycles(graph), []);
	});

	test('the terminal view depends on shared presentation and calls no picker or command flow', () => {
		const wrong: string[] = [];
		for (const [file, dependencies] of graph) {
			if (!file.startsWith('host/terminal/')) { continue; }
			for (const { target } of dependencies) {
				if (target?.startsWith('ui/') && target !== 'ui/presentation.ts') {
					wrong.push(`${file} imports ${target}`);
				}
			}
		}
		assert.deepStrictEqual(wrong, []);
	});

});
