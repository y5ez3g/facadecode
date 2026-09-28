/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { Kernel } from '../common/kernel/kernel';
import { Caller, YOU } from '../common/kernel/model';
import { addresses, conversation, needsYou, PageNode, pageTree, participantRow } from '../common/kernel/viewModels';
import { tempDir } from './util';

suite('What the views draw', () => {

	const you: Caller = { name: YOU, incarnation: 1 };
	let temp: { dir: string; remove(): void };
	let kernel: Kernel;

	setup(() => {
		temp = tempDir('facade-views-');
		kernel = Kernel.open({ dir: path.join(temp.dir, 'workspace') });
	});

	teardown(() => {
		kernel.dispose();
		temp.remove();
	});

	test('a row per participant: the person, and each agent with its agent, state and cost', () => {
		kernel.addAgent({ name: 'lead', agent: 'claude:sonnet', place: '/w/p1', groups: ['p1'], startedBy: YOU });
		kernel.addAgent({ name: 'f2', agent: 'codex', startedBy: 'lead' });
		kernel.addAgent({ name: 'f3', agent: 'claude:haiku', startedBy: 'lead' });
		kernel.setState('lead', 1, 'working');
		kernel.setState('f2', 1, 'waiting', 'a permission prompt');
		kernel.setUsage('f2', 1, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.125 });
		kernel.setState('f3', 1, 'stopped');
		kernel.send({ name: 'lead', incarnation: 1 }, '@you', 'hello');
		const rows = kernel.who().map(view => participantRow(view, Date.now()));

		assert.deepStrictEqual(rows.map(row => [row.label, row.description, row.icon, row.contextValue]), [
			// The notice that @lead started working is unread too: the row counts what `who` counts.
			['@you', 'the person · 2 unread', 'account', 'person'],
			['@lead', 'claude:sonnet · working', 'sync~spin', 'agent'],
			['@f2', 'codex · waiting · $0.13', 'bell-dot', 'agent'],
			['@f3', 'claude:haiku · stopped', 'circle-slash', 'agentGone']
		]);
		assert.match(rows[1].tooltip, /Works in \/w\/p1\.\nStarted by @you\.\nGroups: #p1\.\nLast said: hello/);
		assert.match(rows[2].tooltip, /waiting \(a permission prompt\)/);
	});

	test('the notebook as folders of pages: folders first, then pages, each in order of name', () => {
		const entry = (page: string) => ({ page, version: 1, author: 'lead', ts: 0, size: 1 });
		const tree = pageTree(['p1/plan', 'notes', 'p1/tasks/f3', 'p1/tasks/f2', 'protocol/work'].map(entry));
		const shape = (nodes: PageNode[]): unknown[] => nodes.map(node => node.kind === 'folder' ? { [node.label]: shape(node.children) } : node.label);

		assert.deepStrictEqual(shape(tree), [{ p1: [{ tasks: ['f2', 'f3'] }, 'plan'] }, { protocol: ['work'] }, 'notes']);
		assert.strictEqual((tree[0].children[1]).path, 'p1/plan');
	});

	test('what needs the person: messages to them not yet taken, notices left out, until they are marked read', () => {
		const lead = kernel.addAgent({ name: 'lead', agent: 'claude', startedBy: YOU });
		const leadCaller: Caller = { name: 'lead', incarnation: lead.incarnation };
		kernel.setState('lead', 1, 'working');
		kernel.send(leadCaller, '@you', 'Plan in p1/plan: OK?');
		kernel.send(leadCaller, '@you', 'Merge p1 into main?');
		kernel.join(you, 'p1');
		kernel.join(leadCaller, 'p1');
		kernel.send(leadCaller, '#p1', 'to everyone');

		const waiting = needsYou(kernel).map(message => message.text);
		kernel.markRead(YOU, needsYou(kernel)[0].seq);
		const afterOne = needsYou(kernel).map(message => message.text);
		kernel.markRead(YOU, kernel.state.seq);

		assert.deepStrictEqual({ waiting, afterOne, after: needsYou(kernel) }, {
			waiting: ['Plan in p1/plan: OK?', 'Merge p1 into main?', 'to everyone'],
			afterOne: ['Merge p1 into main?', 'to everyone'],
			after: []
		});
	});

	test('the conversation, oldest first, notices marked, the person\'s own marked, and where the person can write', () => {
		const lead = kernel.addAgent({ name: 'lead', agent: 'claude', groups: ['p1'], startedBy: YOU });
		kernel.addAgent({ name: 'f2', agent: 'codex', groups: ['p1'], startedBy: 'lead' });
		kernel.setState('lead', lead.incarnation, 'working');
		kernel.send(you, '@lead', 'Go ahead.');
		kernel.send({ name: 'lead', incarnation: lead.incarnation }, '#p1', 'Starting.');
		const all = conversation(kernel, 10);
		const last = conversation(kernel, 1);

		assert.deepStrictEqual(all.map(message => [message.from, message.to, message.notice, message.mine]), [
			['facade', '@you', true, true],
			['you', '@lead', false, true],
			['lead', '#p1', false, false]
		]);
		assert.deepStrictEqual(last.map(message => message.text), ['Starting.']);
		assert.deepStrictEqual(addresses(kernel), ['#p1', '@f2', '@lead']);
	});
});
