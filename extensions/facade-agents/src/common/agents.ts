/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { AgentRef, LEAD_RUNG, UsageRecord } from './model';
import { Environment, which } from './spawn';
import { claudeStreamUsage, codexStreamUsage, antigravityStreamUsage, genericStreamUsage } from './usage';

/*
 * How to start each worker agent with Facade's MCP server for that one launch, without writing the
 * agent's own configuration (design doc section 12.3). Claude Code takes `--mcp-config` and
 * `--settings`; Codex takes `-c` overrides. Antigravity, Muse and Grok read project files, which
 * Facade writes into the feature's worktree and keeps out of its commits. Where an agent must be
 * told to trust a fresh worktree, the person agrees first, once per agent.
 *
 * Each agent runs either in a Facade terminal as its interactive self, or headless: its own
 * non-interactive mode, whose output Facade logs and reads token usage from.
 */

/** How to start Facade's MCP server for one worker. */
export interface McpLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

export interface WorkerLaunchInput {
	readonly agent: AgentRef;
	readonly worktree: string;
	/** One line; the contract itself comes from `get_contract`. */
	readonly prompt: string;
	readonly mcp: McpLaunch;
	/** Where the launch may write its own files. */
	readonly runDir: string;
	/** Unique per attempt, used for file names. */
	readonly slug: string;
	/** Acceptance commands, which the worker may run without asking. */
	readonly acceptance: readonly (readonly string[])[];
	/** Run without a terminal UI, in the agent's own non-interactive mode. */
	readonly headless?: boolean;
	/** The person agreed that this agent may trust Facade's worktrees. */
	readonly trusted?: boolean;
	/**
	 * A command line that runs Facade's hook handler for this attempt, for agents whose hooks can
	 * only run commands. The handler's mode is appended as the last argument.
	 */
	readonly hookCommand?: string;
	/**
	 * Set when the agent joins a workspace as a participant (L2-PLAN, step 28) rather than as a
	 * program's worker: no commands are refused, its hooks report its state, and nothing waits on a
	 * contract.
	 */
	readonly participant?: ParticipantLaunch;
}

export interface ParticipantLaunch {
	/** A Claude plugin holding the process skills. */
	readonly pluginDir?: string;
}

/** The hook handler's mode for a participant's event: `event:stop` and the like. */
export function eventMode(event: string): string {
	return `event:${event}`;
}

export interface LaunchSpec {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** Written into the run folder, private to the user, before the launch. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
	/**
	 * Written into the worktree, paths relative to it. Never committed and never counted as the
	 * feature's changes. JSON files that already exist get Facade's entries merged in.
	 */
	readonly injected?: readonly { readonly path: string; readonly content: string }[];
	/** Typed into the agent once it has started, for an agent that takes no prompt argument. */
	readonly initialInput?: string;
}

export interface TrustNeed {
	/** What the person agrees to, in a sentence. */
	readonly detail: string;
	/** Added to the launch once the person agreed; without flags the agent asks in its terminal. */
	readonly flags?: readonly string[];
}

/**
 * A question an agent's own UI asks as it starts, before it can work: whether to trust its folder,
 * or the hooks it was given. Facade picks `choose` for the person, once they let it.
 */
export interface FirstRunAnswer {
	/** The question, as the terminal shows it. */
	readonly question: RegExp;
	/** The option picked, as the terminal shows it. */
	readonly choose: RegExp;
	/** What else the screen must say for Facade to answer: that it asks about what Facade gave it only. */
	readonly onlyIf?: RegExp;
	/** Whether it asks about the folder: answered only in a worktree Facade made for the agent. */
	readonly aboutTheFolder?: boolean;
}

/** The questions an agent asks as it starts that Facade answers once the person let it, and what they agree to. */
export interface FirstRunQuestions {
	readonly detail: string;
	readonly answers: readonly FirstRunAnswer[];
}

