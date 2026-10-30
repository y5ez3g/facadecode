/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The one environment rule of CLIS-1.2, shared by discovery and launch so that the program found is the program started: the
// execution extension host's environment, the folder's `terminal.integrated.env.<platform>`, the `env` map of the default
// terminal profile, then the run's own variables. No shell is started to find more.

/** Environment variables as a process holds them. */
export type Environment = { readonly [name: string]: string | undefined };

/** A configured environment map: a string sets the variable, null removes it, an omitted name inherits (CLIS-1.2). */
export type EnvironmentMap = { readonly [name: string]: string | null };

/** The configured layers over the host's environment, lowest first (CLIS-1.2). */
export interface EnvironmentLayers {
	/** The execution extension host's environment; `${env:NAME}` reads it. */
	readonly host: Environment;
	/** `terminal.integrated.env.<platform>` as the destination folder has it. */
	readonly terminal?: EnvironmentMap;
	/** The `env` map of the profile `terminal.integrated.defaultProfile.<platform>` names; none adds nothing. */
	readonly profile?: EnvironmentMap;
}

/** The variable CLIs started by Facade are told their run by: its `#aN` alias (CLIS-1.2). */
export const RUN_VARIABLE = 'FACADE_AGENT';

/** Whether `platform` takes a variable's name in any case: Windows does. */
function caseless(platform: NodeJS.Platform): boolean {
	return platform === 'win32';
}

/** The names `env` has for the variable `name`: on Windows every key of it in any case, elsewhere `name` alone where present. */
function namesOf(env: Environment, name: string, platform: NodeJS.Platform): string[] {
	if (!caseless(platform)) {
		return Object.hasOwn(env, name) ? [name] : [];
	}
	const upper = name.toUpperCase();
	return Object.keys(env).filter(key => key.toUpperCase() === upper);
}

/** The value `env` has for `name`, as `platform` compares names. */
export function variableOf(env: Environment, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
	const [key] = namesOf(env, name, platform);
	return key === undefined ? undefined : env[key];
}

/**
 * Sets `name` in `env` to `value`, or removes it for null: on Windows the variable keeps the name it has, whatever case `name`
 * is in, and no second key of another case is left beside it.
 */
export function setVariable(env: { [name: string]: string }, name: string, value: string | null, platform: NodeJS.Platform = process.platform): void {
	const [kept, ...others] = namesOf(env, name, platform);
	for (const other of others) {
		delete env[other];
	}
	if (value === null) {
		if (kept !== undefined) {
			delete env[kept];
		}
		return;
	}
	env[kept ?? name] = value;
}

/** `value` with each `${env:NAME}` read from the host's environment, an unset one empty (CLIS-1.2). */
export function withHostVariables(value: string, host: Environment, platform: NodeJS.Platform = process.platform): string {
	return value.replace(/\$\{env:(?<name>[^}]+)\}/g, (_, name: string) => variableOf(host, name, platform) ?? '');
}

/** `env` with the configured `map` over it: each string set, its `${env:NAME}` read from `host`; each null removed. */
function applied(env: { [name: string]: string }, map: EnvironmentMap | undefined, host: Environment, platform: NodeJS.Platform): void {
	for (const [name, value] of Object.entries(map ?? {})) {
		setVariable(env, name, typeof value === 'string' ? withHostVariables(value, host, platform) : null, platform);
	}
}

/**
 * The environment a CLI is found and started with in a destination folder, before its run's own variables: the layers in their
 * order (CLIS-1.2), then what every agent terminal has - no ELECTRON_RUN_AS_NODE, which would make an Electron-based CLI run as
 * Node, and VS Code's terminal program and colour depth.
 */
export function composeEnvironment(layers: EnvironmentLayers, platform: NodeJS.Platform = process.platform): { [name: string]: string } {
	const env: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(layers.host)) {
		if (typeof value === 'string') {
			setVariable(env, name, value, platform);
		}
	}
	applied(env, layers.terminal, layers.host, platform);
	applied(env, layers.profile, layers.host, platform);
	setVariable(env, 'ELECTRON_RUN_AS_NODE', null, platform);
	setVariable(env, 'TERM_PROGRAM', 'vscode', platform);
	setVariable(env, 'COLORTERM', 'truecolor', platform);
	return env;
}

/** The environment a run starts with: the destination's, with the run's alias in {@link RUN_VARIABLE} (CLIS-1.2). */
export function runEnvironment(base: Environment, alias: string, platform: NodeJS.Platform = process.platform): { [name: string]: string } {
	const env: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(base)) {
		if (typeof value === 'string') {
			env[name] = value;
		}
	}
	setVariable(env, RUN_VARIABLE, alias, platform);
	return env;
}
