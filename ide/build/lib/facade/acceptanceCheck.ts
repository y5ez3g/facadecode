/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage: node build/lib/facade/acceptanceCheck.ts [--list]

import fs from 'fs';
import path from 'path';
import { caseIds, coverage } from './acceptance.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const SPECS = ['WORKSPACE.md', 'ACTIVITY-BAR.md', 'WORKTREE.md', 'IDENTITY.md'];
const TEST_ROOTS = ['src', 'extensions', 'build/lib/test', 'test'];
const SKIPPED = new Set(['node_modules', 'out', '.build', 'dist', 'fixtures']);
const MANUAL = 'test/facade/manualAcceptance.json';

function* testFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED.has(entry.name)) {
				yield* testFiles(full);
			}
		} else if (entry.name.endsWith('.test.ts')) {
			yield full;
		}
	}
}

const ids = SPECS.flatMap(spec => caseIds(fs.readFileSync(path.join(root, '../docs/ide', spec), 'utf8')));
// This check's own test writes test sources as fixtures; their titles hold nothing.
const OWN_TEST = 'build/lib/test/facadeAcceptance.test.ts';
const tests = TEST_ROOTS.flatMap(dir => [...testFiles(path.join(root, dir))]).map(file => ({
	path: path.relative(root, file).replace(/\\/g, '/'),
	source: fs.readFileSync(file, 'utf8')
})).filter(test => test.path !== OWN_TEST);
const manualPath = path.join(root, MANUAL);
const manual: Record<string, string> = fs.existsSync(manualPath) ? JSON.parse(fs.readFileSync(manualPath, 'utf8')) : {};
const result = coverage(ids, tests, manual);

if (process.argv.includes('--list')) {
	for (const [id, held] of result.held) {
		const by = held.length ? held.join('\n    ') : result.manual.has(id) ? `manual: ${result.manual.get(id)}` : 'NOTHING';
		console.log(`${id}\n    ${by}`);
	}
}

const heldByTests = [...result.held.values()].filter(list => list.length > 0).length;
console.log(`${ids.length} cases: ${heldByTests} held by tests, ${result.manual.size} by a manual procedure, ${result.missing.length} by nothing.`);
if (result.missing.length) {
	console.log(`Held by nothing: ${result.missing.join(' ')}`);
}
if (result.unknown.length) {
	console.log(`Named but in no spec: ${result.unknown.join(' ')}`);
}
process.exitCode = result.missing.length || result.unknown.length ? 1 : 0;
