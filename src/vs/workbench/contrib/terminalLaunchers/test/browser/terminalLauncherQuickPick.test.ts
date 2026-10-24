/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IResourceEditorInputIdentifier } from '../../../../../platform/editor/common/editor.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IQuickInputButton, IQuickInputHideEvent, IQuickInputService, IQuickPick, IQuickPickDidAcceptEvent, IQuickPickItemButtonEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { IReconnectionProperties, IShellLaunchConfig, TerminalIcon, TerminalLocation, TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { glyphInFolderColor, IFolderCustomization, IWorkspaceBarCustomizationService, worktreeIcon } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IEditorIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { facadeRunProperties, IPreparingRun } from '../../../facadeCommands/common/facadeRun.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { ITerminalStatusList } from '../../../terminal/browser/terminalStatusList.js';
import { agentPicks, IAgentPick, IAgentPlace, IPlaceStep, placeOfFolder, TerminalLauncherQuickPick } from '../../browser/terminalLauncherQuickPick.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { agentIcon } from '../../common/terminalLaunchers.js';

/**
 * An agent's terminal, as much of one as the picker reads: when it was made, the title its CLI gave it - none
 * yet where empty - its agent's name, where it is, and its tab's glyph; `options`, its agent's number, and the
 * title its tab has where it is not made as an agent's is - the CLI's title, then the agent's name: renamed, say.
 * Something runs in it, and it says when it is closed.
 */
class TestAgent extends mock<ITerminalInstance>() {

	override readonly shellLaunchConfig: IShellLaunchConfig;
	override readonly sequence: string | undefined;
	override readonly title: string;
	override readonly resource: URI;
	override readonly reconnectionProperties: IReconnectionProperties | undefined;
	override readonly hasChildProcesses = true;
	override readonly onDisposed = Event.None;
	// What a terminal editor input listens to
	override readonly onDidFocus = Event.None;
	override readonly onDidBlur = Event.None;
	override readonly onExit = Event.None;
	override readonly onTitleChanged = Event.None;
	override readonly onIconChanged = Event.None;
	override readonly statusList = upcastPartial<ITerminalStatusList>({ onDidChangePrimaryStatus: Event.None });
	/** Called as it is closed. */
	whenDisposed: (() => void) | undefined;

	constructor(override readonly instanceId: number, cliTitle: string, name: string, override readonly target = TerminalLocation.Editor, override readonly icon?: TerminalIcon, options?: { readonly number?: number; readonly title?: string }) {
		super();
		this.shellLaunchConfig = { name };
		this.sequence = cliTitle || undefined;
		this.title = options?.title ?? (cliTitle ? `${cliTitle} - ${name}` : name);
		this.resource = URI.from({ scheme: 'vscode-terminal', path: `/${instanceId}` });
		this.reconnectionProperties = options?.number !== undefined ? facadeRunProperties({ workspace: 'w1', id: options.number }) : undefined;
	}

	override dispose(): void {
		this.whenDisposed?.();
	}

	override detachFromElement(): void { }

	override setParentContextKeyService(): void { }
}

/** The quick pick the picker is drawn in: its rows, a row accepted, and a row's close button pressed. */
class TestQuickPick extends mock<IQuickPick<IAgentPick>>() {

	private readonly _onDidAccept = new Emitter<IQuickPickDidAcceptEvent>();
	override readonly onDidAccept = this._onDidAccept.event;
	private readonly _onDidTriggerItemButton = new Emitter<IQuickPickItemButtonEvent<IAgentPick>>();
	override readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event;
	private readonly _onDidHide = new Emitter<IQuickInputHideEvent>();
	override readonly onDidHide = this._onDidHide.event;

	override items: readonly IAgentPick[] = [];
	override activeItems: readonly IAgentPick[] = [];
	override selectedItems: readonly IAgentPick[] = [];
	override placeholder: string | undefined;
	override sortByLabel = true;
	override ignoreFocusOut = false;

	override show(): void { }

	override hide(): void { }

