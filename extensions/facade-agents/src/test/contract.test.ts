/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { Contract, ToolResult } from '../contract/tools';
import { Caller } from '../record/events';
import { PERSON } from '../record/registry';
import { fakeWorld } from './fakes';
import { tempDir } from './util';

suite('Contract: what the model sees, word for word, over the real core with the window faked', () => {

	let temp: { dir: string; remove(): void };
	let world: ReturnType<typeof fakeWorld>;
	let contract: Contract;
	let main: Caller;

	setup(async () => {
		temp = tempDir('facade-contract-');
		world = fakeWorld(path.join(temp.dir, 'workspace'), { '/lab': 'main' });
		contract = new Contract(world.facade);
		const agent = await world.facade.startAgent(PERSON, { cli: 'claude', model: 'sonnet', folder: '/lab' });
		main = { name: agent.name, incarnation: agent.incarnation };
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('an agent is told who it is, who started it, where it runs and what ide does; the ide tool lists its actions and their arguments', () => {
		const hello = contract.hello(main);
		const ide = hello.tools[0] as { name: string; description: string; inputSchema: { properties: { action: { enum: string[] } } } };

		assert.deepStrictEqual({
			name: hello.name,
			tools: hello.tools.map(tool => tool.name),
			actions: ide.inputSchema.properties.action.enum,
			description: ide.description,
			instructions: hello.instructions.split('\n'),
			person: contract.hello(PERSON).instructions.split('\n')
		}, {
			name: 'main',
			tools: ['ide'],
			actions: ['open_file', 'open_terminal', 'read_terminal', 'send_terminal', 'command'],
			description: 'Does in the IDE what the person can do there. The actions, with their args: '
				+ 'open_file (path, line?): open a file in the editor, at a line; '
				+ 'open_terminal (path, name?): open a terminal in a folder, held under its row, and get its name; '
				+ 'read_terminal (name, lines?): the last lines a terminal shows: 50, or as many as lines says up to 2000; '
				+ 'send_terminal (name, text, enter?): type text into a terminal, then Enter unless enter is false; '
				+ 'command (id, args?): run any VS Code command, its arguments as a list. '
				+ 'A path is absolute.',
			instructions: [
				'You are @main, a Claude Code agent in Facade Code, started by the person.',
				'You run in /lab: the worktree main. You are in that folder already: run commands there without cd.',
				'ide does what the person can do in the IDE.'
			],
			person: ['You act as the person, @you, in Facade Code.', 'ide does what the person can do in the IDE.']
		});
	});

	test('each action does what it says, and says what it did', async () => {
		const file = path.join(temp.dir, 'src', 'a.ts');
		world.ide.terminals.set('build', 'npm test\n3 passing');
		const ide = (action: string, args?: object) => contract.call(main, 'ide', { action, args });

		const results = [
			await ide('open_file', { path: file, line: 12 }),
			await ide('open_file', { path: file }),
			await ide('open_terminal', { path: temp.dir, name: 'checks' }),
			await ide('read_terminal', { name: 'checks' }),
			await ide('read_terminal', { name: 'bui', lines: 5000 }),
			await ide('send_terminal', { name: 'checks', text: 'git status' }),
			await ide('send_terminal', { name: 'checks', text: 'y', enter: false }),
			await ide('command', { id: 'workbench.action.files.save', args: [1, 'a'] }),
			await ide('command', { id: 'nothing' })
		];

		assert.deepStrictEqual({ results, steps: world.ide.steps }, {
			results: [
				{ text: `Opened ${file} at line 12.` },
				{ text: `Opened ${file}.` },
				{ text: `Opened the terminal checks in ${temp.dir}.`, data: { name: 'checks' } },
				{ text: 'checks has shown nothing yet.', data: { name: 'checks' } },
				{ text: 'The last 2000 lines of build:\nnpm test\n3 passing', data: { name: 'build', text: 'npm test\n3 passing' } },
				{ text: 'Typed into checks, then Enter.', data: { name: 'checks' } },
				{ text: 'Typed into checks.', data: { name: 'checks' } },
				{ text: 'Ran workbench.action.files.save; it returned {"ran":"workbench.action.files.save"}.' },
				{ text: 'Ran nothing; it returned nothing.' }
			],
			steps: [
				`open ${file} at 12`,
				`open ${file}`,
				`terminal checks in ${temp.dir}`,
				'read 50 lines of checks',
				'read 2000 lines of build',
				'type "git status" and Enter into checks',
				'type "y" into checks',
				'run workbench.action.files.save [1,"a"]',
				'run nothing []'
			]
		});
	});

	test('a wrong argument is INVALID, and the result says what is right', async () => {
		const file = path.join(temp.dir, 'a.ts');
		const calls: [string, unknown][] = [
			['ide', { action: 'dance' }],
			['ide', { action: 'open_file' }],
			['ide', { action: 'open_file', args: { path: 'src/a.ts' } }],
			['ide', { action: 'open_file', args: { path: file, line: 0 } }],
			['ide', { action: 'open_file', args: { file } }],
			['ide', { action: 'open_file', args: [file] }],
			['ide', { action: 'send_terminal', args: { name: 'checks', text: 3 } }],
			['ide', { action: 'send_terminal', args: { name: ' ', text: 'x' } }],
			['ide', { action: 'send_terminal', args: { name: 'checks', text: 'x', enter: 'yes' } }],
			['ide', { action: 'command', args: { id: 'x', args: 'y' } }],
			['ide', { action: 'open_file', verbose: true }],
			['ide', 'open_file'],
			['spawn', { cli: 'claude' }]
		];
		const results: ToolResult[] = [];
		for (const [tool, args] of calls) {
			results.push(await contract.call(main, tool, args));
		}

		assert.deepStrictEqual({ results: results.map(result => `${result.isError ? (result.data as { code: string }).code : 'OK'}: ${result.text}`), steps: world.ide.steps }, {
			results: [
				'INVALID: Unknown action dance. The actions: open_file, open_terminal, read_terminal, send_terminal, command.',
				'INVALID: path is required.',
				'INVALID: path must be an absolute path, not src/a.ts.',
				'INVALID: line must be a whole number above 0.',
				'INVALID: open_file takes path, line?; not file.',
				'INVALID: args must be an object: the action\'s arguments.',
				'INVALID: text must be a string.',
				'INVALID: name must not be empty.',
				'INVALID: enter must be true or false.',
				'INVALID: args must be a list.',
				'INVALID: ide takes action, args?; not verbose.',
				'INVALID: ide takes an object of arguments: action, args?.',
				'INVALID: Unknown tool spawn. The tools: ide.'
			],
			steps: []
		});
	});

	test('what is not there is NOT_FOUND, and what the window could not do is FAILED', async () => {
		const missing = await contract.call(main, 'ide', { action: 'read_terminal', args: { name: 'nope' } });
		const failed = await contract.call(main, 'ide', { action: 'command', args: { id: 'fail' } });

		assert.deepStrictEqual([missing, failed], [
			{ text: 'No terminal is called nope.', isError: true, data: { code: 'NOT_FOUND' } },
			{ text: 'command \'fail\' failed.', isError: true, data: { code: 'FAILED' } }
		]);
	});
});
