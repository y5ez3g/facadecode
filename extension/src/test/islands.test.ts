/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { dependenciesOf, productionGraph, SOURCE_ROOT, type SourceGraph } from './sourceGraph';

interface Contracts {
	readonly root: readonly string[];
	readonly migration: readonly string[];
	readonly shared: readonly string[];
	readonly islands: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
	readonly interfaces: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

function violations(graph: SourceGraph, contracts: Contracts): string[] {
	const owners = new Map<string, string>();
	const problems: string[] = [];
	for (const [owner, files] of [
		['Root', contracts.root], ['Legacy migration', contracts.migration], ['Shared contracts', contracts.shared],
		...Object.values(contracts.islands).flatMap(children => Object.entries(children))
	] as ReadonlyArray<readonly [string, readonly string[]]>) {
		for (const file of files) {
			if (!graph.has(file)) { problems.push(`${owner} owns missing ${file}`); }
			const previous = owners.get(file);
			if (previous) { problems.push(`${file} has owners ${previous} and ${owner}`); }
			owners.set(file, owner);
		}
	}

	const used = new Set<string>();
	const grant = (target: string, owner: string, name: string) => JSON.stringify([target, owner, name]);
	for (const [file, dependencies] of graph) {
		const owner = owners.get(file);
		if (!owner) {
			problems.push(`${file} has no island owner`);
			continue;
		}
		for (const { target, names } of dependencies) {
			if (!target || owners.get(target) === owner) { continue; }
			const allowed = contracts.interfaces[target]?.[owner] ?? [];
			for (const name of names) {
				if (name === '*' || !allowed.includes(name)) {
					problems.push(`${file} (${owner}) imports private ${name} from ${target}`);
				} else {
					used.add(grant(target, owner, name));
				}
			}
		}
	}
	for (const [target, consumers] of Object.entries(contracts.interfaces)) {
		for (const [owner, names] of Object.entries(consumers)) {
			for (const name of names) {
				if (!used.has(grant(target, owner, name))) {
					problems.push(`Unused grant: ${target} offers ${name} to ${owner}`);
				}
			}
		}
	}
	return problems;
}

function reachable(graph: SourceGraph, root: string): Set<string> {
	const visited = new Set<string>();
	function visit(file: string): void {
		if (visited.has(file)) { return; }
		visited.add(file);
		for (const { target } of graph.get(file) ?? []) {
			if (target) { visit(target); }
		}
	}
	visit(root);
	return visited;
}

suite('Extension island interfaces (ISLANDS, ARCHITECTURE-1.3)', () => {
	test('each production file has one owner and imports only public names granted to it', () => {
		const map = path.join(path.dirname(SOURCE_ROOT), 'islands.json');
		const contracts: Contracts = JSON.parse(fs.readFileSync(map, 'utf8'));
		assert.deepStrictEqual(violations(productionGraph(), contracts), []);
	});

	test('only the workspace host reaches the migration adapter and every production source has an entry point', () => {
		const graph = productionGraph();
		const workspace = reachable(graph, 'extension.ts');
		const window = reachable(graph, 'host/window.ts');
		const page = reachable(graph, 'webview/panel.ts');
		const legacy = (file: string) => file.startsWith('host/migration/') || file === 'host/legacyCutover.ts';
		assert.ok([...workspace].some(legacy));
		assert.deepStrictEqual([...window, ...page].filter(legacy), []);
		const all = new Set([...workspace, ...window, ...page]);
		assert.deepStrictEqual([...graph.keys()].filter(file => !all.has(file)), []);
		assert.deepStrictEqual([...all].filter(file => /^(?:ptyd|transport|clis|schema|contract)\//u.test(file)), []);
	});

	test('AST dependencies retain exported names for type imports and re-exports', () => {
		const source = ts.createSourceFile('client.ts', [
			"import type { Public as Alias } from './entry';",
			"export { Public as Alias } from './entry';",
			"type Item = import('./entry').Public;",
			"const next = import('./entry');"
		].join('\n'), ts.ScriptTarget.Latest, true);
		assert.deepStrictEqual(dependenciesOf(source).map(each => each.names), [['Public'], ['Public'], ['Public'], ['*']]);
	});

	test('a foreign island cannot import a private name, wildcard or undeclared interface', () => {
		const particular = (names: readonly string[], target = 'library.ts'): SourceGraph => new Map([
			['client.ts', [{ target, names, specifier: './library' }]], ['library.ts', []], ['internal.ts', []]
		]);
		const contracts: Contracts = {
			root: ['client.ts'], migration: [], shared: [],
			islands: { Library: { Store: ['library.ts', 'internal.ts'] } },
			interfaces: { 'library.ts': { Root: ['read'] } }
		};
		assert.deepStrictEqual(violations(particular(['read']), contracts), []);
		assert.match(violations(particular(['read', 'write']), contracts).join('\n'), /imports private write/u);
		assert.match(violations(particular(['*']), contracts).join('\n'), /imports private \*/u);
		assert.match(violations(particular(['read'], 'internal.ts'), contracts).join('\n'), /imports private read from internal\.ts/u);
	});
});
