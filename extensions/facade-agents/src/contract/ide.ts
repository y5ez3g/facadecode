/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import { Args, invalid } from './args';
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
		description: `the last lines a terminal shows, or @name for an agent's: ${DEFAULT_LINES}, or as many as lines says up to ${MAX_LINES}`,
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
		description: 'type text into a terminal, or @name for a child\'s, then Enter unless enter is false',
		async run(facade, caller, args) {
			const name = args.text('name');
			const text = args.string('text');
			const enter = args.boolean('enter') ?? true;
			const sent = await facade.sendTerminal(caller, name, text, enter);
			return { text: `Typed into ${sent.name}${enter ? ', then Enter' : ''}.`, data: { name: sent.name } };
		}
	},
	{
		name: 'delete_worktree',
		params: ['name', 'force?'],
		description: 'Delete Worktree without its dialog, stopping your children in it; changes not committed are thrown away only with force',
		async run(facade, caller, args) {
			const deleted = await facade.deleteWorktree(caller, args.text('name'), args.boolean('force') ?? false);
			const stopped = deleted.stopped.length ? ` Stopped ${deleted.stopped.map(name => `@${name}`).join(', ')} first.` : '';
			return { text: `Deleted the worktree ${deleted.name} at ${deleted.folder}; its branch is kept.${stopped}`, data: deleted };
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
 * checks its arguments, has Facade do it, and says what was done. read_charter, write_charter and
 * list_clis come with M4.
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
