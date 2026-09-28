/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { Delivery, NUDGE } from '../common/kernel/delivery';
import { Kernel } from '../common/kernel/kernel';
import { Caller, YOU } from '../common/kernel/model';
import { tempDir, waitFor } from './util';

suite('Delivery', () => {

	const you: Caller = { name: YOU, incarnation: 1 };
	let temp: { dir: string; remove(): void };
	let kernel: Kernel;
	let delivery: Delivery;
	let typed: string[];
	let lastInput: Map<string, number>;

	function agent(name: string): Caller {
		const added = kernel.addAgent({ name, agent: 'fake', startedBy: YOU });
		return { name, incarnation: added.incarnation };
	}

	const settle = () => new Promise(resolve => setTimeout(resolve, 20));

	setup(() => {
		temp = tempDir('facade-delivery-');
		kernel = Kernel.open({ dir: path.join(temp.dir, 'workspace') });
		typed = [];
		lastInput = new Map();
		delivery = new Delivery({
			kernel,
			type: async (name, text) => {
				typed.push(`${name}: ${text}`);
				return true;
			},
			lastInputAt: async name => lastInput.get(name),
			quietMs: 200,
			log: () => { }
		});
	});

	teardown(() => {
		delivery.dispose();
		kernel.dispose();
		temp.remove();
	});

	test('an agent is nudged only between turns, once, and never while the person types', async () => {
		agent('i');
		kernel.send(you, '@i', 'while it starts');
		await settle();
		assert.deepStrictEqual(typed, [], 'a starting agent gets its first message as its prompt');
		kernel.setState('i', 1, 'working');
		kernel.setState('i', 1, 'waiting', 'a permission prompt');
		kernel.send(you, '@i', 'while it waits at a prompt');
		await settle();
		assert.deepStrictEqual(typed, [], 'nothing is typed at a prompt');
		kernel.setState('i', 1, 'idle');
		await waitFor(() => typed.length === 1);
		assert.deepStrictEqual(typed, [`i: ${NUDGE}`]);
		assert.ok(!/\d/.test(NUDGE), 'a digit could pick an entry of a menu');
		kernel.send(you, '@i', 'a second one, still idle');
		await settle();
		assert.strictEqual(typed.length, 2, 'a newer message is worth a nudge of its own');
		// The person is typing in its terminal: Facade waits until they stop.
		kernel.setState('i', 1, 'working');
		kernel.setState('i', 1, 'idle');
		lastInput.set('i', Date.now());
		kernel.send(you, '@i', 'while the person types');
		await settle();
		assert.strictEqual(typed.length, 2);
		await waitFor(() => typed.length === 3, 2_000, 'the nudge after the person stopped typing');
	});

	test('a turn that ends without reading is not nudged again for the same messages, never in a loop', async () => {
		const w = agent('w');
		kernel.setState('w', 1, 'working');
		kernel.send(you, '@w', 'while it works');
		await settle();
		assert.deepStrictEqual(typed, [], 'a working agent reads its messages on its own');
		kernel.setState('w', 1, 'idle');
		await waitFor(() => typed.length === 1);
		kernel.setState('w', 1, 'working');
		kernel.setState('w', 1, 'idle');
		await settle();
		assert.strictEqual(typed.length, 1);
		// Read: nothing to nudge it for, even at the end of its next turn.
		await kernel.recv(w, {});
		kernel.setState('w', 1, 'working');
		kernel.setState('w', 1, 'idle');
		await settle();
		assert.strictEqual(typed.length, 1);
	});

	test('a stopped agent, and the person, are never nudged', async () => {
		agent('s');
		kernel.setState('s', 1, 'stopped');
		kernel.send(you, '@s', 'too late');
		const a = agent('a');
		kernel.send(a, '@you', 'for the person');
		await settle();
		await delivery.deliver(YOU);
		assert.deepStrictEqual(typed, []);
	});
});
