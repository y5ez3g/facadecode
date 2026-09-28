/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpTool, McpToolResult } from '../mcp';
import { Kernel, KernelError, ListEntry, MAX_WAIT_SEC, ParticipantView, WriteResult } from './kernel';
import { Caller, Message, WriteMode } from './model';

/*
 * The facade MCP server's tools (L2-PLAN, step 27): the same twelve for the person and for every
 * agent, whatever it was started to do. Each result is text a model reads whole, with the facts
 * also as structured data, and ends with how many messages wait, so that an agent hears of them on
 * whatever call it makes next.
 */

export const TOOL_NAMES = ['whoami', 'who', 'send', 'recv', 'join', 'leave', 'read', 'write', 'list', 'spawn', 'stop', 'ide'] as const;

/** Where a spawned agent works: a folder, or a new worktree. */
export interface SpawnPlace {
	readonly folder?: string;
	readonly repo?: string;
	readonly branch?: string;
	readonly base?: string;
}

export interface SpawnRequest {
	readonly agent: string;
	readonly where: SpawnPlace;
	readonly text: string;
	readonly name?: string;
	readonly groups?: readonly string[];
}

export interface SpawnResult {
	readonly name: string;
	readonly incarnation: number;
	readonly agent: string;
	readonly place: string;
	/** Set when the place is a worktree made for it. */
	readonly branch?: string;
}

/** Starts and stops agents: the window's, since only it has terminals. */
export interface AgentHost {
	spawn(caller: Caller, request: SpawnRequest, signal: AbortSignal, progress: (message: string) => void): Promise<SpawnResult>;
	stop(caller: Caller, name: string): Promise<string>;
	/** The agents this machine has, as `spawn` takes them. */
	agents(): readonly string[];
}

/** Does in the IDE what the person can do there. */
export interface IdeHost {
	readonly actions: readonly { readonly name: string; readonly description: string }[];
	run(caller: Caller, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ readonly text: string; readonly data?: object }>;
}

/** Hears an agent's own hooks: its turn started or ended, it waits at a prompt. */
export interface HookHost {
	/** Returns what the hook prints for its agent, often nothing. */
	hook(caller: Caller, event: string, payload: unknown): Promise<string>;
}

export interface KernelHosts {
	readonly agents?: AgentHost;
	readonly ide?: IdeHost;
	readonly hooks?: HookHost;
}

/** The tool Facade's hook launchers call. Not listed: no model is meant to call it. */
export const HOOK_TOOL = '_hook';

export const INSTRUCTIONS = [
	'Facade Code connects the person and the agents working in this workspace.',
	'- You are a participant with a name; whoami says who you are, who started you, what you were asked and how many messages wait for you.',
	'- The person is @you. Agents have names like @lead or @codex-1; groups are #names.',
	'- Talk with send (to @name or #group) and recv (recv can wait for messages). Keep messages short: put long content in a notebook page and send its path.',
	'- The notebook is shared by everyone: pages are paths like p1/plan. read, write (replace, append, or create only if absent) and list. write with if_version to change a page only if nobody changed it since you read it. You hear once when a page you read changes.',
	'- spawn starts another agent with a first message; stop stops one; ide does what the person can do in the IDE.',
	'- Your own shell, files and git are yours to use as always: merging, testing and committing are not Facade tools.',
	'- Every result ends with how many messages you have unread. When there are some, call recv.',
	'- How to lead a team, work on a task, review and more are skills: pages under protocol/ in the notebook. When told to use a skill, read protocol/<skill> and follow it.'
].join('\n');

const PAGE_DESCRIPTION = 'A page path such as p1/plan: lower case, parts split by /, no .md.';

