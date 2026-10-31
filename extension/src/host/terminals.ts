/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor's terminal settings an agent's environment follows (CLIS-1.2, UX-4.2), read for the destination location: its
// `terminal.integrated.env.<platform>` and the `env` map of its default terminal profile. No shell is started to find more.

import * as vscode from 'vscode';
import { isJsonObject } from '../base/json';
import type { EnvironmentMap } from '../clis/environment';
import type { DestinationEnvironment } from '../clis/plan';

/** The platform's name in VS Code's terminal settings. */
function settingsPlatform(platform: NodeJS.Platform): 'osx' | 'linux' | 'windows' {
	return platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux';
}

/** A configured environment map as the terminal takes it: string values set, null ones remove; other values are not variables. */
function mapOf(value: unknown): EnvironmentMap | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const map: { [name: string]: string | null } = {};
	for (const [name, each] of Object.entries(value)) {
		if (typeof each === 'string' || each === null) {
			map[name] = each;
		}
	}
	return map;
}

/**
 * The destination environment's layers for a launch in the folder `scope` names (CLIS-1.2): the extension host's environment,
 * the folder's `terminal.integrated.env.<platform>`, and the `env` of the profile `terminal.integrated.defaultProfile.<platform>`
 * names in `terminal.integrated.profiles.<platform>` - none where no default profile is set or it has no env map.
 */
export function destinationEnvironment(scope: vscode.Uri | undefined): DestinationEnvironment {
	const platform = process.platform;
	const key = settingsPlatform(platform);
	const terminal = vscode.workspace.getConfiguration('terminal.integrated', scope);
	const name = terminal.get<unknown>(`defaultProfile.${key}`);
	const profiles = terminal.get<unknown>(`profiles.${key}`);
	const profile = typeof name === 'string' && isJsonObject(profiles) && isJsonObject(profiles[name]) ? mapOf(profiles[name].env) : undefined;
	return {
		host: process.env,
		...mapOf(terminal.get<unknown>(`env.${key}`)) ? { terminal: mapOf(terminal.get<unknown>(`env.${key}`)) } : {},
		...profile ? { profile, profileName: name as string } : {},
		platform
	};
}

/** The terminal environment setting of this platform, as Show Agent Launch names that layer (CLIS-1.2, 4.1). */
export function terminalEnvSetting(): string {
	return `terminal.integrated.env.${settingsPlatform(process.platform)}`;
}
