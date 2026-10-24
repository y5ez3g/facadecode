/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWindowOpenable, IOpenWindowOptions, isFolderToOpen } from '../../../../../platform/window/common/window.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceBarTrustGate } from '../../../../browser/parts/workspacebar/workspaceBarTrust.js';
import { IHostService } from '../../../../services/host/browser/host.js';

suite('Workspace bar - a folder not trusted, on its way into a trusted window', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IWindow {
		/** Whether the window is trusted, and which folders are, by path. */
		trusted: boolean;
		readonly trustedFolders: Set<string>;
		enabled: boolean;
		/** The button pressed, by its label; undefined for Cancel. */
		answer: string | undefined;
		/** Whether the box to trust the parent folder was ticked. */
		ticked?: boolean;
		/** Whether the link to a new window was followed, rather than a button pressed. */
		followsLink?: boolean;
	}

	function services(window: IWindow) {
		const steps: string[] = [];
		const asked: { message: string; details: string[]; box: string | undefined; icon: string | undefined }[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		// Where git's files are read, to know a worktree's repository
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(IWorkspaceTrustEnablementService, { isWorkspaceTrustEnabled: () => window.enabled });
		instantiationService.stub(IWorkspaceTrustManagementService, {
			isWorkspaceTrusted: () => window.trusted,
			getUriTrustInfo: async (uri: URI): Promise<IWorkspaceTrustUriInfo> => ({ uri, trusted: window.trustedFolders.has(uri.path) }),
			setUrisTrust: async (uris: URI[], trusted: boolean) => {
				steps.push(`trust ${uris.map(uri => uri.path).join(' ')} ${trusted}`);
				for (const uri of uris) {
					window.trustedFolders.add(uri.path);
				}
			}
		});
		instantiationService.stub(IDialogService, {
			prompt: async <T>(prompt: IPrompt<T>) => {
				steps.push(`ask: ${prompt.message} [${(prompt.buttons ?? []).map(button => button.label.replace('&&', '')).join(', ')}]`);
				const custom = typeof prompt.custom === 'object' ? prompt.custom : undefined;
				asked.push({ message: prompt.message, details: (custom?.markdownDetails ?? []).map(detail => detail.markdown.value), box: prompt.checkbox?.label, icon: custom?.icon?.id });
				if (window.followsLink) {
					// The link the question follows itself, which closes it as Cancel would
					const link = custom?.markdownDetails?.find(detail => detail.actionHandler);
					await link?.actionHandler?.('command:_facade.workspaceBar.openElsewhere');
					assert.ok(prompt.token?.isCancellationRequested, 'the link closes the question');
					return { result: undefined };
				}
				const button = (prompt.buttons ?? []).find(candidate => candidate.label.replace('&&', '') === window.answer);
				return { result: button ? await button.run({ checkboxChecked: !!window.ticked }) : undefined, checkboxChecked: !!window.ticked };
			}
		});
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IOpenerService, {});
		instantiationService.stub(IHostService, {
			openWindow: async (toOpen?: IWindowOpenable[] | IOpenWindowOptions, options?: IOpenWindowOptions) => {
				const folders = Array.isArray(toOpen) ? toOpen.filter(isFolderToOpen).map(openable => openable.folderUri.path) : [];
				steps.push(`new window ${folders.join(' ')}${options?.forceNewWindow ? '' : ' (reused!)'}`);
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: (uri: URI) => uri.path });
		instantiationService.stub(ILogService, new NullLogService());
		return { instantiationService, steps, asked, fileService };
	}

	async function admit(paths: string[], window: IWindow) {
		const { instantiationService, steps, asked } = services(window);
		const admission = await instantiationService.createInstance(WorkspaceBarTrustGate).admit(paths.map(path => URI.file(path)));
		return { here: admission?.here.map(uri => uri.path), steps, asked };
	}

	const trustedWindow = (answer?: string): IWindow => ({ trusted: true, trustedFolders: new Set(['/code/api']), enabled: true, answer });

	test('WS-48 one question for everything added together, before it is added, as VS Code asks its own - the shield, the paths that are not trusted as code, why it is asked, its docs and a new window: Trust and Add trusts them and lets all in', async () => {
		const { here, steps, asked } = await admit(['/code/api', '/tmp/a', '/srv/b'], trustedWindow('Trust and Add'));

		assert.deepStrictEqual({ here, steps, asked }, {
			here: ['/code/api', '/tmp/a', '/srv/b'],
			steps: ['ask: Do you trust the authors of the files in these 2 folders? [Trust and Add]', 'trust /tmp/a /srv/b true'],
			asked: [{
				message: 'Do you trust the authors of the files in these 2 folders?',
				details: [
					'`/tmp/a`  \n`/srv/b`',
					'This workspace is trusted. Adding untrusted folders will switch the entire workspace and active agents to Restricted Mode.',
					'See [our docs](https://aka.ms/vscode-workspace-trust) to learn more, or [open all 3 folders in a new window](command:_facade.workspaceBar.openElsewhere) in Restricted Mode.'
				],
				// In two parent folders: neither is offered whole
				box: undefined,
				icon: 'shield'
			}]
		});
	});

	test('WS-48 the link to a new window takes everything being added, the trusted too, to one window of its own; nothing joins this one, nothing is trusted', async () => {
		const { here, steps, asked } = await admit(['/code/api', '/tmp/a'], { ...trustedWindow(), followsLink: true });

		assert.deepStrictEqual({ here, steps, link: asked[0].details[2] }, {
			here: [],
			steps: ['ask: Do you trust the authors of the files in this folder? [Trust and Add]', 'new window /code/api /tmp/a'],
			link: 'See [our docs](https://aka.ms/vscode-workspace-trust) to learn more, or [open all 2 folders in a new window](command:_facade.workspaceBar.openElsewhere) in Restricted Mode.'
		});
	});

	test('WS-48 folders that share a parent folder: the box to trust it whole, as VS Code\'s own question has, and ticked it is the parent that is trusted', async () => {
		const ticked = await admit(['/tmp/a', '/tmp/b'], { ...trustedWindow('Trust and Add'), ticked: true });
		const left = await admit(['/tmp/a'], trustedWindow('Trust and Add'));

		assert.deepStrictEqual({
			ticked: { box: ticked.asked[0].box, steps: ticked.steps.slice(1) },
			left: { box: left.asked[0].box, steps: left.steps.slice(1), link: left.asked[0].details[2] }
		}, {
			ticked: { box: 'Trust the authors of all files in the parent folder \'tmp\'', steps: ['trust /tmp true'] },
			left: { box: 'Trust the authors of all files in the parent folder \'tmp\'', steps: ['trust /tmp/a true'], link: 'See [our docs](https://aka.ms/vscode-workspace-trust) to learn more, or [open in a new window](command:_facade.workspaceBar.openElsewhere) in Restricted Mode.' }
		});
	});

	test('WS-48 past ten folders not trusted, the question names ten and counts the rest', async () => {
		const paths = Array.from({ length: 12 }, (_, at) => `/tmp/f${at + 1}`);
		const { asked } = await admit(paths, trustedWindow());

		assert.deepStrictEqual({ message: asked[0].message, paths: asked[0].details[0].split('  \n') }, {
			message: 'Do you trust the authors of the files in these 12 folders?',
			paths: [...paths.slice(0, 10).map(path => `\`${path}\``), 'and 2 more']
		});
	});

	test('WS-48 Cancel lets nothing in, the trusted ones neither', async () => {
		const { here, steps } = await admit(['/code/api', '/tmp/a'], trustedWindow(undefined));

		assert.deepStrictEqual({ here, asked: steps.length }, { here: undefined, asked: 1 });
	});

	test('nothing is asked when everything is trusted, when the window is in Restricted Mode already, or with trust switched off', async () => {
		assert.deepStrictEqual({
			trusted: (await admit(['/code/api'], trustedWindow())).steps,
			restricted: (await admit(['/tmp/a'], { ...trustedWindow(), trusted: false })).steps,
			off: (await admit(['/tmp/a'], { ...trustedWindow(), enabled: false })).steps,
		}, { trusted: [], restricted: [], off: [] });
	});

	test('a worktree of a repository that is not trusted is asked about as that repository, and Trust and Add trusts the repository - and with it the worktree and every other of it (WORKTREE.md)', async () => {
		// /wt/web-fix is a worktree of /code/web, which is not trusted; /tmp/a is a folder of its own
		const window = trustedWindow('Trust and Add');
		const { instantiationService, steps, asked, fileService } = services(window);
		const files: Record<string, string> = {
			'/code/web/.git/HEAD': 'ref: refs/heads/main',
			'/code/web/.git/worktrees/web-fix/commondir': '../..',
			'/code/web/.git/worktrees/web-fix/gitdir': '/wt/web-fix/.git',
			'/wt/web-fix/.git': 'gitdir: /code/web/.git/worktrees/web-fix',
		};
		for (const [path, content] of Object.entries(files)) {
			await fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
		}

		const admission = await instantiationService.createInstance(WorkspaceBarTrustGate).admit([URI.file('/wt/web-fix'), URI.file('/tmp/a')]);

		assert.deepStrictEqual({ here: admission?.here.map(uri => uri.path), steps, listed: asked[0].details[0] }, {
			here: ['/wt/web-fix', '/tmp/a'],
			steps: ['ask: Do you trust the authors of the files in these 2 folders? [Trust and Add]', 'trust /code/web /tmp/a true'],
			listed: '`/code/web`  \n`/tmp/a`',
		});
	});

});
