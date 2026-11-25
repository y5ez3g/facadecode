/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface Dependency {
	readonly specifier: string;
	readonly names: readonly string[];
	readonly target?: string;
}

export type SourceGraph = ReadonlyMap<string, readonly Dependency[]>;

export const SOURCE_ROOT = path.join(__dirname, '..', '..', '..', 'src');

function sourceFiles(folder: string): string[] {
	return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(folder, entry.name);
		return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
	});
}

function namedBindings(bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): string[] {
	if (!bindings || ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) {
		return ['*'];
	}
	return bindings.elements.map(element => (element.propertyName ?? element.name).text);
}

export function dependenciesOf(source: ts.SourceFile): readonly Dependency[] {
	const imports: Dependency[] = [];
	function record(argument: ts.Node | undefined, names: readonly string[]): void {
		if (!argument || !ts.isStringLiteralLike(argument)) {
			const { line } = source.getLineAndCharacterOfPosition(argument?.getStart(source) ?? 0);
			throw new Error(`${source.fileName}:${line + 1} has a computed module specifier`);
		}
		imports.push({ specifier: argument.text, names });
	}
	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const names = clause?.name ? ['default'] : [];
			if (clause?.namedBindings) { names.push(...namedBindings(clause.namedBindings)); }
			record(node.moduleSpecifier, names.length ? names : ['*']);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			record(node.moduleSpecifier, namedBindings(node.exportClause));
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			record(node.moduleReference.expression, ['*']);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			let qualifier = node.qualifier;
			while (qualifier && ts.isQualifiedName(qualifier)) { qualifier = qualifier.left; }
			record(node.argument.literal, [qualifier?.text ?? '*']);
		} else if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expression) && expression.text === 'require')
				|| (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
					&& expression.expression.text === 'require' && expression.name.text === 'resolve')) {
				record(node.arguments[0], ['*']);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return imports;
}

export function productionGraph(root = SOURCE_ROOT): SourceGraph {
	const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
	const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Node10 };
	const cache = ts.createModuleResolutionCache(root, file => file, options);
	const files = sourceFiles(root).filter(file => !relative(file).startsWith('test/'));
	return new Map(files.map(file => {
		const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const dependencies = dependenciesOf(source).map(dependency => {
			if (!dependency.specifier.startsWith('.')) { return dependency; }
			const resolved = ts.resolveModuleName(dependency.specifier, file, options, ts.sys, cache).resolvedModule;
			if (!resolved) {
				throw new Error(`${relative(file)} imports missing ${dependency.specifier}`);
			}
			return { ...dependency, target: relative(resolved.resolvedFileName) };
		});
		return [relative(file), dependencies];
	}));
}

export function sourceCycles(graph: SourceGraph): string[] {
	const visited = new Set<string>();
	const visiting: string[] = [];
	const cycles = new Set<string>();
	function visit(file: string): void {
		const at = visiting.indexOf(file);
		if (at >= 0) {
			cycles.add([...visiting.slice(at), file].join(' -> '));
			return;
		}
		if (visited.has(file)) { return; }
		visiting.push(file);
		for (const dependency of graph.get(file) ?? []) {
			if (dependency.target && graph.has(dependency.target)) { visit(dependency.target); }
		}
		visiting.pop();
		visited.add(file);
	}
	for (const file of graph.keys()) { visit(file); }
	return [...cycles];
}
