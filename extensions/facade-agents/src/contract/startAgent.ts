/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorOutcome, FacadeError } from '../core/errors';
import type { Facade, Started } from '../core/facade';
import type { SetupProgress } from '../core/ports';
import { excerptText } from '../core/screens';
import { describe } from '../record/events';
import { Args } from './args';
import { factsText } from './listAgents';
import type { ContractTool } from './tools';

const PARAMS = ['name', 'cli', 'model?', 'effort?', 'task?', 'folder?', 'new_worktree?'];

/**
 * What of the model and effort a start was given is not known to be applied, and why: its launch has no group for it,
 * so its CLI was not given it and its own applies; or - an effort given with a model whose name may carry one of its own -
 * its CLI was given it, and may run at the model's instead (O3; N-64; OR-01).
 */
function ignoredText(facade: Facade, started: Started): string {
	const byModel = started.ignored.includes('effort') && started.model !== undefined && !started.ignored.includes('model') && facade.modelCarriesEffort(started.cli);
	const noGroup = started.ignored.filter(what => !(what === 'effort' && byModel));
	return [
		...noGroup.length ? [` The ${noGroup.join(' and ')} you gave ${noGroup.length === 1 ? 'was' : 'were'} not used: ${started.cli}'s launch has no group for ${noGroup.length === 1 ? 'it' : 'them'}, so its own applies.`] : [],
		...byModel ? [` The effort you gave was passed on, but ${facade.cliName(started.cli)} may override it where the model's name carries an effort, as ${started.model}'s may: the effort it runs at is not known.`] : []
	].join('');
}

/** A failed start's data: its error's outcome, with the agent's facts and its status (O3). */
type FailedStart = ErrorOutcome & Omit<Started, 'status' | 'why' | 'screen' | 'phase'> & { readonly status: 'failed' };

/**
 * A start that failed once its agent had a number, as its caller is answered (AGENT-ORCHESTRATION.md, O3; O2): with the
 * facts a start that started or is not confirmed answers with - status failed - in words and as data, beside the phase it
 * had got to, its final screen and what was made for it, which stays. Undefined for any other failure, which is answered
 * as it is.
 */
function failedStart(facade: Facade, err: unknown, newWorktree: boolean): FacadeError | undefined {
	const outcome = err instanceof FacadeError && err.code === 'FAILED' && err.outcome?.outcome === 'failed' ? err.outcome : undefined;
	const facts = outcome?.agent !== undefined ? facade.facts(outcome.agent) : undefined;
	if (!(err instanceof FacadeError) || !outcome || !facts) {
		return undefined;
	}
	// Its facts after what failed, before the last lines of its screen
	const [first, ...rest] = err.message.split('\n');
	const text = `${first}${/[.!?]$/.test(first) ? '' : '.'} Its start: ${factsText(facade, facts)}.`;
	const data: FailedStart = { ...outcome, ...facts, status: 'failed', newWorktree };
	return new FacadeError(err.code, [text, ...rest].join('\n'), data);
}

/**
 * Where the setup of the worktree of a start that is not confirmed is, as its answer says it - the line running, and the last
 * lines of its setup terminal - for a start with no terminal of its own yet (O3: setup diagnostics). None without one.
 */
function settingUpText(settingUp: SetupProgress | undefined): string {
	if (!settingUp) {
		return '';
	}
	const running = settingUp.running !== undefined ? `Its worktree's setup is running \`${settingUp.running}\`.` : 'Its worktree\'s setup is running.';
	return `\n${running} ${settingUp.lines.length ? `The last lines of its setup terminal, as they were:\n${settingUp.lines.join('\n')}` : 'Its setup terminal shows nothing yet.'}`;
}

/**
 * `start_agent` (AGENT-ORCHESTRATION.md, O3): starts an agent in its own UI, in any folder of the window
 * or a new worktree. It answers with the agent's number once it has started, or that its start is not
 * confirmed.
 */
