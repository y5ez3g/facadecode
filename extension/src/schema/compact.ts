/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from '../base/json';
import type { Result } from './result';

type Data = { readonly [key: string]: unknown };

/** Public projection only: never use this to trim runtime records or intermediate cross-window responses (MCP-1.2). */
export function compactResult(tool: string, result: Result, details = false): Result {
	if (!isJsonObject(result.data)) {
		return result;
	}
	let data = identity(result.data);
	switch (tool) {
		case 'list_agents':
			if (Array.isArray(data.agents)) {
				data = { ...without(data, ['agents']), agents: data.agents.map(agent => isJsonObject(agent) ? agentView(agent, details) : agent) };
			}
			break;
		case 'list_start_options':
			if (isJsonObject(data.location) && data.location.location_id === data.location_id) {
				data = { ...data, location: without(data.location, ['location_id']) };
			}
			break;
		case 'start_agent':
			if (isJsonObject(data.prompt)) {
				data = { ...data, prompt: identity(data.prompt) };
			}
			break;
		case 'send_message':
		case 'type_text':
			data = without(data, ['length', 'enter']);
			break;
		case 'press_keys':
			data = without(data, ['keys']);
			break;
		case 'read_messages':
			if (Array.isArray(data.messages)) {
				data = { ...data, messages: data.messages.map(message => isJsonObject(message) ? messageView(message) : message) };
			}
			break;
	}
	const effects = { ...result.effects };
	// The affected agent is already identified in data; all other effects, including unknown/null, stay explicit.
	if (effects.agent_id !== undefined && effects.agent_id === result.data.agent_id) {
		delete effects.agent_id;
	}
	// Keep outcome/completeness before potentially long bodies, including when a client folds the visible result.
	return { status: result.status, effects, data, ...result.error !== undefined ? { error: result.error } : {} };
}

/** A single callable identity, retaining its name separately where it describes a listed or newly created agent. */
function identity(source: Data): Data {
	const data: { [key: string]: unknown } = { ...source };
	if (typeof source.agent_id === 'string') {
		data.agent_id = agentReference(source.alias) ?? agentReference(source.reference) ?? source.agent_id;
		delete data.alias;
		delete data.reference;
		if (source.process !== undefined) {
			data.process_state = source.process;
			delete data.process;
		}
		if (source.tools !== undefined) {
			data.tools_state = source.tools;
			delete data.tools;
		}
	}
	if (typeof source.message_id === 'string') {
		data.message_id = messageReference(source.message_id);
		delete data.alias;
	}
	if (typeof source.target === 'string') {
		data.target = agentReference(source.target_reference) ?? (source.target === '@human' ? '#human' : source.target);
		delete data.target_reference;
	}
	for (const key of ['reply_to', 'about']) {
		if (typeof source[key] === 'string') {
			data[key] = messageReference(source[key]);
		}
	}
	return data;
}

function agentView(source: Data, details: boolean): Data {
	let data = identity(source);
	if (!details && isJsonObject(data.message_input) && data.message_input.state === 'supported') {
		data = { ...data, message_input: without(data.message_input, ['reason']) };
	}
	return details ? data : without(data, ['window', 'creator', 'root', 'created_at', 'title', ...(source.activity === 'unknown' ? [] : ['activity_reason'])]);
}

function messageView(source: Data): Data {
	const data = identity(source);
	return {
		...without(data, ['from_reference', 'to', 'to_reference', 'length', 'agent_reference']),
		// A sender's name is useful context; this single reference also directly addresses it in the next tool call.
		...source.from_reference !== undefined ? { from: source.from_reference } : {},
		...source.agent !== undefined ? { agent: agentReference(source.agent_reference) ?? source.agent } : {},
		...isJsonObject(source.delivery) ? { delivery: without(source.delivery, ['attempts']) } : {}
	};
}

function agentReference(value: unknown): string | undefined {
	return typeof value === 'string' ? /(?:^|\s)(#a\d+)$/.exec(value)?.[1] : undefined;
}

function messageReference(id: string): string {
	return /^m-\d+$/.test(id) ? `#m${id.slice(2)}` : id;
}

function without(source: Data, keys: readonly string[]): Data {
	return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}
