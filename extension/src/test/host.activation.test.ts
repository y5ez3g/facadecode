/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWindowIdentity, WINDOW_IDENTITY_COMMAND, WINDOW_LEGACY_HANDOFF_COMMAND, WINDOW_LEGACY_INSTANCE_COMMAND, WINDOW_TERMINAL_OWNER_COMMAND, WINDOW_TERMINALS_COMMAND } from '../base/windowIdentity';
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
	const api = (sessionId = session, handlers = commands) => ({
		env: { sessionId, remoteName, appName: 'Visual Studio Code' },
		Uri: { from: (parts: object) => parts },
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(id, handler);
				return { dispose: () => { if (handlers.get(id) === handler) { handlers.delete(id); } } };
			},
			executeCommand: async (id: string, ...args: unknown[]) => {
				executed.push(id);
				if (id === 'setContext') { return undefined; }
				const handler = handlers.get(id);
				if (!handler) {
					throw new Error(`command '${id}' not found`);
				}
				return handler(...args);
			}
		},
		window: {
			terminals: [],
			onDidOpenTerminal: () => none,
			onDidCloseTerminal: () => none,
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
		extensionPath: temp,
		subscriptions: [] as unknown[],
		environmentVariableCollection: {
			replace: (variable: string, value: string) => { terminalHome.push(`${variable}=${value}`); },
			delete: (variable: string) => { terminalHome.push(`${variable} removed`); }
		}
	});

	function assertOnlyTerminalCommands(): void {
		assert.deepStrictEqual([...commands.keys()].sort(), [
			WINDOW_IDENTITY_COMMAND, WINDOW_LEGACY_HANDOFF_COMMAND, WINDOW_LEGACY_INSTANCE_COMMAND, WINDOW_TERMINAL_OWNER_COMMAND, WINDOW_TERMINALS_COMMAND
		].sort());
	}

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

	function componentEditor(editorSession = session) {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const vscode = api(editorSession, handlers);
		return {
			vscode,
			command: (id: string, ...args: unknown[]) => {
				assert.ok(handlers.has(id), id + ' is registered');
				return vscode.commands.executeCommand(id, ...args);
			}
		};
	}

	/** Real component activation with the editor command dispatch supplied by the fixture. */
	function activateWindowComponent(logUri: string, editorSession = session, component = '0.1.6', editor = componentEditor(editorSession)) {
		const subscriptions: { dispose(): void }[] = [];
		const { activate } = withModules({ vscode: editor.vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		activate({
			logUri: { fsPath: logUri }, globalStorageUri: { fsPath: path.join(logUri, 'storage') }, subscriptions,
			extension: { packageJSON: { version: component } }
		} as never);
		return { ...editor, dispose: () => subscriptions.splice(0).reverse().forEach(subscription => subscription.dispose()) };
	}

	test('the identity command answers the current session with the persisted window token and component version, refuses stale sessions and leaves damaged records intact (ARCHITECTURE-2.2)', async () => {
		const before = process.env.FACADE_HOME;
		const facadeRoot = path.join(temp, 'home');
		home = facadeRoot;
		const record = path.join(temp, 'handover.json');
		const initial = activateWindowComponent(temp);
		const restartedSession = 'session-restarted';
		const restarted = activateWindowComponent(temp, restartedSession, '0.1.7');
		const damaged = activateWindowComponent(temp, restartedSession);
		try {
			assert.strictEqual(await initial.command(WINDOW_IDENTITY_COMMAND, 'older-session'), undefined);
			assert.ok(!fs.existsSync(record), 'stale requests do not mint an identity');

			const identity = await initial.command(WINDOW_IDENTITY_COMMAND, session);
			assert.ok(isWindowIdentity(identity, session));
			assert.deepStrictEqual(identity, { version: 1, session, token: identity.token, component: '0.1.6' });
			const serialized = fs.readFileSync(record, 'utf8');
			assert.deepStrictEqual(JSON.parse(serialized), { version: 1, token: identity.token });
			initial.dispose();

			assert.strictEqual(await restarted.command(WINDOW_IDENTITY_COMMAND, session), undefined);
			assert.deepStrictEqual(await restarted.command(WINDOW_IDENTITY_COMMAND, restartedSession), {
				version: 1, session: restartedSession, token: identity.token, component: '0.1.7'
			});
			assert.strictEqual(fs.readFileSync(record, 'utf8'), serialized);
			restarted.dispose();

			fs.writeFileSync(record, '{');
			assert.strictEqual(await damaged.command(WINDOW_IDENTITY_COMMAND, session), undefined);
			assert.deepStrictEqual(await damaged.command(WINDOW_IDENTITY_COMMAND, restartedSession),
				{ version: 1, session: restartedSession, damaged: true });
			assert.strictEqual(fs.readFileSync(record, 'utf8'), '{');
		} finally {
			damaged.dispose();
			restarted.dispose();
			initial.dispose();
			if (before === undefined) { delete process.env.FACADE_HOME; } else { process.env.FACADE_HOME = before; }
		}
	});

	test('the native handoff returns only the retired owner for the current local session (ARCHITECTURE-1.4)', async () => {
		const token = '03fded10-d96f-4f93-a0e9-ed8553af5606';
		const claim = { owner: '0123456789abcdef', token: 'old-claim', generation: 1 };
		fs.writeFileSync(path.join(temp, 'handover.json'), JSON.stringify({ version: 1, token }));
		fs.writeFileSync(path.join(temp, 'terminals.json'), JSON.stringify({
			version: 1, epoch: token, retired: [{ claim, runs: [{ run: 'original-run', title: 'Ada' }] }]
		}));
		const window = activateWindowComponent(temp);
		try {
			assert.strictEqual(await window.command(WINDOW_LEGACY_HANDOFF_COMMAND, 'older-session', claim.owner), undefined);
			assert.strictEqual(await window.command(WINDOW_LEGACY_HANDOFF_COMMAND, session, 'different-owner'), undefined);
			assert.deepStrictEqual(await window.command(WINDOW_LEGACY_HANDOFF_COMMAND, session, claim.owner), {
				version: 1, token, session, claim, runs: ['original-run']
			});
		} finally {
			window.dispose();
		}
	});

	test('a damaged handover record: the window component reports the damage without inventing an identity', async () => {
		const vscode = api();
		fs.writeFileSync(path.join(temp, 'handover.json'), '{');
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		const windowContext = { logUri: { fsPath: temp }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, subscriptions: [] as unknown[] };
		activate(windowContext as never);
		assert.strictEqual(fs.readFileSync(path.join(temp, 'handover.json'), 'utf8'), '{', 'no other identity is written');
		assertOnlyTerminalCommands();
		assert.deepStrictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!(session), { version: 1, session, damaged: true });
		assert.strictEqual(await commands.get(WINDOW_IDENTITY_COMMAND)!('session-before'), undefined, 'a late request of another editor session is not answered');
	});

	test('a handover record that cannot be read is reported as unreadable by the window component', async () => {
		const vscode = api();
		// A folder where the record would be: reading it fails, as a lock or a lack of file handles would
		fs.mkdirSync(path.join(temp, 'handover.json'));
		const { activate } = withModules({ vscode })<typeof import('../host/window')>(require.resolve('../host/window'));
		activate({ logUri: { fsPath: temp }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, subscriptions: [] } as never);
		assertOnlyTerminalCommands();
		const answer = await commands.get(WINDOW_IDENTITY_COMMAND)!(session) as { unreadable?: unknown };
		assert.deepStrictEqual([typeof answer.unreadable, 'damaged' in answer, 'token' in answer], ['string', false, false]);
	});

	test('a window whose Facade could not start: each of its commands says why, as its notification does, never that the editor has no such command (ARCHITECTURE-4.3)', async () => {
		const vscode = api();
		const service = withModules({ vscode })<typeof import('../host/service')>(require.resolve('../host/service'));
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
		const failure = new service.ActivationError('Could not restore agents for this window. Reload the window to try again.');
		service.sayActivationFailed({ subscriptions: [] } as never, failure);
		assert.deepStrictEqual(manifest.contributes.commands.map(each => each.command).filter(id => !commands.has(id)), [], 'every contributed command answers');
		await vscode.commands.executeCommand('facade.newAgent');
		await vscode.commands.executeCommand('facade.resumeAgent');
		assert.deepStrictEqual(shown, Array(3).fill({ text: failure.message, items: ['Reload Window'] }));
	});

	test('a missing Framework program reports the error without activating an execution engine', async () => {
		const vscode = api();
		const service = withModules({ vscode, './framework/index': {
			activateOrchestrator: () => assert.fail('attempted to launch the missing program')
		} })<typeof import('../host/service')>(require.resolve('../host/service'));
		const windowContext = context();
		const failure = await service.activateFacade(windowContext as never).then(() => assert.fail('Facade started'), (err: unknown) => err);
		assert.match((failure as Error).message, /Framework program is missing/);
		assert.ok(!executed.includes(WINDOW_TERMINALS_COMMAND));
		service.sayActivationFailed(windowContext as never, failure);
		assert.match(shown[0].text, /Framework program is missing/);
	});

	test('a failed first legacy inventory remains pending and retries (ARCHITECTURE-1.4)', async () => {
		const { FACADE_PROGRAM } = await import('../host/framework/daemonTypes');
		const program = path.join(temp, FACADE_PROGRAM);
		fs.mkdirSync(path.dirname(program), { recursive: true });
		fs.writeFileSync(program, '');
		let checks = 0;
		const vscode = { ...api(),
			Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => parts.forEach(part => part.dispose()) }) }
		};
		const { prepareFramework } = withModules({ vscode, './legacyCutover': {
			checkLegacyCutover: async () => {
				if (++checks === 1) { throw new Error('legacy supervisor records are busy'); }
				return { ready: false, unavailable: ['could not read legacy supervisor status'], waitingForOwner: 0, unconfirmed: 0 };
			}
		} })<typeof import('../host/implementation')>(require.resolve('../host/implementation'));
		const pending = await prepareFramework(context() as never, temp);
		assert.ok(pending);
		try {
			await new Promise(resolve => setImmediate(resolve));
			await commands.get('facade.newAgent')!();
			assert.strictEqual(checks, 2);
			assert.match(informed[0].text, /could not read legacy supervisor status/);
			assert.ok(!executed.includes('workbench.action.reloadWindow'));
		} finally {
			pending.dispose();
		}
	});

	test('Facade: Home that the person set is this window\'s Facade home before anything reads it: FACADE_HOME for what the window starts, and for its terminals; never set, FACADE_HOME is left as it is (ARCHITECTURE-3.1)', async () => {
		const before = process.env.FACADE_HOME;
		try {
			home = '~/facade-elsewhere';
			const verified: string[] = [];
			const connected: string[] = [];
			const service = withModules({ vscode: api(),
				'./implementation': { prepareFramework: async (_context: unknown, home: string) => { verified.push(home); } },
				'./framework/index': { activateOrchestrator: async (_context: unknown, deps: { root: string }) => {
					connected.push(deps.root);
					return async () => undefined;
				} }
			})<typeof import('../host/service')>(require.resolve('../host/service'));
			await (await service.activateFacade(context() as never))();
			const set = path.join(os.homedir(), 'facade-elsewhere');
			assert.deepStrictEqual([process.env.FACADE_HOME, terminalHome], [set, [`FACADE_HOME=${set}`]]);
			process.env.FACADE_HOME = before ?? '';
			home = undefined;
			terminalHome = [];
			await (await service.activateFacade(context() as never))();
			assert.deepStrictEqual([process.env.FACADE_HOME, terminalHome], [before ?? '', ['FACADE_HOME removed']]);
			assert.ok(before);
			assert.deepStrictEqual(verified, [path.join(set, 'extension'), path.join(before, 'extension')]);
			assert.deepStrictEqual(connected, [set, before]);
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
		for (const [remote, command] of [[undefined, 'workbench.action.openSettings2'], ['ssh-remote', 'workbench.action.openRemoteSettings']] as const) {
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
				[[command], [{ query: '@id:facade.home' }]], remote ?? 'local');
		}
	});

	test('Open Settings opens Facade Code\'s section on the User tab, or the Remote tab in a remote window; there a person whose Settings open as JSON, whom the editor would show the remote settings.json without the section, gets facade.json itself (CONFIGURATION-1.2)', async () => {
		const opened: string[] = [];
		for (const [remote, editor, expected] of [
			[undefined, undefined, 'workbench.action.openSettings2 {"query":"@ext:facade.facade-code"}'],
			[undefined, 'json', 'workbench.action.openSettings2 {"query":"@ext:facade.facade-code"}'],
			['ssh-remote', 'ui', 'workbench.action.openRemoteSettings {"query":"@ext:facade.facade-code"}'],
			['ssh-remote', 'json', 'facade.openSettingsFile']
		] as const) {
			remoteName = remote;
			settingsEditor = editor;
			executed = [];
			const vscode = api();
			for (const command of ['workbench.action.openSettings2', 'workbench.action.openRemoteSettings', 'facade.openSettingsFile']) {
				commands.set(command, (...args: unknown[]) => { opened.push([command, ...args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))].join(' ')); });
			}
			await withModules({ vscode })<typeof import('../host/framework/settings')>(require.resolve('../host/framework/settings')).openSettingsOf('facade.facade-code');
			assert.strictEqual(opened.pop(), expected, `${remote ?? 'local'}, ${editor ?? 'default'}`);
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
