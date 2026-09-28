/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { FeatureSpec, ProgramPlan } from '../common/model';
import { commandKey, interfaceKey, validatePlan, ValidationContext } from '../common/validator';
import { alwaysPasses, feature, plan } from './util';

const context: ValidationContext = {
	trackedFiles: ['src/shared.txt', 'src/a/one.ts', 'src/a/two.ts', 'src/b/one.ts', 'package-lock.json'],
	hotspots: ['**/package-lock.json'],
	knownAgents: new Set(['codex', 'claude', 'agy']),
	availableAgents: new Set(['codex', 'claude']),
	defaultLadder: ['codex', 'lead'],
	approvedCommands: new Set(),
	otherPrograms: [],
	ignoreCase: false
};

function rules(target: ProgramPlan, extra: Partial<ValidationContext> = {}): string[] {
	const result = validatePlan(target, { ...context, ...extra });
	return [...result.errors.map(issue => `error ${issue.rule}: ${issue.message}`), ...result.warnings.map(issue => `warning ${issue.rule}: ${issue.message}`)];
}

suite('validatePlan', () => {

	test('a sound plan passes and names the commands the repository has not approved', () => {
		const result = validatePlan(plan([feature('f1'), feature('f2')]), context);
		assert.deepStrictEqual({ errors: result.errors, warnings: result.warnings.map(issue => issue.rule), newCommands: result.newCommands.length }, { errors: [], warnings: ['V5'], newCommands: 3 });
	});

	test('V1: duplicate ids, missing dependencies and cycles', () => {
		assert.deepStrictEqual({
			broken: rules(plan([feature('f1'), feature('f2'), feature('f2', { owns: ['src/other.txt'], dependsOn: ['f9'] })])).filter(line => line.includes('V1')),
			circular: rules(plan([feature('f1', { dependsOn: ['f3'] }), feature('f2', { dependsOn: ['f1'] }), feature('f3', { dependsOn: ['f2'] })])).filter(line => line.includes('V1'))
		}, {
			broken: ['error V1: Two features share the id f2.', 'error V1: Feature f2 depends on f9, which the plan does not have.'],
			circular: ['error V1: The dependencies go round in a circle: f1 -> f3 -> f2 -> f1.']
		});
	});

	test('V2: two features may not own a path, whether it exists or is only named', () => {
		assert.deepStrictEqual(rules(plan([
			feature('f1', { owns: ['src/a'] }),
			feature('f2', { owns: ['src/a/two.ts'] }),
			feature('f3', { owns: ['src/new/file.ts'] }),
			feature('f4', { owns: ['src/new/**'] })
		])).filter(line => line.includes('V2')), [
			'error V2: f1 and f2 both own src/a/two.ts. Give each path one owner, or move what they share into the scaffold.',
			'error V2: f3 and f4 both own src/new/file.ts. Give each path one owner, or move what they share into the scaffold.'
		]);
	});

	test('V3: a hotspot belongs to the scaffold', () => {
		assert.deepStrictEqual(rules(plan([feature('f1', { owns: ['package-lock.json'] }), feature('f2')])).filter(line => line.includes('V3')), [
			'error V3: f1 owns package-lock.json, a file several features would change. Change it in the scaffold instead.'
		]);
	});

	test('V4: what a feature consumes comes from the scaffold or from a dependency', () => {
		const provides: FeatureSpec = feature('f1', { interfaces: { provides: ['src/f1.txt#Api(x: number): string'] } });
		assert.deepStrictEqual(rules(plan([
			provides,
			feature('f2', { interfaces: { consumes: ['src/f1.txt#Api'] } }),
			feature('f3', { interfaces: { consumes: ['src/f1.txt#Api(x: number)'] }, dependsOn: ['f1'] }),
			feature('f4', { interfaces: { consumes: ['src/shared.txt#Shared', 'src/none.ts#Missing'] } })
		], { scaffold: { summary: 'Shared', paths: ['src/shared.txt'], provides: ['src/shared.txt#Shared(): void'] } })).filter(line => line.includes('V4')), [
			'error V4: Feature f2 consumes src/f1.txt#Api from f1 without depending on it. Put it in the scaffold, or add dependsOn.',
			'error V4: Feature f4 consumes src/none.ts#Missing, which neither the scaffold nor any feature provides.'
		]);
	});

	test('V5 and V6: commands, sizes and the number of features, before anything else', () => {
		const broken = { ...feature('f1'), size: 'L', acceptance: { criteria: ['x'], commands: [] } } as unknown as FeatureSpec;
		assert.deepStrictEqual(rules(plan([broken])), [
			'error V5: Feature f1: acceptance.commands needs at least one command that fails before the work and passes after.',
			'error V6: Feature f1: size must be "S" (up to 150 changed lines) or "M" (up to 400). Split anything larger.'
		]);
		assert.deepStrictEqual(rules(plan([feature('f1')])).filter(line => line.includes('V6')), [
			'error V6: A program has 2 to 12 features; this one has 1. Fewer than 2: do the work yourself.'
		]);
	});

	test('V7: agents that do not exist are errors; ones not installed are skipped with a warning', () => {
		assert.deepStrictEqual(rules(plan([feature('f1', { ladder: ['nope', 'lead'] }), feature('f2', { ladder: ['agy'] })])).filter(line => line.includes('V7')), [
			'error V7: Feature f1: no agent is called "nope". Known agents: codex, claude, agy.',
			'error V7: Feature f2: no agent on its ladder (agy) is installed.',
			'warning V7: agy is not installed on this machine; features skip it on their ladders.'
		]);
	});

	test('V8: another open program changing the same files is a warning', () => {
		assert.deepStrictEqual(rules(plan([feature('f1'), feature('f2')]), { otherPrograms: [{ id: 'p-0001', owns: ['src/f1.txt'] }] }).filter(line => line.includes('V8')), [
			'warning V8: Program p-0001 is still open and also changes src/f1.txt; the second to ship will have to merge the first.'
		]);
	});

	test('V9: approved commands are not asked again', () => {
		const approved = new Set([commandKey(alwaysPasses), commandKey(feature('f1').acceptance.commands[0])]);
		assert.deepStrictEqual(validatePlan(plan([feature('f1'), feature('f2')]), { ...context, approvedCommands: approved }).newCommands, [commandKey(feature('f2').acceptance.commands[0])]);
	});

	test('interfaces are named by path and symbol, whatever signature follows', () => {
		assert.deepStrictEqual(['src\\a.ts#Api(x: number): string', 'src/a.ts#Api', 'src/a.ts#Api<T>'].map(interfaceKey), ['src/a.ts#Api', 'src/a.ts#Api', 'src/a.ts#Api']);
	});
});
