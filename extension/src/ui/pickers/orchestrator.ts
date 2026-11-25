/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentRef, DaemonOperations } from '../../base/frameworkProtocol';
import type { RunId } from '../../core/ports';
import { cliDisplayName, cliIcon, plainText, reasonOf } from '../presentation';
import { newAgent, type LaunchPickerDeps, type LaunchStart } from './newAgent';
import { matchesCliSearch } from './search';
import { BACK, Flow, pickLoaded } from './stepping';

type AgentListResult = DaemonOperations['agent.list']['result'];
type AgentListEntry = AgentListResult['agents'][number];
type ResumeListArgs = DaemonOperations['agent.resume_list']['args'];
type ResumeListResult = DaemonOperations['agent.resume_list']['result'];
type ResumeCandidate = ResumeListResult['items'][number];
export interface FrameworkPickerDeps extends LaunchPickerDeps {
	readonly listAgents: () => Promise<AgentListResult>;
	readonly listResumes: (args: ResumeListArgs) => Promise<ResumeListResult>;
	readonly stop: (entry: AgentListEntry) => Promise<void>;
	readonly resume: (candidate: ResumeCandidate) => Promise<RunId>;
}

/** Orchestrator-backed commands use the same public candidates as Shell (RULES-6.2, 6.5). */
export function createFrameworkPickers(deps: FrameworkPickerDeps): {
	readonly newAgent: (startAt?: LaunchStart) => Promise<void>;
	readonly stopAgent: () => Promise<void>;
	readonly resumeAgent: () => Promise<void>;
} {
	const run = async (command: (flow: Flow) => Promise<void>) => {
		const flow = new Flow();
		try {
			await command(flow);
		} catch (error) {
			deps.notifyError(error);
		} finally {
			flow.close();
		}
	};
	return {
		newAgent: startAt => run(flow => newAgent(deps, flow, startAt)),
		stopAgent: () => run(flow => pickRunningAgent(deps, flow, {
			title: vscode.l10n.t("Stop Agent"),
			empty: vscode.l10n.t("No running agents to stop"),
			act: async entry => {
				try {
					await deps.stop(entry);
				} catch (error) {
					throw new Error(vscode.l10n.t("Could not stop {0}: {1}", entry.address, reasonOf(error)));
				}
			}
		})),
		resumeAgent: () => run(flow => resumeAgent(deps, flow))
	};
}

function rowText(...parts: readonly (string | undefined)[]): string {
	return plainText(parts.filter(Boolean).join(' · ').replace(/\r?\n/g, ' '));
}

function exactReferenceSearch(ref: AgentRef): string {
	const machine = ref.machine_id.replace(/-/gu, '');
	return `${ref.agent_id}@${ref.machine_id} #${ref.agent_id}@id:${machine}`;
}

function matchesAgentRow(row: vscode.QuickPickItem & { readonly cli: string; readonly searchText: string }, query: string): boolean {
	return matchesCliSearch(query, row.cli, cliDisplayName(row.cli), row, row.searchText);
}

/** Stop selects a running Managed Agent by its original Framework reference (LIFECYCLE-5.3). */
async function pickRunningAgent(deps: FrameworkPickerDeps, flow: Flow, action: {
	readonly title: string;
	readonly empty: string;
	readonly act: (entry: AgentListEntry) => Promise<void>;
}): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: action.title,
		placeholder: vscode.l10n.t("Search by name, CLI, title, location, or ID"),
		matchesHidden: matchesAgentRow,
		load: async () => {
			const { agents } = await deps.listAgents();
			const items = agents.filter(agent => agent.type === 'managed').map(agent => {
				const name = agent.name.trim();
				return {
					label: rowText(name || agent.address),
					description: rowText(name ? agent.address : undefined, agent.folder),
					iconPath: cliIcon(deps.media, deps.icons(agent.cli)),
					cli: agent.cli,
					searchText: [exactReferenceSearch(agent.reference), agent.title, agent.session_name].join(' '),
					agent
				};
			});
			return { items, placeholder: items.length ? undefined : action.empty };
		}
	});
	if (picked && picked !== BACK) {
		flow.close();
		await action.act(picked.item.agent);
	}
}

function resumeKey(candidate: ResumeCandidate): string {
	const ref = candidate.target.kind === 'agent' ? candidate.target.reference : undefined;
	return ref ? JSON.stringify([ref.machine_id, ref.agent_id]) : JSON.stringify([candidate.machine_id, candidate.cli, candidate.session]);
}

async function resumeAgent(deps: FrameworkPickerDeps, flow: Flow): Promise<void> {
	const picked = await pickLoaded(flow, deps, {
		title: vscode.l10n.t("Resume Agent"),
		placeholder: vscode.l10n.t("Search by name, CLI, title, location, or ID"),
		matchesHidden: matchesAgentRow,
		load: async () => {
			const folders = deps.locations.snapshot().folders;
			// With no workspace folder, the host resolves its default directory.
			const queries = folders.length ? folders.map(({ path }) => ({ folder: path })) : [{}];
			const results = await Promise.all(queries.map(query => deps.listResumes({ ...query, scope: { kind: 'local' }, folder_scope: 'cwd' })));
			const seen = new Set<string>();
			const timeOf = (candidate: ResumeCandidate) => candidate.at === undefined ? -Infinity : Date.parse(candidate.at);
			const candidates = results.flatMap(({ items, machines }) => items.map(candidate => ({
				candidate, selector: machines.find(machine => machine.machine_id === candidate.machine_id)?.selector
			})));
			const items = candidates.sort((a, b) => timeOf(b.candidate) - timeOf(a.candidate)).flatMap(({ candidate, selector }) => {
				const { target } = candidate;
				if (target.kind !== 'agent' && target.kind !== 'session') { return []; }
				const key = resumeKey(candidate);
				if (seen.has(key)) { return []; }
				seen.add(key);
				const name = candidate.name?.trim();
				const title = candidate.title?.trim();
				const reference = target.kind === 'agent'
					? `${target.reference.agent_id}@${selector ?? target.reference.machine_id.slice(0, 8)}`
					: `${target.cli}:${candidate.session_selector ?? target.session.slice(0, 8)}`;
				const exact = target.kind === 'agent' ? exactReferenceSearch(target.reference) : `${target.cli}:${target.session}`;
				return [{
					label: rowText(name || title || vscode.l10n.t("Untitled session")),
					description: rowText(name && title !== name ? title : undefined, candidate.folder, reference),
					iconPath: cliIcon(deps.media, deps.icons(candidate.cli)),
					cli: candidate.cli,
					searchText: [exact, candidate.session, candidate.session_name].join(' '),
					candidate
				}];
			});
			return { items, placeholder: items.length ? undefined : vscode.l10n.t("No agents or saved sessions to resume") };
		}
	});
	if (picked && picked !== BACK) {
		flow.close();
		deps.select(await deps.resume(picked.item.candidate));
	}
}
