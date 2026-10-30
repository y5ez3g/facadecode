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
			window: { showErrorMessage: (text: string) => { shown.push(text); return Promise.resolve(undefined); } },
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
			window: { showErrorMessage: (text: string) => { shown.push(text); return Promise.resolve(undefined); } },
			commands: { executeCommand: async () => undefined }
		};
		const { WindowHuman } = withModules({ vscode: vscodeApi })<typeof import('../host/human')>(require.resolve('../host/human'));
		const human = new WindowHuman(async () => undefined);
		human.failed({ kind: 'start', name: 'Bea', reason: 'claude is not installed in this environment.' }, {});
		assert.deepStrictEqual(shown, [
			'Could not start Bea: claude is not installed in this environment.'
		]);
	});
});
