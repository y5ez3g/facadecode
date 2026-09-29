/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import type { ContractTool, ToolOutput } from './tools';

/** How many lines read_terminal gives when it is not told, and the most it gives. */
const DEFAULT_LINES = 50;
const MAX_LINES = 2000;
/** How much of what a command returned is shown. */
const MAX_SHOWN = 2000;

interface Action {
	readonly name: string;
	/** Its arguments, as the model passes them in `args`; `?` marks one it may leave out. */
	readonly params: readonly string[];
	readonly description: string;
	run(facade: Facade, caller: Caller, args: Args): Promise<ToolOutput>;
}

const ACTIONS: readonly Action[] = [
	{
		name: 'open_file',
		params: ['path', 'line?'],
		description: 'open a file in the editor, at a line',
		async run(facade, caller, args) {
			const file = args.path('path');
			const line = args.count('line');
			await facade.openFile(caller, file, line);
			return { text: `Opened ${file}${line ? ` at line ${line}` : ''}.` };
		}
	},
	{
		name: 'open_terminal',
		params: ['path', 'name?'],
		description: 'open a terminal in a folder, held under its row, and get its name',
		async run(facade, caller, args) {
			const folder = args.path('path');
			const name = await facade.openTerminal(caller, folder, args.optionalText('name'));
			return { text: `Opened the terminal ${name} in ${folder}.`, data: { name } };
		}
	},
	{
		name: 'read_terminal',
		params: ['name', 'lines?'],
		description: `the last lines a terminal shows: ${DEFAULT_LINES}, or as many as lines says up to ${MAX_LINES}`,
		async run(facade, caller, args) {
			const name = args.text('name');
			const lines = Math.min(MAX_LINES, args.count('lines') ?? DEFAULT_LINES);
			const read = await facade.readTerminal(caller, name, lines);
			if (read.text === undefined) {
				return { text: `${read.name} has shown nothing yet.`, data: { name: read.name } };
			}
			return { text: `The last ${lines} lines of ${read.name}:\n${read.text}`, data: { name: read.name, text: read.text } };
		}
	},
	{
		name: 'send_terminal',
		params: ['name', 'text', 'enter?'],
		description: 'type text into a terminal, then Enter unless enter is false',
		async run(facade, caller, args) {
			const name = args.text('name');
			const text = args.string('text');
			const enter = args.boolean('enter') ?? true;
			const sent = await facade.sendTerminal(caller, name, text, enter);
			return { text: `Typed into ${sent.name}${enter ? ', then Enter' : ''}.`, data: { name: sent.name } };
		}
	},
	{
		name: 'command',
		params: ['id', 'args?'],
		description: 'run any VS Code command, its arguments as a list',
		async run(facade, caller, args) {
			const id = args.text('id');
			const result = await facade.runCommand(caller, id, args.list('args') ?? []);
			return { text: `Ran ${id}; it returned ${shown(result)}.` };
		}
	}
];

/**
 * The `ide` tool (WORKTREE-AGENTS.md, WA-9.5): what the person can do in the IDE, as actions. Each
 * checks its arguments, has Facade do it, and says what was done. M0 has five; delete_worktree and
 * `@name` for an agent's terminal come with M1, read_charter, write_charter and list_clis with M4.
 */
export const ideTool: ContractTool = {
	definition: {
		name: 'ide',
		title: 'Use the IDE',
		description: `Does in the IDE what the person can do there. The actions, with their args: ${ACTIONS.map(action => `${action.name} (${action.params.join(', ') || 'none'}): ${action.description}`).join('; ')}. A path is absolute.`,
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ACTIONS.map(action => action.name) },
				args: { type: 'object', description: 'The action\'s arguments.' }
			},
			required: ['action'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const tool = new Args('ide', ['action', 'args?'], input);
		const name = tool.text('action');
		const action = ACTIONS.find(each => each.name === name);
		if (!action) {
			throw invalid(`Unknown action ${name}. The actions: ${ACTIONS.map(each => each.name).join(', ')}.`);
		}
		return action.run(facade, caller, new Args(action.name, action.params, tool.object('args') ?? {}));
	}
};

/** An action's arguments, each checked as it is read: a wrong one is INVALID, saying what is right. */
class Args {

	private readonly values: Record<string, unknown>;

	constructor(owner: string, params: readonly string[], input: unknown) {
		if (!isObject(input)) {
			throw invalid(`${owner} takes an object of arguments: ${params.join(', ')}.`);
		}
		const known = params.map(param => param.replace(/\?$/, ''));
		const unknown = Object.keys(input).filter(key => !known.includes(key));
		if (unknown.length) {
			throw invalid(`${owner} takes ${params.join(', ') || 'no arguments'}; not ${unknown.join(', ')}.`);
		}
		this.values = input;
	}

	/** A string, perhaps empty. */
	string(name: string): string {
		const value = this.values[name];
		if (value === undefined) {
			throw invalid(`${name} is required.`);
		}
		if (typeof value !== 'string') {
			throw invalid(`${name} must be a string.`);
		}
		return value;
	}

	/** A string with something in it, trimmed. */
	text(name: string): string {
		const value = this.string(name).trim();
		if (!value) {
			throw invalid(`${name} must not be empty.`);
		}
		return value;
	}

	optionalText(name: string): string | undefined {
		return this.values[name] === undefined || this.values[name] === '' ? undefined : this.text(name);
	}

	/** An absolute path, normalized. */
	path(name: string): string {
		const value = this.text(name);
		if (!path.isAbsolute(value)) {
			throw invalid(`${name} must be an absolute path, not ${value}.`);
		}
		return path.normalize(value);
	}

	/** A whole number above 0, if it is given. */
	count(name: string): number | undefined {
		const value = this.values[name];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
			throw invalid(`${name} must be a whole number above 0.`);
		}
		return value;
	}

	boolean(name: string): boolean | undefined {
		const value = this.values[name];
		if (value === undefined || typeof value === 'boolean') {
			return value;
		}
		throw invalid(`${name} must be true or false.`);
	}

	list(name: string): readonly unknown[] | undefined {
		const value = this.values[name];
		if (value === undefined || Array.isArray(value)) {
			return value;
		}
		throw invalid(`${name} must be a list.`);
	}

	object(name: string): Record<string, unknown> | undefined {
		const value = this.values[name];
		if (value === undefined || isObject(value)) {
			return value;
		}
		throw invalid(`${name} must be an object: the action's arguments.`);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): FacadeError {
	return new FacadeError('INVALID', message);
}

/** What a command returned, as the model reads it. */
function shown(result: unknown): string {
	if (result === undefined) {
		return 'nothing';
	}
	let text: string;
	try {
		text = JSON.stringify(result) ?? String(result);
	} catch {
		text = String(result);
	}
	return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;
}
