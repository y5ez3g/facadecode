/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { AgentCli, CliConfig } from './cli';
import { LaunchTarget } from './executable';

/** A CLI as Facade: Show Agent Launch shows it. */
export interface DescribedCli {
	readonly cli: AgentCli;
	/** How the person has Facade start it now. */
	readonly config: CliConfig;
	/** The person's own `facade.orchestration.<section>.launch`, as they wrote it. */
	readonly yours: unknown;
	/** How Facade starts it on this machine; else why this machine has none. */
	readonly program: { readonly target: LaunchTarget; readonly missing?: undefined } | { readonly target?: undefined; readonly missing: string };
}

/**
 * What Facade starts each CLI with now, as a JSONC document for the person to read: by each CLI's
 * section, the program Facade runs - with the script it gives Node for an npm shim, and whether cmd.exe
 * runs it - how an agent's first line, which names its task, reaches it, its launch - Facade's own with
 * the person's changes over it - and those changes as they wrote them.
 */
export function launchDocument(clis: readonly DescribedCli[]): string {
	const shown = Object.fromEntries(clis.map(({ cli, config, yours, program }) => {
		if (program.target === undefined) {
			return [cli.section, { program: l10n.t("not on this machine: {0}", program.missing), launch: config.launch, yourChanges: yours ?? {} }];
		}
		const { executable, args, throughCmd } = program.target;
		return [cli.section, {
			program: executable,
			...(args.length ? { script: args.join(' ') } : {}),
			...(throughCmd ? { throughCmd } : {}),
			task: cli.task,
			launch: config.launch,
			yourChanges: yours ?? {}
		}];
	}));
	return [
		`// ${l10n.t("What Facade starts each CLI with now: the program it runs, and its launch - Facade's own, with your facade.orchestration.<cli>.launch over it.")}`,
		`// ${l10n.t("An agent's first line, which names its task, reaches the CLI as its argument, or typed into its terminal. This only shows the launch: to change it, write what you change in your settings.")}`,
		JSON.stringify(shown, undefined, '\t'),
		''
	].join('\n');
}
