/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { DaemonTopics } from '../../base/coreProtocol';
import { messageOf } from '../../base/errors';
import { disposeAll } from '../../base/lifecycle';
import type { LogPort, WorkspaceFolderInfo } from '../../core/ports';
import { FACADE_HOME_VARIABLE } from '../../record/paths';
import { COMMANDS } from '../../ui/catalog';
import { registerOrchestratorUi, type OrchestratorUiDeps } from '../../ui/commands/index';
import { WindowColours } from '../execution/terminalColours';
import { WindowHuman } from '../human';
import { facadeInTerminals, startEnvironment } from '../rust/environment';
import { rustSettings } from '../rust/settings';
import { FACADE_PROGRAM } from '../rust/types';
import { optionalTerminalOwner } from '../windowComponent';
import { agentKey } from './agentFacts';
import { OrchestratorAgents } from './agents';
import { OrchestratorLocations } from './catalog';
import { connectOrchestrator } from './connection';
import { OrchestratorTerminals } from './terminals';
import { DaemonError, type OrchestratorLink } from './types';
import { openRustWorkspace } from './workspace';

declare const FACADE_TEST_MODE: boolean;

type MachineInfo = DaemonTopics['machines']['snapshot'][number];

interface OrchestratorDeps {
	readonly root: string;
	readonly home: string;
	readonly legacyHome?: string;
}

class HostSettingsError extends Error {}

function workspaceFolders(): readonly WorkspaceFolderInfo[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
		index: folder.index,
		name: folder.name,
		uri: folder.uri.toString(),
		path: folder.uri.fsPath
	}));
}

function panelPreferences(state: vscode.Memento): OrchestratorUiDeps['workspaceState'] {
	return {
		get<T>(key: string): T | undefined { return state.get<T>(`facade.orchestrator.${key}`); },
		update: (key, value) => state.update(`facade.orchestrator.${key}`, value)
	};
}

function registerDaemonLog(link: OrchestratorLink): vscode.Disposable {
	const scheme = 'facade-agents-log';
	const uri = vscode.Uri.from({ scheme, path: '/Agents Log' });
	const changed = new vscode.EventEmitter<vscode.Uri>();
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(scheme, {
			onDidChange: changed.event,
			provideTextDocumentContent: async () => {
				const { lines } = await link.call('daemon.log', { lines: 200 });
				return lines.length ? `${lines.join('\n')}\n` : `${vscode.l10n.t('No agent events yet')}\n`;
			}
		}),
		vscode.commands.registerCommand(COMMANDS.showAgentsLog, async () => {
			changed.fire(uri);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		})
	);
}

