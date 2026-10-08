/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { JsonObject } from '../base/json';
import { AgentCli, CliConfig } from './cli';
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

/** How Facade's tools go unasked with YOLO off, as the document says it. */
function facadeToolsShown(cli: AgentCli, config: CliConfig, overridden: string | undefined): string {
	if (overridden !== undefined) {
		return l10n.t("asked for: {0}", overridden);
	}
	const changed = JSON.stringify(config.launch.arguments.yoloOff ?? []) !== JSON.stringify(cli.defaults.launch.arguments.yoloOff ?? []);
	if (cli.custom || changed) {
		return l10n.t("as your launch's yoloOff group says");
	}
	return cli.exemption === 'precise'
		? l10n.t("never asked: its launch lets Facade's server through alone")
		: l10n.t("never asked: it cannot let Facade's server alone through, so with YOLO off it asks for nothing, its sandbox still on");
}

/**
 * What Facade starts each CLI with now, as a JSONC document for the person to read: whether YOLO and the
 * agent framework are on, and by each CLI's setting the program Facade runs - with the script it gives Node
 * for an npm shim, and whether cmd.exe runs it - how the notice of its task reaches it, its sandbox with YOLO
 * on and off, whether Facade's tools are asked for, the trust it is given and where, what is wrong in the
 * person's settings of it, the version it was last verified at, its launch - Facade's own with the person's
 * changes over it - and those changes as they wrote them. No token and no inherited variable is shown.
 */
export function launchDocument({ folder, yolo, framework, clis }: ShownLaunches): string {
	const shown = Object.fromEntries(clis.map(({ cli, config, yours, program, trust, overridden }) => {
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
			sandbox: { yoloOn: cli.sandbox.yoloOn, yoloOff: cli.sandbox.yoloOff },
			facadeTools: facadeToolsShown(cli, config, overridden),
			trust: trustShown(trust),
			...(config.wrong ? { wrongSettings: config.wrong } : {}),
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
				: l10n.t("YOLO is off: each agent is given its yoloOff arguments - its sandbox on where it has one, and it asks before its own commands and edits, but never before a call of Facade's tools.")}`,
		`// ${framework
			? l10n.t("The agent framework is on: its warmUp, connect and messages groups apply, and Facade's tools, skills and files go into each launch.")
			: l10n.t("The agent framework is off: no warmUp, connect or messages group applies, and nothing of Facade's goes into a launch.")}`,
		`// ${l10n.t("task: argument - the notice of its task is its argument; typed - typed into its terminal once it has connected; none - it takes no task.")}`,
		`// ${l10n.t("trust: a file's entry is merged in as if you had answered the CLI yourself, and stays: Facade never takes it back. Arguments trust the folder for that launch alone.")}`,
		`// ${l10n.t("This only shows the launch: to change it, write what you change in your settings. An agent with wrongSettings does not start until they are put right.")}`,
		JSON.stringify(shown, undefined, '\t'),
		''
	].join('\n');
}
