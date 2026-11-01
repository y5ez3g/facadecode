/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { WINDOW_IDENTITY_COMMAND } from '../base/windowIdentity';
import { TestEmitter, withModules } from './withModules';

const SESSION = 'session-1';
const IDENTITY = { version: 1, token: '11111111-1111-4111-8111-111111111111', session: SESSION };

type Command = (...args: unknown[]) => unknown;

/** The editor as the workspace extension waits for its window component in it: its commands, extensions and notifications, scripted. */
function fakeEditor() {
	const handlers = new Map<string, Command>();
	const executed: string[] = [];
	const extensionsChanged = new TestEmitter<void>();
	const notices: { readonly kind: 'warning' | 'information'; readonly text: string; readonly actions: readonly string[]; answer(choice: string | undefined): void }[] = [];
	const providers = new Map<string, { resolveWebviewView(view: unknown): void }>();
	const vscode = {
		env: { language: 'en' },
		l10n: { t: (text: string) => text },
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => {
				executed.push(id);
				const handler = handlers.get(id);
				if (!handler) {
					throw new Error(`command '${id}' not found`);
				}
				return handler(...args);
			}
		},
		extensions: { onDidChange: extensionsChanged.event },
		window: {
			registerWebviewViewProvider: (id: string, provider: { resolveWebviewView(view: unknown): void }) => {
				providers.set(id, provider);
				return { dispose: () => providers.delete(id) };
			},
			showWarningMessage: (text: string, ...actions: string[]) => new Promise(resolve => notices.push({ kind: 'warning', text, actions, answer: resolve })),
			showInformationMessage: (text: string, ...actions: string[]) => new Promise(resolve => notices.push({ kind: 'information', text, actions, answer: resolve }))
		},
		Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => parts.forEach(part => part.dispose()) }) }
	};
	const component = withModules({ vscode })<typeof import('../host/windowComponent')>(require.resolve('../host/windowComponent'));
	return { component, handlers, executed, extensionsChanged, notices, providers };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

suite('The window component as the workspace extension waits for it (ARCHITECTURE-4.3, D94, VERIFICATION E06)', () => {

	test('a component that answers for this window is its identity at once; one that answers for another window is none', async () => {
		const editor = fakeEditor();
		editor.handlers.set(WINDOW_IDENTITY_COMMAND, session => ({ ...IDENTITY, session }));
		assert.deepStrictEqual(await editor.component.waitForWindowIdentity(SESSION, 1_000), IDENTITY);
		// A late answer of an earlier editor session identifies no window
		editor.handlers.set(WINDOW_IDENTITY_COMMAND, () => ({ ...IDENTITY, session: 'session-0' }));
		assert.strictEqual(await editor.component.waitForWindowIdentity(SESSION, 1_000), undefined);
	});

	test('a component the editor installs or activates later is waited for: asked again as extensions change, and at least twice a second', async () => {
		const editor = fakeEditor();
		const began = Date.now();
		const waiting = editor.component.waitForWindowIdentity(SESSION, 5_000);
		await tick();
		editor.handlers.set(WINDOW_IDENTITY_COMMAND, () => IDENTITY);
		editor.extensionsChanged.fire();
		assert.deepStrictEqual(await waiting, IDENTITY);
		assert.ok(Date.now() - began < 400, 'a change of extensions asks again at once');
		// With no change told, the next try comes within half a second
		const quiet = fakeEditor();
		const again = quiet.component.waitForWindowIdentity(SESSION, 5_000);
		setTimeout(() => quiet.handlers.set(WINDOW_IDENTITY_COMMAND, () => IDENTITY), 100);
		const since = Date.now();
		assert.deepStrictEqual(await again, IDENTITY);
		assert.ok(Date.now() - since < 1_000);
	});

	test('a component that never answers within the wait is none, and the waiting ends then', async () => {
		const editor = fakeEditor();
		const began = Date.now();
		assert.strictEqual(await editor.component.waitForWindowIdentity(SESSION, 300), undefined);
		const waited = Date.now() - began;
		assert.ok(waited >= 300 && waited < 1_500, String(waited));
		assert.ok(editor.executed.filter(id => id === WINDOW_IDENTITY_COMMAND).length >= 1);
	});

	test('missing, the panel and one warning say what to do in plain words, each opening the component in the Extensions view; once it answers, a reload is offered once', async () => {
		const editor = fakeEditor();
		editor.handlers.set('extension.open', () => undefined);
		editor.handlers.set('workbench.action.reloadWindow', () => undefined);
		const subscriptions: { dispose(): void }[] = [];
		const shown = editor.component.showComponentMissing({ subscriptions } as never, SESSION);
		assert.strictEqual(subscriptions.length, 1);

		const [warning] = editor.notices;
		assert.deepStrictEqual([warning.kind, warning.actions], ['warning', ['Show Window Component']]);
		assert.match(warning.text, /needs its Window Component on this computer.*Agents that are already running keep running\./);
		warning.answer('Show Window Component');
		await tick();
		assert.deepStrictEqual(editor.executed, ['extension.open']);

		// The panel's own page: the same words and button, no remote content, no command links
		const received: ((message: unknown) => void)[] = [];
		const view = { webview: { options: {}, html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: (listener: (message: unknown) => void) => received.push(listener) } };
		editor.providers.get('facade.agents')!.resolveWebviewView(view);
		assert.deepStrictEqual(view.webview.options, { enableScripts: true, enableCommandUris: false });
		assert.match(view.webview.html, /default-src 'none'/);
		assert.ok(view.webview.html.includes('Install and enable &#34;Facade Code Window Component&#34;'), 'its words are escaped text');
		received[0]('show');
		await tick();
		assert.deepStrictEqual(editor.executed, ['extension.open', 'extension.open']);

		// Extensions change while it is still missing: nothing is offered
		editor.extensionsChanged.fire();
		await tick();
		assert.strictEqual(editor.notices.length, 1);
		// It answers now: a reload is offered, once however often extensions change
		editor.handlers.set(WINDOW_IDENTITY_COMMAND, () => IDENTITY);
		editor.extensionsChanged.fire();
		editor.extensionsChanged.fire();
		await tick();
		await tick();
		const offers = editor.notices.filter(notice => notice.kind === 'information');
		assert.deepStrictEqual(offers.map(notice => [notice.text, notice.actions]), [['The Facade Code Window Component is installed. Reload the window to start Facade Code.', ['Reload Window']]]);
		offers[0].answer('Reload Window');
		await tick();
		assert.strictEqual(editor.executed.at(-1), 'workbench.action.reloadWindow');

		// Disposed with the extension: the panel's page and the listening go
		shown.dispose();
		assert.strictEqual(editor.providers.size, 0);
	});

	test('the editor telling of the change before it activates the component: the component is asked for again, and the reload offered once it answers (ARCHITECTURE-4.3)', async function () {
		this.timeout(10_000);
		const editor = fakeEditor();
		const shown = editor.component.showComponentMissing({ subscriptions: [] } as never, SESSION);
		// Installed and enabled now, activated a moment later
		editor.extensionsChanged.fire();
		await new Promise(resolve => setTimeout(resolve, 700));
		assert.strictEqual(editor.notices.filter(notice => notice.kind === 'information').length, 0);
		editor.handlers.set(WINDOW_IDENTITY_COMMAND, () => IDENTITY);
		const deadline = Date.now() + 3_000;
		while (!editor.notices.some(notice => notice.kind === 'information')) {
			assert.ok(Date.now() < deadline, 'the reload is offered once the component answers');
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		shown.dispose();
	});
});
