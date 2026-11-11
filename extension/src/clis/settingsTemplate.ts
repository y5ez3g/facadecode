/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text of a settings file Facade makes (CONFIGURATION-1.3): every built-in with all of its fields, the built-in names, what Facade
// gives each CLI and why, and entries of the person's own to start from - written for a person to read at once. Values go in its
// {{tokens}}.

import { isJsonObject } from '../base/json';
import { BUILT_IN_NAMES } from '../base/names';
import { BUILT_IN_FACTS } from './catalog';
import type { BuiltInFacts } from './entries';

const TEMPLATE = `// Facade settings. A saved change applies to agents started afterwards; running agents keep
// the settings they started with.
{
	// Choose how much approval agents require, and how far their tools can reach:
	// - When set to true, each CLI runs in its no-approval mode. An agent's Facade tools can reach
	//   every agent across all of your Facade windows on this computer.
	// - When set to false, each CLI keeps its normal approval prompts and sandbox. An agent's Facade
	//   tools can reach only its own family: the agent you started, and every agent started from it,
	//   directly or through other agents. That includes the agent that started it and its siblings,
	//   while agents from your other starts remain out of reach.
	"yolo": {{yolo}},

	// Choose the names suggested when starting an agent, or resuming a conversation with no name:
	// - New Agent and Resume fill in a random name from this list that no agent in this window is
	//   using. You can keep or change it; a blank name is filled in the same way.
	// - Edit the list to remove names, or add your own. If every name in the list is in use,
	//   or the list is empty, the agent is named by its ID, such as #a1.
	"names": {{names}},

	// Every entry takes eight fields. A field left out or commented out takes its default:
	// - type: CLI to run (claude, codex, agy, muse, opencode, pi, custom). Needed if you add one.
	// - icon: the entry's icon in the panel, New Agent and terminal tab. Two kinds of values:
	//   A CLI's own icon: claude, codex, agy, muse, opencode, or pi.
	//   A Facade robot: facade-red, facade-orange, facade-amber, facade-lime, facade-green,
	//     facade-teal, facade-sky, facade-blue, facade-violet, facade-pink, facade-aurora,
	//     facade-sunset, facade-ocean, facade-orchid, facade-pearl, or facade-graphite.
	//   Default: its type's own icon, or facade-pearl for custom.
	// - command: program to run; custom requires it. Default: the CLI's own on PATH, like claude.
	// - args: command-line options for the CLI, added after Facade's own. Default: none.
	// - env: environment variables for the CLI; one set to null is removed. Default: none.
	// - model: default model for CLIs that take one. A custom entry or OpenCode cannot set it.
	// - effort: default effort for CLIs that take it. A custom entry or OpenCode cannot set it.
	// - enabled: false hides the entry from New Agent. Default: true.
	//
	// Why Facade adds command-line options and environment variables:
	// - Tools: Facade provides each agent with an MCP server and a skill, allowing agents to start
	//   other agents, send each other messages, and read each other's terminal screens.
	// - Resume and Pin: Facade supplies a session ID or registers hooks so the CLI writes down which
	//   conversation the agent is in. The CLI records the conversation's ID—never its text—into the
	//   file named by FACADE_CODE_SESSION_FILE. Resume and Pin then reopen exactly that conversation,
	//   not just the latest one.
	// - Startup: Facade marks the workspace folder as trusted before the CLI starts, so that no trust
	//   question stops the CLI before the agent receives its first task.
	// - YOLO: Facade translates this single switch into each CLI's native approval and sandbox options.
	// - Privacy: Settings that might contain keys are written to a run file that, on macOS and
	//   Linux, only your account can read; on Windows it takes its folder's permissions. They stay
	//   off the command line, where any process list would show them.
	// - Only this run: Everything Facade adds applies strictly to that single run, except that when
	//   Muse Code on Windows starts through cmd.exe or the folder's .mcp.json already names a
	//   facade server, Facade adds its server entry to that .mcp.json, which every Muse Code run in
	//   the folder shares. Facade never modifies the CLIs' own settings files, except to mark the
	//   workspace folder as trusted in Claude Code (~/.claude.json) and Antigravity
	//   (~/.gemini/antigravity-cli/settings.json). For Codex and Muse Code, Facade places its skill
	//   in .agents/skills/facade, and for Antigravity its plugin in .agents/plugins/facade.
	//
	// Shared rules for all six CLIs, with YOLO on or off:
	//
	// Variables that Facade sets:
	// Facade sets these variables for every agent, and your own "env" cannot override them:
	// - FACADE_AGENT contains the agent's ID, such as #a1, so Facade's tools know which agent is calling.
	// - FACADE_CODE_SESSION_FILE contains the path where the CLI writes down which conversation the agent
	//   is in (recording its ID, not its text), which Resume and Pin use to reopen it.
	// - TERM_PROGRAM=vscode and COLORTERM=truecolor provide the same values VS Code's own terminal sets.
	// - ELECTRON_RUN_AS_NODE is removed so that CLIs built on Electron do not run as plain Node.
	//
	// Model and effort precedence:
	// The model or effort you choose when starting an agent comes first. If you do not choose one then,
	// Facade uses the "model" or "effort" set in the agent's entry under "clis". If neither is set,
	// the CLI uses its own default. OpenCode is the exception: Facade passes neither option to
	// OpenCode, and setting "model" or "effort" in its entry is an error; you configure them in
	// OpenCode's own configuration instead.
	//
	// Your custom arguments ("args"):
	// Facade keeps your arguments exactly as written and places them after its own options. When an agent
	// is given a first task, that task still comes last. Facade refuses options that it controls itself,
	// reporting an error that names the option and where it was set. Refused options include approval and
	// YOLO options, model, effort, the session, the folder, where the session runs, print modes, options
	// that turn off Facade's tools, \`--\`, and plain positional arguments.
	//
	// Your custom environment variables ("env"):
	// Your variables override those the agent would otherwise inherit from the editor's terminal.
	// Writing "\${env:NAME}" reads NAME from the editor's own environment, and results in an error if NAME
	// is missing. Setting a variable to null removes it from the agent's environment.
	//
	// First tasks and resuming:
	// When an agent is given an initial task, Facade passes it last: after --, or with --prompt for
	// OpenCode, or typed into the terminal for Antigravity. This applies whether the agent is new or
	// resumed; resuming is a separate option that Facade adds itself, and each CLI's section below
	// names it.
	"clis": {
		// Claude Code
		//
		// What Facade always adds:
		// - Facade creates a run file and passes it via --settings. This file holds session hooks for
		//   Resume and Pin, applies your entry's "env", and turns off any MCP server named "facade" in the
		//   project's .mcp.json: Claude Code would otherwise stop at startup to ask about it, and the run
		//   already has its own Facade tools.
		// - Facade passes --mcp-config, --plugin-dir, and --allowedTools mcp__facade to load Facade's tools
		//   and skill and allow the tools without asking.
		// - Facade passes --session-id <new id> for a new agent, or --resume <id> to resume
		//   an existing one.
		// - Facade sets CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1 unless you set it. Without this variable,
		//   Claude Code installs its extension and waits for Enter in the terminal, blocking all messages.
		// - Facade removes CLAUDE_CODE_DISABLE_TERMINAL_TITLE from the environment and
		//   sets it to an empty value in the run file, so that Claude Code's own settings cannot
		//   turn it back on. That switch turns off Claude Code's terminal titles and, with
		//   them, the status reports Facade uses to show whether the agent is working.
		// - Facade marks the workspace folder as trusted in ~/.claude.json.
		//
		// Approvals and sandboxing:
		// - When YOLO is on, Facade passes --dangerously-skip-permissions; Claude Code's sandbox
		//   follows your own Claude Code setting.
		// - When YOLO is off, the run file turns on Claude Code's sandbox on macOS and Linux,
		//   and Claude Code prompts for approval as it normally does.
		//
		// Model and effort:
		// - Facade passes your chosen model with --model and your chosen effort with --effort.
		//
		// Where your args and env differ from the shared rules:
		// - Arguments: If you pass a --settings file, Facade merges it into the run file. If you pass
		//   --allowedTools or --mcp-config, Facade joins your lists with its own.
		// - Environment: Facade writes your variables into the run file so Claude Code's own settings
		//   files cannot override them. Setting ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to null writes
		//   an empty value into the run file. Setting any other variable to null is an error if a Claude
		//   Code settings file or your custom --settings sets that variable again.
		"claude": {{claude}},

		// Codex
		//
		// What Facade always adds:
		// - Facade passes -c mcp_servers.facade.* to add its tools to Codex, already approved, and
		//   places its skill in .agents/skills/facade in the workspace folder.
		// - Facade passes -c mcp_optional_startup_grace_ms=10000 so Codex's first request waits
		//   up to 10 seconds for Facade's tools instead of 1 second, ensuring a slow start does
		//   not leave them out.
		// - Facade passes -c hooks=... with session hooks that write down which conversation
		//   the agent is in.
		// - Facade passes -c projects=... to trust the workspace for this run only, writing nothing to
		//   Codex's permanent configuration.
		// - Facade passes -c check_for_update_on_startup=false so update prompts do not hold back tasks.
		// - Facade passes --no-daemon because with -c settings Codex runs on its own anyway
		//   instead of through its background service; setting it up front prevents Codex from
		//   showing a warning about it under its input.
		// - To resume an existing agent, Facade passes resume <id>.
		//
		// Approvals and sandboxing:
		// - When YOLO is on, Facade passes --dangerously-bypass-approvals-and-sandbox.
		// - When YOLO is off, Facade passes --sandbox workspace-write so Codex can write inside the
		//   workspace while keeping its own approval rules.
		//
		// Model and effort:
		// - Facade passes your chosen model with --model and your reasoning effort with
		//   -c model_reasoning_effort.
		//
		// Where your args differ from the shared rules:
		// - Facade merges your custom -c hooks with its own. Facade refuses -c keys that it sets itself:
		//   model, model_reasoning_effort, approval_policy, sandbox_mode, projects, mcp_servers.facade,
		//   mcp_optional_startup_grace_ms, and check_for_update_on_startup.
		"codex": {{codex}},

		// Antigravity
		//
		// What Facade always adds:
		// - Facade passes --settings with a run file that allows Facade's tools on top of your existing
		//   rules. It sets Antigravity's title command to a hook that tells Facade which conversation the
		//   agent is in; any title command you configured still runs and displays your title.
		// - Facade places its tools and skill as a plugin in .agents/plugins/facade, loads it with /mcp
		//   before the first turn, and types your initial task once the tools are ready.
		// - To resume an existing agent, Facade passes --conversation <id>.
		// - Facade sets FACADE_RUN and FACADE_PTYD in the environment so tools know which agent they work
		//   for and where to send calls.
		// - Facade adds the workspace directory to trustedWorkspaces in
		//   ~/.gemini/antigravity-cli/settings.json.
		//
		// Approvals and sandboxing:
		// - When YOLO is on, Facade passes --mode accept-edits --dangerously-skip-permissions.
		// - When YOLO is off, Facade adds no options, and Antigravity prompts for approval normally.
		//
		// Model and effort:
		// - Facade passes your chosen model with --model and your chosen effort with --effort.
		//
		// Where your args differ from the shared rules:
		// - If you pass --settings (or -settings), Facade merges your file into the run file, replacing
		//   the specific keys you name.
		"agy": {{agy}},

		// Muse Code
		//
		// What Facade always adds:
		// - Facade registers its tools with -c mcpServers.facade=... and installs its skill into
		//   .agents/skills/facade in the workspace folder.
		// - Facade sets FACADE_RUN and FACADE_PTYD so tools know which agent they work for and where to
		//   send calls.
		// - Facade passes -c hooks=... with session hooks that write down which conversation
		//   the agent is in.
		// - Facade passes --trust-workspace to trust the workspace folder.
		// - To resume an existing agent, Facade passes resume <id>.
		//
		// Approvals and sandboxing:
		// - When YOLO is on, Facade passes --disable-approval --disable-sandbox.
		// - When YOLO is off, Facade adds no options, and Muse Code asks for approval normally.
		//   This includes prompting for each tool call, because Muse Code cannot approve a server's
		//   tools in advance.
		//
		// Model and effort:
		// - Facade passes your chosen model with --model and your reasoning effort with
		//   -c reasoning_effort.
		//
		// Where your args differ from the shared rules:
		// - Facade merges your custom -c hooks with its own. Facade refuses these -c keys: model,
		//   reasoning_effort, model_reasoning_efforts, and mcpServers.facade.
		"muse": {{muse}},

		// OpenCode
		//
		// What Facade always adds:
		// - Facade sets OPENCODE_CONFIG_CONTENT to provide its tools, grant permission to use them, and
		//   register its skill.
		// - Facade sets OPENCODE_CLI_CONFIG_CONTENT with a plugin that writes down which conversation the
		//   agent is in.
		// - Facade passes --standalone so OpenCode starts its own isolated server just for this run.
		// - To resume an existing agent, Facade passes --session <id>. When an initial task is provided,
		//   Facade passes it with --prompt.
		//
		// Approvals and sandboxing:
		// - When YOLO is on, Facade passes --auto.
		// - When YOLO is off, Facade adds no options, and OpenCode asks for approval normally.
		//
		// Model and effort:
		// - Facade passes neither model nor effort to OpenCode; setting either here is an error. Configure
		//   them in OpenCode's own configuration instead.
		//
		// Where your env differs from the shared rules:
		// - If you set OPENCODE_CONFIG_CONTENT or OPENCODE_CLI_CONFIG_CONTENT, Facade keeps your content
		//   and adds its own to it.
		"opencode": {{opencode}},

		// Pi
		//
		// What Facade always adds:
		// - Facade passes -e with a temporary run extension to load its tools, and passes --extension with
		//   a file that writes down which conversation the agent is in.
		// - Facade passes --session-id <new id> for a new agent, or --session <id> to resume
		//   an existing one.
		// - Facade passes --approve to trust the workspace for this run without writing anything to disk,
		//   allowing Pi to load project settings, extensions, and skills.
		//
		// Approvals and sandboxing:
		// - Pi has no approvals and no sandbox, so YOLO adds no options for Pi. The YOLO switch
		//   still decides which agents Pi's Facade tools can reach.
		//
		// Model and effort:
		// - Facade passes your chosen model with --model and your reasoning effort with --thinking.
		"pi": {{pi}},

{{added}}		// Adding custom entries:
		// You can add your own entries under "clis". The key can be any name you like, and New Agent
		// displays that name. The "type" field is required: choose one of claude, codex, agy, muse,
		// opencode, or pi, or use custom for any other terminal program.
		//
		// An added entry stands on its own and inherits nothing from the built-in entry of the same
		// type. For example, "Codex · Other" with "type": "codex" does not get the "args" or "env" of
		// the "codex" entry. The built-in claude and codex entries keep using their usual service.
		//
		// To use an example below, remove the leading // from each of its lines, replace YOUR_API_KEY
		// and YOUR_PROVIDER_URL with your provider's, check its model names, and save. Agents started
		// afterwards can use it.
		//
		// A key written here is stored in plain text in this file. Facade creates this file so
		// that, on macOS and Linux, only your account can read it; on Windows it takes its
		// folder's permissions. Facade never puts a key on the command line when it starts an
		// agent. To keep the key out of this file, write "\${env:NAME}" instead: Facade then reads
		// NAME from the editor's environment.
		//
		// Example 1: Claude Code on another provider (samples: OpenRouter and Qwen Cloud)
		// This example connects Claude Code to an alternate provider instead of Anthropic. Claude Code
		// only speaks Anthropic's API, so this requires a provider that offers an Anthropic-compatible
		// endpoint. Facade writes this environment into the run's private settings file, so Claude
		// Code's own settings files cannot override it, and the key never appears on the command line.
		// The values below use DeepSeek V4.1 Flash as the example model.
		// "Claude · Other": {
		// 	"type": "claude",
		// 	"icon": "facade-blue", // or values on line {{iconLine}}
		// 	// The model the agent starts with. Facade passes it as --model; a model chosen when
		// 	// the agent is started wins. Use a model the provider serves; DeepSeek V4.1 Flash is
		// 	// deepseek/deepseek-v4.1-flash on OpenRouter and deepseek-v4.1-flash on Qwen Cloud:
		// 	"model": "deepseek/deepseek-v4.1-flash",
		// 	"env": {
		// 		// Claude Code sends every request to this address: the provider's Anthropic-compatible
		// 		// address, such as https://openrouter.ai/api on OpenRouter or
		// 		// https://token-plan.maas.qwencloudapi.com/apps/anthropic on Qwen Cloud:
		// 		"ANTHROPIC_BASE_URL": "YOUR_PROVIDER_URL",
		// 		// The provider's key, sent with each request:
		// 		"ANTHROPIC_AUTH_TOKEN": "YOUR_API_KEY",
		// 		// Setting this to null removes any Anthropic key you set elsewhere, so Claude Code
		// 		// neither uses it nor sends it to the other provider. Keep this as it is:
		// 		"ANTHROPIC_API_KEY": null,
		// 		// Claude Code requests models across three tiers: opus, sonnet, and haiku. It uses
		// 		// the haiku tier for small background tasks. Each tier must name a model that the
		// 		// provider serves, or Claude Code will ask for models the provider does not have.
		// 		// Set the provider's model names; the three tiers may differ:
		// 		"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek/deepseek-v4.1-flash",
		// 		"ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-v4.1-flash",
		// 		"ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4.1-flash",
		// 	},
		// },
		//
		// Example 2: Codex on another provider (samples: OpenRouter and Qwen Cloud)
		// This example connects Codex to an alternate provider using an OpenAI-compatible Responses
		// API. Codex decides where requests go through a "model provider", which normally lives in
		// ~/.codex/config.toml. These -c options define and select a provider when the agent starts.
		// They apply only to this entry's agents: nothing is written to Codex's configuration, and
		// other Codex agents are not affected. The values below use DeepSeek V4.1 Flash as the example
		// model.
		// "Codex · Other": {
		// 	"type": "codex",
		// 	"icon": "facade-lime", // or values on line {{iconLine}}
		// 	// The model the agent starts with. Facade passes it as --model; a model chosen when
		// 	// the agent is started wins. Use a model the provider serves; DeepSeek V4.1 Flash is
		// 	// deepseek/deepseek-v4.1-flash on OpenRouter and deepseek-v4.1-flash on Qwen Cloud:
		// 	"model": "deepseek/deepseek-v4.1-flash",
		// 	"args": [
		// 		// Selects the provider defined below. "provider" is only its name; any name works
		// 		// as long as all lines use the same one:
		// 		"-c", "model_provider=provider",
		// 		// The display name of the provider. Any name works here:
		// 		"-c", "model_providers.provider.name=Provider",
		// 		// The address Codex sends requests to: the provider's OpenAI-compatible address,
		// 		// such as https://openrouter.ai/api/v1 on OpenRouter or
		// 		// https://token-plan.maas.qwencloudapi.com/compatible-mode/v1 on Qwen Cloud:
		// 		"-c", "model_providers.provider.base_url=YOUR_PROVIDER_URL",
		// 		// Codex talks to the provider in the Responses API format. Keep it as it is:
		// 		"-c", "model_providers.provider.wire_api=responses",
		// 		// The name of the environment variable Codex reads the key from, keeping it off
		// 		// the command line. Any variable name works as long as the entry's "env" uses
		// 		// the same one:
		// 		"-c", "model_providers.provider.env_key=PROVIDER_API_KEY",
		// 	],
		// 	// Provide your key here. Any variable name works if model_providers.provider.env_key
		// 	// above uses the same one:
		// 	"env": { "PROVIDER_API_KEY": "YOUR_API_KEY" },
		// },
		//
		// Example 3: A program Facade does not know (sample: Aider)
		// Setting "type": "custom" runs any terminal program that Facade does not natively support.
		// Facade only starts the program in a terminal, so none of the built-in features apply:
		// the program gets no Facade tools or skill (it cannot message or launch other agents), no trust
		// or YOLO options (its own approval prompts apply), no first task or messages (you type into its
		// terminal yourself), no Resume or Pin, and Facade cannot tell whether the program is working.
		// Setting "model" or "effort" on a custom entry is an error. The program still receives
		// FACADE_AGENT and follows the shared "env" rules.
		// "Aider": {
		// 	"type": "custom",
		// 	"icon": "facade-pink", // or values on line {{iconLine}}
		// 	// Required. A program name looked up on PATH, or a full path. It must be a single
		// 	// program, not a shell command line: pipes and && are not allowed:
		// 	"command": "aider",
		// 	// Passed to the program exactly as written, without Facade interpreting them.
		// 	// For example, --model sonnet is Aider's own option, not Facade's "model" field:
		// 	"args": ["--model", "sonnet"],
		// },
	}
}
`;

