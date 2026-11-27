/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { isSameFolder } from '../../base/files';
import type { AgentInfo, ResumeCandidateTarget } from '../../base/frameworkProtocol';
import { parseJsonc, type JsonNode } from '../../base/jsonc';
import { isFullyQualified } from '../../record/paths';
import { editorEnvironment } from '../editorEnvironment';
import type { LegacyResumeAttempt, LegacyResumeTarget, LegacySessionPin } from '../legacyPins';
import { DaemonError, type FrameworkLink } from './types';

interface LegacyRecovery {
	readonly link: FrameworkLink;
	readonly inspect: (reference: AgentInfo['reference']) => Promise<AgentInfo>;
	readonly resume: (machine: string, target: ResumeCandidateTarget, folder: string) => Promise<AgentInfo>;
	readonly restart: () => Promise<AgentInfo>;
	readonly begin: (target?: LegacyResumeTarget) => Promise<boolean>;
	readonly confirmedNoStart: () => Promise<void>;
}

// These replies refuse the requested operation before it can start. A disconnect, deadline or
// daemon error with an uncertain effect keeps the migration attempt fenced.
const LEGACY_RESUME_REFUSALS = new Set([
	'ambiguous_reference', 'configuration_invalid', 'invalid_argument', 'not_found',
	'protocol_incompatible', 'refused', 'session_not_found', 'unsupported', 'upgrading',
]);

// Entry IDs reserved by the published TypeScript implementation. Facade Code Framework binds each of
// these IDs to the same built-in and refuses settings that attempt to change its type.
const LEGACY_BUILT_INS = new Set(['agy', 'claude', 'codex', 'muse', 'opencode', 'pi']);

/** Recover a TypeScript Pin in its exact local environment (ARCHITECTURE-6.2, RULES-6.4). */
export async function recoverLegacyPin(pin: LegacySessionPin, recovery: LegacyRecovery): Promise<AgentInfo> {
	const { cli, sessionId: session } = pin.conversation;
	if (!isFullyQualified(pin.cwd) || pin.conversation.environment !== editorEnvironment()) {
		throw new Error(vscode.l10n.t("The working location {0} is not available in this window.", pin.cwd));
	}
	const { link, inspect, resume } = recovery;
	if (!session) {
		if (pin.conversation.builtIn !== undefined || LEGACY_BUILT_INS.has(cli)) { await verifyBuiltIn(pin, link); }
		return recovery.restart();
	}
	const builtIn = await verifyBuiltIn(pin, link);
	const alias = builtIn !== cli;
	const machine = link.machineId;
	const scope = { kind: 'local' } as const;
	const matches = (record: AgentInfo) => matchesLegacyPin(pin, machine, record);
	const { agents } = await link.call('agent.list', { scope });
	const existing = (await Promise.all(agents.filter(agent =>
		agent.reference.machine_id === machine && agent.cli === cli && isSameFolder(agent.folder, pin.cwd))
		.map(async agent => {
			const record = await inspect(agent.reference);
			if (agent.reference.agent_id !== record.reference.agent_id) { throw mismatched(session); }
			return record;
		}))).filter(record => matches(record) && record.process === 'running');
	if (existing.length > 1) { throw ambiguous(session); }
	if (existing.length === 1) {
		// The API cannot prove the historical type of an already running aliased entry.
		if (alias) { throw unverifiedCli(cli, builtIn); }
		return existing[0];
	}

	const { items } = await link.call('agent.resume_list', { scope, folder: pin.cwd, folder_scope: 'cwd' });
	const candidates = items.filter(item => item.machine_id === machine && item.cli === cli
		&& item.session === session && isSameFolder(item.folder, pin.cwd));
	if (candidates.length > 1) { throw ambiguous(session); }
	const target = candidates[0]?.target;
	if (!target) {
		throw new Error(vscode.l10n.t('The saved legacy session {0} is unavailable in {1}.', session, pin.cwd));
	}
	let previous: LegacyResumeTarget | undefined;
	if (target.kind === 'agent') {
		if (target.reference.machine_id !== machine) { throw mismatched(session); }
		const record = await inspect(target.reference);
		if (!matches(record) || record.reference.agent_id !== target.reference.agent_id) { throw mismatched(session); }
		if (alias) { throw unverifiedCli(cli, builtIn); }
		if (record.process === 'running') { return record; }
		if (record.process !== 'ended') { throw mismatched(session); }
		previous = { reference: record.reference, startedAt: record.started_at };
	} else if (target.machine_id !== machine || target.cli !== cli || target.session !== session || !isSameFolder(target.folder, pin.cwd)) {
		throw mismatched(session);
	}
	if (alias) { await verifyBuiltIn(pin, link); }
	if (!await recovery.begin(previous)) {
		throw new Error(vscode.l10n.t('Could not confirm the previous recovery of legacy session {0}.', session));
	}
	try {
		const record = await resume(machine, target, pin.cwd);
		if (!matches(record) || previous && record.reference.agent_id !== previous.reference.agent_id) {
			throw mismatched(session);
		}
		return record;
	} catch (error) {
		if (error instanceof DaemonError && LEGACY_RESUME_REFUSALS.has(error.reason)) {
			await recovery.confirmedNoStart();
		}
		throw error;
	}
}

