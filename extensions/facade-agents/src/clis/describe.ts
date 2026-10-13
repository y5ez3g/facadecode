/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { messageOf } from '../base/errors';
import { JsonObject, sameJson } from '../base/json';
import { AgentCli, CliConfig, Environment, exemptionGroupsChanged, launchFor, sandboxOf } from './cli';
import { homeOf, LaunchTarget } from './executable';
import { trustTarget } from './trust';

/** A CLI as Facade: Show Agent Launch shows it, for an agent in the folder it shows. */
export interface DescribedCli {
	readonly cli: AgentCli;
	/** How the person has Facade start it now. */
	readonly config: CliConfig;
	/** The person's own launch, as they wrote it: `facade.agents.<cli>.launch`, or a custom agent's. */
	readonly yours: unknown;
	/** How Facade starts it, as a terminal in the folder finds it; else why that terminal finds none. */
	readonly program: { readonly target: LaunchTarget; readonly missing?: undefined } | { readonly target?: undefined; readonly missing: string };
	/**
	 * The trust it is given for an agent in the folder that the person starts: merged into its file, for good; its
	 * arguments, for the launch alone; none, where the person set none; else why it cannot be given.
	 */
	readonly trust: GivenTrust;
	/** Where a setting of the person's own outside Facade - a deny rule of theirs - asks for Facade's tools all the same, which one: for an agent the person starts. */
	readonly overridden?: string;
	/**
	 * The same two for an agent started through `start_agent`, which runs in the environment and with the settings its
	 * launch's unattended part gives it (L9; L10): its trust can go elsewhere, and a deny rule can refuse it Facade's
	 * tools. None: as for an agent the person starts.
	 */
	readonly throughStartAgent?: StarterFacts;
	/** What would refuse its start there as things are, as a start says it (L9; X-38). */
	readonly problems?: readonly string[];
}

/** The trust a CLI is given for an agent in a folder: merged into its file, for good; its arguments, for the launch alone; none; or why it cannot be given. */
type GivenTrust =
	| { readonly kind: 'file'; readonly file: string; readonly merge: JsonObject }
	| { readonly kind: 'arguments'; readonly arguments: readonly string[] }
	| { readonly kind: 'none' }
	| { readonly kind: 'cannot'; readonly why: string };

/** What an agent of a CLI gets where the launch of whoever starts it decides it: its trust, and a deny rule of the person's that refuses it Facade's tools. */
interface StarterFacts {
	readonly trust: GivenTrust;
	readonly overridden?: string;
	/**
	 * The servers of the folder's project MCP configuration its launch turns off with YOLO off, the person not having
	 * approved them for the project (L4, rule 3; LV-02): Claude Code's, through `start_agent`. None where nothing is.
	 */
	readonly serversOff?: readonly string[];
}

/**
 * What an agent of `cli` in `place` gets by who starts it - the person, from the UI, or, `unattended`, an agent or the
 * person's script through `start_agent` - where that starter's launch decides it (L4; L9): in the environment a terminal
 * there starts with, `terminal`, with that launch's over it (L10), the trust it is given, a setting of the person's that
 * refuses Facade's tools with YOLO off - a deny rule in Claude Code's settings, that launch's, the person's own or the
 * project's (rule 4) - and the servers of the folder's project MCP configuration that launch turns off (rule 3).
 */
export function starterFacts(cli: AgentCli, config: CliConfig, place: { readonly folder: string; readonly repository: string } | undefined, terminal: Environment, unattended: boolean): StarterFacts {
	const launch = launchFor(config, unattended);
	const env = { ...terminal, ...launch.launch.environment };
	const refused = cli.exemptionOverride?.(launch, env, place?.folder);
	return {
		trust: givenTrust(cli, launch, place, env),
		...(refused !== undefined ? { overridden: l10n.t("{0}: with YOLO off, {1} refuses Facade's tools", refused, cli.displayName) } : {}),
		...(place && unattended && cli.projectServersOff ? { serversOff: cli.projectServersOff(launch, place, homeOf(env), false, unattended) } : {})
	};
}

