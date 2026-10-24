/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { processStartedAt, workingFoldersOf } from '../base/system';
import { knownClis } from '../clis/registry';
import { agentIconId } from '../host/agentIcons';
import { changedFilesIn, excludeIn, fileAtIn, leftoverWorkIn, repositoryIn, submodulesIn, trackedIn, untrackedIn, whyNotBranchNameIn, worktreeRootIn, worktreesIn } from '../host/gitCli';
import { releaseEarlierHost, TakeoverPorts } from '../host/takeover';
import { WAS_AWAY_ASK_MS, WAS_AWAY_COMMAND, windowWasAway } from '../host/windowAway';
import { HostMachine } from '../host/machine';
import { JsonFileState } from '../host/windowState';
import { PipeClientError } from '../transport/pipe';
import { WindowEntry, WindowLink, windowKey } from '../transport/windows';
import { outcomeOf, tempDir } from './util';

suite('Host: Facade: Start Agent', () => {

	test('the Command Palette has one command that starts an agent in the folder on screen, under Agents: Start Agent...', () => {
		const extension = path.join(__dirname, '..', '..');
		const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
		const names = JSON.parse(fs.readFileSync(path.join(extension, 'package.nls.json'), 'utf8'));
		const command = (manifest.contributes?.commands ?? []).find((each: { command?: string }) => each.command === 'facade.agents.startAgent');
		const hidden = (manifest.contributes?.menus?.commandPalette ?? []).some((each: { command?: string; when?: string }) => each.command === 'facade.agents.startAgent' && each.when === 'false');

		assert.deepStrictEqual({ title: names[String(command?.title).replace(/^%|%$/g, '')], category: names[String(command?.category).replace(/^%|%$/g, '')], hidden }, { title: 'Start Agent...', category: 'Agents', hidden: false });
	});

	test('it lists each agent with the icon the agent menu shows it with: a built-in\'s logo, the product icon the workbench registers for its CLI, and the robot for a custom agent, whatever it runs (L3)', () => {
		// Read from the workbench's source on purpose: the workbench alone registers these icons, and an id of the
		// extension's that drifts from its own shows no icon at all - nothing in the extension could catch that
		const launchers = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'vs', 'workbench', 'contrib', 'terminalLaunchers', 'common', 'terminalLaunchers.ts'), 'utf8');
		const registered = new Map([...launchers.matchAll(/\['(?<cli>[\w-]+)', registerIcon\('(?<icon>[\w-]+)'/g)].map(match => [match.groups?.cli, match.groups?.icon]));
		const logos = ['claude: agent-claude', 'codex: agent-codex', 'agy: agent-antigravity', 'muse: agent-muse', 'qwen: agent-qwen'];

		assert.deepStrictEqual({
			builtIns: knownClis().map(cli => `${cli.id}: ${agentIconId(cli.id, false)}`),
			registered: knownClis().map(cli => `${cli.id}: ${registered.get(cli.id)}`),
			custom: [agentIconId('my-agent', true), agentIconId('claude', true)]
		}, { builtIns: logos, registered: logos, custom: ['robot', 'robot'] });
	});
});

