/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorOutcome, FacadeError } from '../core/errors';
import type { Facade, Started } from '../core/facade';
import type { SetupProgress } from '../core/ports';
import { excerptText } from '../core/screens';
import { agentRef, describe, messageRef } from '../record/events';
import { Args } from './args';
import { factsText } from './listAgents';
import type { ContractTool } from './tools';

const PARAMS = ['name', 'cli', 'model?', 'effort?', 'task?', 'folder?', 'new_worktree?'];

/**
 * What of the model and effort a start was given is not known to be applied, and why: its launch has no group for it,
 * so its CLI was not given it and its own applies; or - an effort given with a model whose name may carry one of its own -
 * its CLI was given it, and may run at the model's instead (O3; N-64; OR-01).
 */
function ignoredLines(facade: Facade, started: Started): string[] {
	const byModel = started.ignored.includes('effort') && started.model !== undefined && !started.ignored.includes('model') && facade.modelCarriesEffort(started.cli);
	const noGroup = started.ignored.filter(what => !(what === 'effort' && byModel));
	const fields = noGroup.join(' and ');
	return [
		...noGroup.length ? [`Requested ${fields} could not be applied: ${started.cli}'s launch has no corresponding argument group. The CLI's defaults apply; the actual ${fields} ${noGroup.length === 1 ? 'is' : 'are'} unknown.`] : [],
		...byModel ? [`The requested effort was passed to ${facade.cliName(started.cli)}, but model ${started.model} may specify an overriding effort. The actual effort is unknown.`] : []
	];
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
	const text = `${first}${/[.!?]$/.test(first) ? '' : '.'}\nRun facts: ${factsText(facade, facts)}.`;
	const data: FailedStart = { ...outcome, ...facts, status: 'failed', newWorktree };
	return new FacadeError(err.code, [text, ...rest].join('\n'), data);
}

/**
 * Where the setup of the worktree of a start that is not confirmed is, as its answer says it - the line running, and the last
 * lines of its setup terminal - for a start with no terminal of its own yet (O3: setup diagnostics). None without one.
 */
function settingUpLines(settingUp: SetupProgress | undefined): string[] {
	if (!settingUp) {
		return [];
	}
	return [
		settingUp.running !== undefined ? `Running worktree setup command: \`${settingUp.running}\`.` : 'Worktree setup is running.',
		settingUp.lines.length ? `Setup terminal excerpt:\n${settingUp.lines.join('\n')}` : 'The setup terminal has no output yet.'
	];
}

/** The `cli` parameter as the model is told it, with the CLIs it can start, as far as that is known. */
function cliParameter(available: string): object {
	return { type: 'string', description: `CLI ID or custom agent name. Available when listed: ${available}. Use list_agents to refresh availability and supported options.` };
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
		description: 'Start a separate CLI with your YOLO mode. An optional task is sent as a mailbox message. Returns agent/task IDs at launch readiness, not task retrieval or completion; list_agents shows delivery. An unconfirmed start continues under the same ID: inspect with list_agents/read_screen or stop it; do not launch a duplicate. Startup can take a minute. Facade passes model and effort through without validating CLI support.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Name without @: 1-40 lowercase letters, digits, dots, dashes, or underscores; start with a letter or digit. Names may repeat. With new_worktree:true, also used as the branch name.' },
				// Only the window knows what this machine has
				cli: cliParameter('unknown while the window is disconnected'),
				model: { type: 'string', description: 'Value for the CLI\'s --model option. Omit to use its default.' },
				effort: { type: 'string', description: 'CLI reasoning effort, such as low, medium, or high. Omit to use its default. Does not require model.' },
				task: { type: 'string', description: 'Nonempty task text, preserved exactly and sent from you to the child\'s mailbox. Omit to start without a task, waiting at the CLI prompt for input or mail.' },
				folder: { type: 'string', description: 'Absolute path of a window folder or worktree, or a checked-out branch in your repository. Defaults to your launch folder; @human uses the selected folder.' },
				new_worktree: { type: 'boolean', description: 'Create a worktree and branch using the name argument. Uses your HEAD in your repository, otherwise the target main checkout\'s HEAD. Uncommitted edits are excluded; required work must be in that commit.' }
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
					cli: cliParameter(startable.map(each => each.custom ? `${each.id} (custom)` : `${each.id} (${each.displayName})`).join(', ') || 'none on this machine')
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
		// A folder in no Git repository has no worktree (N-57)
		const where = started.newWorktree ? `new worktree ${started.worktree} on a new branch` : started.outsideGit ? `${started.folder} (not a Git repository)` : `worktree ${started.worktree}`;
		// Started is not fetched: the agent fetches its task itself (M7). Each fact on a line of its own
		const more = [
			...started.taskMessage === undefined ? [] : [`The child must fetch task ${messageRef(started.taskMessage)} itself. Launch readiness does not confirm task retrieval; list_agents shows delivery.`],
			...ignoredLines(facade, started),
			...started.notes ?? []
		];
		const lines = started.status === 'started'
			? [`Started ${describe(started)} in ${where}.`, `${factsText(facade, started)}.`, ...more]
			: [
				`Start unconfirmed for ${describe(started)}: ${started.why}.`,
				`${factsText(facade, started)}.`,
				`This start is still pending. Inspect ${agentRef(started.id)} with list_agents or read_screen, or cancel it with stop_agent. Do not start a duplicate.`,
				...more,
				...started.screen ? [excerptText(started.id, started.screen.text)] : settingUpLines(started.settingUp)
			];
		return { text: lines.join('\n'), data: started };
	}
};