export function kernelTools(host: KernelHosts): McpTool[] {
	const agentNames = host.agents?.agents() ?? [];
	const ideActions = host.ide?.actions ?? [];
	return [
		{
			name: 'whoami',
			title: 'Who am I',
			description: 'Your name, where you work, who started you and with what first message, your groups, and how many messages wait for you. Call it first, and again after your context was compacted.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: { readOnlyHint: true }
		},
		{
			name: 'who',
			title: 'Who is here',
			description: 'Everyone in this workspace, the person (@you) and the agents: state (starting, working, waiting, idle, stopped, failed), where they work, what they last said, their groups and cost.',
			inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'Only the members of this group, such as #p1.' } }, additionalProperties: false },
			annotations: { readOnlyHint: true }
		},
		{
			name: 'send',
			title: 'Send a message',
			description: 'Sends a message to participants (@name) and groups (#name). It is kept until they take it with recv, even if they are busy or stopped. Keep it short; put long content in a page and send the path.',
			inputSchema: {
				type: 'object',
				properties: {
					to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Addresses: @name for a participant, #name for a group. The person is @you.' },
					text: { type: 'string', description: 'The message.' },
					reply_to: { type: 'integer', description: 'The number of the message this answers, from recv.' }
				},
				required: ['to', 'text'],
				additionalProperties: false
			}
		},
		{
			name: 'recv',
			title: 'Receive messages',
			description: `Takes your messages: those sent to you, to your groups, and Facade's notices (a page you read changed; an agent you started works, waits, finished its turn, stopped or failed). Without after, it continues where you left off. With wait_sec it waits for the next message, up to ${MAX_WAIT_SEC} seconds, and returns as soon as one comes.`,
			inputSchema: {
				type: 'object',
				properties: {
					after: { type: 'integer', minimum: 0, description: 'Only messages after this number: to read earlier ones again. Default: where you left off.' },
					wait_sec: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SEC, description: 'How long to wait when there is nothing yet. Default 0.' },
					limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many. Default 50.' }
				},
				additionalProperties: false
			},
			annotations: { readOnlyHint: true }
		},
		{
			name: 'join',
			title: 'Join a group',
			description: 'Joins a group, so that messages to it reach you. A group exists once someone is in it.',
			inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'Such as #p1.' } }, required: ['group'], additionalProperties: false },
			annotations: { idempotentHint: true }
		},
		{
			name: 'leave',
			title: 'Leave a group',
			description: 'Leaves a group.',
			inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'Such as #p1.' } }, required: ['group'], additionalProperties: false },
			annotations: { idempotentHint: true }
		},
		{
			name: 'read',
			title: 'Read a page',
			description: 'Reads a notebook page: its text, version and author. You then hear once, through recv, when someone else changes it.',
			inputSchema: { type: 'object', properties: { page: { type: 'string', description: PAGE_DESCRIPTION } }, required: ['page'], additionalProperties: false },
			annotations: { readOnlyHint: true }
		},
		{
			name: 'write',
			title: 'Write a page',
			description: 'Writes a notebook page. mode replace (the default) replaces it; append adds to its end; create writes only if the page does not exist, so that of several agents taking one thing only one succeeds. With if_version, it writes only if the page is still at that version (0: only if it does not exist); otherwise nothing is written and you get the page as it is now, to merge into and write again. Empty text deletes the page.',
			inputSchema: {
				type: 'object',
				properties: {
					page: { type: 'string', description: PAGE_DESCRIPTION },
					text: { type: 'string', description: 'The text: Markdown.' },
					mode: { type: 'string', enum: ['replace', 'append', 'create'], description: 'Default replace.' },
					if_version: { type: 'integer', minimum: 0, description: 'Write only if the page is at this version.' }
				},
				required: ['page', 'text'],
				additionalProperties: false
			}
		},
		{
			name: 'list',
			title: 'List pages',
			description: 'Lists the notebook pages under a folder, with version, author and time. You then hear once when a page comes or goes there.',
			inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Such as p1. Empty or absent: the whole notebook.' } }, additionalProperties: false },
			annotations: { readOnlyHint: true }
		},
		{
			name: 'spawn',
			title: 'Start an agent',
			description: `Starts an agent with a first message, in an existing folder or in a new git worktree. It joins the workspace under a name; you hear when it starts working, waits, finishes its turn, stops or fails. Giving the name of an agent that exists starts a new one in its place. ${agentNames.length ? `Installed: ${agentNames.join(', ')}.` : 'No agent is installed.'}`,
			inputSchema: {
				type: 'object',
				properties: {
					agent: { type: 'string', description: `Which agent, optionally with a model: ${agentNames.length ? agentNames.join(', ') : 'claude, codex, agy, muse, grok'}; such as claude or claude:sonnet.` },
					where: {
						type: 'object',
						description: 'folder: an existing folder to work in. Or branch: a new worktree on a new branch of that name, of repo (default: the repository you are in), starting from base (default: your HEAD).',
						properties: {
							folder: { type: 'string' },
							repo: { type: 'string' },
							branch: { type: 'string' },
							base: { type: 'string' }
						},
						additionalProperties: false
					},
					text: { type: 'string', description: 'Its first message, such as "Use the work skill. Your task is in p1/tasks/f2."' },
					name: { type: 'string', description: 'Its name. Default: the agent and a number, such as codex-3.' },
					groups: { type: 'array', items: { type: 'string' }, description: 'Groups it is in from the start.' }
				},
				required: ['agent', 'where', 'text'],
				additionalProperties: false
			}
		},
		{
			name: 'stop',
			title: 'Stop an agent',
			description: 'Stops an agent: its terminal or its process ends. Its messages and pages stay.',
			inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Such as @codex-1.' } }, required: ['name'], additionalProperties: false },
			annotations: { destructiveHint: true }
		},
		{
			name: 'ide',
			title: 'Use the IDE',
			description: `Does in the IDE what the person can do there.${ideActions.length ? ` Actions: ${ideActions.map(action => `${action.name} (${action.description})`).join('; ')}.` : ' Not available in this window.'}`,
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', ...(ideActions.length ? { enum: ideActions.map(action => action.name) } : {}) },
					args: { type: 'object', description: 'The action\'s arguments.' }
				},
				required: ['action'],
				additionalProperties: false
			}
		}
	];
}

