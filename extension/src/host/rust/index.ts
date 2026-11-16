/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A window on the Rust engine (ARCHITECTURE-1.1): an `ide` client of Facade core. Core runs the agents, their terminals, messages
// and tools; this window shows them with the same panel, cards, tabs and pickers as the old engine, and keeps only its own view:
// Pins, order, filters and where tabs are.

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { disposeAll } from '../../base/lifecycle';
import { WINDOW_ALLOCATE_COMMAND, isAllocation } from '../../base/windowNetwork';
import { WINDOW_TERMINALS_COMMAND, type WindowIdentity } from '../../base/windowIdentity';
import type { OwnerClaim } from '../../base/ownership';
import type { CliInfo, DaemonLogResult, NumbersGiven, TerminalColors, WindowDescription, WindowInfo, WindowsChange } from '../../base/coreProtocol';
import { VendorHistory } from '../../clis/history';
import type { LogPort, TabPlace, WorkspaceFolderInfo } from '../../core/ports';
import { ConversationFile } from '../../record/conversations';
import { environmentFloor } from '../../record/windowRegistry';
import { COMMANDS } from '../../ui/catalog';
import { registerUi } from '../../ui/commands/index';
import { registerWorktreeCommands } from '../../ui/commands/worktree';
import { HostClis } from '../clis';
import { WindowContact } from '../contact';
import { WindowColours } from '../execution/terminalColours';
import { FacadeSettings } from '../facadeSettings';
import { WorkspaceLaunchHistory } from '../history';
import { WindowHuman } from '../human';
import { WorkspacePins } from '../pins';
import type { KeptWorkspaceState } from '../workspaceState';
import { namesOf } from '../settings';
import { watchSettingsFile } from '../showLaunch';
import { windowAddress } from '../windowNetwork';
import { RustAgents } from './agents';
import { connectDaemon } from './connection';
import { facadeInTerminals, startEnvironment } from './environment';
import { RustClis, RustLocations, RustWorktrees } from './ports';
import { DaemonTerminals } from './terminals';
import { DaemonError, FACADE_PROGRAM, type DaemonLink } from './types';

/** Show Agents Log on the Rust engine: the last lines of core's log, as `daemon.log` gives them. */
function registerDaemonLog(link: DaemonLink): vscode.Disposable {
	const scheme = 'facade-agents-log';
	const uri = vscode.Uri.from({ scheme, path: '/Agents Log' });
	const changed = new vscode.EventEmitter<vscode.Uri>();
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(scheme, {
			onDidChange: changed.event,
			provideTextDocumentContent: async () => {
				const read = await link.call<DaemonLogResult>('daemon.log', { lines: 200 });
				return read.lines.length ? `${read.lines.join('\n')}\n` : `${vscode.l10n.t("No agent events yet")}\n`;
			}
		}),
		vscode.commands.registerCommand(COMMANDS.showAgentsLog, async () => {
			changed.fire(uri);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		})
	);
}

/** Where the window keeps each agent's tab place, by agent ID. */
const TAB_PLACES = 'facade.tabPlaces';

/** What the composition root has made before the engine is chosen, shared by both engines. */
export interface RustDeps {
	/** The Facade home (`FACADE_HOME`, else `~/.facade`): core's, whose `facade.json` is the settings file (CONFIGURATION-1.1). */
	readonly root: string;
	/** The extension's own folder in it, `<root>/extension`: Resume's conversation records and the earlier numbers. */
	readonly home: string;
	readonly identity: WindowIdentity;
	/**
	 * The window's workspace state, kept beside its workspace's record so that Pins, order and choices follow a folder window that
	 * becomes a workspace, and the key core keeps its agents under across reloads (ARCHITECTURE-2.2, 3.1).
	 */
	readonly keep: (log: LogPort) => { readonly state: KeptWorkspaceState; readonly key: string; readonly claim: OwnerClaim; readonly handedOver: boolean };
	/** Opens the editor's Settings at Facade Code's section (CONFIGURATION-1.2). */
	readonly openSettings: () => Promise<void>;
	/** The command that opens Facade's settings file, made first where there is none (CONFIGURATION-1.2). */
	readonly openSettingsFile: (settings: FacadeSettings) => vscode.Disposable;
}