/** The trust `cli` would be given for an agent in `place`, as `config` has it, in the environment `env`; as its launch writes it, without a place. */
function givenTrust(cli: AgentCli, config: CliConfig, place: { readonly folder: string; readonly repository: string } | undefined, env: Environment): GivenTrust {
	const { trust } = config.launch;
	if (!trust) {
		return { kind: 'none' };
	}
	if (trust.arguments) {
		return { kind: 'arguments', arguments: trust.arguments };
	}
	if (!place) {
		return { kind: 'file', file: trust.file, merge: trust.merge };
	}
	try {
		const target = trustTarget(cli, config, place, env);
		return target ? { kind: 'file', file: target.file, merge: target.entry } : { kind: 'none' };
	} catch (err) {
		return { kind: 'cannot', why: messageOf(err) };
	}
}

/** What Facade: Show Agent Launch shows. */
export interface ShownLaunches {
	/** The folder an agent is shown starting in: the one on screen; none in a window without one. */
	readonly folder?: string;
	/** The person's YOLO: on or off; else why it is neither. */
	readonly yolo: boolean | { readonly wrong: string };
	/** Whether the agent framework is on: Facade's tools, skills and files go into a launch. */
	readonly framework: boolean;
	readonly clis: readonly DescribedCli[];
}

/** A CLI's trust as the document shows it. */
function trustShown(trust: GivenTrust): string | object {
	switch (trust.kind) {
		case 'file': return { file: trust.file, merge: trust.merge, kept: l10n.t("for good: Facade never takes it back") };
		case 'arguments': return { arguments: trust.arguments };
		case 'none': return l10n.t("none: the CLI asks whether you trust the folder");
		case 'cannot': return l10n.t("cannot be given: {0}", trust.why);
	}
}

/**
 * How Facade's tools go unasked with YOLO off, for an agent the person starts or, `unattended`, one started through
 * `start_agent`, as the document says it: Facade's own launch lets them through by its yoloOff group, or by its
 * connect group - Codex's server setting - so one the person changed is theirs to say, not a working exemption
 * (L4, rule 4; X-38).
 */
function facadeToolsShown(cli: AgentCli, config: CliConfig, overridden: string | undefined, unattended: boolean): string {
	if (overridden !== undefined) {
		return l10n.t("refused: {0}", overridden);
	}
	if (cli.custom) {
		return l10n.t("as your launch's yoloOff group says");
	}
	const changed = exemptionGroupsChanged(cli, config, unattended);
	if (changed.length) {
		return changed.length === 1
			? l10n.t("as your launch's {0} group says: Facade's own lets its server through, and you changed it", changed[0])
			: l10n.t("as your launch's {0} and {1} groups say: Facade's own let its server through, and you changed them", changed[0], changed[1]);
	}
	if (cli.exemption === 'precise') {
		return l10n.t("never asked: its launch lets Facade's server through alone");
	}
	// Its sandbox as the launch with YOLO off leaves it: one it has not is not said to be on (X-38)
	switch (sandboxOf(cli, launchFor(config, unattended), { framework: true, yolo: false, model: false, effort: false, task: false, trust: true })) {
		case 'on': return l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing, its sandbox still on");
		case 'off': return l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing; its sandbox is off as your launch has it");
		case 'unknown': return l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing; its sandbox as your launch's groups have it");
		default: return l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing; it has no sandbox");
	}
}

/**
 * Its tools that would leave its terminal waiting for someone to pick an answer, as the document says it for an agent
 * the person starts - its question tool theirs to answer - or, `unattended`, one started through `start_agent`: taken
 * away by its launch, or kept - a limitation what it is told as it starts makes up for, said in its launch record
 * (AGENT-LAUNCHER.md, L4; N-55) - and a launch of the person's that gives them back said as theirs.
 */
function questionsShown(cli: AgentCli, config: CliConfig, unattended: boolean): string {
	const taken = (launchFor(config, unattended).launch.arguments.questions?.length ?? 0) > 0;
	switch (cli.questionTool) {
		case 'removed':
			return taken
				? l10n.t("taken away by its launch's questions group: it asks through Facade messages")
				: unattended
					? l10n.t("kept: your launch empties its questions group, so it can put up a question that waits for someone to pick an answer")
					: l10n.t("kept: it can put up a question for you to answer, as it does outside Facade");
		case 'kept': return unattended
			? l10n.t("kept: no launch can take its question tool away, so what it is told as it starts has it ask through Facade messages; asked for that tool by name, it can still put one up")
			: l10n.t("kept: it can put up a question for you to answer, as it does outside Facade");
		case 'unknown': return l10n.t("as your launch's questions group says");
	}
}

