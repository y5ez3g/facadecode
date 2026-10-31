/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WINDOW_IDENTITY_COMMAND, WINDOW_TERMINALS_COMMAND } from '../base/windowIdentity';
import { withModules } from './withModules';

suite('A window whose Facade cannot start says what helps (ARCHITECTURE-2.2, UX-2.4)', () => {
	let temp: string;
	let commands: Map<string, (...args: unknown[]) => unknown>;
	let shown: { readonly text: string; readonly items: readonly string[] }[];
	let executed: string[];
	const session = 'session-now';
	const none = { dispose: () => undefined };
	const api = () => ({
		env: { sessionId: session, remoteName: undefined, appName: 'Visual Studio Code' },
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { commands.set(id, handler); return none; },
			executeCommand: async (id: string, ...args: unknown[]) => {
				executed.push(id);
				const handler = commands.get(id);
				if (!handler) {
					throw new Error(`command '${id}' not found`);
				}
				return handler(...args);
			}
		},
		window: {
			registerWebviewViewProvider: () => none,
			showErrorMessage: async (text: string, ...items: string[]) => { shown.push({ text, items }); return undefined; }
		},
		workspace: { workspaceFolders: undefined, workspaceFile: undefined }
	});

	setup(() => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-activation-'));
		commands = new Map();
		shown = [];
		executed = [];
	});

	teardown(() => {
		fs.rmSync(temp, { recursive: true, force: true });
	});

	test('a damaged handover record: the window component invents no identity and answers so, the workspace component says to open the folder again - not to reload, which reads the same record - in its notification and panel', async () => {
		const vscode = api();
		fs.writeFileSync(path.join(temp, 'handover.json'), '{');
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		const context = { logUri: { fsPath: temp }, subscriptions: [] as unknown[] };
		activate(context as never);
		assert.strictEqual(fs.readFileSync(path.join(temp, 'handover.json'), 'utf8'), '{', 'no other identity is written');
		assert.deepStrictEqual([...commands.keys()], [WINDOW_IDENTITY_COMMAND], 'no terminal registry without an identity');
		assert.deepStrictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!(session), { version: 1, session, damaged: true });
		assert.strictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!('session-before'), undefined, 'a late request of another editor session is not answered');
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const failure = await service.activateFacade({ subscriptions: [] } as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.ok(failure instanceof service.ActivationError);
		assert.strictEqual(failure.message, "This window's Facade Code record is damaged, so its agents cannot be restored here. Close this window and open its folder or workspace again, or restart Visual Studio Code.");
		assert.strictEqual(failure.reloadHelps, false);
		assert.ok(!executed.includes(WINDOW_TERMINALS_COMMAND));
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(shown, [{ text: failure.message, items: [] }], 'no Reload Window that cannot help');
	});

	test('a handover record that cannot be read now - not damaged - fails the window component with a reload, which may read it then', () => {
		const vscode = api();
		// A folder where the record would be: reading it fails, as a lock or a lack of file handles would
		fs.mkdirSync(path.join(temp, 'handover.json'));
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		assert.throws(() => activate({ logUri: { fsPath: temp }, subscriptions: [] } as never), /Could not restore agents for this window\. Reload the window to try again\./);
		assert.deepStrictEqual([...commands.keys()], [], 'nothing answers as damaged');
	});

	test('a window component that does not answer: the workspace component says to reload, which tries again, with Reload Window', async () => {
		const vscode = api();
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const failure = await service.activateFacade({ subscriptions: [] } as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.ok(failure instanceof service.ActivationError);
		assert.strictEqual(failure.message, 'Could not restore agents for this window. Reload the window to try again.');
		assert.strictEqual(failure.reloadHelps, true);
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(shown, [{ text: failure.message, items: ['Reload Window'] }]);
	});
});
