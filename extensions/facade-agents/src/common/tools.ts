/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonSchema, McpTool } from './mcp';

/*
 * The tools each role sees (design doc sections 11.5 and 11.6). The role comes from the caller's
 * token, so a worker never sees a lead tool: delegation is one level deep by construction. No tool
 * approves anything: plans and shipping are approved by the person, in Facade.
 */

export type Role = 'lead' | 'worker';

const text = (description: string, maxLength?: number): JsonSchema => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const textList = (description: string): JsonSchema => ({ type: 'array', description, items: { type: 'string' } });
const programId: JsonSchema = text('The program id, for example "p-4k2d".');

const command: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['argv'],
	properties: {
		argv: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'The program and its arguments. Never a shell string: ["npm", "test"], not "npm test".' },
		cwd: text('Folder to run in, relative to the repository root. Defaults to the root.'),
		timeoutSec: { type: 'integer', minimum: 5, maximum: 7200, description: 'Defaults to 600.' },
		covers: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Which criteria (counted from 1) this command checks.' }
	}
};

const feature: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'title', 'goal', 'owns', 'acceptance', 'size', 'risk'],
	properties: {
		id: text('"f1", "f2" and so on.'),
		title: text('An English imperative sentence, used as the commit title: "Add Codex adapter".', 80),
		goal: text('The outcome, not the steps.', 4000),
		owns: textList('Paths or globs relative to the repository root that only this feature may change. A path without wildcards covers everything below it. No two features may own the same path.'),
		reads: textList('Files or symbols the worker should read first.'),
		interfaces: {
			type: 'object',
			additionalProperties: false,
			properties: {
				consumes: textList('Interfaces this feature uses, as "path#Symbol(signature)". Each must come from the scaffold or from a feature in dependsOn.'),
				provides: textList('Interfaces this feature defines for others, as "path#Symbol(signature)".')
			}
		},
		acceptance: {
			type: 'object',
			additionalProperties: false,
			required: ['criteria', 'commands'],
			properties: {
				criteria: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'What must be true when the feature is done.' },
				commands: { type: 'array', minItems: 1, items: command, description: 'Commands Facade runs in the feature\'s worktree. At least one must fail before the work and pass after.' }
			}
		},
		dependsOn: textList('Features that must be merged before this one starts. Prefer a scaffold stub over a dependency.'),
		size: { type: 'string', enum: ['S', 'M'], description: 'S: up to about 150 changed lines. M: up to about 400. Split anything larger.' },
		risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How closely the change must be reviewed.' },
		ladder: textList('Agents to try in order, for example ["codex", "claude:sonnet", "lead"]. Omit to use the program\'s.'),
		detail: { type: 'string', enum: ['brief', 'full'], description: '"full" when the first agent is a small model and needs exact steps.' }
	}
};

export const PLAN_SCHEMA: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['schema', 'goal', 'approach', 'base', 'conventions', 'scaffold', 'checks', 'features'],
	properties: {
		schema: { type: 'integer', enum: [1] },
		goal: text('The user\'s goal, in their words.', 4000),
		approach: text('How you split it, in a few sentences.', 2000),
		base: text('The branch to start from, for example "main".'),
		integrationBranch: text('Branch the features merge into. Defaults to "facade/<program>-<slug>".'),
		conventions: textList('The repository\'s rules every worker must follow, one per line, copied from AGENTS.md, CLAUDE.md or contributing docs.'),
		scaffold: {
			type: 'object',
			additionalProperties: false,
			required: ['summary', 'paths'],
			properties: {
				summary: text('What you will commit before the features start: shared types and interfaces, registries, stubs, test skeletons, dependency changes.'),
				paths: textList('Files the scaffold creates or changes. Empty when the program needs no scaffold.'),
				provides: textList('Interfaces the scaffold defines, as "path#Symbol(signature)".')
			}
		},
		checks: {
			type: 'object',
			additionalProperties: false,
			required: ['fast', 'full'],
			properties: {
				fast: { type: 'array', minItems: 1, items: command, description: 'About five minutes at most; runs on the scaffold and after every merge.' },
				full: { type: 'array', items: command, description: 'The repository\'s own gate.' }
			}
		},
		features: { type: 'array', minItems: 2, maxItems: 12, items: feature },
		policy: {
			type: 'object',
			additionalProperties: false,
			properties: {
				maxParallel: { type: 'integer', minimum: 1, maximum: 12 },
				ladder: textList('The default ladder for every feature.'),
				retriesPerRung: { type: 'integer', minimum: 0, maximum: 5 }
			}
		}
	}
};