/**
 * What else than Facade's tools an agent of `cli` asks for with YOLO off, started by the person or, `unattended`,
 * through `start_agent` (L4): as the CLI asks, for an agent the person starts; refused unasked for one started
 * through `start_agent`; nothing at all for a CLI that cannot let Facade's tools alone through (rule 1) - and, for
 * a launch the person changed, theirs to say.
 */
function approvalsShown(cli: AgentCli, config: CliConfig, unattended: boolean): string {
	if (cli.custom || exemptionGroupsChanged(cli, config, unattended).includes('yoloOff')) {
		return l10n.t("as your launch's yoloOff group says");
	}
	if (cli.exemption === 'all') {
		return l10n.t("nothing asked, nothing refused: it cannot let Facade's tools alone through, so its approvals are off");
	}
	// Edits in its folder that go unasked - Claude Code's dontAsk with them let through, as through start_agent - are said
	// so; without, the person's own asks them as its CLI does, in their own permission mode (L4)
	const edits = (launchFor(cli.defaults, unattended).launch.arguments.yoloOff ?? []).some(arg => arg.startsWith('Edit('));
	return unattended
		? (edits ? l10n.t("its edits in its folder unasked; anything else that would ask is refused unasked") : l10n.t("anything that would ask is refused unasked"))
		: (edits ? l10n.t("its edits in its folder unasked; anything else asks you, as its CLI does") : l10n.t("asks you, as its CLI does"));
}

/**
 * The servers of the folder's project MCP configuration Claude Code started through `start_agent` runs without, with YOLO
 * off, as the document says it (L4, rule 3; LV-02): those the person has not approved for the project, which it would
 * stop to ask about - by name, for the folder shown, `serversOff`; or in general, for none.
 */
function serversOffShown(serversOff: readonly string[] | undefined): string {
	return serversOff === undefined
		? l10n.t("with YOLO off, those of its folder's .mcp.json you have not approved for its project are turned off for the run, so that it does not stop to ask about them")
		: serversOff.length
			? l10n.t("with YOLO off, turned off for the run, so that it does not stop to ask about them - you have not approved them for this project: {0}", serversOff.join(', '))
			: l10n.t("with YOLO off, none turned off: this folder's .mcp.json has no server you have not approved for its project");
}

/**
 * What an agent of `cli` runs with, started by the person or, `unattended`, through `start_agent`: its sandbox by YOLO,
 * whether Facade's tools and anything else are asked for, its question tool, and - through `start_agent`, of a CLI whose
 * launch turns some off - the project's MCP servers it runs without, `serversOff` (L4).
 */
function byStarter(cli: AgentCli, config: CliConfig, overridden: string | undefined, unattended: boolean, serversOff?: readonly string[]): object {
	return {
		// As the launch the person has set up leaves it (X-07)
		sandbox: Object.fromEntries((['yoloOn', 'yoloOff'] as const).map(key => [key, sandboxOf(cli, launchFor(config, unattended), { framework: true, yolo: key === 'yoloOn', model: false, effort: false, task: false, trust: true })])),
		facadeTools: facadeToolsShown(cli, config, overridden, unattended),
		approvalsWithYoloOff: approvalsShown(cli, config, unattended),
		questions: questionsShown(cli, config, unattended),
		...(unattended && cli.projectServersOff ? { projectMcpServers: serversOffShown(serversOff) } : {})
	};
}

/**
 * What Facade starts each CLI with now, as a JSONC document for the person to read: whether YOLO and the
 * agent framework are on, and by each CLI's setting the program Facade runs - with the script it gives Node
 * for an npm shim, and whether cmd.exe runs it - how the notice of its task reaches it; for an agent the person
 * starts and one started through `start_agent`, each, its sandbox with YOLO on and off, whether Facade's tools
 * are asked for, what else it asks for or is refused with YOLO off, whether it can put up a question that waits
 * for an answer and - one started through `start_agent` of a CLI whose launch turns them off - the project's MCP
 * servers it runs without (L4); the trust it is given and where, once for both or for each where the two differ,
 * what is wrong in the person's settings of it, the version it was last verified at, its launch - Facade's own
 * with the person's changes over it, its unattended part in it - and those changes as they wrote them. No token
 * and no inherited variable is shown.
 */