suite('Host: what the workspaces of the machine share on disk', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-machine-disk-');
	});

	teardown(() => {
		temp.remove();
	});

	/** The machine as the workspace `record` sees it, its window load `load` recorded as live. */
	function machineOf(record: string, load: string): HostMachine {
		const root = path.join(temp.dir, 'workspaces');
		fs.mkdirSync(path.join(root, record), { recursive: true });
		fs.writeFileSync(path.join(root, record, 'window.json'), JSON.stringify({ pipe: `pipe-${record}`, pid: process.pid, enabled: true, record, load }));
		return new HostMachine(new WindowLink(path.join(temp.dir, 'window.key')), root, path.join(temp.dir, 'outbox'), path.join(temp.dir, 'deleting'), { record, label: record, load }, () => 0, () => undefined);
	}

	test('two workspaces deleting one folder at once: one places its mark, the other is refused naming it; one left half written, or by a load that ended, is placed over; the one that placed it alone removes it (WT-8.4)', async () => {
		const alpha = machineOf('alpha', 'load-a');
		const beta = machineOf('beta', 'load-b');
		const folder = path.join(temp.dir, 'work');
		const both = await Promise.all([alpha.mark(folder), beta.mark(folder)]);
		await beta.unmark(folder);
		const held = alpha.markOver(folder);
		await alpha.unmark(folder);
		const file = path.join(temp.dir, 'deleting', fs.readdirSync(path.join(temp.dir, 'deleting')).find(name => name.endsWith('.json')) ?? 'none.json');
		fs.writeFileSync(file, '');
		const overHalf = await beta.mark(folder);
		fs.writeFileSync(path.join(temp.dir, 'workspaces', 'beta', 'window.json'), JSON.stringify({ pipe: 'pipe-beta', pid: process.pid, enabled: true, record: 'beta', load: 'load-b2' }));
		const overEnded = await alpha.mark(folder);

		assert.deepStrictEqual({ placed: both.filter(each => each.placed).length, refused: both.flatMap(each => each.placed ? [] : [each.by]), held, overHalf, overEnded, after: alpha.markOver(folder) }, {
			placed: 1,
			refused: [both[0].placed ? 'alpha' : 'beta'],
			held: both[0].placed ? 'alpha' : undefined,
			overHalf: { placed: true },
			overEnded: { placed: true },
			after: 'alpha'
		});
	});

	test('what protects work is asked of a workspace whose framework is off too; a whole call each takes once - sent again only where it was not taken, to its pipe as it is then - and one taken with no result is unknown (O5, O8)', async () => {
		const root = path.join(temp.dir, 'workspaces');
		const write = (record: string, pipe: string) => {
			fs.mkdirSync(path.join(root, record), { recursive: true });
			fs.writeFileSync(path.join(root, record, 'window.json'), JSON.stringify({ pipe, pid: process.pid, enabled: true, record, load: `${record}-load` }));
		};
		write('on', 'pipe-on');
		write('off', 'pipe-off');
		write('moved', 'pipe-old');
		write('offmoved', 'pipe-off-old');
		write('slow', 'pipe-slow');
		write('keyless', 'pipe-keyless');
		const asked: string[] = [];
		const called: string[] = [];
		const link = {
			hello: async (entry: WindowEntry) => ({ window: true, record: entry.record, enabled: entry.record !== 'off' && entry.record !== 'offmoved' }),
			query: async (entry: WindowEntry) => {
				asked.push(entry.record);
				return {};
			},
			call: async (entry: WindowEntry) => {
				called.push(entry.pipe);
				if (entry.pipe === 'pipe-old' || entry.pipe === 'pipe-off-old') {
					// Not taken as it reloads: by the next try it listens on another pipe, its framework on or off
					write(entry.record, entry.pipe === 'pipe-old' ? 'pipe-new' : 'pipe-off-new');
					throw new PipeClientError('not taken', 'UNREACHABLE');
				}
				if (entry.record === 'off') {
					throw new PipeClientError('taken, then the connection broke', 'NOT_CONNECTED');
				}
				if (entry.record === 'keyless') {
					// Refused before it ran: not the machine's key
					throw new PipeClientError('Facade IPC request \'call\' was rejected (status 401).', 'UNAUTHORIZED');
				}
				if (entry.record === 'slow') {
					// Taken, and its result not come by the time it is waited for
					throw new PipeClientError('Cancelled', 'CANCELLED');
				}
				return { left: [] };
			}
		};
		const machine = new HostMachine(link as unknown as WindowLink, root, path.join(temp.dir, 'outbox'), path.join(temp.dir, 'deleting'), { record: 'self', label: 'self' }, () => 10_000, () => undefined);
		const every = await machine.askEvery('window.workIn', {});
		const plain = await machine.ask('window.workIn', {});
		const released = await machine.callEvery('window.workRelease', {});

		assert.deepStrictEqual({
			every: every.answers.map(each => each.record).sort(),
			plain: { answered: plain.answers.map(each => each.record).sort(), off: plain.silent.map(each => `${each.record} ${each.reason}`) },
			asked: asked.sort(),
			released: { answered: released.answers.map(each => each.record).sort(), unknown: released.unknown?.map(each => each.record).sort(), refused: released.refused?.map(each => `${each.record}: ${each.why}`), silent: released.silent },
			called: called.sort()
		}, {
			every: ['keyless', 'moved', 'off', 'offmoved', 'on', 'slow'],
			plain: { answered: ['keyless', 'moved', 'on', 'slow'], off: ['off framework off', 'offmoved framework off'] },
			asked: ['keyless', 'keyless', 'moved', 'moved', 'off', 'offmoved', 'on', 'on', 'slow', 'slow'],
			released: { answered: ['moved', 'offmoved', 'on'], unknown: ['off', 'slow'], refused: ['keyless: Facade IPC request \'call\' was rejected (status 401).'], silent: [] },
			called: ['pipe-keyless', 'pipe-new', 'pipe-off', 'pipe-off-new', 'pipe-off-old', 'pipe-old', 'pipe-on', 'pipe-slow']
		});
	});

	test('a whole call handed every workspace is waited for no longer than its limit: one that never answers is given up, its outcome unknown (O8)', async () => {
		const root = path.join(temp.dir, 'workspaces');
		fs.mkdirSync(path.join(root, 'hung'), { recursive: true });
		fs.writeFileSync(path.join(root, 'hung', 'window.json'), JSON.stringify({ pipe: 'pipe-hung', pid: process.pid, enabled: true, record: 'hung', load: 'hung-load' }));
		const link = {
			hello: async (entry: WindowEntry) => ({ window: true, record: entry.record, enabled: true }),
			// Takes the call and never answers: only the limit ends the wait
			call: (_entry: WindowEntry, _tool: string, _args: object, _progress: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new PipeClientError('Cancelled', 'CANCELLED'))))
		};
		const machine = new HostMachine(link as unknown as WindowLink, root, path.join(temp.dir, 'outbox'), path.join(temp.dir, 'deleting'), { record: 'self', label: 'self' }, () => 200, () => undefined);
		const released = await machine.callEvery('window.workRelease', {});

		assert.deepStrictEqual({ answered: released.answers.length, unknown: released.unknown?.map(each => each.record) }, { answered: 0, unknown: ['hung'] });
	});

	test('the machine\'s window key is made whole once, whoever makes it first; an empty one left behind is made again, never used (O8)', () => {
		const file = path.join(temp.dir, 'window.key');
		const first = windowKey(file);
		const again = windowKey(file);
		fs.writeFileSync(file, '');
		const remade = windowKey(file);

		assert.deepStrictEqual({ same: first === again, long: first.length >= 40, remade: remade.length >= 40 && remade !== first, onDisk: fs.readFileSync(file, 'utf8') === remade }, { same: true, long: true, remade: true, onDisk: true });
	});
});

