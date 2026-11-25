/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The environment of the Framework: what a start's `env` carries to framework (CLIS-1.2's layers, less the entry's own `env`, which framework
// applies), and what the window's own terminals are given so that `facade` typed there reaches framework.

import * as path from 'path';
import * as vscode from 'vscode';
import { composeEnvironment, setVariable, variableOf } from '../../base/terminalEnvironment';
import type { Location } from '../../core/ports';
import { FACADE_HOME_VARIABLE } from '../../record/paths';
import { destinationEnvironment } from '../terminals';

/** The switch that keeps Claude Code from installing its VS Code extension and showing a welcome no message goes past (CLIS-1.2). */
const AUTO_INSTALL_SWITCH = 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL';

/**
 * The environment a start or resume at `location` sends framework in its `env`: CLIS-1.2's host, `terminal.integrated.env` and default
 * profile layers for the location, without ELECTRON_RUN_AS_NODE, with `TERM_PROGRAM=vscode` and `COLORTERM=truecolor`, the switch
 * against Claude Code's extension install where no layer sets it, and `FACADE_HOME=<home>`. The entry's own `env` is framework's.
 */
export function startEnvironment(location: Pick<Location, 'uri'> | undefined, home: string): Record<string, string> {
	const { host, terminal, profile, platform } = destinationEnvironment(location && vscode.Uri.parse(location.uri));
	const env = composeEnvironment({ host, terminal, profile }, platform);
	if (variableOf(env, AUTO_INSTALL_SWITCH, platform) === undefined) {
		setVariable(env, AUTO_INSTALL_SWITCH, '1', platform);
	}
	setVariable(env, FACADE_HOME_VARIABLE, home, platform);
	return env;
}

/**
 * Gives the window's terminals `facade` and the switch against Claude Code's extension install. With a `home` (a Framework window) `PATH`
 * has `<home>/framework/bin` and the path delimiter put before it; without one (a legacy implementation window) both are removed. No other variable
 * is touched: `FACADE_HOME` stays `useFacadeHome`'s.
 */
export function facadeInTerminals(collection: vscode.EnvironmentVariableCollection, home: string | undefined): void {
	if (home === undefined) {
		collection.delete('PATH');
		collection.delete(AUTO_INSTALL_SWITCH);
		return;
	}
	collection.prepend('PATH', path.join(home, 'framework', 'bin') + path.delimiter);
	collection.replace(AUTO_INSTALL_SWITCH, '1');
}