/**
 * A model and an effort each built-in takes, by its ID, which its entry shows commented out (CONFIGURATION-1.3): from each CLI's own
 * `--help` and model list. Every one of them takes the effort `high`.
 */
const SAMPLE_MODELS: { readonly [id: string]: string } = {
	claude: 'opus', codex: 'gpt-6-astra', agy: 'gemini-4-argon', muse: 'muse-spark-1.3', pi: 'anthropic/claude-opus-5-5'
};
const SAMPLE_EFFORT = 'high';

/** `value` as JSON on one line, spaced as a person writes it: `{ "enabled": true, "args": [] }`. */
function inline(value: unknown): string {
	if (Array.isArray(value)) {
		return value.length ? `[${value.map(inline).join(', ')}]` : '[]';
	}
	if (isJsonObject(value)) {
		const members = Object.entries(value).filter(([, each]) => each !== undefined);
		return members.length ? `{ ${members.map(([key, each]) => `${JSON.stringify(key)}: ${inline(each)}`).join(', ')} }` : '{}';
	}
	return JSON.stringify(value);
}

/** A value at `indent`: on one line where that stays within `room`, else one member a line. */
function valueText(value: unknown, indent: string, room = 90): string {
	const one = inline(value);
	return one.length <= room ? one : JSON.stringify(value, undefined, '\t').split('\n').join(`\n${indent}`);
}

