/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { AgentCli, CliConfig, Environment } from '../clis/cli';
import { claudeCli } from '../clis/claude';
import { whyNotInstalled } from '../clis/config';
import { DescribedCli, launchDocument } from '../clis/describe';
import { homeOf, launchTarget } from '../clis/executable';
import { knownClis, locateCli } from '../clis/registry';
import { trustTarget } from '../clis/trust';
import { HostGit } from './git';
import { configFor, customAgents, frameworkOn, yolo } from './settings';
import { folderOnScreen } from './startAgent';
import { terminalEnvironment } from './terminals';

/** Where the document Agents: Show Agent Launch shows lives: read-only, as a provider's documents are. */
const LAUNCH = vscode.Uri.from({ scheme: 'facade-agents', path: '/agent-launch.jsonc' });

/**
 * Agents: Show Agent Launch: a read-only document of what Facade starts each agent with now, for an agent
 * in the folder on screen - built-ins and custom agents alike - which follows the person's settings as they
 * change them, and is read again each time the person asks for it: a CLI installed meanwhile shows.
 */
export function registerShowLaunch(): vscode.Disposable {
	const changed = new vscode.EventEmitter<vscode.Uri>();
	const provider: vscode.TextDocumentContentProvider = {
		onDidChange: changed.event,
		provideTextDocumentContent: () => shownNow()
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
async function shownNow(): Promise<string> {
	const folders = (vscode.workspace.workspaceFolders ?? []).filter(each => each.uri.scheme === 'file').map(each => each.uri.fsPath);
	const folder = await folderOnScreen() ?? folders.at(0);
	const terminal: Environment = folder === undefined ? process.env : await terminalEnvironment(folder);
	const repository = folder === undefined ? undefined : (await new HostGit().repositoryOf(folder))?.main ?? folder;
	let shownYolo: boolean | { readonly wrong: string };
	try {
		shownYolo = yolo();
	} catch (err) {
		shownYolo = { wrong: messageOf(err) };
	}
	const place = folder === undefined || repository === undefined ? undefined : { folder, repository };
	return launchDocument({
		folder,
		yolo: shownYolo,
		framework: frameworkOn(),
		clis: [
			...knownClis().map(cli => describedCli(cli, configFor(cli), vscode.workspace.getConfiguration(cli.setting).get('launch'), folder, place, terminal)),
			...customAgents().map(({ cli, config }) => describedCli(cli, config, vscode.workspace.getConfiguration(cli.setting).get('launch'), folder, place, terminal))
		]
	});
}

/** An agent as the person has Facade start it now, for an agent in `place`, whose terminal has the environment `terminal`. */
function describedCli(cli: AgentCli, config: CliConfig, yours: unknown, folder: string | undefined, place: { readonly folder: string; readonly repository: string } | undefined, terminal: Environment): DescribedCli {
	const env = { ...terminal, ...config.launch.environment };
	const found = locateCli(cli, config, env);
	const overridden = cli === claudeCli ? claudeDeny(env, folder) : undefined;
	return {
		cli,
		config,
		yours,
		program: found ? { target: launchTarget(found.executable, process.platform, env) } : { missing: whyNotInstalled(cli, config, folder === undefined ? undefined : 'the PATH a terminal there has') },
		trust: trustShown(cli, config, place, env),
		...(overridden !== undefined ? { overridden } : {})
	};
}

/**
 * Where the person's own Claude Code settings deny Facade's tools - a deny rule wins over Facade's
 * `--allowedTools` - which file and which rule: with YOLO off, Claude Code asks for them all the same
 * (AGENT-LAUNCHER.md, L4).
 */
function claudeDeny(env: Environment, folder: string | undefined): string | undefined {
	const files = [
		path.join(env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude'), 'settings.json'),
		...folder === undefined ? [] : [path.join(folder, '.claude', 'settings.json'), path.join(folder, '.claude', 'settings.local.json')]
	];
	for (const file of files) {
		let settings: unknown;
		try {
			settings = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			continue;
		}
		const deny = isJsonObject(settings) && isJsonObject(settings.permissions) ? settings.permissions.deny : undefined;
		const rule = Array.isArray(deny) ? deny.find(each => typeof each === 'string' && /^mcp__facade(?:__|$)/.test(each)) : undefined;
		if (typeof rule === 'string') {
			return vscode.l10n.t("{0} denies {1}, which wins over Facade's allow: with YOLO off, Claude Code asks before Facade's tools", file, rule);
		}
	}
	return undefined;
}

/** The trust `cli` would be given for an agent in `place`, and where; as its launch writes it, without one. */
function trustShown(cli: AgentCli, config: CliConfig, place: { readonly folder: string; readonly repository: string } | undefined, env: Environment): DescribedCli['trust'] {
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