/** Runs one tool for one caller and renders its result. */
export async function callKernelTool(kernel: Kernel, host: KernelHosts, caller: Caller, tool: string, rawArgs: unknown, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
	const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
	if (tool === HOOK_TOOL) {
		// What a hook prints goes to the agent's CLI, which may show it to the model: nothing extra.
		try {
			return { text: host.hooks ? await host.hooks.hook(caller, String(args.event ?? ''), args.payload) : '' };
		} catch (err) {
			return { text: (err as Error).message, isError: true };
		}
	}
	let result: McpToolResult;
	try {
		result = await run(kernel, host, caller, tool, args, signal, progress);
	} catch (err) {
		result = { text: (err as Error).message, isError: true, data: err instanceof KernelError ? { code: err.code } : undefined };
	}
	if (!kernel.state.participants.has(caller.name)) {
		return result;
	}
	const unread = kernel.unread(caller.name);
	if (unread > 0 && tool !== 'recv') {
		return { ...result, text: `${result.text}\n\n(${unread} unread message${unread === 1 ? '' : 's'}: call recv.)` };
	}
	return result;
}

async function run(kernel: Kernel, host: KernelHosts, caller: Caller, tool: string, args: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void): Promise<McpToolResult> {
	switch (tool) {
		case 'whoami': {
			const me = kernel.whoami(caller);
			const lines = [
				`You are @${me.name}${me.incarnation > 1 ? ` (incarnation ${me.incarnation})` : ''}, ${me.kind === 'person' ? 'the person' : `an agent${me.agent ? ` (${me.agent})` : ''}`}${me.place ? `, working in ${me.place}` : ''}.`,
				me.startedBy ? `Started by @${me.startedBy}.` : undefined,
				me.text ? `Your first message:\n${quote(me.text)}` : undefined,
				`Groups: ${me.groups.length ? me.groups.map(group => `#${group}`).join(', ') : 'none'}.`,
				`Unread messages: ${me.unread}${me.unread ? ' (call recv)' : ''}.`,
				`The notebook's files are in ${me.notebook}.`
			];
			return { text: lines.filter(line => line !== undefined).join('\n'), data: me };
		}
		case 'who': {
			const views = kernel.who(optionalString(args.group));
			return { text: views.length ? views.map(view => describeParticipant(view, kernel)).join('\n') : 'Nobody is in that group.', data: { participants: views } };
		}
		case 'send': {
			const to = args.to;
			if (!(typeof to === 'string' || (Array.isArray(to) && to.every(item => typeof item === 'string')))) {
				throw new KernelError('INVALID', 'to is a list of addresses, such as ["@lead", "#p1"].');
			}
			const replyTo = optionalInteger(args.reply_to, 'reply_to');
			const sent = kernel.send(caller, to as string | string[], requiredString(args.text, 'text'), replyTo);
			const notes = [
				sent.recipients.length ? `Sent message ${sent.seq} to ${sent.recipients.map(name => `@${name}`).join(', ')}.` : `Message ${sent.seq} is kept, but it reached nobody.`,
				sent.emptyGroups.length ? `Nobody is in ${sent.emptyGroups.join(', ')} yet.` : undefined,
				sent.stopped.length ? `${sent.stopped.map(name => `@${name}`).join(', ')} ${sent.stopped.length === 1 ? 'is' : 'are'} stopped: it waits for them.` : undefined
			];
			return { text: notes.filter(Boolean).join(' '), data: sent };
		}
		case 'recv': {
			const got = await kernel.recv(caller, { after: optionalInteger(args.after, 'after'), waitSec: optionalInteger(args.wait_sec, 'wait_sec'), limit: optionalInteger(args.limit, 'limit') }, signal, progress);
			let text: string;
			if (got.messages.length) {
				text = `${got.messages.length} message${got.messages.length === 1 ? '' : 's'}:\n${got.messages.map(renderMessage).join('\n')}`;
				if (got.more) {
					text += `\n\nMore are waiting: call recv again.`;
				}
			} else {
				text = got.timedOut ? 'No messages came while waiting. Call recv with wait_sec again to keep waiting.' : 'No new messages.';
			}
			return { text: `${text}\n(cursor ${got.cursor}, unread ${got.unread})`, data: { messages: got.messages, cursor: got.cursor, more: got.more, unread: got.unread } };
		}
		case 'join': {
			const group = requiredString(args.group, 'group');
			const members = kernel.join(caller, group);
			return { text: `You are in #${group.replace(/^#/, '').toLowerCase()}, with ${members.filter(name => name !== caller.name).map(name => `@${name}`).join(', ') || 'nobody else yet'}.`, data: { members } };
		}
		case 'leave': {
			const group = requiredString(args.group, 'group');
			const members = kernel.leave(caller, group);
			return { text: `You left #${group.replace(/^#/, '').toLowerCase()}.`, data: { members } };
		}
		case 'read': {
			const page = kernel.read(caller, requiredString(args.page, 'page'));
			return { text: `${page.page}, version ${page.version}${page.author ? `, by @${page.author}` : ', edited directly'}, ${new Date(page.ts).toISOString()}\n\n${page.text}`, data: page };
		}
		case 'write': {
			const mode = args.mode === undefined ? 'replace' : args.mode;
			if (mode !== 'replace' && mode !== 'append' && mode !== 'create') {
				throw new KernelError('INVALID', 'mode is replace, append or create.');
			}
			const text = args.text;
			if (typeof text !== 'string') {
				throw new KernelError('INVALID', 'text is required: the page\'s text, or empty to delete it.');
			}
			const written = kernel.write(caller, requiredString(args.page, 'page'), text, mode as WriteMode, optionalInteger(args.if_version, 'if_version'));
			return { text: describeWrite(written), data: written };
		}
		case 'list': {
			const folder = optionalString(args.folder) ?? '';
			const entries = kernel.list(caller, folder);
			return { text: entries.length ? entries.map(describeEntry).join('\n') : `No pages${folder ? ` under ${folder}` : ''}.`, data: { pages: entries } };
		}
		case 'spawn': {
			if (!host.agents) {
				throw new KernelError('INVALID', 'This window cannot start agents.');
			}
			const where = args.where;
			if (!where || typeof where !== 'object' || Array.isArray(where)) {
				throw new KernelError('INVALID', 'where is { folder } for an existing folder, or { branch, repo?, base? } for a new worktree.');
			}
			const place = where as Record<string, unknown>;
			const groups = args.groups === undefined ? undefined : Array.isArray(args.groups) && args.groups.every(group => typeof group === 'string') ? args.groups as string[] : undefined;
			if (args.groups !== undefined && !groups) {
				throw new KernelError('INVALID', 'groups is a list of group names.');
			}
			const request: SpawnRequest = {
				agent: requiredString(args.agent, 'agent'),
				where: { folder: optionalString(place.folder), repo: optionalString(place.repo), branch: optionalString(place.branch), base: optionalString(place.base) },
				text: requiredString(args.text, 'text'),
				name: optionalString(args.name),
				groups
			};
			const started = await host.agents.spawn(caller, request, signal, progress);
			return {
				text: `Started @${started.name}${started.incarnation > 1 ? ` (incarnation ${started.incarnation})` : ''}: ${started.agent}, in ${started.place}${started.branch ? ` on the new branch ${started.branch}` : ''}. Your first message is its prompt. You hear through recv when it works, waits, finishes its turn, stops or fails.`,
				data: started
			};
		}
		case 'stop': {
			if (!host.agents) {
				throw new KernelError('INVALID', 'This window cannot stop agents.');
			}
			return { text: await host.agents.stop(caller, requiredString(args.name, 'name')) };
		}
		case 'ide': {
			if (!host.ide) {
				throw new KernelError('INVALID', 'The IDE is not available to tools in this window.');
			}
			const actionArgs = args.args === undefined ? {} : args.args;
			if (!actionArgs || typeof actionArgs !== 'object' || Array.isArray(actionArgs)) {
				throw new KernelError('INVALID', 'args is an object.');
			}
			return host.ide.run(caller, requiredString(args.action, 'action'), actionArgs as Record<string, unknown>, signal);
		}
	}
	throw new KernelError('INVALID', `Unknown tool ${tool}.`);
}