/**
 * A built-in's entry as the file shows it (CONFIGURATION-1.3): all eight fields, one a line, in their order. The fields whose default
 * Facade knows are written out; `command`, `model` and `effort`, whose default is the CLI's own, are commented out with a value they
 * take, so that removing the `//` sets them. What `given` - the editor's old settings - sets is written out over either, as it was. A
 * CLI that takes no model or effort has a line saying where they are set instead.
 */
function builtInText(facts: BuiltInFacts, given: { readonly [field: string]: unknown } = {}, iconLine = 0): string {
	const indent = '\t\t\t';
	const field = (name: string, value: unknown) => `${JSON.stringify(name)}: ${valueText(value, indent, 70)},`;
	// What the old settings gave, a null among them, as it was; a field they did not give, its default (CONFIGURATION-6.2)
	const kept = (name: string, otherwise: unknown) => given[name] !== undefined ? given[name] : otherwise;
	const sample = (name: string, value: string) => given[name] !== undefined ? field(name, given[name]) : `// ${field(name, value)}`;
	const lines = [
		field('type', kept('type', facts.id)),
		`${field('icon', kept('icon', facts.id))} // or values on line ${iconLine}`,
		sample('command', `/path/to/${facts.command}`),
		field('args', kept('args', [])),
		field('env', kept('env', {})),
		...facts.takes.model || facts.takes.effort
			? [sample('model', SAMPLE_MODELS[facts.id] ?? 'model'), sample('effort', SAMPLE_EFFORT)]
			: [`// Model and effort are set in ${facts.displayName}'s own configuration, not in this file.`, ...(['model', 'effort'] as const).filter(name => given[name] !== undefined).map(name => field(name, given[name]))],
		field('enabled', kept('enabled', true)),
		// Anything else the old settings gave, as it was: the file's rules say what is wrong with it (CONFIGURATION-6.2)
		...Object.keys(given).filter(name => !['type', 'command', 'args', 'env', 'model', 'effort', 'enabled', 'icon'].includes(name)).map(name => field(name, given[name]))
	];
	return `{\n${lines.map(line => `${indent}${line}`).join('\n')}\n\t\t}`;
}

