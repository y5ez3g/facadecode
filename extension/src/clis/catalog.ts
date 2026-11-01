/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog (CLIS-1.1): the built-ins in their order, then the custom CLIs in configuration order (CLIS-3.4), each with its
// settings as read. Discovery inspects files and configuration only: it never runs a CLI, logs in, installs or changes settings.

import { CliAdapter } from './adapter';
import { antigravityAdapter } from './antigravity';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { CliProblem, CliSettings, readCliSettings } from './config';
import { CUSTOM_SETTING, customAdapterOf, CustomCliSettings, readCustomClis } from './custom';
import { museAdapter } from './muse';
import { openCodeAdapter } from './opencode';
import { piAdapter } from './pi';

/** The built-ins, in the order every list gives them (CLIS-1.1). */
export const BUILT_IN_ADAPTERS: readonly CliAdapter[] = [claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, openCodeAdapter, piAdapter];

/** The built-ins' API IDs, which no custom key may shadow (CLIS-3.4). */
const BUILT_IN_IDS = BUILT_IN_ADAPTERS.map(adapter => adapter.id);

/** One CLI of the catalog: its adapter, and its settings as read. */
export interface CatalogEntry {
	readonly adapter: CliAdapter;
	/** Whether new starts are offered it: a built-in's `.enabled`; a custom CLI always is (CLIS-1.1). */
	readonly enabled: boolean;
	/** The configured program: a built-in's `.path`, empty for its command on PATH; a custom CLI's `path`. */
	readonly path: string;
	/** The configured literal options: a built-in's `.launch.arguments`, a custom CLI's `.launch.start` (CLIS-3.1, 3.4). */
	readonly extra: readonly string[];
	/** The setting `extra` is read from, as a problem with one of them names it. */
	readonly extraSetting: string;
	/** The configured variables: `.launch.environment` (CLIS-1.2, 3.1). */
	readonly environment: CliSettings['environment'];
	/** Its configuration problems, each naming the setting path; while any stands it does not start. */
	readonly problems: CliSettings['problems'];
	/** A custom CLI's definition as read (CLIS-3.4). */
	readonly custom?: CustomCliSettings;
}

/**
 * The options a built-in's adapter sets itself - its run settings and its YOLO mapping, either way (CLIS-1.3, 3.2): a launch argument
 * repeating one would put the person's value in Facade's place, so it is refused (CLIS-3.1). Its folder's trust is not among them.
 */
export function ownedOptions(adapter: CliAdapter): readonly string[] {
	// A generic configuration flag carries unrelated user settings too; never reserve all of Codex's or Muse's -c.
	return [...adapter.groups.quiet ?? [], ...adapter.groups.yoloOn ?? [], ...adapter.groups.yoloOff ?? []].filter(token => token.startsWith('-') && token !== '-c');
}

/** How the catalog reads the settings: by their full names, as the destination environment's editor has them. */
export type SettingsReader = (name: string) => unknown;

/** The catalog: its entries, and what no entry stands for - `facade.custom` wrong as a whole, or a key that cannot be a CLI's ID. */
export interface Catalog {
	readonly entries: readonly CatalogEntry[];
	readonly problems: readonly CliProblem[];
}

/** The catalog under the settings `read` gives (CLIS-1.1, 1.2, 3.1, 3.4): every built-in, a turned-off one too, then the custom CLIs. */
export function catalogOf(read: SettingsReader): Catalog {
	const builtIns = BUILT_IN_ADAPTERS.map((adapter): CatalogEntry => {
		const settings = readCliSettings(adapter.setting, key => read(`${adapter.setting}.${key}`), ownedOptions(adapter));
		return {
			adapter,
			enabled: settings.enabled,
			path: settings.path,
			extra: settings.arguments,
			extraSetting: `${adapter.setting}.launch.arguments`,
			environment: settings.environment,
			problems: settings.problems
		};
	});
	const { clis, problems } = readCustomClis(read(CUSTOM_SETTING), BUILT_IN_IDS);
	const custom = clis.map((settings): CatalogEntry => ({
		adapter: customAdapterOf(settings),
		enabled: true,
		path: settings.path,
		extra: settings.start,
		extraSetting: `${settings.setting}.launch.start`,
		environment: settings.environment,
		problems: settings.problems,
		custom: settings
	}));
	return { entries: [...builtIns, ...custom], problems };
}

/** The catalog's entry for the API ID `cli`; undefined for one no built-in or custom definition has. */
export function entryOf(catalog: Catalog, cli: string): CatalogEntry | undefined {
	return catalog.entries.find(entry => entry.adapter.id === cli);
}
