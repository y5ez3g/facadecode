/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { withModules } from './withModules';

suite('Host: the person in this window (RULES-1.8, UX-1.2)', () => {

	test('launch notifications and standalone failures share the four truthful retained-effect outcomes', () => {
		const shown: string[] = [];
		const api = {
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
			window: { showErrorMessage: (text: string) => { shown.push(text); return Promise.resolve(undefined); }, tabGroups: { onDidChangeTabs: () => ({ dispose: () => undefined }) } },
			commands: { executeCommand: async () => undefined }
		};
		const load = withModules({ vscode: api });
		const { WindowHuman } = load<typeof import('../host/human')>(require.resolve('../host/human'));
		const { worktreeFailureText } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		const human = new WindowHuman(async () => undefined);
		const suffixes = ['', ' Branch fix was created and kept.', ' Folder /work/fix was created and kept.', ' Branch fix and folder /work/fix were created and kept.'];
		const effects = [undefined, { branch: 'fix' }, { folder: '/work/fix' }, { branch: 'fix', folder: '/work/fix' }];
		effects.forEach((worktree, i) => {
			human.failed({ kind: 'start', name: 'Ada', reason: 'disk full.', ...(worktree ? { worktree } : {}) }, {});
			assert.strictEqual(worktreeFailureText('disk full.', worktree), `Could not create worktree: disk full.${suffixes[i]}`);
		});
		assert.deepStrictEqual(shown, suffixes.map(suffix => `Could not start Ada: disk full.${suffix}`));
		const { withWorktreeEffects } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		assert.strictEqual(withWorktreeEffects('磁盘已满。', { branch: 'fix' }), '磁盘已满。 Branch fix was created and kept.');
	});
	test('a failed start is told in the related window (LIFECYCLE-1.5)', () => {
		const shown: string[] = [];
		const vscodeApi = {
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
			window: { showErrorMessage: (text: string) => { shown.push(text); return Promise.resolve(undefined); }, tabGroups: { onDidChangeTabs: () => ({ dispose: () => undefined }) } },
			commands: { executeCommand: async () => undefined }
		};
		const { WindowHuman } = withModules({ vscode: vscodeApi })<typeof import('../host/human')>(require.resolve('../host/human'));
		const human = new WindowHuman(async () => undefined);
		human.failed({ kind: 'start', name: 'Bea', reason: 'claude is not installed in this environment.' }, {});
		assert.deepStrictEqual(shown, [
			'Could not start Bea: claude is not installed in this environment.'
		]);
	});

	test('LIFECYCLE-3.1, D172: a live agent\'s tab closed by itself closes it without a question; with other tabs, the agents are asked about once', async () => {
		const asked: { message: string; detail: string }[] = [];
		let answer: string | undefined = 'Close Agent';
		let confirmOnKill: string | undefined;
		const listeners: ((event: { closed: readonly unknown[] }) => void)[] = [];
		const api = {
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
			workspace: { getConfiguration: () => ({ get: () => confirmOnKill }) },
			window: {
				showWarningMessage: async (message: string, options: { detail: string }, action: string) => { asked.push({ message, detail: options.detail }); return answer === 'Close Agent' ? action : answer; },
				tabGroups: { onDidChangeTabs: (listener: (event: { closed: readonly unknown[] }) => void) => { listeners.push(listener); return { dispose: () => undefined }; } }
			}
		};
		const { WindowHuman } = withModules({ vscode: api })<typeof import('../host/human')>(require.resolve('../host/human'));
		const human = new WindowHuman(async () => undefined);
		const closeTabs = (count: number) => listeners.forEach(listener => listener({ closed: Array.from({ length: count }, () => ({})) }));
		const ada = { run: 'run-1', label: 'Ada' };
		const bo = { run: 'run-2', label: 'Bo' };

		// Its close button, Close or Close Editor: its tab alone closes
		closeTabs(1);
		const alone = await human.confirmClose(ada);
		// Close Others from a file: the file's tab and the agent's close together
		closeTabs(2);
		const withFile = await human.confirmClose(ada);
		answer = undefined;
		closeTabs(1);
		const later = human.confirmClose(ada);
		closeTabs(1);
		const cancelled = await later;
		// Close All of two agents: one question for both
		answer = 'Close Agents';
		closeTabs(2);
		const both = await Promise.all([human.confirmClose(ada), human.confirmClose(bo)]);
		confirmOnKill = 'never';
		closeTabs(3);
		const never = await human.confirmClose(ada);
		human.dispose();
		assert.deepStrictEqual([alone, withFile, cancelled, both, never], [true, true, false, [true, true], true]);
		assert.deepStrictEqual(asked.map(each => each.message), ['Close Ada?', 'Close Ada?', 'Close 2 agents?']);
		assert.ok(asked[2].detail.startsWith('Ada, Bo\n\n'), asked[2].detail);
	});
});