export function describeParticipant(view: ParticipantView, kernel?: Kernel): string {
	const parts = [
		`@${view.name}`,
		view.kind === 'person' ? 'the person' : view.agent ?? 'agent',
		`${view.state}${view.stateDetail ? ` (${view.stateDetail})` : ''} for ${duration(Date.now() - view.since)}`,
		view.place ? `in ${view.place}` : undefined,
		view.startedBy ? `started by @${view.startedBy}` : undefined,
		view.groups.length ? view.groups.map(group => `#${group}`).join(' ') : undefined,
		view.lastSaid ? `last said: ${JSON.stringify(view.lastSaid.length > 80 ? `${view.lastSaid.slice(0, 80)}…` : view.lastSaid)}` : undefined,
		view.usage?.costUsd !== undefined ? `$${view.usage.costUsd.toFixed(2)}` : undefined,
		kernel && view.unread ? `${view.unread} unread` : undefined
	];
	return parts.filter(Boolean).join(' · ');
}

export function renderMessage(message: Message): string {
	const head = `[${message.seq}] ${message.from === 'facade' ? 'Facade' : `@${message.from}`} → ${message.to.join(', ')}${message.replyTo ? ` (re ${message.replyTo})` : ''}:`;
	return message.text.includes('\n') ? `${head}\n${indent(message.text)}` : `${head} ${message.text}`;
}

