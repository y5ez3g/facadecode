/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IShellLaunchConfig, TerminalIcon, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { glyphInFolderColor, IFolderCustomization, IWorkspaceBarCustomizationService, worktreeIcon } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { agentPicks, IAgentPlace, IPlaceStep, placeOfFolder } from '../../browser/terminalLauncherQuickPick.js';
import { agentIcon } from '../../common/terminalLaunchers.js';

/**
 * An agent's terminal, as much of one as the picker reads: when it was made, the title its CLI gave it - none
 * yet where empty - its agent's name, where it is, and its tab's glyph. Its tab's title is made as an agent's is:
 * the CLI's title, then the agent's name.
 */
class TestAgent extends mock<ITerminalInstance>() {

	override readonly shellLaunchConfig: IShellLaunchConfig;
	override readonly sequence: string | undefined;
	override readonly title: string;

	constructor(override readonly instanceId: number, cliTitle: string, name: string, override readonly target = TerminalLocation.Editor, override readonly icon?: TerminalIcon) {
		super();
		this.shellLaunchConfig = { name };
		this.sequence = cliTitle || undefined;
		this.title = cliTitle ? `${cliTitle} - ${name}` : name;
	}
}

suite('Agent picker - every agent open, in one list', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const facade: IPlaceStep = { glyph: Codicon.rocket, color: 'red', name: 'FacadeCode' };
	const feature: IPlaceStep = { glyph: worktreeIcon, color: 'blue', name: 'feature-16' };

	test('in the order of the rows of the bar, on one row in the order they were started, each read as the way to it', () => {
		const cart = new TestAgent(1, 'Refactoring the cart', 'Claude Code');
		const fixing = new TestAgent(2, 'Fixing drag and drop', 'Claude Code');
		const codex = new TestAgent(3, 'Codex', 'Codex');
		const starting = new TestAgent(4, '', 'Antigravity');
		const panel = new TestAgent(5, '\u2733 Claude Code', 'Claude Code', TerminalLocation.Panel);
		const tests = new TestAgent(6, 'Writing tests', 'Codex');

		// The bar's rows: FacadeCode, its worktree feature-16, then My shop; the panel is on none
		const places = new Map<ITerminalInstance, IAgentPlace>([
			[codex, { steps: [facade], row: 0 }],
			[starting, { steps: [facade], row: 0 }],
			[fixing, { steps: [facade, feature], row: 1 }],
			[tests, { steps: [facade, feature], row: 1 }],
			[cart, { steps: [{ glyph: Codicon.folder, name: 'My shop' }], row: 2 }],
			[panel, { steps: [{ glyph: Codicon.layoutPanel, name: 'Panel' }], row: 3 }]
		]);

		const picks = agentPicks([cart, panel, fixing, starting, codex, tests], agent => places.get(agent)!);

		// Every row says which agent it is, once: after its CLI's title, or alone where its CLI has given none (N-22)
		assert.deepStrictEqual(picks.map(pick => pick.label), [
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Codex \u00b7 Codex',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Antigravity',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree~folderblue) feature-16 $(chevron-right) $(robot) Fixing drag and drop \u00b7 Claude Code',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree~folderblue) feature-16 $(chevron-right) $(robot) Writing tests \u00b7 Codex',
			'$(folder) My shop $(chevron-right) $(robot) Refactoring the cart \u00b7 Claude Code',
			'$(layout-panel) Panel $(chevron-right) $(robot) \u2733 Claude Code \u00b7 Claude Code',
		]);
	});

	test('a row reads out in words, and a name that looks like a glyph is drawn as the text it is', () => {
		const [pick] = agentPicks([new TestAgent(1, 'Fixing $(bug) reports', 'Claude Code')], () => ({ steps: [facade, { glyph: worktreeIcon, name: '$(star) ideas' }], row: 0 }));

		assert.deepStrictEqual({ label: pick.label, ariaLabel: pick.ariaLabel }, {
			label: '$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree) \\$(star) ideas $(chevron-right) $(robot) Fixing \\$(bug) reports \u00b7 Claude Code',
			ariaLabel: 'FacadeCode, $(star) ideas, Fixing $(bug) reports, Claude Code'
		});
	});

	test('a row carries the glyph its tab does: the agent\'s logo, or the robot', () => {
		const picks = agentPicks([
			new TestAgent(1, 'Refactoring the cart', 'Claude Code', TerminalLocation.Editor, agentIcon('claude')),
			new TestAgent(2, 'Writing tests', 'My Agent', TerminalLocation.Editor, agentIcon('my-agent --fast')),
			new TestAgent(3, 'Fixing drag and drop', 'Codex', TerminalLocation.Editor, { id: agentIcon('codex').id })	// rebuilt from a stored record
		], () => ({ steps: [facade], row: 0 }));

		assert.deepStrictEqual(picks.map(pick => pick.label), [
			'$(rocket~folderred) FacadeCode $(chevron-right) $(agent-claude) Refactoring the cart · Claude Code',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Writing tests · My Agent',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(agent-codex) Fixing drag and drop · Codex',
		]);
	});

	test('a folder is drawn as the bar draws it, and a worktree after its repository, whether or not it has joined the workspace', () => {
		const folder = (path: string, name: string): IWorkspaceFolder => new WorkspaceFolder({ uri: URI.file(path), name, index: 0 });
		const facadeFolder = folder('/code/FacadeCode', 'FacadeCode');
		const featureFolder = folder('/code/FacadeCode-feature-16', 'FacadeCode-feature-16');
		const shop = folder('/code/shop-app', 'shop-app');
		const orphan = folder('/code/api-fix', 'api-fix');

		// Two worktrees made for agents, not in the workspace until somebody goes there
		const clamp = URI.file('/code/FacadeCode-clamp');
		const cart = URI.file('/code/FacadeCode-cart');

		// What the bar draws: shop-app was named, given a glyph and coloured in Customize, a worktree goes by
		// its branch and api-fix's was coloured, the main checkout of its repository was customised
		// without being a folder of the workspace, and so was one of the agents' worktrees
		const customizations = new Map<string, IFolderCustomization>([
			['/code/shop-app', { name: 'My shop', icon: 'rocket', color: 'green' }],
			['/code/api', { name: 'API', icon: 'server' }],
			['/code/api-fix', { color: 'pink' }],
			['/code/FacadeCode-cart', { name: 'Cart fix', color: 'blue' }]
		]);
		const branches = new Map<string, string>([['/code/FacadeCode-feature-16', 'feature-16'], ['/code/api-fix', 'fix-login']]);
		const customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'> = {
			nameFor: candidate => customizations.get(candidate.uri.path)?.name ?? branches.get(candidate.uri.path) ?? candidate.name,
			get: uri => customizations.get(uri.path)
		};
		const repository = (main: URI, mainFolder: IWorkspaceFolder | undefined, worktree: IWorkspaceFolder): IWorkspaceBarRepository => ({
			kind: 'repository',
			main,
			folder: mainFolder,
			branch: 'main',
			members: mainFolder ? [mainFolder, worktree] : [worktree],
			worktrees: [{ uri: worktree.uri, branch: worktree.name, label: worktree.name, exists: true, folder: worktree }]
		});
		const withFeature = repository(facadeFolder.uri, facadeFolder, featureFolder);
		const facadeRepository: IWorkspaceBarRepository = {
			...withFeature,
			worktrees: [
				...withFeature.worktrees,
				{ uri: clamp, branch: 'clamp', label: 'clamp', exists: true, folder: undefined },
				{ uri: cart, branch: 'cart', label: 'cart', exists: true, folder: undefined }
			]
		};
		const placeOf = (uri: URI, candidate: IWorkspaceFolder | undefined, of: IWorkspaceBarRepository | undefined) =>
			placeOfFolder(uri, candidate, of, customizationService, extUriBiasedIgnorePathCase).map(step => `${glyphInFolderColor(step.glyph, step.color).id} ${step.name}`);

		assert.deepStrictEqual([
			placeOf(facadeFolder.uri, facadeFolder, facadeRepository),
			placeOf(featureFolder.uri, featureFolder, facadeRepository),
			placeOf(clamp, undefined, facadeRepository),
			placeOf(cart, undefined, facadeRepository),
			placeOf(shop.uri, shop, undefined),
			placeOf(orphan.uri, orphan, repository(URI.file('/code/api'), undefined, orphan)),
		], [
			['folder FacadeCode'],
			['folder FacadeCode', 'workspace-bar-worktree feature-16'],
			['folder FacadeCode', 'workspace-bar-worktree clamp'],
			['folder FacadeCode', 'workspace-bar-worktree~folderblue Cart fix'],
			['rocket~foldergreen My shop'],
			['server API', 'workspace-bar-worktree~folderpink fix-login'],
		]);
	});

	test('no agents, no rows', () => {
		assert.deepStrictEqual(agentPicks([], () => ({ steps: [], row: 0 })), []);
	});
});
