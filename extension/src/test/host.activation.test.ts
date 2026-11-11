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
	/** Facade: Home as the person set it in their user settings; none, never set. */
	let home: unknown;
	let terminalHome: string[];
	/** The remote's name in a remote window; none in a local one. */
	let remoteName: string | undefined;
	/** How the person's editor opens its Settings: `json` as settings.json; else as its Settings page. */
	let settingsEditor: string | undefined;
	/** The button a notification's person chooses; none, it is dismissed. */
	let choose: string | undefined;
	let informed: { readonly text: string; readonly items: readonly string[] }[];
	/** What the person chooses on an information notice, when they do. */
	let answer: () => Promise<string | undefined>;
	let configurationChanged: ((event: { affectsConfiguration: (section: string) => boolean }) => void)[];
	const session = 'session-now';
	const none = { dispose: () => undefined };
	const api = () => ({
		env: { sessionId: session, remoteName, appName: 'Visual Studio Code' },
		Uri: { from: (parts: object) => parts },
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
			showErrorMessage: async (text: string, ...items: string[]) => { shown.push({ text, items }); return choose; },
			showInformationMessage: async (text: string, ...items: string[]) => { informed.push({ text, items }); return answer(); }
		},
		workspace: {
			workspaceFolders: undefined, workspaceFile: undefined,
			getConfiguration: (section: string) => ({
				inspect: (key: string) => section === 'facade' && key === 'home' ? { defaultValue: '~/.facade', globalValue: home } : undefined,
				get: (key: string) => section === 'workbench.settings' && key === 'editor' ? settingsEditor : undefined
			}),
			onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (section: string) => boolean }) => void) => { configurationChanged.push(listener); return none; }
		}
	});
	/** The extension's context: its terminals' environment is what the test reads. */
	const context = () => ({
		subscriptions: [] as unknown[],
		environmentVariableCollection: {
			replace: (variable: string, value: string) => { terminalHome.push(`${variable}=${value}`); },
			delete: (variable: string) => { terminalHome.push(`${variable} removed`); }
		}
	});

	setup(() => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-activation-'));
		commands = new Map();
		shown = [];
		executed = [];
		home = undefined;
		terminalHome = [];
		remoteName = undefined;
		settingsEditor = undefined;
		answer = async () => undefined;
		choose = undefined;
		informed = [];
		configurationChanged = [];
	});

	teardown(() => {
		fs.rmSync(temp, { recursive: true, force: true });
	});

	test('a damaged handover record: the window component invents no identity and answers so, the workspace component says to open the folder again - not to reload, which reads the same record - in its notification and panel', async () => {
		const vscode = api();
		fs.writeFileSync(path.join(temp, 'handover.json'), '{');
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		const windowContext = { logUri: { fsPath: temp }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, subscriptions: [] as unknown[] };
		activate(windowContext as never);
		assert.strictEqual(fs.readFileSync(path.join(temp, 'handover.json'), 'utf8'), '{', 'no other identity is written');
		assert.deepStrictEqual([...commands.keys()], [WINDOW_IDENTITY_COMMAND], 'no terminal registry without an identity');
		assert.deepStrictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!(session), { version: 1, session, damaged: true });
		assert.strictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!('session-before'), undefined, 'a late request of another editor session is not answered');
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const failure = await service.activateFacade(context() as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.ok(failure instanceof service.ActivationError);
		assert.strictEqual(failure.message, "This window's Facade Code record is damaged, so its agents cannot be restored here. Close this window and open its folder or workspace again, or restart Visual Studio Code.");
		assert.strictEqual(failure.reloadHelps, false);
		assert.ok(!executed.includes(WINDOW_TERMINALS_COMMAND));
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(shown, [{ text: failure.message, items: [] }], 'no Reload Window that cannot help');
	});

	test('a handover record that cannot be read now - not damaged - is said by the window component, and the workspace component offers the reload that may read it then - never to install a component that is there', async () => {
		const vscode = api();
		// A folder where the record would be: reading it fails, as a lock or a lack of file handles would
		fs.mkdirSync(path.join(temp, 'handover.json'));
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		activate({ logUri: { fsPath: temp }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, subscriptions: [] } as never);
		assert.deepStrictEqual([...commands.keys()], [WINDOW_IDENTITY_COMMAND], 'no terminal registry without an identity');
		const answer = await commands.get(WINDOW_IDENTITY_COMMAND)!(session) as { unreadable?: unknown };
		assert.deepStrictEqual([typeof answer.unreadable, 'damaged' in answer, 'token' in answer], ['string', false, false]);
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const failure = await service.activateFacade(context() as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.ok(failure instanceof service.ActivationError);
		assert.deepStrictEqual([failure.message, failure.reloadHelps], ['Could not restore agents for this window. Reload the window to try again.', true]);
		assert.ok(!executed.includes(WINDOW_TERMINALS_COMMAND));
	});

	test('a window whose Facade could not start: each of its commands says why, as its notification does, never that the editor has no such command (ARCHITECTURE-4.3)', async () => {
		const vscode = api();
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
		const failure = new service.ActivationError('Could not restore agents for this window. Reload the window to try again.');
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(manifest.contributes.commands.map(each => each.command).filter(id => !commands.has(id)), [], 'every contributed command answers');
		await vscode.commands.executeCommand('facade.newAgent');
		await vscode.commands.executeCommand('facade.showActiveAgents');
		assert.deepStrictEqual(shown, Array(3).fill({ text: failure.message, items: ['Reload Window'] }));
	});

	test('a missing window component uses its installation wait and missing-component explanation, without inventing an identity', async () => {
		const vscode = api();
		let missing = 0;
		let disposed = 0;
		const service = withModules({ vscode, './windowComponent': {
			waitForWindowIdentity: async (asked: string) => { assert.strictEqual(asked, session); return undefined; },
			showComponentMissing: () => { missing++; return { dispose: () => { disposed++; } }; }
		} })<typeof import('../host/service')>(require.resolve('../host/service'));
		const stop = await service.activateFacade(context() as never);
		assert.strictEqual(missing, 1);
		assert.ok(!executed.includes(WINDOW_TERMINALS_COMMAND));
		assert.deepStrictEqual(shown, []);
		await stop();
		assert.strictEqual(disposed, 1);
	});

	test('Facade: Home that the person set is this window\'s Facade home before anything reads it: FACADE_HOME for what the window starts, and for its terminals; never set, FACADE_HOME is left as it is (ARCHITECTURE-3.1)', async () => {
		const before = process.env.FACADE_HOME;
		try {
			home = '~/facade-elsewhere';
			const service = withModules({ vscode: api(), './windowComponent': { waitForWindowIdentity: async () => undefined, showComponentMissing: () => none } })<typeof import('../host/service')>(require.resolve('../host/service'));
			await (await service.activateFacade(context() as never))();
			const set = path.join(os.homedir(), 'facade-elsewhere');
			assert.deepStrictEqual([process.env.FACADE_HOME, terminalHome], [set, [`FACADE_HOME=${set}`]]);
			process.env.FACADE_HOME = before ?? '';
			home = undefined;
			terminalHome = [];
			await (await service.activateFacade(context() as never))();
			assert.deepStrictEqual([process.env.FACADE_HOME, terminalHome], [before ?? '', ['FACADE_HOME removed']]);
		} finally {
			if (before === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = before; }
		}
	});

	test('a Windows Facade home names its drive or share: \\folder alone, on whichever drive a process is in, is refused as a relative path is, and so is such a FACADE_HOME (ARCHITECTURE-3.1)', () => {
		const { homePathOf } = withModules({ vscode: api() })<typeof import('../host/home')>(require.resolve('../host/home'));
		const { facadeRoot } = withModules({})<typeof import('../record/paths')>(require.resolve('../record/paths'));
		const windows = ['C:\\Users\\Ada\\.facade', 'c:/facade', '\\\\server\\share\\facade', '//server/share/facade', '~\\.facade', '\\Users\\Ada\\.facade', '/facade', 'C:facade', '\\\\server', 'facade'];
		assert.deepStrictEqual(windows.map(value => homePathOf(value, 'C:\\Users\\Ada', 'win32')),
			['C:\\Users\\Ada\\.facade', 'c:/facade', '\\\\server\\share\\facade', '//server/share/facade', 'C:\\Users\\Ada\\.facade', undefined, undefined, undefined, undefined, undefined]);
		assert.deepStrictEqual(['/srv/facade', '~/facade', 'facade'].map(value => homePathOf(value, '/home/ada', 'linux')), ['/srv/facade', '/home/ada/facade', undefined]);
		assert.throws(() => facadeRoot({ FACADE_HOME: '\\facade' }, 'win32'), /FACADE_HOME must name an absolute folder/);
		assert.deepStrictEqual([facadeRoot({ FACADE_HOME: 'D:\\facade' }, 'win32'), facadeRoot({ FACADE_HOME: '/srv/facade' }, 'linux')], ['D:\\facade', '/srv/facade']);
		// A written-down home of no drive supplies none, as an unreadable one does; one of a drive or a share does
		const { rememberedHome } = withModules({ vscode: api() })<typeof import('../host/home')>(require.resolve('../host/home'));
		const record = path.join(temp, 'home.json');
		const read = (home: string) => { fs.writeFileSync(record, JSON.stringify({ home })); return rememberedHome(record, 'win32'); };
		assert.deepStrictEqual(['/facade', '\\facade', 'C:facade', 'C:\\facade', '\\\\server\\share'].map(read), [undefined, undefined, undefined, 'C:\\facade', '\\\\server\\share']);
	});

	test('a Facade: Home that is no path starts nothing in this window, never another home, and offers Open Settings at that setting (ARCHITECTURE-3.1, UX-2.4)', async () => {
		const before = process.env.FACADE_HOME;
		home = 'facade';
		const vscode = api();
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const failure = await service.activateFacade(context() as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.ok(failure instanceof service.ActivationError);
		assert.deepStrictEqual([failure.message, failure.reloadHelps, failure.opensSetting, process.env.FACADE_HOME],
			['Facade: Home "facade" must start with ~/ or be absolute. No agent can start until it is fixed.', false, 'facade.home', before]);
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(shown, [{ text: failure.message, items: ['Open Settings'] }]);
		// One of another JSON type is set all the same, and no path: never read as unset, which would use another home
		home = 42;
		const typed = await withModules({ vscode: api() })<typeof import('../host/service')>(require.resolve('../host/service')).activateFacade(context() as never)
			.then(() => assert.fail('Facade started'), (err: unknown) => err as Error);
		assert.deepStrictEqual([typed.message, process.env.FACADE_HOME], ['Facade: Home "42" must start with ~/ or be absolute. No agent can start until it is fixed.', before]);
	});

	test('fixing an unusable Facade: Home offers the reload that uses it, as any other change does; a change elsewhere offers nothing (ARCHITECTURE-3.1)', async () => {
		home = 'facade';
		const service = withModules({ vscode: api() })<typeof import('../host/service')>(require.resolve('../host/service'));
		await service.activateFacade(context() as never).then(() => assert.fail('Facade started'), () => undefined);
		const change = (section: string) => configurationChanged.forEach(listener => listener({ affectsConfiguration: (each: string) => each === section }));
		change('editor.fontSize');
		home = '~/facade';
		change('facade.home');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(informed, [{ text: 'The new Facade home applies only after the window reloads.', items: ['Reload Window'] }]);
	});

	test('in a remote window, Open Settings opens the Remote tab of the editor\'s Settings, where Facade\'s machine settings are; in a local window, the User tab (CONFIGURATION-1.2)', async () => {
		home = 'facade';
		choose = 'Open Settings';
		for (const [remote, command] of [[undefined, 'workbench.action.openSettings'], ['ssh-remote', 'workbench.action.openRemoteSettings']] as const) {
			remoteName = remote;
			executed = [];
			const opened: unknown[] = [];
			const vscode = api();
			commands.set(command, (...args: unknown[]) => { opened.push(...args); });
			const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
			const failure = await service.activateFacade(context() as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
			service.sayActivationFailed({ subscriptions: [] } as never, failure as never);
			await new Promise(resolve => setImmediate(resolve));
			assert.deepStrictEqual([executed.filter(each => each.startsWith('workbench.action.open')), opened],
				[[command], [remote === undefined ? '@id:facade.home' : { query: '@id:facade.home' }]], remote ?? 'local');
		}
	});

	test('Open Settings opens Facade Code\'s section on the User tab, or the Remote tab in a remote window; there a person whose Settings open as JSON, whom the editor would show the remote settings.json without the section, gets facade.json itself (CONFIGURATION-1.2)', async () => {
		const opened: string[] = [];
		for (const [remote, editor, expected] of [
			[undefined, undefined, 'workbench.action.openSettings @ext:facade.facade-code'],
			[undefined, 'json', 'workbench.action.openSettings @ext:facade.facade-code'],
			['ssh-remote', 'ui', 'workbench.action.openRemoteSettings {"query":"@ext:facade.facade-code"}'],
			['ssh-remote', 'json', 'facade.openSettingsFile']
		] as const) {
			remoteName = remote;
			settingsEditor = editor;
			executed = [];
			const vscode = api();
			for (const command of ['workbench.action.openSettings', 'workbench.action.openRemoteSettings', 'facade.openSettingsFile']) {
				commands.set(command, (...args: unknown[]) => { opened.push([command, ...args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))].join(' ')); });
			}
			await withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service')).openSettingsOf('facade.facade-code');
			assert.strictEqual(opened.pop(), expected, `${remote ?? 'local'}, ${editor ?? 'default'}`);
		}
	});

	test('a local window writes down this computer\'s Facade: Home, as it changes too; a remote window\'s component, which VS Code gives only the remote machine\'s value, uses what was written down, and offers the reload when it changes (ARCHITECTURE-3.1)', async () => {
		const before = process.env.FACADE_HOME;
		const subscriptions: { dispose(): void }[] = [];
		try {
			// A damaged handover record stops the component right after the home is decided
			fs.writeFileSync(path.join(temp, 'handover.json'), '{');
			const storage = path.join(temp, 'storage');
			const record = path.join(storage, 'home.json');
			const windowContext = () => ({ logUri: { fsPath: temp }, globalStorageUri: { fsPath: storage }, subscriptions });
			// A local window: the setting is this window's Facade home, and written down
			home = '~/facade-local';
			withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			const local = path.join(os.homedir(), 'facade-local');
			assert.deepStrictEqual([process.env.FACADE_HOME, JSON.parse(fs.readFileSync(record, 'utf8'))], [local, { home: local }]);
			// Another local window of the same home leaves it as it was: a remote window watching it sees no change
			const stamp = () => { const { ino, mtimeMs } = fs.statSync(record); return [ino, mtimeMs]; };
			const written = stamp();
			withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			assert.deepStrictEqual(stamp(), written);
			// The setting changed in a local window that stays open: written down at once; unset, removed; unusable, of any type, kept
			const change = () => configurationChanged.forEach(listener => listener({ affectsConfiguration: (each: string) => each === 'facade.home' }));
			home = '~/facade-moved';
			change();
			const moved = JSON.parse(fs.readFileSync(record, 'utf8'));
			// Unset: never set, null or blank
			const unset = [undefined, null, '  '].map(value => {
				home = '~/facade-local';
				change();
				home = value;
				change();
				return fs.existsSync(record);
			});
			home = '~/facade-local';
			change();
			for (const unusable of ['not a path', 42, true, ['/x'], { path: '/x' }]) {
				home = unusable;
				change();
			}
			assert.deepStrictEqual([moved, unset, JSON.parse(fs.readFileSync(record, 'utf8'))], [{ home: path.join(os.homedir(), 'facade-moved') }, [false, false, false], { home: local }]);
			// A remote window: VS Code's value is the remote machine's, never taken; what the local windows wrote down is
			home = '/srv/facade';
			remoteName = 'ssh-remote';
			process.env.FACADE_HOME = '/somewhere/else';
			withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			assert.deepStrictEqual([process.env.FACADE_HOME, shown], [local, []]);
			// A local window writes down another: the remote window offers the reload that uses it, once
			fs.writeFileSync(record, JSON.stringify({ home: path.join(os.homedir(), 'facade-new') }));
			for (let wait = 0; wait < 40 && !informed.length; wait++) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.deepStrictEqual(informed, [{ text: 'The new Facade home applies only after the window reloads.', items: ['Reload Window'] }]);
			// Written again the same, then back to the home this window uses: nothing more to reload; then another: offered again
			fs.writeFileSync(record, JSON.stringify({ home: path.join(os.homedir(), 'facade-new') }));
			await new Promise(resolve => setTimeout(resolve, 300));
			fs.writeFileSync(record, JSON.stringify({ home: local }));
			await new Promise(resolve => setTimeout(resolve, 300));
			const quiet = informed.length;
			fs.writeFileSync(record, JSON.stringify({ home: path.join(os.homedir(), 'facade-other') }));
			for (let wait = 0; wait < 40 && informed.length < 2; wait++) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.deepStrictEqual([quiet, informed.length], [1, 2]);
			// Unset there, nothing is written down, and a remote window goes by FACADE_HOME as the local windows do
			remoteName = undefined;
			home = undefined;
			withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			assert.ok(!fs.existsSync(record));
			// An unusable value changes nothing written down: the local windows start nothing until it is fixed
			home = '~/facade-kept';
			withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			for (const unusable of ['not a path', 42]) {
				home = unusable;
				withModules({ vscode: api() })<typeof import('../host/window')>(require.resolve('../host/window')).activate(windowContext() as never);
			}
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { home: path.join(os.homedir(), 'facade-kept') });
		} finally {
			subscriptions.forEach(each => each.dispose());
			if (before === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = before; }
		}
	});

	test('a remote window\'s component with nothing written down uses FACADE_HOME, as the local windows do: that folder written down offers nothing, another does, and its removal back to that folder nothing more; a reload chosen after the window let go does nothing; a watch that fails stops (ARCHITECTURE-3.1)', async () => {
		const before = process.env.FACADE_HOME;
		const subscriptions: { dispose(): void }[] = [];
		const watchers: { readonly watcher: fs.FSWatcher; closed: number }[] = [];
		try {
			fs.writeFileSync(path.join(temp, 'handover.json'), '{');
			const storage = path.join(temp, 'storage');
			const record = path.join(storage, 'home.json');
			const used = path.join(temp, 'facade-env');
			process.env.FACADE_HOME = used;
			remoteName = 'ssh-remote';
			home = '/srv/facade';
			let choose: (choice: string | undefined) => void = () => undefined;
			answer = () => new Promise(resolve => { choose = resolve; });
			const watching = { ...fs, watch: (...args: Parameters<typeof fs.watch>) => {
				const watcher = fs.watch(...args);
				const each = { watcher, closed: 0 };
				const close = watcher.close.bind(watcher);
				watcher.close = () => { each.closed++; close(); };
				watchers.push(each);
				return watcher;
			} };
			const start = () => withModules({ vscode: api(), fs: watching })<typeof import('../host/window')>(require.resolve('../host/window'))
				.activate({ logUri: { fsPath: temp }, globalStorageUri: { fsPath: storage }, subscriptions } as never);
			start();
			const wait = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); };
			// The folder it uses, written down: nothing to reload
			fs.mkdirSync(storage, { recursive: true });
			fs.writeFileSync(record, JSON.stringify({ home: used }));
			await wait(300);
			const same = informed.length;
			// Another: offered; removed, back to the folder in use: nothing more
			fs.writeFileSync(record, JSON.stringify({ home: path.join(temp, 'facade-new') }));
			for (let tries = 0; tries < 40 && !informed.length; tries++) {
				await wait(50);
			}
			fs.rmSync(record);
			await wait(300);
			assert.deepStrictEqual([process.env.FACADE_HOME, same, informed.length], [used, 0, 1]);
			// The window lets go, then the reload offered is chosen: nothing runs
			subscriptions.splice(0).forEach(each => each.dispose());
			choose('Reload Window');
			await wait(0);
			assert.ok(!executed.includes('workbench.action.reloadWindow'), executed.join(', '));
			// A watch that fails later, its folder gone, stops quietly: the change applies at the next reload
			start();
			const [failing] = watchers.slice(-1);
			failing.watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
			assert.strictEqual(failing.closed, 1);
			subscriptions.splice(0).forEach(each => each.dispose());
			// Written down through a link to the folder in use: the same folder, nothing to reload
			const link = path.join(temp, 'facade-env-link');
			fs.mkdirSync(used, { recursive: true });
			fs.symlinkSync(used, link, 'junction');
			informed = [];
			start();
			fs.writeFileSync(record, JSON.stringify({ home: link }));
			await wait(300);
			const linked = informed.length;
			subscriptions.splice(0).forEach(each => each.dispose());
			// One written after the first reading, before the watch began: seen all the same
			fs.rmSync(record);
			let racing = true;
			const racer = { ...fs, watch: (...args: Parameters<typeof fs.watch>) => {
				if (racing) {
					racing = false;
					fs.writeFileSync(record, JSON.stringify({ home: path.join(temp, 'facade-raced') }));
				}
				return fs.watch(...args);
			} };
			withModules({ vscode: api(), fs: racer })<typeof import('../host/window')>(require.resolve('../host/window'))
				.activate({ logUri: { fsPath: temp }, globalStorageUri: { fsPath: storage }, subscriptions } as never);
			assert.deepStrictEqual([linked, informed.length], [0, 1]);
		} finally {
			subscriptions.forEach(each => each.dispose());
			if (before === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = before; }
		}
	});

	test('a change of Facade: Home that leaves the folder the window uses - the same written another way, or FACADE_HOME\'s own folder where none was set - offers no reload; one to another folder does (ARCHITECTURE-3.1)', async () => {
		const before = process.env.FACADE_HOME;
		try {
			const change = () => configurationChanged.forEach(listener => listener({ affectsConfiguration: (each: string) => each === 'facade.home' }));
			const settle = () => new Promise(resolve => setImmediate(resolve));
			const start = () => withModules({ vscode: api() })<typeof import('../host/home')>(require.resolve('../host/home'))
				.useFacadeHome(context() as never, { terminals: false, offerReload: true, reloadText: () => 'reload' });
			// Set: the same folder written in full, then another
			home = '~/facade-same';
			start();
			home = path.join(os.homedir(), 'facade-same');
			change();
			await settle();
			const same = informed.length;
			home = '~/facade-else';
			change();
			await settle();
			const other = informed.length;
			// None set, FACADE_HOME's folder: that folder set offers nothing
			configurationChanged = [];
			informed = [];
			process.env.FACADE_HOME = path.join(temp, 'facade-env');
			home = undefined;
			start();
			home = path.join(temp, 'facade-env');
			change();
			await settle();
			const fallback = informed.length;
			// Through a link to the folder in use: the same folder
			configurationChanged = [];
			const real = path.join(temp, 'facade-real'), link = path.join(temp, 'facade-link');
			fs.mkdirSync(real);
			fs.symlinkSync(real, link, 'junction');
			home = real;
			start();
			home = link;
			change();
			await settle();
			assert.deepStrictEqual([same, other, fallback, informed.length], [0, 1, 0, 0]);
		} finally {
			if (before === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = before; }
		}
	});
});
