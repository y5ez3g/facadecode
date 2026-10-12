/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { JsonObject } from '../base/json';
import { AgentCli, CliConfig, exemptionGroupsChanged, launchFor, sandboxOf } from './cli';
import { LaunchTarget } from './executable';

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
	 * The trust it is given for an agent in the folder: merged into its file, for good; its arguments, for
	 * the launch alone; none, where the person set none; else why it cannot be given.
	 */
	readonly trust:
	| { readonly kind: 'file'; readonly file: string; readonly merge: JsonObject }
	| { readonly kind: 'arguments'; readonly arguments: readonly string[] }
	| { readonly kind: 'none' }
	| { readonly kind: 'cannot'; readonly why: string };
	/** Where a setting of the person's own outside Facade - a deny rule of theirs - asks for Facade's tools all the same, which one. */
	readonly overridden?: string;
	/** What would refuse its start there as things are, as a start says it (L9; X-38). */
	readonly problems?: readonly string[];
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
function trustShown(trust: DescribedCli['trust']): string | object {
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
		default: return l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing; it has no sandbox");
	}
}

/**
 * Its tools that would leave its terminal waiting for someone to pick an answer, as the document says it for an agent
 * the person starts - its question tool theirs to answer - or, `unattended`, one started through `start_agent`: taken
 * away by its launch, none, or kept - a limitation what it is told as it starts makes up for, said in its launch
 * record (AGENT-LAUNCHER.md, L4; N-55) - and a launch of the person's that gives them back said as theirs.
 */
function questionsShown(cli: AgentCli, config: CliConfig, unattended: boolean): string {
	const taken = (launchFor(config, unattended).launch.arguments.questions?.length ?? 0) > 0;
	switch (cli.questionTool) {
		case 'removed':
			return taken
				? l10n.t("taken away by its launch's questions group: it asks in words")
				: unattended
					? l10n.t("kept: your launch empties its questions group, so it can put up a question that waits for someone to pick an answer")
					: l10n.t("kept: it can put up a question for you to answer, as it does outside Facade");
		case 'none': return l10n.t("none: no tool of its waits for someone to pick an answer");
		case 'kept': return unattended
			? l10n.t("kept: no launch can take its question tool away, so what it is told as it starts has it ask in words; asked for that tool by name, it can still put one up")
			: l10n.t("kept: it can put up a question for you to answer, as it does outside Facade");
		case 'unknown': return l10n.t("as your launch's questions group says");
	}
}

/** What an agent of `cli` runs with, started by the person or, `unattended`, through `start_agent`: its sandbox by YOLO, whether Facade's tools are asked for, and its question tool (L4). */
function byStarter(cli: AgentCli, config: CliConfig, overridden: string | undefined, unattended: boolean): object {
	return {
		// As the launch the person has set up leaves it (X-07)
		sandbox: Object.fromEntries((['yoloOn', 'yoloOff'] as const).map(key => [key, sandboxOf(cli, launchFor(config, unattended), { framework: true, yolo: key === 'yoloOn', model: false, effort: false, task: false, trust: true })])),
		facadeTools: facadeToolsShown(cli, config, overridden, unattended),
		questions: questionsShown(cli, config, unattended)
	};
}

/**
 * What Facade starts each CLI with now, as a JSONC document for the person to read: whether YOLO and the
 * agent framework are on, and by each CLI's setting the program Facade runs - with the script it gives Node
 * for an npm shim, and whether cmd.exe runs it - how the notice of its task reaches it; for an agent the person
 * starts and one started through `start_agent`, each, its sandbox with YOLO on and off, whether Facade's tools
 * are asked for, and whether it can put up a question that waits for an answer (L4); the trust it is given and
 * where, what is wrong in the person's settings of it, the version it was last verified at, its launch - Facade's
 * own with the person's changes over it, its unattended part in it - and those changes as they wrote them. No
 * token and no inherited variable is shown.
 */
export function launchDocument({ folder, yolo, framework, clis }: ShownLaunches): string {
	const shown = Object.fromEntries(clis.map(({ cli, config, yours, program, trust, overridden, problems }) => {
		const throughCmd = program.target?.throughCmd ?? false;
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
			whenYouStartIt: byStarter(cli, config, overridden, false),
			throughStartAgent: byStarter(cli, config, overridden, true),
			trust: trustShown(trust),
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
				: l10n.t("YOLO is off: each agent is given its yoloOff arguments - its sandbox on where it has one, and never asked about a call of Facade's tools; anything else asks you for an agent you started, and is refused unasked for one started through start_agent.")}`,
		`// ${l10n.t("An agent you start from the agent menu or Start Agent runs as its CLI usually does. One another agent or your script starts through start_agent, where nobody may be watching, runs with its launch's unattended part - its groups in place of the launch's, its environment and settings over the launch's - so that nothing waits for an answer: whenYouStartIt and throughStartAgent say what each gets.")}`,
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