const finding: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['severity', 'title', 'detail'],
	properties: {
		severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'], description: 'blocker: wrong behaviour, lost data, security, a broken contract or rule, weakened tests. major: an unhandled expected error path, a criterion without a test, duplicated logic, a clear performance regression. minor: readability, local style. nit: preference.' },
		title: text('One line.', 200),
		detail: text('What is wrong and why it matters.', 4000),
		path: text('The file, relative to the repository root.'),
		line: { type: 'integer', minimum: 1 },
		suggestion: text('How to fix it, if you know.', 2000)
	}
};

/** The tools a reviewer subagent may use: it reads a packet and records what it found, nothing else. */
export const REVIEW_TOOLS: readonly McpTool[] = [
	{
		name: 'review_packet',
		title: 'Write a review packet',
		description: 'Writes the review packet of a merge - rubric, contract, evidence, commits and diff - or, with target "integration", the packet for reviewing the whole program, and returns its path and size. The content is in the file, not in the result.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id', 'target'], properties: { program_id: programId, target: text('A merge commit (from the event or the digest), a feature id for its latest merge, or "integration".') } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'review_record',
		title: 'Record a review',
		description: 'Records the review of one merge, or of the whole program with target "integration": the findings, and for a fix, whether each finding it claims to fix is addressed. Record a review even when you found nothing. Findings already recorded at the same place are merged, not added twice.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id', 'target', 'findings'], properties: {
				program_id: programId,
				target: text('The merge commit the packet names, or "integration".'),
				findings: { type: 'array', items: finding, description: 'New problems; empty when there are none.' },
				addressed: {
					type: 'array', description: 'For a fix: each finding it claims to fix, addressed or not.', items: {
						type: 'object', additionalProperties: false, required: ['id', 'status'], properties: {
							id: text('For example "r2".'),
							status: { type: 'string', enum: ['addressed', 'not_addressed'] },
							note: text('Why not, when not addressed.', 1000)
						}
					}
				}
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	}
];