	/** Accepts the row of `agent`, as the person choosing it: its terminal, or an agent with none yet. */
	choose(agent: ITerminalInstance | IPreparingRun): void {
		this.selectedItems = [this._rowOf(agent)];
		this._onDidAccept.fire({ inBackground: false });
	}

	/** Presses the close button of the row of `agent`: its terminal, or an agent with none yet. */
	close(agent: ITerminalInstance | IPreparingRun): void {
		const item = this._rowOf(agent);
		this._onDidTriggerItemButton.fire({ item, button: item.buttons![0] as IQuickInputButton });
	}

	private _rowOf(agent: ITerminalInstance | IPreparingRun): IAgentPick {
		return this.items.find(each => each.instance === agent || each.preparing === agent)!;
	}

	override dispose(): void {
		this._onDidAccept.dispose();
		this._onDidTriggerItemButton.dispose();
		this._onDidHide.dispose();
	}
}

suite('Agent picker - every agent open, in one list', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

		const picks = agentPicks([cart, panel, fixing, starting, codex, tests], [], agent => places.get(agent)!, () => ({ steps: [], row: 4 }));

		// Every row reads as its tab does, which says which agent it is, once (N-22)
		assert.deepStrictEqual(picks.map(pick => pick.label), [
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Codex \u00b7 Codex',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) Antigravity',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree~folderblue) feature-16 $(chevron-right) $(robot) Claude Code \u00b7 Fixing drag and drop',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree~folderblue) feature-16 $(chevron-right) $(robot) Codex \u00b7 Writing tests',
			'$(folder) My shop $(chevron-right) $(robot) Claude Code \u00b7 Refactoring the cart',
			'$(layout-panel) Panel $(chevron-right) $(robot) Claude Code \u00b7 \u2733 Claude Code',
		]);
	});

	test('a row reads out in words, and a name that looks like a glyph is drawn as the text it is', () => {
		const [pick] = agentPicks([new TestAgent(1, 'Fixing $(bug) reports', 'Claude Code')], [], () => ({ steps: [facade, { glyph: worktreeIcon, name: '$(star) ideas' }], row: 0 }), () => ({ steps: [], row: 1 }));

		assert.deepStrictEqual({ label: pick.label, ariaLabel: pick.ariaLabel }, {
			label: '$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree) \\$(star) ideas $(chevron-right) $(robot) Claude Code \u00b7 Fixing \\$(bug) reports',
			ariaLabel: 'FacadeCode, $(star) ideas, Claude Code, Fixing $(bug) reports'
		});
	});

	test('a row carries the glyph its tab does: the agent\'s logo, or the robot', () => {
		const picks = agentPicks([
			new TestAgent(1, 'Refactoring the cart', 'Claude Code', TerminalLocation.Editor, agentIcon('claude')),
			new TestAgent(2, 'Writing tests', 'My Agent', TerminalLocation.Editor, agentIcon('my-agent --fast')),
			new TestAgent(3, 'Fixing drag and drop', 'Codex', TerminalLocation.Editor, { id: agentIcon('codex').id })	// rebuilt from a stored record
		], [], () => ({ steps: [facade], row: 0 }), () => ({ steps: [], row: 1 }));

		assert.deepStrictEqual(picks.map(pick => pick.label), [
			'$(rocket~folderred) FacadeCode $(chevron-right) $(agent-claude) Claude Code \u00b7 Refactoring the cart',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(robot) My Agent \u00b7 Writing tests',
			'$(rocket~folderred) FacadeCode $(chevron-right) $(agent-codex) Codex \u00b7 Fixing drag and drop',
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

	test('an active agent with no terminal yet - its worktree being made, or set up - is a row too, read as the way to its worktree where it has one, then the agent and what it is doing, closable (L3; LA-06)', () => {
		const picks = agentPicks([], [
			{ id: 9, name: 'docs', phase: 'running_setup', folder: '/w/facade-wt/docs' },
			{ id: 7, name: 'lint', phase: 'creating_worktree' }
		], () => ({ steps: [], row: 2 }), run => run.folder ? { steps: [facade, { glyph: worktreeIcon, name: 'docs' }], row: 0 } : { steps: [], row: 1 });

		assert.deepStrictEqual(picks.map(pick => ({ id: pick.preparing?.id, label: pick.label, ariaLabel: pick.ariaLabel, buttons: pick.buttons?.length })), [
			{ id: 9, label: '$(rocket~folderred) FacadeCode $(chevron-right) $(workspace-bar-worktree) docs $(chevron-right) $(loading~spin) @docs #a9 \u00b7 setting up its worktree', ariaLabel: 'FacadeCode, docs, @docs #a9, setting up its worktree', buttons: 1 },
			{ id: 7, label: '$(loading~spin) @lint #a7 \u00b7 creating its worktree', ariaLabel: '@lint #a7, creating its worktree', buttons: 1 }
		]);
	});

	test('no agents, no rows', () => {
		assert.deepStrictEqual(agentPicks([], [], () => ({ steps: [], row: 0 }), () => ({ steps: [], row: 0 })), []);
	});

	/**
	 * Show Active Agents over `agents` - each on the row of the bar its folder in `folders` is, by `rows` - and the
	 * agents still `preparing` their worktrees; `tabs`, the agents with a tab in the editor area; `confirmed`, how a
	 * confirmation is answered. What going to one or closing one did is in `steps`, with whether the picker stayed
	 * open through it.
	 */
	function showActiveAgents(agents: readonly TestAgent[], preparing: readonly IPreparingRun[], folders: ReadonlyMap<TestAgent, URI>, rows: readonly URI[], tabs: readonly TestAgent[] = [], confirmed = true, remoteAuthority: string | undefined = undefined) {
		const steps: string[] = [];
		const quickPick = new TestQuickPick();
		const open = () => quickPick.ignoreFocusOut ? ', the picker kept open' : '';
		for (const agent of agents) {
			agent.whenDisposed = () => steps.push(`dispose ${agent.title}`);
		}
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IQuickInputService, { createQuickPick: (() => quickPick) as IQuickInputService['createQuickPick'] });
		instantiationService.stub(ITerminalLauncherService, {
			agentTerminals: agents,
			preparingAgents: preparing,
			onDidChangeAgentTerminals: Event.None,
			stopPreparing: async id => { steps.push(`stop #a${id}`); }
		});
		instantiationService.stub(ITerminalService, {
			onAnyInstanceTitleChange: Event.None,
			foregroundInstances: [],
			getInstanceFromResource: () => undefined,
			safeDisposeTerminal: async instance => { steps.push(`kill ${instance.title}${open()}`); }
		});
		instantiationService.stub(IFolderTerminalsService, { folderOf: agent => folders.get(agent as TestAgent) });
		instantiationService.stub(IWorkspaceBarService, {
			rowOrder: () => rows,
			repositoryFor: () => undefined,
			show: async folder => {
				steps.push(`go to ${folder.toString()}`);
				return { kind: 'shown' };
			}
		});
		instantiationService.stub(IWorkspaceBarCustomizationService, { onDidChange: Event.None, get: () => undefined });
		instantiationService.stub(IUriIdentityService, { extUri: extUriBiasedIgnorePathCase });
		instantiationService.stub(IEditorService, {
			activeEditor: undefined,
			findEditors: (target: URI | IResourceEditorInputIdentifier) => tabs.filter(tab => tab.resource.toString() === (URI.isUri(target) ? target : target.resource).toString()).map(tab => upcastPartial<IEditorIdentifier>({ editor: upcastPartial<EditorInput>({ resource: tab.resource, getName: () => tab.title }), groupId: 1 })),
			closeEditors: async (editors: readonly IEditorIdentifier[]) => { steps.push(`close the tab of ${editors.map(({ editor }) => editor.getName()).join(', ')}${open()}`); }
		});
		instantiationService.stub(IWorkspaceContextService, { onDidChangeWorkspaceFolders: Event.None, getWorkspace: () => upcastPartial<IWorkspace>({ folders: [] }) });
		instantiationService.stub(IActiveFolderService, { onDidChangeActiveFolder: Event.None });
		instantiationService.stub(IConfigurationService, new TestConfigurationService({ [TerminalSettingId.ConfirmOnKill]: 'always' }));
		instantiationService.stub(IDialogService, { confirm: async confirmation => { steps.push(`asked "${confirmation.message}" - "${confirmation.detail}"${open()}`); return { confirmed }; } });
		instantiationService.stub(IEditorGroupsService, { activeGroup: upcastPartial<IEditorGroup>({ id: 1 }) });
		// What a terminal editor input is made with
		instantiationService.stub(IThemeService, {});
		instantiationService.stub(ITerminalInstanceService, {});
		instantiationService.stub(ILifecycleService, { onWillShutdown: Event.None });
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(IWorkbenchEnvironmentService, { remoteAuthority });
		const picker = store.add(instantiationService.createInstance(TerminalLauncherQuickPick));
		picker.show();
		return { quickPick, steps };
	}

	test('a row says which agent it is, then its tab\'s own title - the one the person renamed it to included - without the agent its tab ends with: a long title the row cuts never takes the agent\'s name and number with it (L3; LA-09)', () => {
		const a = URI.file('/w/a');
		const renamed = new TestAgent(1, 'Fixing the API', '@claude #a3', TerminalLocation.Editor, undefined, { number: 3, title: 'api fix - @claude #a3' });
		const titledByItsCli = new TestAgent(2, 'Writing docs', '@codex #a4', TerminalLocation.Editor, undefined, { number: 4, title: 'Writing docs' });
		const untitled = new TestAgent(3, '', '@agy #a5', TerminalLocation.Editor, undefined, { number: 5 });
		const long = new TestAgent(4, 'Refactor the authentication middleware and update every integration test that depends on it', '@long-agent-name-for-truncation-checks-40 #a22', TerminalLocation.Editor, undefined, { number: 22 });
		const { quickPick } = showActiveAgents([renamed, titledByItsCli, untitled, long], [], new Map([[renamed, a], [titledByItsCli, a], [untitled, a], [long, a]]), [a]);

		assert.deepStrictEqual(quickPick.items.map(item => [item.label, item.ariaLabel]), [
			['$(folder) a $(chevron-right) $(robot) @claude #a3 \u00b7 api fix', 'a, @claude #a3, api fix'],
			['$(folder) a $(chevron-right) $(robot) @codex #a4 \u00b7 Writing docs', 'a, @codex #a4, Writing docs'],
			['$(folder) a $(chevron-right) $(robot) @agy #a5', 'a, @agy #a5'],
			['$(folder) a $(chevron-right) $(robot) @long-agent-name-for-truncation-checks-40 #a22 \u00b7 Refactor the authentication middleware and update every integration test that depends on it', 'a, @long-agent-name-for-truncation-checks-40 #a22, Refactor the authentication middleware and update every integration test that depends on it'],
		]);
	});

	test('an agent still preparing its worktree is listed among the others in the order of the bar\'s rows, and on one row in the order the agents were started, by their numbers - not after every agent\'s terminal (L3; LA-10)', () => {
		const a = URI.file('/w/a');
		const fix = URI.file('/w/a-fix');
		const b = URI.file('/w/b');
		const lead = new TestAgent(1, 'Planning', '@lead #a1', TerminalLocation.Editor, undefined, { number: 1 });
		const web = new TestAgent(2, 'Styling', '@web #a4', TerminalLocation.Editor, undefined, { number: 4 });
		// On no row: put away with no folder, after the last one
		const loose = new TestAgent(3, 'Reviewing', '@review #a6', TerminalLocation.Editor, undefined, { number: 6 });
		const { quickPick } = showActiveAgents([lead, web, loose], [
			{ id: 5, name: 'fix', phase: 'running_setup', folder: fix.fsPath },
			{ id: 2, name: 'lint', phase: 'creating_worktree' }
		], new Map([[lead, a], [web, b]]), [a, fix, b]);

		assert.deepStrictEqual(quickPick.items.map(item => item.instance?.title ?? `@${item.preparing?.name} #a${item.preparing?.id}`), [
			'Planning - @lead #a1',
			'@fix #a5',
			'Styling - @web #a4',
			'@lint #a2',
			'Reviewing - @review #a6',
		]);
	});

	test('an agent still preparing its worktree, chosen, goes to its worktree as a click on its row in the bar does - one whose worktree is not made yet, nowhere - and its close button stops it as the person does, by its number (L3; LA-06)', () => {
		const settingUp: IPreparingRun = { id: 5, name: 'fix', phase: 'running_setup', folder: '/w/a-fix' };
		const making: IPreparingRun = { id: 2, name: 'lint', phase: 'creating_worktree' };
		const { quickPick, steps } = showActiveAgents([], [settingUp, making], new Map(), []);
		quickPick.choose(settingUp);
		quickPick.choose(making);
		quickPick.close(making);
		quickPick.close(settingUp);

		assert.deepStrictEqual(steps, ['go to file:///w/a-fix', 'stop #a2', 'stop #a5']);
	});

	test('an agent still preparing on a remote is listed on its remote row, and chosen goes to its worktree\'s remote folder (REMOTE.md R7)', () => {
		const work = URI.parse('vscode-remote://ssh-remote+monster/home/person/work');
		const fix = URI.parse('vscode-remote://ssh-remote+monster/home/person/work-fix');
		const b = URI.parse('vscode-remote://ssh-remote+monster/home/person/b');
		const lead = new TestAgent(1, 'Planning', '@lead #a1', TerminalLocation.Editor, undefined, { number: 1 });
		const web = new TestAgent(2, 'Styling', '@web #a4', TerminalLocation.Editor, undefined, { number: 4 });
		const settingUp: IPreparingRun = { id: 5, name: 'fix', phase: 'running_setup', folder: '/home/person/work-fix' };
		const { quickPick, steps } = showActiveAgents([lead, web], [settingUp], new Map([[lead, work], [web, b]]), [work, fix, b], [], true, 'ssh-remote+monster');
		quickPick.choose(settingUp);

		assert.deepStrictEqual({
			items: quickPick.items.map(item => item.instance?.title ?? `@${item.preparing?.name} #a${item.preparing?.id}`),
			steps
		}, {
			items: ['Planning - @lead #a1', '@fix #a5', 'Styling - @web #a4'],
			steps: [`go to ${fix.toString()}`],
		});
	});

	test('closing an agent closes its terminal the way VS Code closes it where it is - its tab in the editor area through the editor service, one in the panel as Kill Terminal does, and one of the editor area whose tab was put away with its folder asked as closing its tab asks, by its own editor input, and ended only if confirmed - so that VS Code\'s own confirmation, by its setting and in its words, is the one asked; the picker stays open through it (L6; VC-07)', async () => {
		const inEditor = new TestAgent(1, 'Planning', '@lead #a1', TerminalLocation.Editor, undefined, { number: 1 });
		const inPanel = new TestAgent(2, 'Linting', '@lint #a2', TerminalLocation.Panel, undefined, { number: 2 });
		// Its tab put away with its folder, the window on another: Kill Terminal would end it unasked
		const putAway = new TestAgent(3, 'Writing docs', '@docs #a3', TerminalLocation.Editor, undefined, { number: 3 });
		const { quickPick, steps } = showActiveAgents([inEditor, inPanel, putAway], [], new Map(), [], [inEditor]);
		for (const agent of [inEditor, inPanel, putAway]) {
			quickPick.close(agent);
			await timeout(0);
		}
		// The person says no
		const kept = new TestAgent(4, 'Reviewing', '@review #a4', TerminalLocation.Editor, undefined, { number: 4 });
		const notConfirmed = showActiveAgents([kept], [], new Map(), [], [], false);
		notConfirmed.quickPick.close(kept);
		await timeout(0);

		const asked = 'asked "Do you want to terminate running processes?" - "Closing will terminate the running processes in this terminal.", the picker kept open';
		assert.deepStrictEqual({ steps, keptOpenAfter: quickPick.ignoreFocusOut, notConfirmed: notConfirmed.steps }, {
			steps: [
				'close the tab of Planning - @lead #a1, the picker kept open',
				'kill Linting - @lint #a2, the picker kept open',
				asked,
				'dispose Writing docs - @docs #a3',
			],
			keptOpenAfter: false,
			notConfirmed: [asked]
		});
	});
});