export interface AgentAdapter {
	readonly id: string;
	readonly displayName: string;
	/** What to look for on PATH. */
	readonly command: string;
	/** Claude workers draw on the lead's own quota, so they are not on the default ladder. */
	readonly sharesLeadQuota: boolean;
	/** Whether Facade can run it in its non-interactive mode. */
	readonly headless: boolean;
	/** Set when the agent must be told to trust a worktree Facade just made. */
	readonly trust?: TrustNeed;
	/** For a workspace participant: the questions its UI asks as it starts (L2-PLAN, step 28). */
	readonly firstRun?: FirstRunQuestions;
	/** Whether its hooks can only run command lines, so each launch needs a hook launcher. */
	readonly commandHooks?: boolean;
	buildLaunch(input: WorkerLaunchInput, executable: string): LaunchSpec;
	/** Tokens and cost from its headless output, one parsed JSON value per line. */
	usage?(events: readonly unknown[]): UsageRecord | undefined;
}

/** git commands a worker must not run: the engine owns branches and history. */
const FORBIDDEN_GIT = ['push', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'worktree', 'branch -D', 'branch -d', 'tag', 'update-ref'];

/** `git push`, `git merge` and the rest, as command prefixes. */
export const FORBIDDEN_COMMANDS: readonly string[] = FORBIDDEN_GIT.map(command => `git ${command}`);

/** The first two words of each acceptance command, which the worker may run without asking. */
export function commandPrefixes(acceptance: readonly (readonly string[])[]): string[] {
	return [...new Set(acceptance.map(argv => argv.slice(0, 2).join(' ')))];
}

/** The policy an agent's command hook applies, written to a file the hook reads. */
export interface HookPolicy {
	/** The name Facade's MCP server has in the agent's configuration: its tools are always allowed. */
	readonly server: string;
	readonly allowCommands: readonly string[];
	readonly denyCommands: readonly string[];
}

export const claudeAdapter: AgentAdapter = {
	id: 'claude',
	displayName: 'Claude Code',
	command: 'claude',
	sharesLeadQuota: true,
	headless: true,
	firstRun: {
		detail: 'Claude Code asks, in its terminal, whether you trust each folder it starts in. Facade answers yes for you in the worktrees it makes for agents, and nowhere else. Claude Code remembers each answer.',
		answers: [{
			question: /Is this a project you created or one you trust|Do you trust the files in this folder/,
			choose: /Yes, (I trust this folder|proceed)/,
			aboutTheFolder: true
		}]
	},
	buildLaunch(input, executable) {
		if (input.participant) {
			return claudeParticipantLaunch(input, input.participant, executable);
		}
		const configPath = path.join(input.runDir, `${input.slug}.mcp.json`);
		const settingsPath = path.join(input.runDir, `${input.slug}.settings.json`);
		const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
		// Hooks that call Facade's own MCP server: no process to start, nothing to configure.
		const hook = (hookInput: object) => ({ type: 'mcp_tool', server: 'facade', tool: 'worker_hook', input: hookInput });
		const settings = {
			hooks: {
				Stop: [{ hooks: [hook({ event: 'stop', stop_hook_active: '${stop_hook_active}', transcript_path: '${transcript_path}' })] }],
				Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: [hook({ event: 'notification', type: '${notification_type}', message: '${message}' })] }]
			}
		};
		const allowed = ['mcp__facade', ...commandPrefixes(input.acceptance).flatMap(prefix => [`Bash(${prefix})`, `Bash(${prefix} *)`])];
		const denied = FORBIDDEN_COMMANDS.map(command => `Bash(${command} *)`);
		return {
			executable,
			// The prompt goes first: the list options after it would otherwise swallow it.
			args: [
				...(input.headless ? ['-p', input.prompt, '--output-format', 'stream-json', '--verbose'] : [input.prompt]),
				'--mcp-config', configPath,
				// A worker gets Facade's server only, not the user's own servers and connectors, and not
				// the plugins and hooks of the user's settings; the repository's own settings still apply.
				'--strict-mcp-config',
				'--setting-sources', 'project,local',
				'--settings', settingsPath,
				'--permission-mode', 'acceptEdits',
				'--allowedTools', ...allowed,
				'--disallowedTools', ...denied,
				...(input.agent.model ? ['--model', input.agent.model] : [])
			],
			env: {
				// submit_result waits for the checks; a worker must not move it to the background.
				CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: String(24 * 60 * 60 * 1000)
			},
			cwd: input.worktree,
			files: [
				{ path: configPath, content: JSON.stringify(config, undefined, '\t') },
				{ path: settingsPath, content: JSON.stringify(settings, undefined, '\t') }
			]
		};
	},
	usage: claudeStreamUsage
};