suite('Host: the window\'s state, beside the record', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-window-state-');
	});

	teardown(() => {
		temp.remove();
	});

	test('what one sets, the next one made on the same file reads; a value set to undefined is gone', async () => {
		const file = path.join(temp.dir, 'workspace', 'window-state.json');
		const first = new JsonFileState(file);
		const before = first.get('pipe') ?? 'none';
		await first.update('pipe', 'b71ef6fd');
		await first.update('agents', { running: 2 });
		await first.update('gone', 1);
		await first.update('gone', undefined);

		const second = new JsonFileState(file);
		assert.deepStrictEqual(
			{ before, pipe: second.get('pipe'), agents: second.get('agents'), gone: second.get('gone') ?? 'default', inherited: second.get('toString') ?? 'none' },
			{ before: 'none', pipe: 'b71ef6fd', agents: { running: 2 }, gone: 'default', inherited: 'none' });
	});

	test('a file that does not hold an object of values starts it empty', () => {
		const file = path.join(temp.dir, 'window-state.json');
		const read = (content: string) => {
			fs.writeFileSync(file, content);
			return new JsonFileState(file).get('pipe') ?? 'none';
		};
		assert.deepStrictEqual([read('{"pipe":'), read('["pipe"]'), read('null'), read('{"pipe":"a1"}')], ['none', 'none', 'none', 'a1']);
	});

	test('a file that is there and cannot be read says so - its values lost, the pipe\'s with them, for the window to say - and one that is not there is new (C-REC-19)', () => {
		const file = path.join(temp.dir, 'window-state.json');
		const missing = new JsonFileState(file).unreadable;
		fs.writeFileSync(file, '{"pipe":');
		const broken = new JsonFileState(file).unreadable;
		fs.writeFileSync(file, '[]');
		const notAnObject = new JsonFileState(file).unreadable;
		fs.writeFileSync(file, '{"pipe":"a1"}');

		assert.deepStrictEqual({ missing, broken: typeof broken, notAnObject, read: new JsonFileState(file).unreadable }, { missing: undefined, broken: 'string', notAnObject: 'it does not contain a JSON object', read: undefined });
	});
});

