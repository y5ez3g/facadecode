/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { buildHelpMessage, OPTIONS } from '../../../platform/environment/node/argv.js';
import { areAIFeaturesOff, withoutAIOptions } from '../../node/cliAI.js';

suite('Command line - upstream\'s AI while it is off', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ID-19 off unless the person\'s settings turn it on: no settings, unreadable ones and ones that do not say are off', () => {
		assert.deepStrictEqual({
			none: areAIFeaturesOff(undefined),
			silent: areAIFeaturesOff('{ "editor.fontSize": 14 }'),
			commented: areAIFeaturesOff('{\n\t// on again\n\t"chat.disableAIFeatures": false,\n}'),
			saysOff: areAIFeaturesOff('{ "chat.disableAIFeatures": true }'),
			broken: areAIFeaturesOff('{ "chat.disableAIFeatures": '),
		}, { none: true, silent: true, commented: false, saysOff: true, broken: true });
	});

	test('ID-19 the help leaves out `chat` and `--agents` while it is off, and keeps the rest', () => {
		const help = buildHelpMessage('Facade Code', 'facade', '1.138.0', withoutAIOptions(OPTIONS));

		assert.deepStrictEqual({
			chat: /^\s+chat\b/m.test(help),
			agents: help.includes('--agents'),
			rest: help.includes('--new-window') && help.includes('tunnel'),
			stock: buildHelpMessage('Facade Code', 'facade', '1.138.0', OPTIONS).includes('--agents')
		}, { chat: false, agents: false, rest: true, stock: true });
	});
});