/**
 * Claude as a workspace participant: its own interactive UI, which may edit files and run commands
 * without asking, so that a team works on its own while the person watches; anything else it asks in
 * its terminal. Its hooks tell Facade when a turn starts and ends and when it waits at a prompt.
 */
function claudeParticipantLaunch(input: WorkerLaunchInput, participant: ParticipantLaunch, executable: string): LaunchSpec {
	const configPath = path.join(input.runDir, `${input.slug}.mcp.json`);
	const settingsPath = path.join(input.runDir, `${input.slug}.settings.json`);
	const config = { mcpServers: { facade: { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } };
	const hook = (event: string) => ({ type: 'command', command: `${input.hookCommand} ${eventMode(event)}`, timeout: 30 });
	const settings = input.hookCommand ? {
		hooks: {
			Stop: [{ hooks: [hook('stop')] }],
			UserPromptSubmit: [{ hooks: [hook('prompt')] }],
			Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: [hook('notification')] }]
		}
	} : {};
	return {
		executable,
		args: [
			// The prompt goes first: the list options after it would otherwise swallow it.
			input.prompt,
			'--mcp-config', configPath,
			// Facade's server only, not the user's own servers and connectors, nor the plugins and hooks of
			// the user's settings; the repository's own settings still apply.
			'--strict-mcp-config',
			'--setting-sources', 'project,local',
			'--settings', settingsPath,
			...(participant.pluginDir ? ['--plugin-dir', participant.pluginDir] : []),
			'--permission-mode', 'acceptEdits',
			'--allowedTools', 'mcp__facade', 'Bash',
			...(input.agent.model ? ['--model', input.agent.model] : [])
		],
		env: {
			// A recv that waits stays in the turn, rather than moving to the background after two minutes.
			CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: String(24 * 60 * 60 * 1000)
		},
		cwd: input.worktree,
		files: [
			{ path: configPath, content: JSON.stringify(config, undefined, '\t') },
			{ path: settingsPath, content: JSON.stringify(settings, undefined, '\t') }
		]
	};
}