suite('Host: the processes, as the system has them', function () {

	this.timeout(30_000);

	test('where each process under an agent\'s works - a shell it ran, cd\'d elsewhere, included - and when a process started, to the second; on Windows the system says neither (X-74, N-24)', async () => {
		const temp = tempDir('facade-processes-');
		const elsewhere = fs.realpathSync(temp.dir);
		// A child, and its own child in another folder: the tree under this process
		const child = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: ${JSON.stringify(elsewhere)}, stdio: 'ignore' }); setTimeout(() => {}, 20000)`], { stdio: 'ignore' });
		try {
			await new Promise(resolve => setTimeout(resolve, 1500));
			const folders = await workingFoldersOf([process.pid]);
			const started = processStartedAt(process.pid);
			const expected = Date.now() - process.uptime() * 1000;

			assert.deepStrictEqual({
				found: process.platform === 'win32' ? undefined : (folders.get(process.pid) ?? []).includes(elsewhere),
				started: process.platform === 'win32' ? started : started !== undefined && Math.abs(started - expected) < 2_500,
				gone: processStartedAt(2 ** 30)
			}, {
				found: process.platform === 'win32' ? undefined : true,
				started: process.platform === 'win32' ? undefined : true,
				gone: undefined
			});
		} finally {
			spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill', process.platform === 'win32' ? ['/T', '/F', '/PID', String(child.pid)] : ['-P', String(child.pid)]);
			child.kill();
			temp.remove();
		}
	});
});

suite('Host: git\'s records, read with git', function () {

	this.timeout(30_000);

	let temp: { dir: string; remove(): void };
	const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

	setup(() => {
		temp = tempDir('facade-git-');
	});

	teardown(() => {
		temp.remove();
	});

	test('only a folder git says is in no repository is in none, and git tracks nothing there; a checkout on a branch with no commit yet is in one, with no HEAD, as is one whose branch git cannot read; git failing says why, and nothing is taken for none tracked', async () => {
		const plain = path.join(temp.dir, 'plain');
		const empty = path.join(temp.dir, 'empty');
		const orphan = path.join(temp.dir, 'orphan');
		const broken = path.join(temp.dir, 'broken');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(plain);
		fs.mkdirSync(empty);
		git(empty, 'init', '-q', '-b', 'trunk');
		// A repository with a commit, on a branch with none.
		fs.mkdirSync(orphan);
		git(orphan, 'init', '-q');
		git(orphan, '-c', 'user.name=Facade', '-c', 'user.email=facade@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start');
		git(orphan, 'checkout', '-q', '--orphan', 'new');
		// A repository with a commit, whose branch is no commit id.
		fs.mkdirSync(broken);
		git(broken, 'init', '-q', '-b', 'main');
		git(broken, '-c', 'user.name=Facade', '-c', 'user.email=facade@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start');
		fs.writeFileSync(path.join(broken, '.git', 'refs', 'heads', 'main'), 'garbage\n');

		assert.deepStrictEqual({
			plain: await repositoryIn('git', plain),
			empty: await repositoryIn('git', empty),
			orphan: await repositoryIn('git', orphan),
			broken: await repositoryIn('git', broken),
			gone: /cannot change to/.test(await outcomeOf(repositoryIn('git', gone))),
			excludePlain: await excludeIn('git', plain),
			excludeGone: /cannot change to/.test(await outcomeOf(excludeIn('git', gone))),
			trackedPlain: [...await trackedIn('git', plain, ['.mcp.json'])],
			trackedGone: /cannot change to/.test(await outcomeOf(trackedIn('git', gone, ['.mcp.json'])))
		}, {
			plain: undefined,
			empty: { main: empty, mainCheckout: true, worktree: 'trunk', head: undefined },
			orphan: { main: orphan, mainCheckout: true, worktree: 'new', head: undefined },
			broken: { main: broken, mainCheckout: true, worktree: 'main', head: undefined },
			gone: true,
			excludePlain: undefined,
			excludeGone: true,
			trackedPlain: [],
			trackedGone: true
		});
	});

	test('in a repository: its main checkout - a folder inside it is in it too, a worktree git added is not - its HEAD, where its exclude file is, which of some files it tracks - or a commit of it has - each taken as it is, and what deleting a worktree would lose, a change not staged first', async () => {
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(lab, '.mcp.json'), '{}');
		git(lab, 'add', '.mcp.json');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		const head = git(lab, 'rev-parse', 'HEAD').stdout.trim();
		// Tracked since, in the index: the first commit has none of it.
		fs.mkdirSync(path.join(lab, '.agents', 'skills', 'facade'), { recursive: true });
		fs.writeFileSync(path.join(lab, '.agents', 'skills', 'facade', 'SKILL.md'), '# Ours');
		git(lab, 'add', '.agents');

		const added = path.join(temp.dir, 'lab-lint');
		git(lab, 'worktree', 'add', '-q', '-b', 'lint', added);
		fs.writeFileSync(path.join(added, '.mcp.json'), '{ "changed": true }');
		fs.writeFileSync(path.join(added, 'notes.md'), 'new');

		const repository = await repositoryIn('git', lab);
		const exclude = await excludeIn('git', lab);
		const files = ['.mcp.json', '.agents/skills/facade/SKILL.md', '.muse/hooks.json', '*.json'];
		assert.deepStrictEqual({
			repository: repository && { main: path.relative(temp.dir, repository.main), mainCheckout: repository.mainCheckout, worktree: repository.worktree, head: repository.head === head },
			inside: (await repositoryIn('git', path.join(lab, '.agents')))?.mainCheckout,
			worktree: (await repositoryIn('git', added))?.mainCheckout,
			exclude: exclude && [path.relative(lab, exclude.file), path.relative(temp.dir, exclude.root)],
			tracked: [...await trackedIn('git', lab, files)],
			atCommit: [...await trackedIn('git', lab, files, head)],
			changed: [...await changedFilesIn('git', added)].sort()
		}, {
			repository: { main: 'lab', mainCheckout: true, worktree: 'main', head: true },
			inside: true,
			worktree: false,
			exclude: [path.join('.git', 'info', 'exclude'), 'lab'],
			tracked: ['.mcp.json', '.agents/skills/facade/SKILL.md'],
			atCommit: ['.mcp.json'],
			changed: ['.mcp.json', 'notes.md']
		});
	});

	test('the worktree a folder is in, its top level, written as the folder is - through a link, the link: the main checkout\'s, or a worktree git added, from a folder inside it; none in its git directory, in a bare repository or in no repository; git failing otherwise says why (O5; OR-09)', async () => {
		const lab = path.join(temp.dir, 'lab');
		const added = path.join(temp.dir, 'lab-lint');
		const bare = path.join(temp.dir, 'lab.git');
		const link = path.join(temp.dir, 'link');
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(lab);
		fs.mkdirSync(plain);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'lint', added);
		git(temp.dir, 'clone', '-q', '--bare', lab, bare);
		fs.mkdirSync(path.join(added, 'packages', 'app'), { recursive: true });
		fs.symlinkSync(added, link, 'junction');
		// Not there, in a folder whose name has words of git's in it, written otherwise: git's failure, never taken for none
		const gone = path.join(temp.dir, 'My Work Tree', 'gone');

		assert.deepStrictEqual({
			main: await worktreeRootIn('git', lab),
			nested: await worktreeRootIn('git', path.join(added, 'packages', 'app')),
			linked: await worktreeRootIn('git', path.join(link, 'packages', 'app')),
			gitDir: await worktreeRootIn('git', path.join(lab, '.git')),
			bare: await worktreeRootIn('git', bare),
			plain: await worktreeRootIn('git', plain),
			gone: /cannot change to/.test(await outcomeOf(worktreeRootIn('git', gone)))
		}, {
			main: lab,
			nested: added,
			linked: link,
			gitDir: undefined,
			bare: undefined,
			plain: undefined,
			gone: true
		});
	});

	test('a bare repository has no worktree of its own: its worktrees are those checked out of it, and a file of the person\'s is looked for in them alone', async () => {
		const seed = path.join(temp.dir, 'seed');
		const bare = path.join(temp.dir, 'lab.git');
		const main = path.join(temp.dir, 'main');
		fs.mkdirSync(seed);
		git(seed, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(seed, 'tracked.json'), '{}');
		git(seed, 'add', '.');
		git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		git(temp.dir, 'clone', '-q', '--bare', seed, bare);
		git(bare, 'worktree', 'add', '-q', main, 'main');
		fs.writeFileSync(path.join(main, '.mcp.json'), '{}');

		assert.deepStrictEqual({
			worktrees: (await worktreesIn('git', main)).map(each => path.relative(temp.dir, each.folder)),
			untracked: [...await untrackedIn('git', main, ['.mcp.json', 'tracked.json'])]
		}, {
			worktrees: ['main'],
			untracked: ['.mcp.json']
		});
	});

	test('a file of the person\'s that git neither tracks nor ignores is found in whichever worktree of the repository has it, at the same place from that worktree\'s root; one git tracks or ignores, or in a worktree whose folder is gone, is not', async () => {
		const lab = path.join(temp.dir, 'lab');
		const other = path.join(temp.dir, 'other');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(path.join(lab, 'packages', 'app'), { recursive: true });
		git(lab, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(lab, 'tracked.json'), '{}');
		fs.writeFileSync(path.join(lab, 'packages', 'app', 'keep.txt'), '');
		git(lab, 'add', '.');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'other', other);
		git(lab, 'worktree', 'add', '-q', '-b', 'gone', gone);
		fs.rmSync(gone, { recursive: true, force: true });
		// The person's own, untracked: one in the other worktree, one in a folder of it, one they ignore.
		fs.writeFileSync(path.join(other, '.mcp.json'), '{}');
		fs.writeFileSync(path.join(other, 'packages', 'app', '.mcp.json'), '{}');
		fs.writeFileSync(path.join(other, 'ignored.json'), '{}');
		fs.writeFileSync(path.join(lab, '.gitignore'), 'ignored.json\n');
		fs.writeFileSync(path.join(other, '.gitignore'), 'ignored.json\n');

		assert.deepStrictEqual({
			root: [...await untrackedIn('git', lab, ['.mcp.json', '.muse/hooks.json', 'tracked.json', 'ignored.json'])],
			inside: [...await untrackedIn('git', path.join(lab, 'packages', 'app'), ['.mcp.json', '.muse/hooks.json'])],
			plain: [...await untrackedIn('git', temp.dir, ['.mcp.json'])]
		}, {
			root: ['.mcp.json'],
			inside: ['.mcp.json'],
			plain: []
		});
	});

	test('a worktree git still lists whose folder is left without its .git - as git removing it leaves one a process is in, on Windows - is a worktree no more: it is not among the repository\'s worktrees, nothing is looked for there, and git is not asked there', async () => {
		const lab = path.join(temp.dir, 'lab');
		const other = path.join(temp.dir, 'other');
		const emptied = path.join(temp.dir, 'emptied');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'other', other);
		git(lab, 'worktree', 'add', '-q', '-b', 'emptied', emptied);
		for (const entry of fs.readdirSync(emptied)) {
			fs.rmSync(path.join(emptied, entry), { recursive: true, force: true });
		}
		fs.writeFileSync(path.join(other, '.mcp.json'), '{}');

		assert.deepStrictEqual({
			listed: (await worktreesIn('git', lab)).map(each => path.relative(temp.dir, each.folder)).sort(),
			untracked: [...await untrackedIn('git', lab, ['.mcp.json'])]
		}, {
			listed: ['lab', 'other'],
			untracked: ['.mcp.json']
		});
	});

	test('Facade\'s git takes no lock it can do without: its status leaves the index\'s to the person\'s own git (X-69)', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		const seen = path.join(temp.dir, 'seen');
		const wrapper = path.join(temp.dir, 'git');
		fs.writeFileSync(wrapper, `#!/bin/sh\necho "$GIT_OPTIONAL_LOCKS" >> ${JSON.stringify(seen)}\nexec git "$@"\n`, { mode: 0o755 });
		await changedFilesIn(wrapper, lab);

		assert.deepStrictEqual(fs.readFileSync(seen, 'utf8'), '0\n');
	});

	test('a new branch\'s name: git\'s own no, a branch whose name it would be under or that would be under its, or nothing; git not answering is no answer, not a no (X-57)', async () => {
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'branch', 'feature');
		git(lab, 'branch', 'fix/login');

		assert.deepStrictEqual({
			fine: await whyNotBranchNameIn('git', lab, 'clamp'),
			notAName: await whyNotBranchNameIn('git', lab, 'a..b'),
			under: await whyNotBranchNameIn('git', lab, 'feature/more'),
			over: await whyNotBranchNameIn('git', lab, 'fix'),
			noGit: /ENOENT/.test(await outcomeOf(whyNotBranchNameIn(path.join(temp.dir, 'no-git'), lab, 'clamp')))
		}, {
			fine: undefined,
			notAName: 'Git rejects "a..b" as a branch name',
			under: 'branch \'feature\' already exists; Git cannot use the same name for both a branch and a branch-name prefix',
			over: 'branch \'fix/login\' already exists; Git cannot use the same name for both a branch and a branch-name prefix',
			noGit: true
		});
	});

	test('what a deletion left of a worktree, against its branch: a file as the branch has it is no one\'s work; one changed, or one the branch does not have, is; with the branch gone, everything is (SP-14)', async () => {
		const commit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', ...args);
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		commit(lab, 'commit', '-q', '--allow-empty', '-m', 'first');
		const left = path.join(temp.dir, 'left');
		git(lab, 'worktree', 'add', '-q', '-b', 'left', left);
		fs.mkdirSync(path.join(left, 'src'));
		fs.writeFileSync(path.join(left, 'src', 'index.js'), 'kept\n');
		fs.writeFileSync(path.join(left, 'changed.txt'), 'before\n');
		git(left, 'add', '.');
		commit(left, 'commit', '-q', '-m', 'files');
		git(lab, 'worktree', 'remove', '--force', left);
		// What it left: one file as committed, one changed since, one the branch never had
		fs.mkdirSync(path.join(left, 'src'), { recursive: true });
		fs.writeFileSync(path.join(left, 'src', 'index.js'), 'kept\n');
		fs.writeFileSync(path.join(left, 'changed.txt'), 'after\n');
		fs.writeFileSync(path.join(left, 'notes.md'), 'mine\n');
		const work = [...await leftoverWorkIn('git', lab, 'left', left)].sort();
		git(lab, 'branch', '-q', '-D', 'left');

		assert.deepStrictEqual({ work, branchGone: [...await leftoverWorkIn('git', lab, 'left', left)].sort() }, {
			work: ['changed.txt', 'notes.md'],
			branchGone: ['changed.txt', 'notes.md', 'src/index.js']
		});
	});

	test('what a file holds at a commit, from the repository\'s root: none for one the commit does not have, or a folder (X-30)', async () => {
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(path.join(lab, 'sub'), { recursive: true });
		git(lab, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(lab, '.mcp.json'), '{ "mcpServers": {} }\n');
		fs.writeFileSync(path.join(lab, 'sub', 'a.txt'), 'a');
		git(lab, 'add', '.');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		const head = git(lab, 'rev-parse', 'HEAD').stdout.trim();
		fs.writeFileSync(path.join(lab, '.mcp.json'), 'changed since');

		assert.deepStrictEqual({
			committed: await fileAtIn('git', lab, head, '.mcp.json'),
			nested: await fileAtIn('git', lab, head, path.join('sub', 'a.txt')),
			missing: await fileAtIn('git', lab, head, '.codex/config.toml'),
			folder: await fileAtIn('git', lab, head, 'sub')
		}, {
			committed: '{ "mcpServers": {} }\n',
			nested: 'a',
			missing: undefined,
			folder: undefined
		});
	});

	test('a worktree\'s submodules, as git finds them before it removes one: none; one checked out, by its path; one whose repository its git directory keeps though it is not checked out, by its name (X-14)', async () => {
		const commit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', '-c', 'protocol.file.allow=always', ...args);
		const lib = path.join(temp.dir, 'lib');
		fs.mkdirSync(lib);
		git(lib, 'init', '-q', '-b', 'main');
		commit(lib, 'commit', '-q', '--allow-empty', '-m', 'lib');
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		commit(lab, 'commit', '-q', '--allow-empty', '-m', 'first');
		const plain = path.join(temp.dir, 'plain');
		git(lab, 'worktree', 'add', '-q', '-b', 'plain', plain);
		const withLib = path.join(temp.dir, 'with-lib');
		git(lab, 'worktree', 'add', '-q', '-b', 'with-lib', withLib);
		commit(withLib, 'submodule', '--quiet', 'add', lib, 'vendor/lib');
		const before = await submodulesIn('git', withLib);
		git(withLib, 'submodule', '--quiet', 'deinit', '-f', 'vendor/lib');

		assert.deepStrictEqual({ plain: await submodulesIn('git', plain), before, deinit: await submodulesIn('git', withLib) }, {
			plain: [],
			before: ['vendor/lib'],
			deinit: ['vendor/lib']
		});
	});

	test('a worktree whose folder is gone is not among the repository\'s worktrees either: git lists it until it is pruned', async () => {
		const lab = path.join(temp.dir, 'lab');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'gone', gone);
		fs.rmSync(gone, { recursive: true, force: true });

		assert.deepStrictEqual({
			git: /prunable/.test(git(lab, 'worktree', 'list', '--porcelain').stdout),
			listed: (await worktreesIn('git', lab)).map(each => path.relative(temp.dir, each.folder))
		}, { git: true, listed: ['lab'] });
	});
});