/** A colour as an OSC answer writes it, `rrrr/gggg/bbbb`, as the protocol takes it, `#rrggbb`. */
function hexOf(rgb: string | undefined): string | undefined {
	const parts = rgb?.split('/');
	return parts?.length === 3 && parts.every(part => /^[0-9a-f]{2,4}$/i.test(part)) ? `#${parts.map(part => part.slice(0, 2).toLowerCase()).join('')}` : undefined;
}

function colorsOf(colours: WindowColours): TerminalColors {
	const current = colours.current();
	const foreground = hexOf(current.foreground);
	const background = hexOf(current.background);
	const cursor = hexOf(current.cursor);
	return { ...foreground ? { foreground } : {}, ...background ? { background } : {}, ...cursor ? { cursor } : {} };
}

function foldersOf(): readonly WorkspaceFolderInfo[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({ index: folder.index, name: folder.name, uri: folder.uri.toString(), path: folder.uri.fsPath }));
}

/**
 * The highest numbers this computer's windows gave before, which core numbers on from (RULES-2.2): one of each taken from the window
 * component's counter - local or remote, it reaches this computer's - past this environment's own earlier counter.
 */
async function numbersGiven(home: string, session: string, log: (line: string) => void): Promise<NumbersGiven> {
	const given = async (kind: 'agent' | 'message'): Promise<number> => {
		const floor = environmentFloor(home, kind);
		try {
			const allocation = await vscode.commands.executeCommand<unknown>(WINDOW_ALLOCATE_COMMAND, session, kind, 1, floor);
			if (isAllocation(allocation)) {
				return Math.min(allocation.first, Number.MAX_SAFE_INTEGER);
			}
		} catch (err) {
			log(`Could not read this computer's ${kind} numbers: ${messageOf(err)}`);
		}
		return floor;
	};
	return { agent: await given('agent'), message: await given('message') };
}

/** Why core refused, in the person's language, then core's own words, which name what it refused (UX-2.4). */
function describeDaemonError(err: DaemonError): string {
	const said: Partial<Record<DaemonError['reason'], string>> = {
		configuration_invalid: vscode.l10n.t("Facade's settings file has a problem"),
		not_found: vscode.l10n.t('Facade could not find it'),
		unavailable: vscode.l10n.t('Facade cannot do this right now'),
		unsupported: vscode.l10n.t('This CLI cannot do this'),
		worktree_failed: vscode.l10n.t('Could not create the worktree'),
		ended: vscode.l10n.t('The agent has ended'),
		capacity_exceeded: vscode.l10n.t('Too much input at once'),
		upgrading: vscode.l10n.t('Facade is updating; try again in a moment'),
		refused: vscode.l10n.t('Facade does not allow this'),
		internal: vscode.l10n.t('Something went wrong in Facade')
	};
	const sentence = said[err.reason];
	return sentence ? `${sentence}: ${err.message}` : err.message;
}

/**
 * Starts this window on the Rust engine: takes its workspace's record and state and its terminals from the window component, then
 * connects to core before anything of the panel is registered, so that a core that cannot start leaves only those behind and the
 * caller can fall back to the old engine. Returns what deactivation runs: the window disconnects, and its agents go on in core.
 */