/** A TOML value for Codex's `-c`: JSON strings are valid TOML basic strings. */
function toml(value: string | readonly string[] | { readonly [name: string]: string }): string {
	if (typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
	}
	const entries = Object.entries(value as { readonly [name: string]: string });
	return `{ ${entries.map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(item)}`).join(', ')} }`;
}

export const codexAdapter: AgentAdapter = {
	id: 'codex',
	displayName: 'Codex',
	command: 'codex',
	sharesLeadQuota: false,
	headless: true,
	firstRun: {
		detail: 'Codex asks, in its terminal, whether you trust the hooks Facade gives it, which tell Facade when a turn starts and ends. Facade answers yes for you when those three are all it asks about. Codex remembers the answer.',
		answers: [{
			question: /Hooks need review/,
			choose: /Trust all and continue/,
			// Facade gives it three hooks: with any other number, some are the person's own, theirs to trust
			onlyIf: /\b3 hooks are new or changed\b/
		}]
	},
	buildLaunch(input, executable) {
		if (input.participant) {
			return codexParticipantLaunch(input, executable);
		}
		const set = (key: string, value: string) => ['-c', `mcp_servers.facade.${key}=${value}`];
		return {
			executable,
			args: [
				...(input.headless ? ['exec', '--json'] : []),
				...set('command', toml(input.mcp.command)),
				...set('args', toml(input.mcp.args)),
				...set('env', toml(input.mcp.env)),
				...set('startup_timeout_sec', '30'),
				// ask_lead and submit_result wait; Codex's own default gives a tool 60 seconds.
				...set('tool_timeout_sec', '3600'),
				...set('required', 'true'),
				// Facade's tools are the worker's protocol, not actions to approve one by one.
				...set('default_tools_approval_mode', '"approve"'),
				'--sandbox', 'workspace-write',
				...(input.headless ? [] : ['--ask-for-approval', 'on-request']),
				...(input.agent.model ? ['--model', input.agent.model] : []),
				input.prompt
			],
			env: {},
			cwd: input.worktree,
			files: []
		};
	},
	usage: codexStreamUsage
};

/**
 * Codex as a workspace participant: its own interactive UI, always in its `workspace-write` sandbox.
 * That sandbox keeps `.git` read-only, so Codex cannot commit; the work skill says to leave the
 * changes for whoever merges.
 */
function codexParticipantLaunch(input: WorkerLaunchInput, executable: string): LaunchSpec {
	const set = (key: string, value: string) => ['-c', `mcp_servers.facade.${key}=${value}`];
	const mcp = [
		...set('command', toml(input.mcp.command)),
		...set('args', toml(input.mcp.args)),
		...set('env', toml(input.mcp.env)),
		...set('startup_timeout_sec', '30'),
		// A recv may wait; Codex's own default gives a tool 60 seconds.
		...set('tool_timeout_sec', '3600'),
		...set('required', 'true'),
		// Facade's tools are how it talks to the others, not actions to approve one by one.
		...set('default_tools_approval_mode', '"approve"')
	];
	const model = input.agent.model ? ['--model', input.agent.model] : [];
	// Hooks that tell Facade when a turn starts and ends and when it asks the person. Codex runs a hook
	// once the person trusted its definition, so the command is the same every time.
	const hook = (event: string, name: string) => ['-c', `hooks.${event}=[{ hooks = [{ type = "command", command = ${toml(`${input.hookCommand} ${eventMode(name)}`)}, timeout = 30 }] }]`];
	const hooks = input.hookCommand ? [...hook('Stop', 'stop'), ...hook('UserPromptSubmit', 'prompt'), ...hook('PermissionRequest', 'permission')] : [];
	// Its sandbox bounds what it does; within it, it does not stop to ask, so that a team works on its own.
	const args = [...mcp, ...hooks, '--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...model, input.prompt];
	return { executable, args, env: {}, cwd: input.worktree, files: [] };
}

/**
 * Antigravity reads `.agents/mcp_config.json` and `.agents/hooks.json` from the workspace. Its trust
 * is per exact path and it has no flag for it, so every new worktree asks in the terminal. A
 * PreToolUse hook allows Facade's tools and the acceptance commands and refuses the git commands
 * the engine owns; its Stop hook sends a worker that has not submitted back to work.
 *
 * Interactive only: in its print mode (1.2.12) every MCP call needs the "mcp" permission, which a
 * hook cannot grant (neither "allow" nor permissionOverrides does), so Facade's tools would be
 * refused. Only an allow rule in the user's own settings, or skipping every permission, lets it
 * through; Facade does neither for the person.
 */
export const antigravityAdapter: AgentAdapter = {
	id: 'agy',
	displayName: 'Antigravity',
	command: 'agy',
	sharesLeadQuota: false,
	headless: false,
	trust: { detail: 'Antigravity asks, in its terminal, whether to trust each worktree Facade makes for it. Answer it there.' },
	commandHooks: true,
	buildLaunch(input, executable) {
		const injected: { path: string; content: string }[] = [
			{ path: '.agents/mcp_config.json', content: JSON.stringify({ mcpServers: { facade: { command: input.mcp.command, args: input.mcp.args, env: input.mcp.env } } }, undefined, '\t') }
		];
		if (input.hookCommand) {
			injected.push({
				path: '.agents/hooks.json',
				content: JSON.stringify({
					'facade-worker': {
						// Every MCP tool is called through call_mcp_tool, with the server and tool as arguments.
						PreToolUse: [{ matcher: 'call_mcp_tool|run_command', hooks: [{ type: 'command', command: `${input.hookCommand} agy-pretool`, timeout: 15 }] }],
						// A participant's stop is news for the others; a worker's is checked against its contract.
						Stop: [{ type: 'command', command: `${input.hookCommand} ${input.participant ? eventMode('agy-stop') : 'agy-stop'}`, timeout: 30 }]
					}
				}, undefined, '\t')
			});
		}
		return {
			executable,
			args: [
				...(input.headless ? ['-p', input.prompt, '--output-format', 'stream-json'] : ['-i', input.prompt]),
				'--mode', 'accept-edits',
				...(input.agent.model ? ['--model', input.agent.model] : [])
			],
			env: {},
			cwd: input.worktree,
			files: [],
			injected
		};
	},
	usage: antigravityStreamUsage
};

/**
 * Muse reads `.mcp.json` only from a trusted workspace; `--trust-workspace` trusts it for one run and
 * stores nothing. Its interactive mode takes no prompt argument, so the prompt is typed in.
 */
export const museAdapter: AgentAdapter = {
	id: 'muse',
	displayName: 'Muse',
	command: 'muse',
	sharesLeadQuota: false,
	headless: true,
	trust: { detail: 'Muse runs with --trust-workspace in the worktrees Facade makes for it, so it reads the MCP server Facade writes there. Nothing is stored.', flags: ['--trust-workspace'] },
	buildLaunch(input, executable) {
		const server = { type: 'stdio', command: input.mcp.command, args: input.mcp.args, env: input.mcp.env, required: true, tool_timeout_sec: 3600 };
		const trust = input.trusted ? ['--trust-workspace'] : [];
		return {
			executable,
			args: input.headless
				? ['exec', '--json', ...trust, ...(input.agent.model ? ['--model', input.agent.model] : []), input.prompt]
				: [...trust, ...(input.agent.model ? ['--model', input.agent.model] : [])],
			env: {},
			cwd: input.worktree,
			files: [],
			injected: [{ path: '.mcp.json', content: JSON.stringify({ mcpServers: { facade: server } }, undefined, '\t') }],
			initialInput: input.headless ? undefined : input.prompt
		};
	},
	usage: genericStreamUsage
};

/**
 * Grok reads `.grok/config.toml` from the project once the folder is trusted; `--trust` records that
 * trust in Grok's own list, so the person agrees first. Facade's tools and the acceptance commands
 * are allowed with `--allow` for this run.
 */
export const grokAdapter: AgentAdapter = {
	id: 'grok',
	displayName: 'Grok',
	command: 'grok',
	sharesLeadQuota: false,
	headless: true,
	trust: { detail: 'Grok is started with --trust in the worktrees Facade makes for it, which adds each of them to Grok\'s list of trusted folders.', flags: ['--trust'] },
	buildLaunch(input, executable) {
		const config = [
			'[mcp_servers.facade]',
			`command = ${toml(input.mcp.command)}`,
			`args = ${toml(input.mcp.args)}`,
			`env = ${toml(input.mcp.env)}`,
			'startup_timeout_sec = 30',
			'tool_timeout_sec = 3600',
			''
		].join('\n');
		const allow = ['MCPTool(facade__*)', ...commandPrefixes(input.acceptance).map(prefix => `Bash(${prefix} *)`)].flatMap(rule => ['--allow', rule]);
		// A participant may run what the person may; only a program's worker leaves the branches alone.
		const deny = input.participant ? [] : FORBIDDEN_COMMANDS.flatMap(command => ['--deny', `Bash(${command} *)`]);
		const trust = input.trusted ? ['--trust'] : [];
		return {
			executable,
			args: [
				...(input.headless ? ['--no-auto-update', '-p', input.prompt, '--output-format', 'streaming-json'] : []),
				...trust,
				...allow,
				...deny,
				...(input.agent.model ? ['--model', input.agent.model] : []),
				// A separator, so a prompt is never read as one of Grok's own options.
				...(input.headless ? [] : ['--', input.prompt])
			],
			env: {},
			cwd: input.worktree,
			files: [],
			injected: [{ path: '.grok/config.toml', content: config }]
		};
	},
	usage: genericStreamUsage
};

export const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, grokAdapter];

export interface InstalledAgent {
	readonly adapter: AgentAdapter;
	readonly executable: string;
}

export interface AgentCatalog {
	readonly known: ReadonlySet<string>;
	readonly installed: ReadonlyMap<string, InstalledAgent>;
	/** Every installed agent that does not share the lead's quota, then `lead`. */
	readonly defaultLadder: readonly string[];
}

/** Finds the installed agents. Settings may point an agent at an explicit executable. */
export function detectAgents(env: Environment, overrides: { readonly [id: string]: string } = {}): AgentCatalog {
	const installed = new Map<string, InstalledAgent>();
	for (const adapter of ADAPTERS) {
		const executable = overrides[adapter.id] ? which(overrides[adapter.id], env) : which(adapter.command, env);
		if (executable) {
			installed.set(adapter.id, { adapter, executable });
		}
	}
	const others = [...installed.values()].filter(agent => !agent.adapter.sharesLeadQuota).map(agent => agent.adapter.id);
	const defaultLadder = others.length ? [...others, LEAD_RUNG] : installed.has('claude') ? ['claude', LEAD_RUNG] : [LEAD_RUNG];
	return { known: new Set(ADAPTERS.map(adapter => adapter.id)), installed, defaultLadder };
}
