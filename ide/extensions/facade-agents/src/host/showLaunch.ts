/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { AgentCli, CliConfig, Environment, InstalledCli } from '../clis/cli';
import { whyNotInstalled } from '../clis/config';
import { CUSTOM_AGENTS_SETTING } from '../clis/custom';
import { DescribedCli, launchDocument, starterFacts } from '../clis/describe';
import { launchTargetOf } from '../clis/executable';
import { knownClis, locateCli } from '../clis/registry';
import { repositoryAt } from './git';
import { configFor, customAgents, frameworkOn, yolo } from './settings';
import { terminalPlace } from './startAgent';

/** Where the document Agents: Show Agent Launch shows lives: read-only, as a provider's documents are. */
const LAUNCH = vscode.Uri.from({ scheme: 'facade-agents', path: '/agent-launch.jsonc' });

/** What would refuse a start of an agent in a folder as things are: the window's core's own checks, where it has one. */
export type LaunchProblems = (installed: InstalledCli, folder: string) => Promise<readonly string[]>;

/**
 * Agents: Show Agent Launch: a read-only document of what Facade starts each agent with now, for an agent
 * in the folder on screen - built-ins and custom agents alike - which follows the person's settings as they
 * change them, and is read again each time the person asks for it: a CLI installed meanwhile shows. What
 * would refuse a start comes from `problemsOf`.
 */
export function registerShowLaunch(problemsOf: LaunchProblems): vscode.Disposable {
	const changed = new vscode.EventEmitter<vscode.Uri>();
	const provider: vscode.TextDocumentContentProvider = {
		onDidChange: changed.event,
		provideTextDocumentContent: () => shownNow(problemsOf)
	};
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(LAUNCH.scheme, provider),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('facade.agents') || event.affectsConfiguration('facade.orchestration')) {
				changed.fire(LAUNCH);
			}
		}),
		vscode.commands.registerCommand('facade.agents.showLaunch', async () => {
			// A document open already is read again.
			changed.fire(LAUNCH);
			const document = await vscode.workspace.openTextDocument(LAUNCH);
			await vscode.window.showTextDocument(await vscode.languages.setTextDocumentLanguage(document, 'jsonc'), { preview: false });
		})
	);
}

/**
 * The document as it is now: for an agent in the folder on screen, else the window's first, each agent as
 * a terminal there finds it and the trust it would be given there; in a window without a folder, as the
 * window's own environment finds it.
 */
async function shownNow(problemsOf: LaunchProblems): Promise<string> {
	const { folder, env: terminal } = await terminalPlace();
	const repository = folder === undefined ? undefined : (await repositoryAt(folder))?.main ?? folder;
	let shownYolo: boolean | { readonly wrong: string };
	try {
		shownYolo = yolo();
	} catch (err) {
		shownYolo = { wrong: messageOf(err) };
	}
	const place = folder === undefined || repository === undefined ? undefined : { folder, repository };
	// A custom agent's own launch by its name, which may have a dot in it: not a path of settings (X-38)
	const custom = vscode.workspace.getConfiguration().get<unknown>(CUSTOM_AGENTS_SETTING);
	const customLaunch = (name: string) => {
		const entry = isJsonObject(custom) ? custom[name] : undefined;
		return isJsonObject(entry) ? entry.launch : undefined;
	};
	return launchDocument({
		folder,
		yolo: shownYolo,
		framework: frameworkOn(),
		clis: await Promise.all([
			...knownClis().map(cli => describedCli(cli, configFor(cli), vscode.workspace.getConfiguration(cli.setting).get('launch'), folder, place, terminal, problemsOf)),
			...customAgents().map(({ cli, config }) => describedCli(cli, config, customLaunch(cli.id), folder, place, terminal, problemsOf))
		])
	});
}

/** An agent as the person has Facade start it now, for an agent in `place`, whose terminal has the environment `terminal`. */
async function describedCli(cli: AgentCli, config: CliConfig, yours: unknown, folder: string | undefined, place: { readonly folder: string; readonly repository: string } | undefined, terminal: Environment, problemsOf: LaunchProblems): Promise<DescribedCli> {
	const env = { ...terminal, ...config.launch.environment };
	const found = locateCli(cli, config, env, folder);
	// What would refuse its start there, as a start finds it: only for one there is, in a folder (L9)
	const problems = found && folder !== undefined ? await problemsOf(found, folder) : [];
	// Its trust and a deny rule of the person's, for each starter in the environment and with the settings of its own launch (L9; L10)
	const theirs = starterFacts(cli, config, place, terminal, false);
	return {
		cli,
		config,
		yours,
		program: found ? { target: launchTargetOf(cli, found.executable, process.platform, env) } : { missing: whyNotInstalled(cli, config, folder === undefined ? undefined : 'the PATH used by a terminal in that folder') },
		trust: theirs.trust,
		...(theirs.overridden !== undefined ? { overridden: theirs.overridden } : {}),
		...(theirs.ownSandbox !== undefined ? { ownSandbox: theirs.ownSandbox } : {}),
		throughStartAgent: starterFacts(cli, config, place, terminal, true),
		...(problems.length ? { problems } : {})
	};
}
