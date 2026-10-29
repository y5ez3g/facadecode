/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUILT_IN_LAUNCHERS, readCustomAgents } from '../../common/terminalLaunchers.js';

suite('Terminal launchers - the agents the menu offers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the built-ins are Claude Code, Codex, Antigravity, Muse Code and Qwen Code, in that order, each by the id Start Agent takes and its settings', () => {
		assert.deepStrictEqual(BUILT_IN_LAUNCHERS.map(launcher => [launcher.id, launcher.label, launcher.command, launcher.setting]), [
			['claude', 'Claude Code', 'claude', 'facade.agents.claude'],
			['codex', 'Codex', 'codex', 'facade.agents.codex'],
			['agy', 'Antigravity', 'agy', 'facade.agents.antigravity'],
			['muse', 'Muse Code', 'muse', 'facade.agents.muse'],
			['qwen', 'Qwen Code', 'qwen', 'facade.agents.qwen']
		]);
	});

	test('the person\'s custom agents are read in the order they wrote them, each by its name and the program its path names - one with no program listed all the same, for choosing it to say what is wrong', () => {
		assert.deepStrictEqual(readCustomAgents({
			reviewer: { path: ' /opt/review/bin/review ', launch: { arguments: { task: ['--', '${task}'] } } },
			cursor: { path: 'cursor-agent' },
			broken: { launch: {} },
			odd: 'not an object'
		}), [
			{ id: 'reviewer', label: 'reviewer', command: '/opt/review/bin/review', custom: true },
			{ id: 'cursor', label: 'cursor', command: 'cursor-agent', custom: true },
			{ id: 'broken', label: 'broken', command: '', custom: true },
			{ id: 'odd', label: 'odd', command: '', custom: true }
		]);
	});

	test('anything but an object of agents is none', () => {
		assert.deepStrictEqual([readCustomAgents(undefined), readCustomAgents([{ id: 'claude' }]), readCustomAgents('claude')], [[], [], []]);
	});
});