suite('Host: a window takes over from its earlier extension host (R4)', () => {

	const HOLDER = 424242;
	const OTHER = 434343;
	const OWNER = 'window-owner';
	const LOCK = 'ledger.lock';
	const WINDOW = 'window.json';

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-takeover-');
		fs.writeFileSync(path.join(temp.dir, LOCK), `${HOLDER} ${OWNER} abc123`);
		fs.writeFileSync(path.join(temp.dir, WINDOW), JSON.stringify({ pipe: 'facade-test', pid: HOLDER, release: 'secret' }));
	});
	teardown(() => temp.remove());

	interface TakeoverWorld {
		readonly killed: [number, string][];
		readonly infos: string[];
		readonly warns: string[];
		readonly ports: TakeoverPorts;
	}

	function world(askRelease: TakeoverPorts['askRelease'], identify?: TakeoverPorts['identify']): TakeoverWorld {
		const alive = new Set([HOLDER, OTHER]);
		const killed: [number, string][] = [];
		const infos: string[] = [];
		const warns: string[] = [];
		const ports: TakeoverPorts = {
			info: message => infos.push(message),
			warn: message => warns.push(message),
			isRunning: pid => alive.has(pid),
			kill: (pid, signal) => { killed.push([pid, signal]); alive.delete(pid); },
			identify: identify ?? (() => ({ words: ['node', '--type=extensionHost'], executable: process.execPath })),
			askRelease,
			askMs: 30, closeMs: 60, handoverMs: 60, pollMs: 5
		};
		return { killed, infos, warns, ports };
	}

	test('an earlier extension host that answers and lets go is waited for, and its process is left to close itself', async () => {
		const holds = world(async () => { fs.rmSync(path.join(temp.dir, LOCK)); });

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual({ killed: holds.killed, warns: holds.warns }, { killed: [], warns: [] });
		assert.ok(holds.infos.join('\n').includes('is letting go'));
	});

	test('one that answers but still holds is ended, checked first to be an extension host', async () => {
		const seen: number[] = [];
		const holds = world(async () => { }, pid => {
			seen.push(pid);
			return { words: ['node', '--type=extensionHost'], executable: process.execPath };
		});

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual({ seen, killed: holds.killed }, { seen: [HOLDER], killed: [[HOLDER, 'SIGTERM']] });
		assert.ok(holds.warns.join('\n').includes('still holds the lock'));
	});

	test('one that refuses is given the handover wait while it closes, and ended only after', async () => {
		const holds = world(async () => { throw new Error('ECONNREFUSED'); });

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual(holds.killed, [[HOLDER, 'SIGTERM']]);
		assert.ok(holds.infos.join('\n').includes('could not be asked to let go'));
	});

	test('one that answers nothing in time is ended at once, without the handover wait', async () => {
		const holds = world((_pipe, _secret, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
		holds.ports.handoverMs = 1500;
		const started = Date.now();

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual(holds.killed, [[HOLDER, 'SIGTERM']]);
		assert.ok(holds.warns.join('\n').includes('did not answer letting go in time'));
		assert.ok(Date.now() - started < 1000, 'the handover wait must be skipped where nothing answered');
	});

	test('one that names no release is waited for through the handover, then ended', async () => {
		fs.writeFileSync(path.join(temp.dir, WINDOW), JSON.stringify({ pipe: 'facade-test', pid: HOLDER }));
		const holds = world(async () => { throw new Error('must not be asked without a release'); });

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual(holds.killed, [[HOLDER, 'SIGTERM']]);
		assert.ok(holds.infos.join('\n').includes('names no release'));
	});

	test('a reload that lands while waited for wins: the lock moved to a new extension host is left alone', async () => {
		const holds = world(async () => { throw new Error('ECONNREFUSED'); });
		holds.ports.handoverMs = 1000;
		setTimeout(() => fs.writeFileSync(path.join(temp.dir, LOCK), `${OTHER} ${OWNER} xyz789`), 10);

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'taken');
		assert.deepStrictEqual(holds.killed, []);
	});

	test('a process that is not an extension host is never ended: the takeover fails instead', async () => {
		const holds = world(async () => { }, () => ({ words: ['node'], executable: process.execPath }));

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, holds.ports), 'failed');
		assert.deepStrictEqual(holds.killed, []);
		assert.ok(holds.warns.length > 0);
	});

	test('one whose service stopped while it was waited for is left to close itself: nothing is ended, and no ending said', async () => {
		const held = world(async () => { });
		held.ports.stopped = () => true;

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, held.ports), 'failed');
		assert.deepStrictEqual({ killed: held.killed, warns: held.warns, infos: held.infos }, {
			killed: [],
			warns: [],
			infos: ['This window\'s earlier extension host (process 424242) is letting go of the workspace\'s agents.']
		});
	});

	test('a stale host never takes the record from a newer holder: no ask, no wait, no kill (L5)', async () => {
		fs.writeFileSync(path.join(temp.dir, LOCK), `${HOLDER} ${OWNER} abc123 ${Date.now() + 60_000}`);
		let asked = 0;
		const stale = world(async () => { asked++; });
		stale.ports.startedAt = Date.now();
		stale.ports.askMs = 1500;
		stale.ports.closeMs = 1500;
		stale.ports.handoverMs = 1500;
		const started = Date.now();

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, stale.ports), 'newer-holder');
		assert.deepStrictEqual({ asked, killed: stale.killed, warns: stale.warns, infos: stale.infos }, { asked: 0, killed: [], warns: [], infos: [] });
		assert.ok(Date.now() - started < 1000, 'a newer holder is given up to at once, before any ask, wait or kill');
	});

	test('a newer host takes over from an older holder as ever: asked, waited for, ended (L5)', async () => {
		fs.writeFileSync(path.join(temp.dir, LOCK), `${HOLDER} ${OWNER} abc123 ${Date.now() - 60_000}`);
		let asked = 0;
		const newer = world(async () => { asked++; });
		newer.ports.startedAt = Date.now();

		assert.strictEqual(await releaseEarlierHost(temp.dir, HOLDER, OWNER, newer.ports), 'taken');
		assert.deepStrictEqual({ asked, killed: newer.killed }, { asked: 1, killed: [[HOLDER, 'SIGTERM']] });
	});
});

