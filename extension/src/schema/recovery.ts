/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from '../base/json';
import type { Effects, Recovery, Result } from './result';

/** Add only exceptional recovery facts after public projection; message bodies and human history stay separate. */
export function withRecovery(tool: string, result: Result, argumentsValue?: unknown): Result {
	const data = isJsonObject(result.data) ? result.data : {};
	const args = isJsonObject(argumentsValue) ? argumentsValue : {};
	const recovery = result.status === 'failure' ? recoveryOf(tool, result, data, args) : undefined;
	const prompt = tool === 'start_agent' && isJsonObject(data.prompt) ? data.prompt : undefined;
	const exceptionalPrompt = prompt && (prompt.status === 'failure' || prompt.status === 'unknown');
	return {
		...result,
		...recovery ? { recovery } : {},
		...exceptionalPrompt ? {
			data: { ...data, prompt: { ...prompt, recovery: recoveryOf('send_message', {
				status: 'failure', data: {}, effects: (isJsonObject(prompt.effects) ? prompt.effects : { outcome: 'unknown' }) as unknown as Effects,
				error: { code: 'FAILED', reason: typeof prompt.reason === 'string' ? prompt.reason : 'submission_unconfirmed', message: '' }
			}, { target: data.agent_id }, {}) } }
		} : {}
	};
}

function recoveryOf(tool: string, result: Result, data: Record<string, unknown>, args: Record<string, unknown>): Recovery {
	const reason = result.error?.reason;
	const effects = result.effects;
	const target = typeof data.agent_id === 'string' ? data.agent_id : typeof data.target === 'string' && data.target !== '#human' ? data.target : undefined;
	const check = (name: 'list_agents' | 'read_screen'): Pick<Recovery, 'check'> => target && data.closed !== true
		? { check: { tool: name, arguments: { agent: target } } } : {};
	// A lost route can be asked about under its ORIGINAL key. This retrieves that operation; it is no new effect.
	if (effects.outcome === 'unknown' && ['window_unavailable', 'timeout', 'invalid_response', 'route_failed'].includes(reason ?? '') && (tool === 'start_agent' || tool === 'send_message') && typeof args.request_id === 'string' && [...args.request_id].length > 0 && [...args.request_id].length <= 200) {
		return { action: 'repeat_original_request', request_id: args.request_id, condition: 'within_original_hour' };
	}
	if (effects.outcome === 'partial' || effects.outcome === 'unknown' || effects.outcome === 'confirmed' || effects.worktree_created !== undefined) {
		return { action: 'inspect_effects', ...check(tool === 'start_agent' || tool === 'stop_agent' ? 'list_agents' : 'read_screen') };
	}
	if (effects.outcome === 'pending') {
		// A failed observation does not cancel continuing work or make a new send safe.
		return { action: 'inspect_effects', ...check('list_agents') };
	}
	if (reason === 'protocol_incompatible') {
		return { action: 'update_tools' };
	}
	if (reason === 'ambiguous_reference') {
		return { action: 'resolve_target', check: { tool: 'list_agents', arguments: {} } };
	}
	if (result.error?.code === 'INVALID') {
		return { action: 'correct_arguments' };
	}
	if (reason === 'not_found' || reason === 'ended' || reason === 'out_of_tree') {
		return { action: 'resolve_target' };
	}
	if (reason === 'unsupported' || reason === 'configuration_invalid') {
		return { action: 'check_capability', ...check('list_agents') };
	}
	if (reason === 'window_unavailable' || reason === 'timeout' || reason === 'invalid_response' || reason === 'route_failed') {
		return { action: 'reconnect' };
	}
	return { action: 'resolve_blocker', ...check(tool === 'start_agent' ? 'list_agents' : 'read_screen') };
}
