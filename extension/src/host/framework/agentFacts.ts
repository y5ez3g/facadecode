/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { AgentRef, DaemonOperations } from '../../base/frameworkProtocol';
import { folderKeyOf } from '../../base/files';
import type { Location, RunError, RunFacts, RunId, FrameworkPin } from '../../core/ports';

type AgentInfo = DaemonOperations['agent.inspect']['result']['agent'];
const CARD_STATES = new Set<AgentInfo['state']>([
	'starting', 'working', 'waiting_for_you', 'just_done', 'idle', 'error', 'ended', 'unknown'
]);

export function agentKey(ref: AgentRef): RunId {
	return `${ref.machine_id}/${ref.agent_id}`;
}

export function referenceOf(agent: AgentRef): AgentRef {
	return { machine_id: agent.machine_id, agent_id: agent.agent_id };
}

export function referenceOfPin(pin: FrameworkPin): AgentRef {
	return { machine_id: pin.machine_id, agent_id: pin.agent };
}

function locationOf(folder: string, locations: readonly Location[]): Location | undefined {
	const key = folderKeyOf(folder);
	let closest: Location | undefined;
	for (const location of locations) {
		const place = folderKeyOf(location.path);
		const relative = path.relative(place, key);
		if (relative === '') { return location; }
		if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
			&& (!closest || location.path.length > closest.path.length)) {
			closest = location;
		}
	}
	return closest;
}

interface AgentPresentation {
	readonly locations: readonly Location[];
	readonly local: boolean;
	readonly machine?: string;
	readonly disconnected: boolean;
	readonly pin?: FrameworkPin;
	readonly failure?: RunError;
}

/** Card facts for a managed agent (PANEL-4.1). */
export function agentFacts(info: AgentInfo, view: AgentPresentation): RunFacts {
	const { reference, creator } = info;
	const { agent_id, machine_id } = reference;
	const location = view.local ? locationOf(info.cwd, view.locations) : undefined;
	const id = agentKey(reference);
	const state = info.state !== 'online' && CARD_STATES.has(info.state) ? info.state : 'unknown';
	const ended = info.process === 'ended';
	const detail = info.state_detail;
	const startedAt = Date.parse(info.started_at);
	return {
		id,
		orchestrator: { reference, state, ...(view.machine !== undefined ? { machine: view.machine } : {}) },
		alias: agent_id,
		address: info.address,
		name: info.name,
		cli: info.cli,
		displayName: info.cli,
		command: info.cli,
		location: location?.id ?? `${machine_id}:${info.cwd}`,
		cwd: info.cwd,
		environment: location?.environment ?? `machine:${machine_id}`,
		yolo: info.yolo,
		createdAt: Date.parse(info.created_at),
		startedAt,
		lifecycle: ended ? 'ended' : 'running',
		phase: 'running',
		activity: state === 'working' ? 'working'
			: state === 'idle' || state === 'just_done' || state === 'waiting_for_you' ? 'not_working' : 'unknown',
		reporting: state === 'working' || state === 'idle' || state === 'just_done' || state === 'waiting_for_you',
		disconnected: view.disconnected,
		tools: info.tools_state,
		root: agentKey(info.root),
		origin: info.creator_kind === 'agent' || creator ? 'agent' : 'human',
		...(creator ? { creator: agentKey(creator) } : {}),
		...(info.session ? { sessionId: info.session, resumable: true, pinnable: true } : {}),
		...(info.title !== undefined ? { title: info.title } : {}),
		...(info.model !== undefined ? { model: info.model } : {}),
		...(info.effort !== undefined ? { effort: info.effort } : {}),
		...(view.pin !== undefined ? { pin: view.pin.id } : {}),
		...(state === 'waiting_for_you' ? { blocker: { kind: detail?.kind ?? 'unknown', ...(detail?.text ? { text: detail.text } : {}) } } : {}),
		...(state === 'error' && detail?.text ? { error: { reason: detail.text, source: 'cli', at: startedAt } } : {}),
		...(view.failure !== undefined ? { error: view.failure } : {})
	};
}

/** A saved Pin supplies the card's identity when its Agent record could not be loaded. */
export function failedPinFacts(pin: FrameworkPin, error: RunError, machine: string | undefined): RunFacts {
	const reference = referenceOfPin(pin);
	const id = agentKey(reference);
	return {
		id,
		orchestrator: { reference, state: 'error', ...(machine !== undefined ? { machine } : {}) },
		alias: pin.agent,
		name: pin.name,
		cli: pin.conversation.cli,
		displayName: pin.conversation.cli,
		command: pin.conversation.cli,
		location: pin.location,
		cwd: pin.cwd,
		environment: pin.conversation.environment,
		yolo: false,
		createdAt: error.at,
		lifecycle: 'ended',
		phase: 'running',
		activity: 'unknown',
		reporting: false,
		root: id,
		origin: 'human',
		tools: 'not_injected',
		pin: pin.id,
		error
	};
}
