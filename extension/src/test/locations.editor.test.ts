/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { TestEmitter, withModules } from './withModules';

/** Enough of `vscode.Uri` to tell a derived URI from one rebuilt as a local file. */
class FakeUri {
	constructor(readonly scheme: string, readonly authority: string, readonly path: string) { }
	static parse(value: string): FakeUri {
		const match = /^([^:]+):\/\/([^/]*)(.*)$/.exec(value);
		if (!match) {
			throw new Error(`not a URI: ${value}`);
		}
		return new FakeUri(match[1], match[2], match[3] || '/');
	}
	static file(file: string): FakeUri {
		return new FakeUri('file', '', file);
	}
	with(change: { readonly path?: string }): FakeUri {
		return new FakeUri(this.scheme, this.authority, change.path ?? this.path);
	}
	get fsPath(): string {
		return this.path;
	}
	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}`;
	}
}

interface FakeWatcher {
	readonly base: string;
	readonly pattern: string;
	readonly created: TestEmitter<FakeUri>;
	readonly changed: TestEmitter<FakeUri>;
	readonly deleted: TestEmitter<FakeUri>;
	disposed: boolean;
}

function fakeEditor(remoteName: string | undefined, folders: readonly string[], settings: { readonly [key: string]: unknown } = {}) {
	const watchers: FakeWatcher[] = [];
	const scopes: unknown[] = [];
	const vscode = {
		Uri: FakeUri,
		RelativePattern: class { constructor(readonly base: FakeUri, readonly pattern: string) { } },
		env: { remoteName },
		workspace: {
			workspaceFolders: folders.map((uri, index) => ({ index, name: uri.split('/').pop(), uri: FakeUri.parse(uri) })),
			onDidChangeWorkspaceFolders: new TestEmitter<unknown>().event,
			getConfiguration: (section: string, scope?: unknown) => {
				scopes.push(scope);
				return { get: (key: string) => settings[`${section}.${key}`] };
			},
			createFileSystemWatcher: (pattern: { base: FakeUri; pattern: string }) => {
				const watcher: FakeWatcher = { base: pattern.base.toString(), pattern: pattern.pattern, created: new TestEmitter(), changed: new TestEmitter(), deleted: new TestEmitter(), disposed: false };
				watchers.push(watcher);
				return {
					onDidCreate: watcher.created.event,
					onDidChange: watcher.changed.event,
					onDidDelete: watcher.deleted.event,
					dispose: () => { watcher.disposed = true; }
				};
			}
		}
	};
	const load = withModules({ vscode });
	return {
		watchers, scopes,
		events: load<typeof import('../host/locations/gitEvents')>(require.resolve('../host/locations/gitEvents')),
		folders: load<typeof import('../host/locations/workspaceFolders')>(require.resolve('../host/locations/workspaceFolders'))
	};
}

const BOX = 'vscode-remote://ssh-remote+box';

suite('Locations: the editor side of locations (WORKTREES-1.3, 4.1)', () => {

	test('a location\'s URI is derived from its folder\'s, keeping the remote authority; folders keep their original URI and environment path', () => {
		const editor = fakeEditor('ssh-remote', [`${BOX}/w/repo`]);

		assert.strictEqual(editor.folders.editorUriOf(`${BOX}/w/repo`, '/w/repo.worktrees/feat'), `${BOX}/w/repo.worktrees/feat`);
		assert.deepStrictEqual(editor.folders.editorFolders().folders(), [{ index: 0, name: 'repo', uri: `${BOX}/w/repo`, path: '/w/repo' }]);
		assert.strictEqual(editor.folders.editorEnvironment(), 'ssh-remote+box', 'the authority names the host, so two hosts never share location IDs');
		assert.strictEqual(fakeEditor(undefined, []).folders.editorEnvironment(), 'local');
	});

	test('git.path is read on use in the folder\'s own scope', async () => {
		const editor = fakeEditor(undefined, [], { 'git.path': ['/nowhere/git'] });

		assert.strictEqual(await editor.folders.editorGit().executable({ index: 0, name: 'repo', uri: 'file:///w/repo', path: '/w/repo' }), 'git');
		assert.strictEqual(String(editor.scopes[0]), 'file:///w/repo');
	});

	test('a repository\'s Git directory is watched for worktrees coming, going and moving and for HEADs, not for every write in it (WORKTREES-1.3)', () => {
		const editor = fakeEditor('ssh-remote', [`${BOX}/w/repo`]);
		let events = 0;
		const watch = editor.events.watchGitDirectory('/w/repo/.git', { index: 0, name: 'repo', uri: `${BOX}/w/repo`, path: '/w/repo' }, () => events++);

		assert.deepStrictEqual(editor.watchers.map(each => [each.base, each.pattern]), [[`${BOX}/w/repo/.git`, 'HEAD'], [`${BOX}/w/repo/.git`, 'worktrees/**']]);
		const [head, worktrees] = editor.watchers;
		const at = (relative: string) => FakeUri.parse(`${BOX}/w/repo/.git/${relative}`);
		head.changed.fire(at('HEAD'));
		worktrees.created.fire(at('worktrees/feat'));
		worktrees.changed.fire(at('worktrees/feat/HEAD'));
		worktrees.changed.fire(at('worktrees/feat/gitdir'));
		worktrees.deleted.fire(at('worktrees/feat'));
		assert.strictEqual(events, 5);
		worktrees.changed.fire(at('worktrees/feat/index'));
		worktrees.changed.fire(at('worktrees/feat/logs/HEAD'));
		assert.strictEqual(events, 5);
		watch.dispose();
		assert.deepStrictEqual(editor.watchers.map(each => each.disposed), [true, true]);
	});
});
