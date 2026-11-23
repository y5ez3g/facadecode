// Optional evidence from the full Linux x64 release-script test step. ARCHITECTURE-4.3.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateSource } from './native-package-evidence.mjs';
import { sha256 } from './release-assets.mjs';

const promotion = 'release promotion checks the accepted source and bytes before switching stable';
export const releaseFixtureCases = {
	'extension/p0/release/invalid-artifact': [
		'release preparation refuses invalid native inputs before writing the GitHub draft',
		'release preparation leaves a draft closed if GitHub lists an extra attachment',
		promotion,
	],
	'extension/p0/release/stable-pointer': [
		promotion,
		'partial promotion resumes the same pin and refuses a competing marker',
	],
};

export function observeReleaseFixture(tap, suite) {
	const text = tap.toString('utf8').replace(/\r\n/gu, '\n');
	assert.ok(text.startsWith('TAP version 13\n'), 'Missing the release suite TAP header');
	const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
	const [planLine, ...summary] = text.trimEnd().split('\n').slice(-fields.length - 1);
	const planned = /^1\.\.([1-9][0-9]*)$/u.exec(planLine);
	assert.ok(planned, 'Missing the complete release suite TAP summary');
	const plan = Number(planned[1]);
	const [tests, suites, passed, failed, cancelled, skipped, todo, durationMs] = fields.map((field, index) => {
		const prefix = '# ' + field + ' ';
		const line = summary[index];
		const value = line.startsWith(prefix) ? line.slice(prefix.length) : '';
		assert.match(value, field === 'duration_ms' ? /^\d+(?:\.\d+)?$/u : /^\d+$/u, 'Invalid release TAP summary field ' + field);
		return Number(value);
	});
	assert.deepStrictEqual([tests, suites, passed, failed, cancelled, skipped, todo], [plan, 0, plan, 0, 0, 0, 0],
		'The complete release suite must pass without failed, cancelled, skipped or pending tests');

	// The release script uses top-level tests with literal titles. Compare with the source so a filtered run cannot prove the suite.
	const defined = [...suite.toString('utf8').matchAll(/^test\('((?:[^'\\]|\\.)+)',/gmu)]
		.map(([, name]) => name.replace(/\\(['\\])/gu, '$1'));
	const outcomes = [...text.matchAll(/^(ok|not ok) ([1-9][0-9]*) - (.+)$/gmu)];
	assert.equal(new Set(defined).size, defined.length, 'Release suite test titles must be unique');
	assert.equal(outcomes.length, plan, 'Release test outcomes differ from the TAP plan');
	assert.ok(outcomes.every(([, result, number], index) => result === 'ok' && Number(number) === index + 1),
		'Release test outcomes must all pass in TAP plan order');
	assert.deepStrictEqual(outcomes.map(([, , , name]) => name), defined, 'TAP results do not cover the exact release suite');
	for (const names of Object.values(releaseFixtureCases)) {
		for (const name of names) assert.ok(defined.includes(name), 'Missing the release fixture test ' + name);
	}

	return {
		suite: { file: 'extension/scripts/release.test.mjs', sha256: sha256(suite) },
		log: { file: 'release.tap', sha256: sha256(tap) },
		summary: { plan, tests, suites, passed, failed, cancelled, skipped, todo, durationMs },
		cases: releaseFixtureCases,
	};
}

function receipt(directory, source, node) {
	validateSource(source);
	const nodeMajor = fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
	assert.ok(/^\d+$/.test(nodeMajor) && new RegExp('^v' + nodeMajor + '\\.\\d+\\.\\d+$').test(node),
		'Release fixtures require the pinned Node major');
	const tap = fs.readFileSync(path.join(directory, 'release.tap'));
	const suite = fs.readFileSync(new URL('release.test.mjs', import.meta.url));
	return { schemaVersion: 1, source, target: 'linux-x64', engine: 'old', node, ...observeReleaseFixture(tap, suite) };
}

function main(args) {
	const { values, positionals } = parseArgs({
		args, allowPositionals: true, options: {
			revision: { type: 'string' }, tree: { type: 'string' }, run: { type: 'string' }, attempt: { type: 'string' },
		},
	});
	const [mode, directory] = positionals;
	assert.ok(positionals.length === 2 && ['stamp', 'verify'].includes(mode), 'Supply stamp or verify and a release fixture directory');
	const file = path.join(directory, 'receipt.json');
	if (mode === 'stamp') {
		assert.ok(process.platform === 'linux' && process.arch === 'x64', 'Release fixtures come from Linux x64');
		const git = ref => execFileSync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' }).trim();
		const source = { revision: git('HEAD'), tree: git('HEAD^{tree}'), run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
		fs.writeFileSync(file, JSON.stringify(receipt(directory, source, process.version), null, 2) + '\n');
		return;
	}
	const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
	const { revision, tree, run, attempt } = values;
	const expected = receipt(directory, { revision, tree, run, attempt }, actual.node);
	assert.deepStrictEqual(actual, expected, 'Release fixture receipt differs from the raw suite or expected source');
	console.log(JSON.stringify(expected));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try { main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