export function launchDocument({ folder, yolo, framework, clis }: ShownLaunches): string {
	const shown = Object.fromEntries(clis.map(({ cli, config, yours, program, trust, overridden, throughStartAgent, problems }) => {
		const throughCmd = program.target?.throughCmd ?? false;
		// An agent started through start_agent, in its own environment and with its own settings (L9; L10): its trust
		// shown for each starter where the two differ
		const startAgentFacts = throughStartAgent ?? { trust, ...(overridden !== undefined ? { overridden } : {}) };
		const trusts = [trustShown(trust), trustShown(startAgentFacts.trust)] as const;
		const sameTrust = sameJson(trusts[0], trusts[1]);
		return [cli.setting.replace(/^facade\.agents\./, ''), {
			...(program.target === undefined
				? { program: l10n.t("not found: {0}", program.missing) }
				: {
					program: program.target.executable,
					...(program.target.args.length ? { script: program.target.args.join(' ') } : {}),
					...(throughCmd ? { throughCmd } : {})
				}),
			...(cli.custom ? {} : { offered: config.enabled }),
			task: cli.task === 'terminal' ? 'typed' : cli.task === 'none' ? 'none' : 'argument',
			whenYouStartIt: { ...byStarter(cli, config, overridden, false), ...(sameTrust ? {} : { trust: trusts[0] }) },
			throughStartAgent: { ...byStarter(cli, config, startAgentFacts.overridden, true, startAgentFacts.serversOff), ...(sameTrust ? {} : { trust: trusts[1] }) },
			...(sameTrust ? { trust: trusts[0] } : {}),
			...(config.wrong ? { wrongSettings: config.wrong } : {}),
			...(problems?.length ? { cannotStart: problems } : {}),
			...(cli.custom ? {} : { verified: cli.verified ?? l10n.t("not yet") }),
			launch: config.launch,
			yourChanges: yours ?? {}
		}];
	}));
	return [
		`// ${folder === undefined
			? l10n.t("What Facade starts each agent with now: the program it runs, and its launch - Facade's own, with your facade.agents settings over it.")
			: l10n.t("What Facade starts each agent with now, for an agent in {0}: the program a terminal there runs, and its launch - Facade's own, with your facade.agents settings over it.", folder)}`,
		`// ${typeof yolo !== 'boolean'
			? l10n.t("YOLO: {0}. No agent starts until it is put right.", yolo.wrong)
			: yolo
				? l10n.t("YOLO is on: each agent is given its yoloOn arguments - its sandbox off, nothing asked. facade.agents.yolo turns it off for the agents started after.")
				: l10n.t("YOLO is off: each agent is given its yoloOff arguments - its sandbox on where it has one, and Facade's tools let through where its CLI can: facadeTools and approvalsWithYoloOff say, for each, what is asked and what is refused.")}`,
		`// ${l10n.t("An agent you start from the agent menu or Start Agent keeps its CLI's own questions and updates, and its approvals as YOLO has them. One another agent or your script starts through start_agent, where nobody may be watching, runs with its launch's unattended part - its groups in place of the launch's, its environment and settings over the launch's - so that, where its CLI allows it, nothing waits for an answer: whenYouStartIt and throughStartAgent say what each gets.")}`,
		`// ${framework
			? l10n.t("The agent framework is on: its warmUp, connect and messages groups apply, and Facade's tools, skills and files go into each launch.")
			: l10n.t("The agent framework is off: no warmUp, connect or messages group applies, and nothing of Facade's goes into a launch.")}`,
		`// ${l10n.t("task: argument - the notice of its task is its argument; typed - typed into its terminal once it has connected; none - it takes no task.")}`,
		`// ${l10n.t("trust: a file's entry is merged in as if you had answered the CLI yourself, and stays: Facade never takes it back. Arguments trust the folder for that launch alone.")}`,
		`// ${l10n.t("This only shows the launch: to change it, write what you change in your settings. An agent with wrongSettings does not start until they are put right; cannotStart says what else would refuse its start here.")}`,
		JSON.stringify(shown, undefined, '\t'),
		''
	].join('\n');
}
