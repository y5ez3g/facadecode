/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceFolderData } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { ConfigurationResolverExpression } from '../../../../services/configurationResolver/common/configurationResolverExpression.js';
import { TerminalLauncherDetection } from '../../browser/terminalLauncherDetection.js';
import { ITerminalLauncher } from '../../common/terminalLaunchers.js';

/** Only the files this test says are on disk are on disk. */
class TestFileService extends mock<IFileService>() {

	constructor(private readonly present: ReadonlySet<string>) {
		super();
	}

	override async exists(resource: URI): Promise<boolean> {
		return this.present.has(resource.fsPath.replace(/\\/g, '/').toLowerCase());
	}
}

/** Answers `${env:NAME}` from a table, and hands anything it does not know straight back. */
class TestResolverService extends mock<IConfigurationResolverService>() {

	constructor(private readonly env: Readonly<Record<string, string>>) {
		super();
	}

	override resolveAsync<T>(_folder: IWorkspaceFolderData | undefined, config: T): Promise<T extends ConfigurationResolverExpression<infer R> ? R : T> {
		const resolved = typeof config === 'string'
			? config.replace(/\$\{env:([^}]+)\}/g, (whole, name: string) => this.env[name] ?? whole)
			: config;

		return Promise.resolve(resolved as T extends ConfigurationResolverExpression<infer R> ? R : T);
	}
}

suite('Terminal launchers - is it on this machine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const detector = (present: string[], env: Record<string, string>) => new TerminalLauncherDetection(
		new TestFileService(new Set(present.map(p => p.toLowerCase()))),
		new TestResolverService(env),
		upcastPartial<ICommandService>({}),
		new NullLogService()
	);

	const launcher = (id: string, command: string): ITerminalLauncher => ({ id, label: id, command });

	const dir = isWindows ? 'C:/tools' : '/opt/tools';
	const separator = isWindows ? ';' : ':';

	test('found on the shell PATH, and not found when it is not there', async () => {
		const found = await detector(
			[`${dir}/claude${isWindows ? '.exe' : ''}`],
			{ PATH: [dir, `${dir}/empty`].join(separator) }
		).detect([launcher('claude', 'claude'), launcher('grok', 'grok')]);

		assert.deepStrictEqual([found.has('claude'), found.has('grok')], [true, false]);
	});

	test('a bare command is tried with the extensions the environment names', async () => {
		// `.ps1` is deliberately not one of the four the fallback carries, so finding it is proof
		// that the real `PATHEXT` was read rather than a list written into the source.
		const found = await detector(
			[`${dir}/claude${isWindows ? '.ps1' : ''}`],
			{ PATH: dir, PATHEXT: '.PS1' }
		).detect([launcher('claude', 'claude')]);

		assert.strictEqual(found.has('claude'), true);
	});

	test('a name the environment does not allow is not tried', async () => {
		// Windows: `PATHEXT` says `.ps1` only, so a `.exe` beside it is not this command. Elsewhere
		// there are no extensions at all and the name on the command line is the name on disk.
		const found = await detector(
			[`${dir}/claude.exe`],
			{ PATH: dir, PATHEXT: '.PS1' }
		).detect([launcher('claude', 'claude')]);

		assert.strictEqual(found.has('claude'), false);
	});

	test('a PATHEXT nothing answers falls back to the usual four', async () => {
		const found = await detector(
			[`${dir}/claude${isWindows ? '.cmd' : ''}`],
			{ PATH: dir }
		).detect([launcher('claude', 'claude')]);

		assert.strictEqual(found.has('claude'), true);
	});

	test('no PATH hides nothing', async () => {
		// A remote or a web window. An empty menu would be worse than an optimistic one, so every
		// launcher is reported present.
		const found = await detector([], {}).detect([launcher('claude', 'claude'), launcher('grok', 'grok')]);

		assert.deepStrictEqual([found.has('claude'), found.has('grok')], [true, true]);
	});

	test('a launcher with no command is always there, because it is the shell', async () => {
		const found = await detector([], { PATH: dir }).detect([launcher('terminal', '   ')]);

		assert.strictEqual(found.has('terminal'), true);
	});

	test('a command that names a place is checked where it points', async () => {
		const where = isWindows ? 'C:/custom/muse.exe' : '/custom/muse';
		const gone = isWindows ? 'C:/custom/nope.exe' : '/custom/nope';

		const found = await detector([where], { PATH: dir })
			.detect([launcher('muse', where), launcher('gone', gone)]);

		assert.deepStrictEqual([found.has('muse'), found.has('gone')], [true, false]);
	});

	test('on a remote, the ids the agents\' extension host finds, asked in one command; unknown - not none - when it cannot be asked (REMOTE.md R3)', async () => {
		const calls: unknown[][] = [];
		const remote = (answer: unknown) => new TerminalLauncherDetection(
			new TestFileService(new Set()),
			new TestResolverService({}),
			upcastPartial<ICommandService>({
				executeCommand: async <R,>(...args: unknown[]): Promise<R | undefined> => {
					calls.push(args);
					if (answer instanceof Error) {
						throw answer;
					}
					return answer as R | undefined;
				}
			}),
			new NullLogService()
		);

		const folder = URI.parse('vscode-remote://ssh-remote+host/home/person/work');
		const found = await remote(['claude', 'muse']).detectRemote(folder);
		const missing = await remote(new Error('unknown command')).detectRemote(folder);
		const unanswered = await remote(undefined).detectRemote(undefined);
		const unshaped = await remote(['claude', 42, null]).detectRemote(folder);
		assert.deepStrictEqual({
			found: found && [...found],
			commands: calls.map(call => call[0]),
			folders: calls.map(call => call[1] === undefined ? undefined : (call[1] as URI).toString()),
			missing,
			unanswered: unanswered && [...unanswered],
			unshaped: unshaped && [...unshaped],
		}, {
			found: ['claude', 'muse'],
			commands: ['_facade.agents.detectClis', '_facade.agents.detectClis', '_facade.agents.detectClis', '_facade.agents.detectClis'],
			folders: [folder.toString(), folder.toString(), undefined, folder.toString()],
			missing: undefined,
			unanswered: [],
			unshaped: ['claude'],
		});
	});
});
