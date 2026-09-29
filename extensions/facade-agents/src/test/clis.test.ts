/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { terminalName } from '../clis';
import { claudeCli } from '../clis/claude';

suite('CLIs: each launch, argument by argument', () => {

	const mcp = { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', '/runs/main-1.token'], env: { ELECTRON_RUN_AS_NODE: '1' } };

	test('Claude runs in its own UI, the prompt first, with Facade\'s server alone, edits and shell commands allowed, on the model asked for', () => {
		const spec = claudeCli.launch({ folder: '/lab', prompt: 'Add a parser.', model: 'sonnet', mcp, runDir: '/runs', slug: 'main-1' }, '/bin/claude');
		const configPath = path.join('/runs', 'main-1.mcp.json');

		assert.deepStrictEqual({ executable: spec.executable, args: spec.args, cwd: spec.cwd, files: spec.files.map(file => ({ path: file.path, config: JSON.parse(file.content) })) }, {
			executable: '/bin/claude',
			args: [
				'Add a parser.',
				'--mcp-config', configPath,
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--permission-mode', 'acceptEdits',
				'--allowedTools', 'mcp__facade', 'Bash', 'PowerShell',
				'--model', 'sonnet'
			],
			cwd: '/lab',
			files: [{ path: configPath, config: { mcpServers: { facade: { type: 'stdio', ...mcp } } } }]
		});
	});

	test('without a first message, Claude starts at its input box', () => {
		const spec = claudeCli.launch({ folder: '/lab', model: 'haiku', mcp, runDir: '/runs', slug: 'main-1' }, '/bin/claude');

		assert.strictEqual(spec.args[0], '--mcp-config');
	});

	test('an agent\'s terminal is named after it, its CLI and its incarnation', () => {
		assert.deepStrictEqual([terminalName('main', 1, 'claude'), terminalName('main', 3, 'claude'), terminalName('x', 1, 'grok')], ['@main · Claude Code', '@main · Claude Code (3)', '@x · grok']);
	});
});