suite('Host: the window is pinged, and last heard written, within a minute (REMOTE.md RM-08)', () => {

	test('every 20 seconds a ping, at most every 15 a write of last heard', () => {
		const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'service.ts'), 'utf8');

		assert.deepStrictEqual(
			[/const WINDOW_PING_MS = ([\d_]+);/.exec(service)?.[1], /const HEARD_WRITE_MS = ([\d_]+);/.exec(service)?.[1]],
			['20_000', '15_000']);
	});
});

suite('Host: a timeout says what the window\'s answers say (D3)', () => {

	test('every answer the window gives stamps when it came - no heard() call bypasses the stamp - and a ping\'s answer and a ticket\'s claim stamp too', () => {
		const terminals = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'terminals.ts'), 'utf8');
		const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'service.ts'), 'utf8');

		assert.deepStrictEqual({
			bare: terminals.match(/this\.heard\(\)/g),
			stamps: terminals.includes('this.lastHeardAt = Date.now();'),
			sinceWaitBegan: terminals.includes('this.lastHeardAt >= started'),
			serviceNotes: service.match(/this\.noteHeard\(\)/g)
		}, {
			bare: ['this.heard()'],
			stamps: true,
			sinceWaitBegan: true,
			serviceNotes: ['this.noteHeard()', 'this.noteHeard()']
		});
	});
});