export const startAgentTool: ContractTool = {
	definition: {
		name: 'start_agent',
		title: 'Start an agent',
		description: 'Starts an agent called name in its own terminal: a CLI, on the model and effort you give or else its own, with a task if you give one - the task is a message from you, as #m12, which the agent fetches itself. It works in your folder; in another folder of this window, by its absolute path; in a worktree of your repository, by the branch checked out in it; or, with new_worktree, in a new worktree of that folder\'s repository, on a new branch called name - starting at your commit in your own repository, so commit what it needs first, and at the main checkout\'s in another. Its YOLO is yours. It answers once the agent has started - its CLI connected to Facade - with its number, as #a7, and its task\'s; started is not that it has fetched its task, which list_agents shows. If it has not started within the timeout, it answers that its start is not confirmed, why, and the last lines of its screen: it stays starting, and list_agents, read_screen and stop_agent take it. A start can take a minute: do not call start_agent again just to wait. Facade gives the model and the effort to the CLI as they are, and no CLI checks them as it starts.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Its name, without the @: a label of lower-case letters, digits, dots, dashes and underscores, which other agents may have too. With new_worktree, its branch.' },
				cli: { type: 'string', description: 'The CLI, by its id, or a custom agent, by its name.' },
				model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it. Omitted: the CLI\'s own default.' },
				effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. Omitted: the CLI\'s own default.' },
				task: { type: 'string', description: 'Its task: Facade sends it to the agent as a message from you, which the agent fetches with read_messages. Omitted: none, and it waits at its CLI\'s own prompt for a message.' },
				folder: { type: 'string', description: 'Where it works: a folder of this window, by its absolute path, or a worktree of your repository, by the branch checked out in it. Omitted: your folder.' },
				new_worktree: { type: 'boolean', description: 'true: a new worktree of that folder\'s repository, on a new branch called name.' }
			},
			required: ['name', 'cli'],
			additionalProperties: false
		}
	},
	/** Its definition with the agents this machine can start. */
	describe(facade) {
		const startable = facade.startable();
		return {
			...this.definition,
			inputSchema: {
				...this.definition.inputSchema,
				properties: {
					...this.definition.inputSchema.properties,
					// No enum: a CLI installed or a custom agent added after this was read is startable all the same (X-39)
					cli: { type: 'string', description: `The CLI, or a custom agent: ${startable.map(each => each.custom ? `${each.id} (custom)` : `${each.id} (${each.displayName})`).join(', ') || 'none on this machine'} - as they were when you started; list_agents lists them as they are now.` }
				}
			}
		};
	},
	async call(facade, caller, input, progress) {
		const args = new Args('start_agent', PARAMS, input);
		const name = args.text('name');
		const cli = args.text('cli');
		const model = args.optionalText('model');
		const effort = args.optionalText('effort');
		// As it was written: kept, and read, exactly (X-56)
		const task = args.optionalWords('task');
		const folder = args.optionalText('folder');
		const newWorktree = args.boolean('new_worktree');
		let started: Started;
		try {
			started = await facade.startAgent(caller, {
				name,
				cli,
				...(model !== undefined ? { model } : {}),
				...(effort !== undefined ? { effort } : {}),
				...(task !== undefined ? { task } : {}),
				...(folder !== undefined ? { folder } : {}),
				...(newWorktree !== undefined ? { newWorktree } : {})
			}, progress);
		} catch (err) {
			throw failedStart(facade, err, newWorktree === true) ?? err;
		}
		const ignored = ignoredText(facade, started);
		// A folder in no Git repository has no worktree (N-57)
		const where = started.newWorktree ? `the new worktree ${started.worktree} (a new branch)` : started.outsideGit ? `${started.folder}, a folder in no Git repository` : `the worktree ${started.worktree}`;
		const notes = started.notes?.length ? ` ${started.notes.join(' ')}` : '';
		// Started is not fetched: the agent fetches its task itself (M7)
		const fetched = started.taskMessage === undefined ? '' : ' It fetches its task itself: list_agents shows when it has.';
		const screen = started.screen ? `\n${excerptText(started.id, started.screen.text)}` : settingUpText(started.settingUp);
		return {
			text: started.status === 'started'
				? `Started ${describe(started)} in ${where}: ${factsText(facade, started)}.${fetched}${ignored}${notes}`
				: `${describe(started)} is not confirmed to have started: ${started.why}. It stays starting - ${factsText(facade, started)} - and may start yet: look at it with list_agents or read_screen, or stop it with stop_agent; do not start it again.${fetched}${ignored}${notes}${screen}`,
			data: started
		};
	}
};
