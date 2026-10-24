/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorOutcome, FacadeError } from '../core/errors';
import type { Facade, Started } from '../core/facade';
import { WINDOW_REQUESTS } from '../core/machine';
import type { SetupProgress } from '../core/ports';
import { excerptText } from '../core/screens';
import { agentRef, Caller, describe, messageRef } from '../record/events';
import { Progress, ToolResult, toolResultOf } from '../transport/protocol';
import { Args } from './args';
import { factsText } from './listAgents';
import type { ContractTool } from './tools';

const PARAMS = ['name', 'cli', 'model?', 'effort?', 'task?', 'folder?', 'new_worktree?', 'workspace?'];

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

/**
 * Hands a start to the workspace `where` that has its folder, for `caller` (O3, O8): with the commit of the caller's own
 * checkout where a new worktree may be of its repository, and the caller's wait. That workspace starts the child as the
 * caller's, and answers as a start here does; this one records the child as the caller's, in that workspace, and the
 * sender's copy of its task. A reply lost after that workspace gave the child its number still says the number.
 */
async function startElsewhere(facade: Facade, caller: Caller, where: { readonly record: string; readonly label: string }, request: { readonly name: string; readonly cli: string; readonly model?: string; readonly effort?: string; readonly task?: string; readonly folder?: string; readonly newWorktree?: boolean }, progress: Progress): Promise<ToolResult> {
	const machine = facade.machine;
	if (!machine) {
		throw new FacadeError('UNAVAILABLE', `Cannot reach workspace ${where.label}: this workspace has no link to other workspaces.`);
	}
	const head = request.newWorktree ? await facade.callerHead(caller) : undefined;
	let id: number | undefined;
	const args = {
		name: request.name, cli: request.cli,
		...(request.model !== undefined ? { model: request.model } : {}), ...(request.effort !== undefined ? { effort: request.effort } : {}),
		...(request.task !== undefined ? { task: request.task } : {}), ...(request.folder !== undefined ? { folder: request.folder } : {}),
		...(request.newWorktree !== undefined ? { new_worktree: request.newWorktree } : {})
	};
	let answer: unknown;
	try {
		answer = await machine.call(where.record, WINDOW_REQUESTS.start, { caller: facade.identityOf(caller), args, ...(head ? { head } : {}), waitMs: facade.waitMs() }, message => {
			// Its number, as soon as it was recorded there: what a lost reply still tells (O3)
			const recorded = /^Recorded @\S+ #a(\d+)/.exec(message);
			if (recorded && id === undefined) {
				id = Number(recorded[1]);
				facade.childStartedAfar(caller, { id, name: request.name, window: where.record, label: where.label });
			}
			progress(message);
		});
	} catch (err) {
		if (id !== undefined && err instanceof FacadeError) {
			throw new FacadeError(err.code, `${err.message}\nThe child was recorded as ${agentRef(id)} in workspace ${where.label}: inspect it with list_agents all:true or read_screen before starting another.`, { ...err.outcome, agent: id, outcome: err.outcome?.outcome ?? 'unknown' });
		}
		throw err;
	}
	const result = toolResultOf(answer);
	if (!result) {
		throw new FacadeError('FAILED', `Workspace ${where.label} answered the start with nothing that can be read.${id !== undefined ? ` The child was recorded as ${agentRef(id)} there.` : ''} Its effects are unknown; inspect with list_agents all:true before retrying.`, { outcome: 'unknown', ...(id !== undefined ? { agent: id } : {}) });
	}
	const data = (result.data ?? {}) as { id?: unknown; name?: unknown; taskMessage?: unknown };
	if (typeof data.id === 'number') {
		facade.childStartedAfar(caller, { id: data.id, name: typeof data.name === 'string' ? data.name : request.name, window: where.record, label: where.label }, typeof data.taskMessage === 'number' && request.task !== undefined ? { id: data.taskMessage, text: request.task } : undefined);
	}
	return { ...result, text: `${result.text}\n${result.isError ? `Workspace ${where.label} carried out this start.` : `The child runs in workspace ${where.label}.`}`, data: { ...(result.data as object ?? {}), workspace: where.label } };
}

/** The `cli` parameter as the model is told it, with the CLIs it can start, as far as that is known. */
function cliParameter(available: string): object {
	return { type: 'string', description: `CLI ID or custom agent name. Available when listed: ${available}. Use list_agents to refresh availability and supported options.` };
}

/**
 * `start_agent` (AGENT-ORCHESTRATION.md, O3): starts an agent in its own UI, in the workspace that has its folder - an
 * agent's child in a main checkout, a worktree Facade made or a new one; with worktree management off, in a folder that
 * workspace knows. It answers with the agent's number once it has started, or that its start is not confirmed.
 */
export const startAgentTool: ContractTool = {
	findsClis: true,
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
				folder: { type: 'string', description: 'Launch folder; with new_worktree:true, the folder whose repository will supply the new worktree. Use an absolute path of a folder of your workspace or of another Facade workspace on this machine - the child then starts in that workspace - or a branch checked out in your repository. With worktree management on, an agent\'s child needs a main checkout or a worktree created by Facade unless new_worktree:true; @human may use any folder. Defaults to your registered launch folder; @human defaults to the selected folder. Multiple agents may share a folder. With management off, use an absolute path to an existing window folder or recorded agent launch folder; branch lookup and new_worktree:true are unavailable.' },
				new_worktree: { type: 'boolean', default: false, description: 'Create a worktree and a new branch named name in the repository selected by folder. Uses your launch checkout\'s HEAD in the same repository, otherwise the target main checkout\'s HEAD. Uncommitted edits are excluded; required work must be in that commit. Unavailable when facade.workspaceBar.worktrees is false.' },
				workspace: { type: 'string', description: 'The Facade workspace to start in, by its name or the start of its record id, as list_agents names workspaces. It must have folder (your own launch folder when folder is omitted). Omit to start in your own workspace when it has the folder, else in the one workspace on this machine that has it.' }
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
	async call(facade, caller, input, progress, _whenWritten, forwarded) {
		const args = new Args('start_agent', PARAMS, input);
		const name = args.text('name');
		const cli = args.text('cli');
		const model = args.optionalText('model');
		const effort = args.optionalText('effort');
		// As it was written: kept, and read, exactly (X-56)
		const task = args.optionalWords('task');
		const folder = args.optionalText('folder');
		const newWorktree = args.boolean('new_worktree');
		const workspace = args.optionalText('workspace');
		// A folder of another workspace: that workspace carries out the start, for this caller (O3, O8)
		const target = await facade.startWhere(caller, folder, workspace);
		if (!target.here) {
			// The folder as this workspace found it - the caller's own where it named none - which the other has (O3)
			return startElsewhere(facade, caller, target, { name, cli, model, effort, task, folder: target.folder, newWorktree }, progress);
		}
		let started: Started;
		try {
			started = await facade.startAgent(caller, {
				name,
				cli,
				...(model !== undefined ? { model } : {}),
				...(effort !== undefined ? { effort } : {}),
				...(task !== undefined ? { task } : {}),
				...(folder !== undefined ? { folder } : {}),
				...(newWorktree !== undefined ? { newWorktree } : {}),
				...(forwarded?.head ? { head: forwarded.head } : {}),
				...(forwarded?.waitMs ? { waitMs: forwarded.waitMs } : {})
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
