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
import { IShellLaunchConfig, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { glyphInFolderColor, IFolderCustomization, IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { agentPicks, IAgentPlace, IPlaceStep, placeOfFolder, placeOfRow } from '../../browser/terminalLauncherQuickPick.js';

/** An agent's terminal, as much of one as the picker reads: when it was made, its title, its agent's name, and where it is. */
class TestAgent extends mock<ITerminalInstance>() {

	override readonly shellLaunchConfig: IShellLaunchConfig;

	constructor(override readonly instanceId: number, override readonly title: string, name: string, override readonly target = TerminalLocation.Editor) {
		super();
		this.shellLaunchConfig = { name };
	}
}

suite('Agent picker - every agent open, in one list', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const facade: IPlaceStep = { glyph: Codicon.rocket, color: 'red', name: 'FacadeCode' };
	const feature: IPlaceStep = { glyph: Codicon.circleSmallFilled, color: 'blue', name: 'feature-16' };

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

		// Every row says which agent it is, one whose tab says nothing else included
		assert.deepStrictEqual(picks.map(pick => pick.label), [
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Codex \u00b7 Codex',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Antigravity \u00b7 Antigravity',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(circle-small-filled~folderblue) feature-16 $(chevron-right) $(robot) Fixing drag and drop \u00b7 Claude Code',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(circle-small-filled~folderblue) feature-16 $(chevron-right) $(robot) Writing tests \u00b7 Codex',
			'$(folder) My shop $(chevron-right) $(robot) Refactoring the cart \u00b7 Claude Code',
			'$(layout-panel) Panel $(chevron-right) $(robot) \u2733 Claude Code \u00b7 Claude Code',
		]);
	});

	test('a row reads out in words, and a name that looks like a glyph is drawn as the text it is', () => {
		const [pick] = agentPicks([new TestAgent(1, 'Fixing $(bug) reports', 'Claude Code')], () => ({ steps: [facade, { glyph: Codicon.circleSmallFilled, name: '$(star) ideas' }], row: 0 }));

		assert.deepStrictEqual({ label: pick.label, ariaLabel: pick.ariaLabel }, {
			label: '$(rocket~folderred) FacadeCode $(chevron-right) $(circle-small-filled) \\$(star) ideas $(chevron-right) $(robot) Fixing \\$(bug) reports \u00b7 Claude Code',
			ariaLabel: 'FacadeCode, $(star) ideas, Fixing $(bug) reports, Claude Code'
		});
	});

	test('a folder is drawn as the bar draws it, and a worktree after its repository', () => {
		const folder = (path: string, name: string): IWorkspaceFolder => new WorkspaceFolder({ uri: URI.file(path), name, index: 0 });
		const facadeFolder = folder('/code/FacadeCode', 'FacadeCode');
		const featureFolder = folder('/code/FacadeCode-feature-16', 'FacadeCode-feature-16');
		const shop = folder('/code/shop-app', 'shop-app');
		const orphan = folder('/code/api-fix', 'api-fix');

		// What the bar draws: shop-app was named, given a glyph and coloured in Customize, a worktree goes by
		// its branch and api-fix's was coloured, and the main checkout of its repository was customised
		// without being a folder of the workspace
		const customizations = new Map<string, IFolderCustomization>([
			['/code/shop-app', { name: 'My shop', icon: 'rocket', color: 'green' }],
			['/code/api', { name: 'API', icon: 'server' }],
			['/code/api-fix', { color: 'pink' }]
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
		const facadeRepository = repository(facadeFolder.uri, facadeFolder, featureFolder);
		const placeOf = (candidate: IWorkspaceFolder, of: IWorkspaceBarRepository | undefined) =>
			placeOfFolder(candidate, of, customizationService, extUriBiasedIgnorePathCase).map(step => `${glyphInFolderColor(step.glyph, step.color).id} ${step.name}`);

		assert.deepStrictEqual([
			placeOf(facadeFolder, facadeRepository),
			placeOf(featureFolder, facadeRepository),
			placeOf(shop, undefined),
			placeOf(orphan, repository(URI.file('/code/api'), undefined, orphan)),
		], [
			['folder FacadeCode'],
			['folder FacadeCode', 'circle-small-filled feature-16'],
			['rocket~foldergreen My shop'],
			['server API', 'circle-small-filled~folderpink fix-login'],
		]);
	});

	test('a worktree with a row and no folder in the workspace is drawn after its repository, by the name it was given or else its branch', () => {
		const main = URI.file('/code/FacadeCode');
		const worktree = (path: string, branch: string) => ({ uri: URI.file(path), branch, label: branch, exists: true, folder: undefined });
		const repository: IWorkspaceBarRepository = {
			kind: 'repository',
			main,
			folder: new WorkspaceFolder({ uri: main, name: 'FacadeCode', index: 0 }),
			branch: 'main',
			members: [],
			worktrees: [worktree('/code/p1', 'p1'), worktree('/code/p1-clamp', 'p1-clamp')]
		};
		const customizations = new Map<string, IFolderCustomization>([['/code/p1-clamp', { name: 'Clamp', color: 'pink' }]]);
		const customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'> = {
			nameFor: candidate => candidate.name,
			get: uri => customizations.get(uri.path)
		};
		const placeOf = (uri: URI, of: IWorkspaceBarRepository | undefined) =>
			placeOfRow(uri, of, customizationService, extUriBiasedIgnorePathCase).map(step => `${glyphInFolderColor(step.glyph, step.color).id} ${step.name}`);

		assert.deepStrictEqual([
			placeOf(URI.file('/code/p1'), repository),
			placeOf(URI.file('/code/p1-clamp'), repository),
			placeOf(URI.file('/code/elsewhere'), undefined),
		], [
			['folder FacadeCode', 'circle-small-filled p1'],
			['folder FacadeCode', 'circle-small-filled~folderpink Clamp'],
			['folder elsewhere'],
		]);
	});

	test('no agents, no rows', () => {
		assert.deepStrictEqual(agentPicks([], () => ({ steps: [], row: 0 })), []);
	});
});