/** Validate a durable shared result before adopting it into another workspace's roster. */
export function matchesLegacyPin(pin: LegacySessionPin, machine: string, record: AgentInfo): boolean {
	const { cli, sessionId } = pin.conversation;
	return record.type === 'managed' && !record.unreachable && record.reference.machine_id === machine
		&& pin.conversation.environment === editorEnvironment() && record.cli === cli
		&& (sessionId === undefined || record.session === sessionId) && isSameFolder(record.cwd, pin.cwd);
}

/** An unkeyed request can reconcile only the exact target whose Facade Code Framework run changed after dispatch. */
export function confirmsLegacyResume(pin: LegacySessionPin, machine: string, attempt: LegacyResumeAttempt, record: AgentInfo): boolean {
	const started = Date.parse(record.started_at);
	return matchesLegacyPin(pin, machine, record) && record.reference.agent_id === attempt.reference.agent_id
		&& record.reference.machine_id === attempt.reference.machine_id
		&& started >= attempt.requestedAt && started > Date.parse(attempt.startedAt)
		&& (record.process === 'running' || record.process === 'ended');
}

async function verifyBuiltIn(pin: LegacySessionPin, link: FrameworkLink): Promise<string> {
	const { cli, builtIn } = pin.conversation;
	if (LEGACY_BUILT_INS.has(cli)) {
		if (builtIn === undefined || builtIn === cli) { return cli; }
		throw unverifiedCli(cli, builtIn);
	}
	if (!builtIn || !LEGACY_BUILT_INS.has(builtIn)) { throw unverifiedCli(cli, builtIn); }
	const { settings_file: file } = await link.call('daemon.status', {});
	if (!isFullyQualified(file)) { throw unverifiedCli(cli, builtIn); }
	const settings = parseJsonc(await readFile(file, 'utf8'));
	const type = onlyMember(onlyMember(onlyMember(settings, 'clis'), cli), 'type');
	if (type?.kind !== 'scalar' || type.value !== builtIn) { throw unverifiedCli(cli, builtIn); }
	return builtIn;
}

function onlyMember(node: JsonNode | undefined, key: string): JsonNode | undefined {
	if (node?.kind !== 'object') { return undefined; }
	const matches = node.members.filter(member => member.key === key);
	return matches.length === 1 ? matches[0].value : undefined;
}

function unverifiedCli(cli: string, builtIn: string | undefined): Error {
	return new Error(vscode.l10n.t('Could not verify the saved CLI type {0} for legacy entry {1}.', builtIn ?? '-', cli));
}

function ambiguous(session: string): Error {
	return new Error(vscode.l10n.t('Several Facade Code Framework records match legacy session {0}.', session));
}

function mismatched(session: string): Error {
	return new Error(vscode.l10n.t('Facade Code Framework did not confirm the exact legacy session {0}.', session));
}