suite('Host: whether the window was away as the service recovers (M1)', () => {

	test('the window\'s own answer, asked once: true where it was away; false where it was not, says otherwise, or has no such command; unknown where the asking fails or no answer comes in time', async () => {
		const commands = (known: readonly string[]) => async () => known;
		const asked: unknown[] = [];
		const ask = (answer: unknown) => async () => { asked.push(answer); return answer; };
		const calls = [
			windowWasAway(commands([WAS_AWAY_COMMAND]), ask({ away: true }), 20),
			windowWasAway(commands([WAS_AWAY_COMMAND]), ask({ away: false }), 20),
			windowWasAway(commands([WAS_AWAY_COMMAND]), ask({}), 20),
			windowWasAway(commands([]), ask({ away: true }), 20),
			windowWasAway(commands([WAS_AWAY_COMMAND]), async () => { throw new Error('gone'); }, 20),
			windowWasAway(async () => { throw new Error('gone'); }, ask({ away: true }), 20),
			windowWasAway(commands([WAS_AWAY_COMMAND]), () => new Promise(() => { }), 20),
			windowWasAway(() => new Promise(() => { }), ask({ away: true }), 20)
		];

		assert.deepStrictEqual({ answers: await Promise.all(calls), asked, askMs: WAS_AWAY_ASK_MS }, {
			answers: [true, false, false, false, undefined, undefined, undefined, undefined],
			asked: [{ away: true }, { away: false }, {}],
			askMs: 30_000
		});
	});
});