function describeWrite(written: WriteResult): string {
	if (written.ok) {
		return written.deleted ? `Deleted ${written.page} (version ${written.version}).` : `Wrote ${written.page}: version ${written.version}.`;
	}
	const current = written.current;
	switch (written.reason) {
		case 'exists':
			return `Not written: ${written.page} already exists (version ${current!.version}${current!.author ? `, by @${current!.author}` : ''}). Its text:\n${quote(current!.text)}`;
		case 'conflict':
			return current
				? `Not written: ${written.page} is at version ${current.version}${current.author ? ` (by @${current.author})` : ''}, not the one you gave. Merge your change into its text below and write again with if_version ${current.version}.\n${quote(current.text)}`
				: `Not written: ${written.page} does not exist. Write it without if_version, or with if_version 0.`;
		case 'missing':
			return `Nothing to delete: there is no page ${written.page}.`;
	}
}

function describeEntry(entry: ListEntry): string {
	return `${entry.page} · version ${entry.version} · ${entry.author ? `@${entry.author}` : 'edited directly'} · ${duration(Date.now() - entry.ts)} ago · ${entry.size} bytes`;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new KernelError('INVALID', `${name} is required.`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalInteger(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new KernelError('INVALID', `${name} is a number.`);
	}
	return Math.floor(value);
}

function quote(text: string): string {
	return text.split('\n').map(line => `> ${line}`).join('\n');
}

function indent(text: string): string {
	return text.split('\n').map(line => `    ${line}`).join('\n');
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** What `hello` tells an MCP server about its caller: the tools, and the instructions for the model. */
export function helloFor(host: KernelHosts, caller: Caller): { readonly name: string; readonly tools: McpTool[]; readonly instructions: string } {
	return { name: caller.name, tools: kernelTools(host), instructions: INSTRUCTIONS };
}
