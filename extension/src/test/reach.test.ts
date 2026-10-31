/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { FacadeError } from '../core/errors';
import { reaches, referenceOf, resolveAgent } from '../core/reach';
import { runFacts } from './contractFakes';

function refusal(run: () => unknown): FacadeError {
	try {
		run();
	} catch (err) {
		assert.ok(err instanceof FacadeError, String(err));
		return err;
	}
	assert.fail('the reference resolved');
}

suite('Reach and references (RULES-2.3, 4.3)', () => {

	const root = runFacts(1, { name: 'lead' });
	const child = runFacts(2, { name: 'worker', root: root.id, creator: root.id, origin: 'agent' });
	const sibling = runFacts(3, { name: 'worker', root: root.id, creator: root.id, origin: 'agent', lifecycle: 'ended', end: { kind: 'abnormal', code: 1, at: 5 } });
	const grandchild = runFacts(4, { name: 'helper', root: root.id, creator: child.id, origin: 'agent' });
	const stranger = runFacts(5, { name: 'stranger' });
	const yolo = runFacts(6, { name: 'boss', yolo: true });
	const all = [root, child, sibling, grandchild, stranger, yolo];

	test('the caller\'s own YOLO reaches every run; without it, the whole creation tree and nothing else', () => {
		assert.ok(all.every(run => reaches(yolo, run)));
		assert.deepStrictEqual(all.filter(run => reaches(grandchild, run)).map(run => run.alias), ['#a1', '#a2', '#a3', '#a4']);
		assert.deepStrictEqual(all.filter(run => reaches(stranger, run)).map(run => run.alias), ['#a5']);
		// A YOLO target does not widen a non-YOLO caller's reach
		assert.ok(!reaches(root, yolo));
	});

	test('an exact run ID, `#aN`, `@name`, a bare name, and a name with its ID all resolve', () => {
		const tree = all.filter(run => reaches(root, run));
		assert.strictEqual(resolveAgent(child.id, tree), child);
		assert.strictEqual(resolveAgent('#a4', tree), grandchild);
		assert.strictEqual(resolveAgent('@helper', tree), grandchild);
		assert.strictEqual(resolveAgent('  lead ', tree), root);
		assert.strictEqual(resolveAgent('@helper #a4', tree), grandchild);
		assert.strictEqual(resolveAgent(`helper ${grandchild.id}`, tree), grandchild);
		assert.strictEqual(referenceOf(grandchild), '@helper #a4');
	});

	test('the ID decides: a stale or wrong name beside it does not redirect, and a missing ID never falls back to the name', () => {
		const tree = all.filter(run => reaches(root, run));
		assert.strictEqual(resolveAgent('@lead #a4', tree), grandchild);
		assert.strictEqual(refusal(() => resolveAgent('@helper #a99', tree)).reason, 'not_found');
	});

	test('a shared name is ambiguous and the answer lists the IDs; one live and one ended agent are no ambiguity for input', () => {
		const tree = all.filter(run => reaches(root, run));
		const err = refusal(() => resolveAgent('@worker', tree));
		assert.strictEqual(err.code, 'INVALID');
		assert.strictEqual(err.reason, 'ambiguous_reference');
		assert.match(err.message, new RegExp(`@worker #a2 \\(${child.id}\\), @worker #a3 \\(${sibling.id}\\)`));
		assert.strictEqual(resolveAgent('worker', tree, { eligible: run => run.lifecycle !== 'ended' }), child);
		// An ID names its run whatever it is; a name with no eligible match gives back its one run, for its tool to say why not
		assert.strictEqual(resolveAgent('#a3', tree, { eligible: run => run.lifecycle !== 'ended' }), sibling);
		assert.strictEqual(resolveAgent('worker', [root, sibling], { eligible: run => run.lifecycle !== 'ended' }), sibling);
	});

	test('outside reach: an ID is refused as out_of_tree, a name is simply not found', () => {
		const tree = all.filter(run => reaches(root, run));
		const outside = all.filter(run => !reaches(root, run));
		const byId = refusal(() => resolveAgent(stranger.id, tree, { outside }));
		assert.deepStrictEqual([byId.code, byId.reason], ['REFUSED', 'out_of_tree']);
		assert.strictEqual(refusal(() => resolveAgent('#a5', tree, { outside })).reason, 'out_of_tree');
		assert.strictEqual(refusal(() => resolveAgent('@stranger #a5', tree, { outside })).reason, 'out_of_tree');
		const byName = refusal(() => resolveAgent('@stranger', tree, { outside }));
		assert.deepStrictEqual([byName.code, byName.reason], ['NOT_FOUND', 'not_found']);
		assert.doesNotMatch(byName.message, /tree|#a5|run-/);
		assert.strictEqual(refusal(() => resolveAgent('nobody', tree, { outside })).reason, 'not_found');
	});

	test('#human is the person and never an agent; @human is the person while no agent in reach is named human (RULES-2.3, O22, D80)', () => {
		const refused = refusal(() => resolveAgent('#human', all));
		assert.deepStrictEqual([refused.code, refused.reason], ['INVALID', 'invalid_argument']);
		assert.match(refused.message, /#human is the person/);
		assert.strictEqual(refusal(() => resolveAgent('@human', all)).reason, 'invalid_argument');
		assert.strictEqual(refusal(() => resolveAgent('Human', all)).reason, 'invalid_argument');
	});

	test('an agent may be named human (O22): @human is then ambiguous between it and the person, and its ID or #human decides', () => {
		const named = runFacts(7, { name: 'human', root: root.id, creator: root.id, origin: 'agent' });
		const tree = [...all.filter(run => reaches(root, run)), named];
		for (const reference of ['@human', 'human', '@Human']) {
			const err = refusal(() => resolveAgent(reference, tree));
			assert.deepStrictEqual([err.code, err.reason], ['INVALID', 'ambiguous_reference'], reference);
			assert.match(err.message, new RegExp(`@human #a7 \\(${named.id}\\)`));
			assert.match(err.message, /#human for the person/);
		}
		// The agent's own ID, or its name with its ID, is never the person
		assert.strictEqual(resolveAgent('#a7', tree), named);
		assert.strictEqual(resolveAgent(`@human ${named.id}`, tree), named);
		assert.strictEqual(refusal(() => resolveAgent('#human', tree)).reason, 'invalid_argument');
		// Outside the caller's reach, the agent named human makes no ambiguity: only candidates in reach do
		assert.strictEqual(refusal(() => resolveAgent('@human', all.filter(run => reaches(root, run)), { outside: [named] })).reason, 'invalid_argument');
	});
});
