/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { FeatureStatus } from '../common/model';
import { criticalPaths, holdsSlot, pickStarts, SchedulerFeature } from '../common/scheduler';

function feature(id: string, overrides: Partial<SchedulerFeature> = {}): SchedulerFeature {
	return { id, status: 'pending', dependsOn: [], size: 'S', order: Number(id.slice(1)), agent: 'codex', ...overrides };
}

/** A small deterministic generator, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

suite('scheduler', () => {

	test('starts the head of the longest chain first, then larger features, then plan order', () => {
		const features = [
			feature('f1'),
			feature('f2', { size: 'M' }),
			feature('f3'),
			feature('f4', { dependsOn: ['f3'] }),
			feature('f5', { dependsOn: ['f4'] })
		];
		assert.deepStrictEqual({
			chains: Object.fromEntries(criticalPaths(features)),
			starts: pickStarts({ features, merged: new Set(), maxParallel: 3, agentCaps: new Map() })
		}, {
			chains: { f1: 1, f2: 1, f3: 3, f4: 2, f5: 1 },
			starts: ['f3', 'f2', 'f1']
		});
	});

	test('respects the slots, each agent\'s own limit, the lead rung and dependencies', () => {
		const features = [
			feature('f1', { status: 'running' }),
			feature('f2'),
			feature('f3'),
			feature('f4', { agent: 'claude' }),
			feature('f5', { agent: 'lead' }),
			feature('f6', { dependsOn: ['f1'] })
		];
		assert.deepStrictEqual(pickStarts({ features, merged: new Set(), maxParallel: 4, agentCaps: new Map([['codex', 2]]) }), ['f2', 'f4']);
		assert.deepStrictEqual(pickStarts({ features, merged: new Set(['f1']), maxParallel: 6, agentCaps: new Map() }), ['f2', 'f3', 'f4', 'f6']);
	});

	test('property: never more workers than slots or caps, never an unmerged dependency, never a busy feature', () => {
		const statuses: FeatureStatus[] = ['pending', 'running', 'verifying', 'verified', 'needs_lead', 'abandoned'];
		const agents = ['codex', 'claude', 'agy', 'lead', undefined];
		for (let seed = 1; seed <= 500; seed++) {
			const next = random(seed);
			const count = 1 + Math.floor(next() * 10);
			const features: SchedulerFeature[] = [];
			for (let index = 0; index < count; index++) {
				// Dependencies only point backwards, so the graph has no cycle.
				const dependsOn = features.filter(() => next() < 0.3).map(other => other.id);
				features.push(feature(`f${index + 1}`, { status: statuses[Math.floor(next() * statuses.length)], agent: agents[Math.floor(next() * agents.length)], size: next() < 0.5 ? 'S' : 'M', dependsOn }));
			}
			const merged = new Set(features.filter(() => next() < 0.3).map(each => each.id));
			const maxParallel = 1 + Math.floor(next() * 5);
			const caps = new Map([['codex', 1 + Math.floor(next() * 3)]]);
			const starts = pickStarts({ features, merged, maxParallel, agentCaps: caps });
			const byId = new Map(features.map(each => [each.id, each]));
			const busy = features.filter(each => holdsSlot(each.status));
			const context = `seed ${seed}`;
			assert.ok(busy.length + starts.length <= Math.max(maxParallel, busy.length), context);
			assert.strictEqual(new Set(starts).size, starts.length, context);
			for (const id of starts) {
				const started = byId.get(id)!;
				assert.strictEqual(started.status, 'pending', context);
				assert.ok(started.agent && started.agent !== 'lead', context);
				assert.ok(started.dependsOn.every(dep => merged.has(dep)), context);
			}
			const codex = [...busy, ...starts.map(id => byId.get(id)!)].filter(each => each.agent === 'codex').length;
			const codexStarted = starts.filter(id => byId.get(id)!.agent === 'codex').length;
			assert.ok(codexStarted === 0 || codex <= caps.get('codex')!, context);
		}
	});
});