export async function activateRust(context: vscode.ExtensionContext, deps: RustDeps): Promise<() => Promise<void>> {
	const { root, home, identity } = deps;
	const output = vscode.window.createOutputChannel('Facade Code', { log: true });
	const log: LogPort = { event: text => output.info(text) };
	const kept = deps.keep(log);
	// The window component takes this activation's terminals as the window's, retiring those an earlier one left (ARCHITECTURE-2.2)
	const terminalOwner = { session: identity.session, claim: kept.claim };
	if (await vscode.commands.executeCommand(WINDOW_TERMINALS_COMMAND, { ...terminalOwner, kind: 'activate', handedOver: kept.handedOver }) !== true) {
		output.dispose();
		throw new Error(vscode.l10n.t('Could not restore agents for this window. Reload the window to try again.'));
	}
	const colours = new WindowColours();
	const label = (): string => vscode.workspace.name ?? vscode.l10n.t('Window');
	const description = (): WindowDescription => {
		const prefix = vscode.workspace.getConfiguration('git').get<string>('branchPrefix');
		const folders = foldersOf().map(folder => folder.path);
		return {
			id: windowAddress(identity.token),
			label: label(),
			environment: identity.remote ?? 'local',
			...folders.length ? { workspace: kept.key } : {},
			...folders.length ? { folders } : {},
			...prefix ? { branch_prefix: prefix } : {},
			colors: colorsOf(colours),
			// The environment its first folder's terminals have, which core finds each CLI's program in
			env: startEnvironment(vscode.workspace.workspaceFolders?.[0] && { uri: vscode.workspace.workspaceFolders[0].uri.toString() }, root)
		};
	};
	let link: DaemonLink;
	try {
		link = await connectDaemon({
			home: root,
			program: path.join(context.extensionPath, FACADE_PROGRAM),
			build: String(context.extension.packageJSON.version),
			window: description(),
			numbersGiven: await numbersGiven(home, identity.session, line => log.event(line)),
			log: line => log.event(line)
		});
	} catch (err) {
		colours.dispose();
		output.dispose();
		throw err;
	}
	// The window's terminals run this home's `facade` (spec: VS Code's terminals); FACADE_HOME there stays useFacadeHome's
	facadeInTerminals(context.environmentVariableCollection, root);
	const update = (): void => { void link.update(description()).catch(err => log.event(`Could not describe this window to Facade again: ${messageOf(err)}`)); };

	// This window as core lists it: its locations and the CLIs a start can run here (root freeze 2.3)
	let windowInfo: WindowInfo | undefined;
	const windowChanged = new vscode.EventEmitter<void>();
	const windows = link.watch<readonly WindowInfo[], WindowsChange>('windows', {}, {
		snapshot: list => { windowInfo = list.find(each => each.window_id === link.windowId); windowChanged.fire(); },
		change: change => {
			if (change.kind === 'updated' && change.window.window_id === link.windowId) {
				windowInfo = change.window;
				windowChanged.fire();
			} else if (change.kind === 'removed' && change.window_id === link.windowId) {
				windowInfo = undefined;
				windowChanged.fire();
			}
		}
	});

	const settings = new FacadeSettings({ log: line => log.event(line) });
	const hostClis = new HostClis({ settings, log: line => log.event(line), home, version: String(context.extension.packageJSON.version) });
	const locations = new RustLocations(() => windowInfo, windowChanged.event, foldersOf, identity.remote, () => link.update(description()));
	const clis = new RustClis(() => windowInfo, () => hostClis.icons());
	const worktrees = new RustWorktrees(link, locations, update);
	const terminals = new DaemonTerminals(link, { media: vscode.Uri.joinPath(context.extensionUri, 'media'), icon: cli => hostClis.icons()(cli), log: line => log.event(line), colours, terminalOwner: { ...terminalOwner, remote: identity.remote !== undefined } });
	const conversations = new ConversationFile(home);
	// The CLIs' own conversation stores where they run, as on the old engine (LIFECYCLE-3.2, CLIS-2.4)
	const vendorHistory = new VendorHistory({
		knownCwd: key => conversations.get(key)?.cwd,
		arguments: () => hostClis.storeArguments(),
		builtIns: () => hostClis.storeBuiltIns(),
		environment: cwd => { const location = locations.conversationLocation?.(cwd); return location ? hostClis.storeEnvironments(location) : {}; },
		associated: (environment, store, sessionId) => conversations.associated(environment, store, sessionId),
		unavailable: (cli, cwd, store) => { const location = locations.conversationLocation?.(cwd); return location ? hostClis.resumeProblem(cli, location, store) : 'The original working directory is unavailable.'; }
	});
	const human = new WindowHuman(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const contact = new WindowContact(run => Promise.resolve(vscode.commands.executeCommand('facade.revealAgent', { run_id: run })));
	const history = new WorkspaceLaunchHistory(kept.state, log);
	const agents = new RustAgents({
		link,
		terminals,
		locations,
		clis: (): readonly CliInfo[] => windowInfo?.clis ?? [],
		environment: location => startEnvironment(location, root),
		pins: new WorkspacePins(kept.state, log),
		conversations,
		titles: vendorHistory,
		history,
		human,
		contact,
		describe: describeDaemonError,
		names: namesOf(settings),
		// Where each agent's tab is, by its ID, for a reload to put it back (LIFECYCLE-3.5)
		places: {
			get: agent => kept.state.get<Record<string, TabPlace>>(TAB_PLACES)?.[agent],
			set: (agent, place) => {
				const places = { ...kept.state.get<Record<string, TabPlace>>(TAB_PLACES) ?? {} };
				if (place === undefined) { delete places[agent]; } else { places[agent] = place; }
				void Promise.resolve(kept.state.update(TAB_PLACES, places)).catch(err => log.event(`Could not keep where the agents' tabs are: ${messageOf(err)}`));
			}
		},
		log,
		newRunId: () => `start-${crypto.randomBytes(16).toString('hex')}`
	});
	// A reload's or a reopening's Pins start again once this window's agents are known (LIFECYCLE-3.4, 3.5); then the tabs an
	// earlier activation left are retired, also where no Pin opened one
	void agents.restorePins().catch(err => log.event(`Could not restore pinned agents: ${messageOf(err)}`))
		.then(() => terminals.pinnedSequenceOver()).catch(err => log.event(`Could not retire an earlier activation's tabs: ${messageOf(err)}`));
	const settingsChanged = new vscode.EventEmitter<void>();
	const disposables: vscode.Disposable[] = [
		output,
		colours,
		windowChanged,
		settingsChanged,
		human,
		contact,
		colours.onDidChange(update),
		vscode.workspace.onDidChangeWorkspaceFolders(update),
		// Core reads Git only when told: a branch switched or a worktree made outside the editor shows once the person is back here,
		// and the pickers ask again before they list locations
		vscode.window.onDidChangeWindowState(state => { if (state.focused) { update(); } }),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('git.branchPrefix') || event.affectsConfiguration('terminal.integrated')) { update(); }
		}),
		...watchSettingsFile(settings.file, () => { update(); settingsChanged.fire(); }),
		...registerUi({
			agents,
			openSettings: deps.openSettings,
			names: namesOf(settings),
			icons: () => hostClis.icons(),
			settingsChanged: settingsChanged.event,
			savedName: key => conversations.get(key)?.name,
			conversations: vendorHistory,
			readsTitles: cli => vendorHistory.readsTitles(cli),
			locations,
			clis,
			history,
			execution: terminals,
			worktrees,
			workspaceState: kept.state,
			extensionUri: context.extensionUri,
			log,
			notifyError: (text, options) => human.error(text, options),
			ready: agents.ready,
			motion: reduced => terminals.systemMotion(reduced),
			...(identity.remote ? { remote: identity.remote } : {})
		}),
		...registerWorktreeCommands({ locations, worktrees, agents, notifyError: (text, options) => human.error(text, options), log }),
		deps.openSettingsFile(settings),
		// The agents log on the Rust engine is core's own, read through the protocol: every agent of this home, and who sent whom a message
		registerDaemonLog(link)
	];
	context.subscriptions.push(...disposables);
	return async () => {
		// Its state's changes waiting to be written together are written now, while this activation may own them
		kept.state.flush();
		agents.dispose();
		windows.dispose();
		locations.dispose();
		disposeAll(disposables, err => log.event(`Could not dispose part of the window: ${messageOf(err)}`));
		link.dispose();
	};
}