/** A list of names as the file shows it: a few to a line, two tabs in, each line at most 100 columns with a tab counted as 4. */
function namesText(names: readonly string[]): string {
	const lines: string[] = [];
	let line = '';
	for (const [index, name] of names.entries()) {
		const item = `${JSON.stringify(name)}${index < names.length - 1 ? ',' : ''}`;
		if (line && 8 + line.length + 1 + item.length > 100) {
			lines.push(line);
			line = item;
		} else {
			line = line ? `${line} ${item}` : item;
		}
	}
	return names.length ? `[\n${[...lines, line].map(each => `\t\t${each}`).join('\n')}\n\t]` : '[]';
}

/**
 * The settings file's text (CONFIGURATION-1.3, 6.1): `yolo`, true where not given; each built-in's entry - its defaults, with what
 * `clis` gives it over them - in the built-ins' order; then the other entries of `clis` in their order, each member written in turn so
 * that a name that is a number keeps its place, which a JavaScript object would move first.
 */
export function settingsText(yolo: unknown, clis: readonly (readonly [string, { readonly [field: string]: unknown }])[]): string {
	const given = new Map(clis);
	const added = clis.filter(([name]) => !BUILT_IN_FACTS.some(builtIn => builtIn.id === name));
	const text = (iconLine: number) => {
		const values = new Map<string, string>([
			['yolo', JSON.stringify(yolo === undefined ? true : yolo, undefined, '\t').split('\n').join('\n\t')],
			['names', namesText(BUILT_IN_NAMES)],
			['iconLine', String(iconLine)],
			...BUILT_IN_FACTS.map((facts): [string, string] => [facts.id, builtInText(facts, given.get(facts.id), iconLine)]),
			['added', added.map(([name, entry]) => `\t\t${JSON.stringify(name)}: ${valueText(entry, '\t\t')},\n\n`).join('')]
		]);
		// In one pass, each value as it is: never read for a replacement's `$` patterns, nor for a token that a value holds
		return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values.get(name) ?? token);
	};
	// The line each icon's comment points to: the field list's icon, above every entry, so that its own number moves no line before it
	return text(text(0).split('\n').findIndex(line => line.startsWith('\t// - icon:')) + 1);
}