/** The extension host connects to its own Orchestrator, including in Remote SSH windows (RULES-6.7). */
export async function activateOrchestrator(context: vscode.ExtensionContext, deps: OrchestratorDeps): Promise<() => Promise<void>> {
	const output = vscode.window.createOutputChannel('Facade Code', { log: true });
	const log: LogPort = { event: text => output.info(text) };
	const disposables: vscode.Disposable[] = [output];
	let stopAgents: (() => Promise<unknown> | undefined) | undefined;
	let step = vscode.l10n.t('connect to the Orchestrator');
	try {
		const link = await connectOrchestrator({
			home: deps.root,
			program: path.join(context.extensionPath, FACADE_PROGRAM),
			build: String(context.extension.packageJSON.version),
			log: log.event
		});
		disposables.push(link);
		step = vscode.l10n.t('open the workspace state');
		const workspace = openRustWorkspace(context, {
			home: deps.home,
			...(deps.legacyHome ? { legacyHome: deps.legacyHome } : {}),
			log
		});
		disposables.push(workspace);
		step = vscode.l10n.t('set up the terminals');
		const terminalOwner = await optionalTerminalOwner(context, deps.home, log);
		const colours = new WindowColours();
		disposables.push(colours);
		const terminals = new OrchestratorTerminals(link, {
			media: vscode.Uri.joinPath(context.extensionUri, 'media'),
			icon: cli => cli,
			log: log.event,
			colours,
			viewer: vscode.workspace.name ?? vscode.env.appName,
			...(terminalOwner ? { terminalOwner } : {})
		});
		disposables.push(terminals);
		step = vscode.l10n.t('set up the Panel');
		const locations = new OrchestratorLocations({
			folders: workspaceFolders,
			onDidChangeFolders: listener => vscode.workspace.onDidChangeWorkspaceFolders(() => listener(undefined)),
			list: args => link.call('location.list', args),
			log
		});
		disposables.push(locations);

		const machines = new Map<string, MachineInfo>();
		const machineNames = new vscode.EventEmitter<void>();
		disposables.push(machineNames, link.watch('machines', {}, {
			snapshot: rows => {
				machines.clear();
				for (const row of rows) { machines.set(row.machine_id, row); }
				machineNames.fire();
			},
			change: change => {
				if (change.kind === 'updated') {
					machines.set(change.machine.machine_id, change.machine);
				} else if (change.kind === 'removed') {
					machines.delete(change.machine_id);
				}
				machineNames.fire();
			}
		}));
		const environmentAt = (folder: string | undefined) =>
			startEnvironment(folder ? { uri: vscode.Uri.file(folder).toString() } : undefined, deps.root);
		const withSettingsError = async <T>(local: boolean, call: () => Promise<T>): Promise<T> => {
			try {
				return await call();
			} catch (error) {
				if (local && error instanceof DaemonError && error.reason === 'configuration_invalid') {
					throw new HostSettingsError(error.message, { cause: error });
				}
				throw error;
			}
		};
		const human: WindowHuman = new WindowHuman(run => agents.open(run));
		const reportError: WindowHuman['error'] = (text, options) => {
			if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE) { console.error(text); }
			human.error(text, options);
		};
		const notifyError = (error: unknown): void => {
			reportError(messageOf(error), { settingsFile: error instanceof HostSettingsError });
		};
		const agents = new OrchestratorAgents({
			link, terminals, workspace, locations,
			onDidChangeMachineNames: machineNames.event,
			machineName: machineId => machines.get(machineId)?.name,
			environment: environmentAt,
			notifyError, log
		});
		disposables.push(human, agents);
		stopAgents = () => {
			agents.dispose();
			return agents.pendingPinRecovery();
		};
		void locations.refresh().catch(notifyError);
		const ready = agents.loadWorkspace();
		void ready.then(async imported => {
			// Capture the registered predecessor keys before Pin recovery can replace an expired Agent.
			const { members, pins } = workspace.snapshot();
			const knownRuns = members.flatMap(reference => [
				agentKey(reference), `#${reference.agent_id}@id:${reference.machine_id.replaceAll('-', '')}`
			]);
			// A pending legacy roster can already have local Pins available for recovery.
			if (imported || pins.length) { await agents.restorePins(); }
			await terminals.pinnedSequenceOver(knownRuns);
		}).catch(notifyError);
		const settings = rustSettings({ status: () => link.call('daemon.status', {}), log });
		disposables.push(...registerOrchestratorUi({
			agents, locations, ready, log,
			pickers: {
				hostMachineId: () => link.machineId,
				machines: () => [...machines.values()],
				listAgents: () => link.call('agent.list', {}),
				listLocations: args => link.call('location.list', args),
				listClis: args => {
					const local = args.scope?.kind !== 'machine';
					return withSettingsError(local, () => link.call('cli.list', { ...args, env: local ? environmentAt(args.folder) : undefined }));
				},
				listResumes: args => link.call('agent.resume_list', args),
				start: args => withSettingsError(args.scope?.kind !== 'machine', () => agents.start(args)),
				open: entry => agents.goTo(entry),
				resume: candidate => withSettingsError(candidate.machine_id === link.machineId, () => agents.resume(candidate)),
				notifyError,
				icons: cli => cli
			},
			onDidActivate: terminals.onDidActivate,
			openSettings: () => settings.open().catch(notifyError),
			extensionUri: context.extensionUri,
			workspaceState: panelPreferences(context.workspaceState),
			notifyError: reportError,
			motion: reduced => terminals.systemMotion(reduced)
		}), settings.register(), registerDaemonLog(link));

		const environment = context.environmentVariableCollection;
		environment.replace(FACADE_HOME_VARIABLE, deps.root);
		facadeInTerminals(environment, deps.root);
	} catch (error) {
		disposeAll(disposables.reverse(), failure => log.event(messageOf(failure)));
		throw new Error(vscode.l10n.t('Could not {0}. {1}', step, messageOf(error)), { cause: error });
	}
	return async () => {
		const recovery = stopAgents?.();
		if (recovery) {
			await recovery.catch(error => log.event(messageOf(error)));
		}
		disposeAll(disposables.reverse(), error => log.event(messageOf(error)));
	};
}