export const LEAD_TOOLS: readonly McpTool[] = [
	{
		name: 'plan_save',
		title: 'Save plan',
		description: 'Saves a program plan and checks it: features must own disjoint files, shared files belong to the scaffold, every feature needs an acceptance command, and every agent must exist. Returns every problem at once; fix them and save again with the same program_id. Saving touches no files and no git state.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: PLAN_SCHEMA, program_id: text('Omit to create a program; pass it to replace that program\'s plan before approval.') } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'plan_submit',
		title: 'Submit plan for approval',
		description: 'Pins the base commit and asks the user to approve the plan in Facade. You cannot approve it yourself. The answer arrives as a plan.approved or plan.changes_requested event from await_events.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id'], properties: { program_id: programId } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'lead_workspace',
		title: 'Get your worktree',
		description: 'Creates your own worktree for the program at the tip of the integration branch, or brings it up to that tip, and returns its path. Enter it with EnterWorktree. With feature, it also merges that feature\'s branch in, to finish a feature that needs you. With sync, it also merges the base branch in, to resolve a conflict with it. Refuses while your worktree has changes you have not submitted. Needs an approved plan.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id'], properties: {
				program_id: programId,
				feature: text('A feature that needs you, to finish it yourself.'),
				sync: { type: 'boolean', description: 'Also merge the base branch in, when it conflicts with the integration branch.' }
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'lead_submit',
		title: 'Submit your changes',
		description: 'Commits everything in your worktree and puts it in the merge queue, which merges it with the integration branch, runs the fast checks on the result and moves the branch only when they pass. Returns once it is merged, or with why not: failed checks or a conflict. kind: "scaffold" before the features start; "fix" for findings routed to you (list them in resolves); "resolve" after resolving a conflict; "implement" to finish a feature that needs you (name it in feature).',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id', 'kind', 'message'], properties: {
				program_id: programId,
				kind: { type: 'string', enum: ['scaffold', 'fix', 'resolve', 'implement'] },
				message: text('The commit message, in English: a title line, a blank line, then the body.', 4000),
				resolves: textList('For kind "fix": the ids of the findings routed to you that this change fixes, for example ["r2"]. Omit for a fix no finding asked for, such as failing full checks.'),
				feature: text('For kind "implement": the feature you finished.')
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'program_start',
		title: 'Start the program',
		description: 'Starts workers on the features, as many at once as the slots allow, each in its own worktree branched from the integration branch. Needs an approved plan and, when the plan has a scaffold, the scaffold merged. Returns a cursor for await_events.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id'], properties: { program_id: programId } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'await_events',
		title: 'Wait for events',
		description: 'Waits until something needs you - a question, a merge to review, findings to route, a feature that ran out of agents, a conflict, the user\'s decision - and returns those events and a new cursor. Returns at once if events are already waiting. Call it again with the new cursor; never poll program_status in a loop and never sleep.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id'], properties: {
				program_id: programId,
				cursor: { type: 'integer', minimum: 0, description: 'The cursor from the last call; 0 or omitted for everything so far.' },
				timeout_sec: { type: 'integer', minimum: 1, maximum: 600, description: 'Defaults to 600.' }
			}
		},
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'program_status',
		title: 'Program status',
		description: 'A short digest of a program: phase, every feature\'s state, the queue, merges waiting for review, open findings and questions, and what to do next. Without program_id, lists the programs in this repository. Call it first after a compaction or in a new session.',
		inputSchema: { type: 'object', additionalProperties: false, properties: { program_id: programId } },
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'answer',
		title: 'Answer a worker',
		description: 'Answers a question a worker asked with ask_lead. Ask the user first when the question is theirs to decide.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id', 'question_id', 'text'], properties: { program_id: programId, question_id: text('For example "q-3".'), text: text('The answer.', 4000) } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'feature_update',
		title: 'Change a feature\'s course',
		description: 'retry: start the feature over on its current agent, with its failure count reset. reassign: give it a new ladder, for example ["claude:sonnet", "lead"]. abandon: drop it from the program; its branch stays.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id', 'feature_id', 'op'], properties: {
				program_id: programId,
				feature_id: text('For example "f2".'),
				op: { type: 'string', enum: ['retry', 'reassign', 'abandon'] },
				ladder: textList('For reassign.')
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'program_control',
		title: 'Pause or resume',
		description: 'pause: start no new workers; running ones continue. resume: start them again. Stopping a program for good is the user\'s decision, made in Facade.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id', 'op'], properties: { program_id: programId, op: { type: 'string', enum: ['pause', 'resume'] } } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	...REVIEW_TOOLS,
	{
		name: 'review_route',
		title: 'Route findings',
		description: 'Decides who handles each open finding. worker: inside one merged feature\'s files, and bigger than about 20 lines or needing test runs; Facade sends all of a feature\'s findings to its worker as one fix attempt. lead: it crosses features, touches scaffold files, or is small: fix it yourself and lead_submit with kind "fix". follow-up: not needed for the goal; never for a blocker. wontfix: the finding is wrong. follow-up and wontfix need a ruling, which the user reads before shipping. After three fix rounds a finding must be ruled on.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['program_id', 'items'], properties: {
				program_id: programId,
				items: {
					type: 'array', minItems: 1, items: {
						type: 'object', additionalProperties: false, required: ['id', 'route'], properties: {
							id: text('For example "r3".'),
							route: { type: 'string', enum: ['worker', 'lead', 'follow-up', 'wontfix'] },
							ruling: text('Why, for follow-up and wontfix.', 1000)
						}
					}
				}
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'review_complete',
		title: 'Complete the review',
		description: 'Declares the review done, with a summary for the merge message. Accepted only when every feature is merged or abandoned, the full checks pass on the integration tip, no blocker or major finding is open or being fixed, every fix was re-reviewed, every merge has a review, and the whole program was reviewed. Otherwise it lists what is missing.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id', 'summary'], properties: { program_id: programId, summary: text('What the program does and what the review found, in a few sentences of English.', 4000) } },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'ship',
		title: 'Ship',
		description: 'Asks the user to approve putting the reviewed integration branch into the base branch. merge: a merge commit, what most repositories\' rules want. squash: one commit. pr: push the branch and open a pull request. If the base branch moved, Facade first merges it into the integration branch through the queue, and that merge needs a review too. You cannot approve shipping yourself; the result arrives as ship.done or ship.failed.',
		inputSchema: { type: 'object', additionalProperties: false, required: ['program_id', 'mode'], properties: { program_id: programId, mode: { type: 'string', enum: ['merge', 'squash', 'pr'] } } },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
	}
];

