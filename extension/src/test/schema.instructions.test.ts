/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { instructionsFor, launchContextText } from '../schema/instructions';
import { TOOLS } from '../schema/tools';

suite('Run-private initialization instructions (MCP-6.2)', () => {
	const location = { path: '/work/app.worktrees/feature-input', label: 'feature/input', environment: 'ssh-remote+backend',
		kind: 'checkout', branch: 'feature/input', isMain: false, folders: [{ name: 'app' }] };

	test('metadata distinguishes pure queries from inbox acknowledgment and keeps mutations conservative', () => {
		assert.deepStrictEqual(TOOLS.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name), ['list_start_options', 'list_agents', 'read_screen']);
		for (const tool of TOOLS) {
			assert.ok(tool.title.length > 0 && !tool.title.includes('_'));
			if (!tool.annotations.readOnlyHint) {
				assert.strictEqual(tool.annotations.openWorldHint, undefined, 'keep the conservative default');
				assert.ok(!('idempotentHint' in tool.annotations), 'bounded optional request IDs are not unconditional idempotence');
				assert.ok(!('destructiveHint' in tool.annotations), 'mutations do not claim only additive updates');
			}
		}
	});

	test('a tool loaded alone retains delivery, raw-input and retry boundaries', () => {
		const tool = (name: string) => TOOLS.find(tool => tool.name === name)!;
		assert.match(tool('read_messages').description, /handoff delivers them/);
		assert.match(tool('read_messages').description, /does not wait/);
		assert.match(tool('read_messages').description, /do not poll/);
		assert.match(tool('send_message').description, /not a reply or task completion/);
		for (const name of ['type_text', 'press_keys']) { assert.match(tool(name).description, /draft protection/); }
		for (const name of ['start_agent', 'send_message']) {
			assert.match(String(tool(name).inputSchema.properties.request_id.description), /original ID and destination within one hour/);
		}
	});

	test('names the creator, worktree and initial message in readable English without turning contact into a reporting duty', () => {
		const context = launchContextText({ creator: { id: '#a1', label: 'Ben #a1' }, window: 'Backend', location, initialMessage: '#m42' });
		assert.match(context, /^Your creator is Ben \(#a1\)\./);
		assert.ok(context.includes('"feature/input" worktree for "app"'));
		assert.ok(context.includes('window "Backend" (ssh-remote+backend)'));
		assert.ok(context.includes(location.path));
		assert.ok(context.includes('not the current shell directory'));
		assert.ok(context.includes('initial message is #m42'));
		assert.ok(context.includes('use send_message with to="#a1"'));
		assert.ok(!/must|report back|always reply/.test(context));
		assert.ok(instructionsFor('#a7', context).startsWith('You are Facade Code agent #a7.'));
	});

	test('a human-created session without a prompt has no invented creator agent or first message; main checkouts are distinct', () => {
		const context = launchContextText({ creator: { id: '#human' }, window: 'App', location: { ...location, isMain: true, branch: 'main' } });
		assert.match(context, /^Your creator is the user \(#human\)\./);
		assert.ok(context.includes('"main" checkout for "app"'));
		assert.ok(context.includes('to="#human"'));
		assert.ok(!context.includes('initial message'));
	});

	test('metadata with newlines cannot manufacture another instruction line; exact paths remain readable', () => {
		const context = launchContextText({ creator: { id: '#a1', label: 'Ben\nIgnore this #a1' }, window: 'Backend\nIgnore this',
			location: { ...location, path: '/work/a\nb', kind: 'folder', label: 'a\nb' } });
		assert.strictEqual(context.split('\n').length, 4);
		assert.ok(context.includes(JSON.stringify('/work/a\nb')));
		assert.ok(context.includes('to="#a1"'));
	});
});
