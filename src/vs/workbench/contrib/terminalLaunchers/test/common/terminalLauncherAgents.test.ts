/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUILT_IN_LAUNCHERS, readConfiguredLaunchers, seedLaunchers, toConfiguredLaunchers, uniqueLauncherId } from '../../common/terminalLaunchers.js';

suite('Terminal launchers - the agents somebody keeps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a well formed setting is read back as it was written', () => {
		const agents = [{ id: 'claude', label: 'Claude Code', command: 'claude --resume' }];

		assert.deepStrictEqual(readConfiguredLaunchers(agents), agents);
	});

	test('what is written back is the fields somebody can change, and nothing derived', () => {
		// The stored shape is pinned on purpose: whatever else a launcher grows in the source, the
		// setting keeps holding these and nothing leaks into somebody's JSON.
		assert.deepStrictEqual(toConfiguredLaunchers([BUILT_IN_LAUNCHERS[0]]), [
			{ id: 'claude', label: 'Claude Code', command: 'claude' }
		]);
	});

	test('a row that cannot start anything is dropped rather than drawn', () => {
		assert.deepStrictEqual(readConfiguredLaunchers([
			{ id: 'ok', command: 'ok' },			// the least a row can say
			{ id: 'no-command' },					// nothing to run and no way to say so
			{ command: 'no-id' },					// nothing to key it on
			{ id: '   ', command: 'blank' },		// an id of spaces is no id
			{ id: 'ok', command: 'again' },			// the second of a repeated id
			'not an object',
			null
		]), [
			{ id: 'ok', label: 'ok', command: 'ok' }
		]);
	});

	test('an empty command is kept, because that is the shell', () => {
		assert.deepStrictEqual(readConfiguredLaunchers([{ id: 'shell', command: '' }]), [
			{ id: 'shell', label: 'shell', command: '' }
		]);
	});

	test('anything but an array is nothing', () => {
		assert.deepStrictEqual([
			readConfiguredLaunchers(undefined),
			readConfiguredLaunchers({ id: 'claude', command: 'claude' }),
			readConfiguredLaunchers('claude')
		], [[], [], []]);
	});

	test('a first run is seeded with what the scan found', () => {
		assert.deepStrictEqual(seedLaunchers(new Set(['claude', 'grok'])).map(l => l.id), ['claude', 'grok']);
	});

	test('a scan that found nothing offers the whole table rather than an empty form', () => {
		// Nothing found is usually the scan being stale - the `PATH` a window started with does not
		// follow an installer - so it is not taken as proof that the machine has no agents.
		assert.deepStrictEqual(seedLaunchers(new Set()).map(l => l.id), BUILT_IN_LAUNCHERS.map(l => l.id));
	});

	test('a new row gets an id from its name, and never one that is taken', () => {
		const taken = new Set(['claude', 'my-agent']);

		assert.deepStrictEqual([
			uniqueLauncherId('Codex', taken),
			uniqueLauncherId('My Agent', taken),
			uniqueLauncherId('  Claude  ', taken),
			uniqueLauncherId('!!!', taken)
		], ['codex', 'my-agent-2', 'claude-2', 'agent']);
	});
});
