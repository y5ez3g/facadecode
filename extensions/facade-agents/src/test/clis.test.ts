/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { terminalName } from '../clis';
import { claudeCli } from '../clis/claude';
import { keysToAnswer } from '../core/firstRun';

suite('CLIs: each launch, argument by argument', () => {

	const mcp = { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', '/runs/main-1.token'], env: { ELECTRON_RUN_AS_NODE: '1' } };
	const input = { folder: '/lab', model: 'sonnet', mcp, hookCommand: '/facade/hooks/lab-main-1.cmd', skills: [{ name: 'facade', description: 'How to work in Facade Code.', body: '# Working in Facade Code' }], runDir: '/runs', slug: 'main-1' };

	test('Claude runs in its own UI, the prompt first, with Facade\'s server alone, its hooks and skills from the run, edits and shell commands allowed, on the model asked for', () => {
		const spec = claudeCli.launch({ ...input, prompt: 'Add a parser.' }, '/bin/claude');
		const run = (file: string) => path.join('/runs', file);
		const files = Object.fromEntries(spec.files.map(file => [path.relative('/runs', file.path).split(path.sep).join('/'), file.path.endsWith('.md') ? file.content : JSON.parse(file.content)]));
		const hook = (event: string) => [{ type: 'command', command: `/facade/hooks/lab-main-1.cmd event:${event}`, timeout: 30 }];

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, cwd: spec.cwd, files }, {
			executable: '/bin/claude',
			args: [
				'Add a parser.',
				'--mcp-config', run('main-1.mcp.json'),
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--settings', run('main-1.settings.json'),
				'--plugin-dir', run('main-1.plugin'),
				'--permission-mode', 'acceptEdits',
				'--allowedTools', 'mcp__facade', 'Bash', 'PowerShell',
				'--model', 'sonnet'
			],
			cwd: '/lab',
			files: {
				'main-1.mcp.json': { mcpServers: { facade: { type: 'stdio', ...mcp } } },
				'main-1.settings.json': {
					hooks: {
						SessionStart: [{ hooks: hook('start') }],
						UserPromptSubmit: [{ hooks: hook('prompt') }],
						Stop: [{ hooks: hook('stop') }],
						Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: hook('notification') }]
					}
				},
				'main-1.plugin/.claude-plugin/plugin.json': { name: 'facade', version: '1.0.0', description: 'How to work in Facade Code with your parent, your children and the person.', author: { name: 'Facade Code' } },
				'main-1.plugin/skills/facade/SKILL.md': '---\nname: facade\ndescription: How to work in Facade Code.\n---\n\n# Working in Facade Code\n'
			}
		});
	});

	test('without a first message, Claude starts at its input box', () => {
		const spec = claudeCli.launch(input, '/bin/claude');

		assert.strictEqual(spec.args[0], '--mcp-config');
	});

	test('Claude\'s hooks read as Facade\'s events; its SessionStart hook loads the opening, and its Stop hook goes on with the messages', () => {
		const read = [
			claudeCli.readHook('start', { source: 'compact' }),
			claudeCli.readHook('prompt', { prompt: 'hi' }),
			claudeCli.readHook('stop', { stop_hook_active: false }),
			claudeCli.readHook('stop', { stop_hook_active: true }),
			claudeCli.readHook('notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
			claudeCli.readHook('notification', { notification_type: 'elicitation_dialog' }),
			claudeCli.readHook('notification', { notification_type: 'idle_prompt' }),
			claudeCli.readHook('notification', { notification_type: 'auth_success' }),
			claudeCli.readHook('sessionstart', {})
		];

		assert.deepStrictEqual({ read, opening: claudeCli.openWith('You are @clamp.'), answer: claudeCli.continueWith('[from @clamp] Done.') }, {
			read: [
				{ kind: 'start' },
				{ kind: 'prompt' },
				{ kind: 'stop', continuing: false },
				{ kind: 'stop', continuing: true },
				{ kind: 'waiting', what: 'Claude needs your permission to use Bash' },
				{ kind: 'waiting', what: 'a question' },
				{ kind: 'idle' },
				undefined,
				undefined
			],
			opening: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You are @clamp."}}',
			answer: '{"decision":"block","reason":"[from @clamp] Done."}'
		});
	});

	test('a message is typed into Claude as its first line, the rest pasted so that its line breaks do not submit it', () => {
		assert.deepStrictEqual([claudeCli.typing('[from @clamp] Done.'), claudeCli.typing('[from @clamp] Done:\n- clamp.js\n- clamp.test.js')], [
			['[from @clamp] Done.'],
			['[from @clamp] Done:', '\x1b[200~\n- clamp.js\n- clamp.test.js\x1b[201~']
		]);
	});

	test('Claude\'s question whether it trusts a folder is answered by moving to Yes and pressing Enter; a screen without it asks nothing', () => {
		const screen = [
			'Do you trust the files in this folder?',
			'',
			'  C:\\Users\\me\\.facade\\worktrees\\lab\\clamp',
			'',
			'\u276f 1. No, exit',
			'  2. Yes, I trust this folder',
			'',
			'Enter to confirm'
		].join('\n');

		assert.deepStrictEqual([keysToAnswer(screen, claudeCli.firstRun!), keysToAnswer('> Try "write a test"', claudeCli.firstRun!)], [['\x1b[B', '\r'], undefined]);
	});

	test('an agent\'s terminal is named after it, its CLI and its incarnation', () => {
		assert.deepStrictEqual([terminalName('main', 1, 'claude'), terminalName('main', 3, 'claude'), terminalName('x', 1, 'grok')], ['@main · Claude Code', '@main · Claude Code (3)', '@x · grok']);
	});
});