export const WORKER_TOOLS: readonly McpTool[] = [
	{
		name: 'get_contract',
		title: 'Get your contract',
		description: 'Your task: the goal, the files you own, what must be true when you are done, and the commands Facade will run. Call it first, and again whenever you lose track.',
		inputSchema: { type: 'object', additionalProperties: false, properties: {} },
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'report_progress',
		title: 'Report progress',
		description: 'Tells Facade your steps and which one you are on. Call it when you start a step. The reply carries any messages from the lead; follow them.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['steps'], properties: {
				steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'status'], properties: { title: text('A short step.', 200), status: { type: 'string', enum: ['pending', 'active', 'done'] } } } },
				note: text('One sentence on where you are.', 500)
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	{
		name: 'ask_lead',
		title: 'Ask the lead',
		description: 'Asks the lead a question when a decision blocks you, and waits for the answer. If the reply is "pending", call again with the question_id to keep waiting. If it times out, choose the most reasonable option and record it under assumptions in submit_result.',
		inputSchema: {
			type: 'object', additionalProperties: false, properties: {
				question: text('A concrete question. Required on the first call.', 2000),
				options: textList('The choices you see, if any.'),
				question_id: text('To keep waiting on a question you asked.'),
				wait_sec: { type: 'integer', minimum: 1, maximum: 600, description: 'How long to wait this call. Defaults to 300.' }
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'submit_result',
		title: 'Submit your result',
		description: 'Hands in your work. Facade checks that you only changed files you own, commits your changes, and runs the acceptance commands; this call returns when they finish. "verified": you are done, stop. "changes_required": read why, fix it, and call submit_result again. "stop": another agent takes over; stop now.',
		inputSchema: {
			type: 'object', additionalProperties: false, required: ['outcome', 'summary', 'criteria'], properties: {
				outcome: { type: 'string', enum: ['done', 'partial', 'blocked'] },
				summary: text('What you did, in a few sentences.', 2000),
				criteria: {
					type: 'array', items: {
						type: 'object', additionalProperties: false, required: ['id', 'status'], properties: {
							id: text('"c1", "c2" and so on, from get_contract.'),
							status: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
							evidence: { type: 'array', maxItems: 5, items: { type: 'string' } }
						}
					}
				},
				assumptions: textList('Decisions you made without an answer.'),
				risks: textList('What might break.')
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	{
		name: 'worker_hook',
		title: 'Facade hook',
		description: 'Called by your own hooks, not by you. Never call it yourself.',
		inputSchema: {
			type: 'object', additionalProperties: true, required: ['event'], properties: {
				event: { type: 'string', enum: ['stop', 'notification', 'agy-stop'] }
			}
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	}
];

/** What a client sees when the shim cannot reach a Facade window. */
export const DISCONNECTED_TOOLS: readonly McpTool[] = [
	{
		name: 'facade_status',
		title: 'Facade connection status',
		description: 'Explains why Facade\'s tools are unavailable and how to connect.',
		inputSchema: { type: 'object', additionalProperties: false, properties: {} },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}
];

export function toolsFor(role: Role): readonly McpTool[] {
	return role === 'lead' ? LEAD_TOOLS : WORKER_TOOLS;
}
