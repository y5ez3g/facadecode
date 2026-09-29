/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Contract } from '../contract/tools';
import { Caller } from '../record/events';
import { PERSON } from '../record/registry';
import { PipeEndpoint } from '../transport/endpoint';
import { pipePath } from '../transport/pipe';
import { fakeWorld, worktreeFolder } from './fakes';
import { StdioMcpClient } from './mcpClient';
import { runHook, tempDir } from './util';

suite('Parents and children through the real shim, launchers and pipe, with the window faked', function () {

	this.timeout(60_000);

	let temp: { dir: string; remove(): void };
	let world: ReturnType<typeof fakeWorld>;
	let endpoint: PipeEndpoint<Caller>;
	const clients: StdioMcpClient[] = [];

	/** An agent's MCP server, as its launch starts it: the shim with the token file of its run. */
	function serverOf(name: string): StdioMcpClient {
		const agent = world.registry.agent(name)!;
		const client = StdioMcpClient.start(['--pipe', endpoint.pipe, '--token-file', path.join(world.registry.runsDir, `${agent.name}-${agent.incarnation}.token`)]);
		clients.push(client);
		return client;
	}

	/** The command line Claude runs for one of an agent's hooks, from the settings of its launch. */
	function hookOf(name: string, event: string): string {
		const launched = world.terminals.launched.find(each => each.name.startsWith(`@${name} `))!;
		const settings = JSON.parse(fs.readFileSync(launched.args[launched.args.indexOf('--settings') + 1], 'utf8'));
		return settings.hooks[event][0].hooks[0].command;
	}

	setup(async () => {
		temp = tempDir('facade-integration-');
		// The core needs the endpoint's launchers and the endpoint needs the core: nothing starts before both are there.
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { '/lab': [] }, hookCommand: (tokenFile, run) => endpoint.hookCommand(tokenFile, run) });
		const contract = new Contract(world.facade);
		endpoint = await PipeEndpoint.start(pipePath(`test-${crypto.randomBytes(6).toString('hex')}`), world.registry.dir, {
			authenticate: token => world.registry.authenticate(token),
			hello: caller => contract.hello(caller),
			call: (caller, tool, args) => contract.call(caller, tool, args),
			hook: (caller, event, payload) => world.facade.hook(caller, event, payload)
		}, path.join(temp.dir, 'hooks'));
		await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', prompt: 'Lead.', folder: '/lab' });
	});

	teardown(async () => {
		await Promise.all(clients.splice(0).map(client => client.stop()));
		endpoint.dispose();
		world.dispose();
		temp.remove();
	});

	test('a lead sends a child out, the child reports, and the report comes back to the lead with its next result', async () => {
		const main = serverOf('main');
		await main.initialize();
		const spawned = await main.call('spawn', { cli: 'claude', model: 'haiku', prompt: 'Add clamp.', worktree: 'new', name: 'clamp' });
		const clamp = serverOf('clamp');
		await clamp.initialize();
		const sibling = await clamp.call('send', { to: '@nobody', text: 'Hi.' });
		const report = await clamp.call('send', { to: '@main', text: 'Done: clamp() on the branch clamp.' });
		const next = await main.call('ide', { action: 'command', args: { id: 'nothing' } });
		const stopped = await main.call('stop', { name: '@clamp' });
		const refused = await clamp.call('send', { to: '@main', text: 'Still here?' });

		assert.deepStrictEqual({
			spawned: spawned.text,
			sibling: [sibling.isError, sibling.data?.code, sibling.text],
			report: report.text,
			next: next.text,
			stopped: stopped.text,
			refused: refused.isError && /no longer accepts @clamp/.test(refused.text)
		}, {
			spawned: `Started @clamp: Claude Code on haiku, in the new worktree clamp at ${worktreeFolder('/lab', 'clamp')}, on the branch clamp. Its messages reach you by themselves.`,
			sibling: [true, 'REFUSED', '@nobody is not your parent or one of your children. Yours: @main, your parent.'],
			report: 'Sent to @main.',
			next: 'Ran nothing; it returned nothing.\n\nMessages for you:\n[from @clamp] Done: clamp() on the branch clamp.',
			stopped: 'Stopped @clamp. Its worktree clamp stays as it is.',
			refused: true
		});
	});

	test('a child\'s hooks, run as Claude runs them, load its opening at its start; its parent\'s Stop hook goes on with its report', async () => {
		const main = serverOf('main');
		await main.initialize();
		await main.call('spawn', { cli: 'claude', model: 'haiku', prompt: 'Add clamp.', name: 'clamp' });
		const opening = await runHook(hookOf('clamp', 'SessionStart'), '{"source":"startup"}');
		const clamp = serverOf('clamp');
		await clamp.initialize();
		await clamp.call('send', { to: '@main', text: 'Done.' });
		const stop = await runHook(hookOf('main', 'Stop'), '{"stop_hook_active":false}');

		assert.deepStrictEqual({ opening, stop, main: world.registry.agent('main')?.state }, {
			opening: { status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You are @clamp; your parent is @main."}}\n' },
			stop: { status: 0, stdout: '{"decision":"block","reason":"[from @clamp] Done."}\n' },
			main: 'working'
		});
	});
});
