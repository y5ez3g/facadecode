/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog (CLIS-1.1, CONFIGURATION-2.1): the built-ins in their order, then the CLIs added in the settings file's `clis` in
// its order, each with its entry as read. A settings file wrong as a whole lists none, its problems standing for every start.
// Discovery inspects files and configuration only: it never runs a CLI, logs in, installs or changes settings.

import { PROGRAM_ICON } from '../base/robot';
import { CliAdapter } from './adapter';
import { antigravityAdapter } from './antigravity';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import type { CliProblem } from './config';
import { builtInAdapterOf, programAdapterOf } from './custom';
import { BuiltInFacts, EntrySettings, PROGRAM_TYPE, readEntries } from './entries';
import type { EnvironmentMap } from './environment';
import { museAdapter } from './muse';
import { openCodeAdapter } from './opencode';
import { piAdapter } from './pi';
import type { SettingsSnapshot } from './settingsFile';

/** The built-ins, in the order every list gives them (CLIS-1.1). */
export const BUILT_IN_ADAPTERS: readonly CliAdapter[] = [claudeAdapter, codexAdapter, antigravityAdapter, museAdapter, openCodeAdapter, piAdapter];

/** The built-ins' API IDs: their entries' names in `clis` (CONFIGURATION-2.1). */
const BUILT_IN_IDS: readonly string[] = BUILT_IN_ADAPTERS.map(adapter => adapter.id);

/** What an entry needs to know of each built-in (CONFIGURATION-2.2). */
export const BUILT_IN_FACTS: readonly BuiltInFacts[] = BUILT_IN_ADAPTERS.map(adapter => ({
	id: adapter.id, displayName: adapter.displayName, command: adapter.command, takes: adapter.takes, ...adapter.grammar ? { grammar: adapter.grammar } : {}
}));

/**
 * The built-in whose adapter runs a CLI of the API ID `cli` (CONFIGURATION-2.3): a built-in itself, an added entry's built-in as its
 * run kept it, none for a program - what Facade keys by CLI, its store, exits and session hooks, goes by it.
 */
export function builtInOf(cli: string, kept?: string): string | undefined {
	return kept ?? (BUILT_IN_IDS.includes(cli) ? cli : undefined);
}

/** One CLI of the catalog: its adapter, and its entry as read. */
export interface CatalogEntry {
	readonly adapter: CliAdapter;
	/** Whether new starts are offered it: its `enabled` (CONFIGURATION-2.2). */
	readonly enabled: boolean;
	/** Its `command` as written; empty for its type's command on PATH. */
	readonly path: string;
	/** Its `args`, literal (CLIS-3.1). */
	readonly extra: readonly string[];
	/** The setting `extra` is read from, as a problem with one of them names it: `clis.codex.args`. */
	readonly extraSetting: string;
	/** Its `env` (CLIS-1.2). */
	readonly environment: EnvironmentMap;
	/** Its `model` and `effort`, which a start passes where it asks for none (CONFIGURATION-3.3). */
	readonly model?: string;
	readonly effort?: string;
	/** Its configuration problems, each naming its setting path; while any stands it does not start. */
	readonly problems: readonly CliProblem[];
	/** Its entry as read (CONFIGURATION-2.2). */
	readonly entry: EntrySettings;
}

/** The catalog: its entries, and what is wrong with the settings file as a whole - which, while it stands, stops every start. */
export interface Catalog {
	readonly entries: readonly CatalogEntry[];
	readonly problems: readonly CliProblem[];
	/** The settings file, as a problem names it to the person. */
	readonly file: string;
}

/** The catalog entry of `entry` (CONFIGURATION-2.3): its built-in's adapter, under its own name for an added one, or a program's. */
function catalogEntryOf(entry: EntrySettings): CatalogEntry {
	const builtIn = BUILT_IN_ADAPTERS.find(adapter => adapter.id === entry.type);
	const adapter = entry.builtIn && builtIn ? builtIn : builtIn ? builtInAdapterOf(builtIn, entry) : programAdapterOf(entry);
	return {
		adapter,
		enabled: entry.enabled,
		path: entry.command,
		extra: entry.args,
		extraSetting: `${entry.setting}.args`,
		environment: entry.env,
		...entry.model !== undefined ? { model: entry.model } : {},
		...entry.effort !== undefined ? { effort: entry.effort } : {},
		problems: entry.problems,
		entry
	};
}

/** The catalog under the settings `settings` (CLIS-1.1, CONFIGURATION-2.1): every built-in, a turned-off one too, then the added CLIs. */
export function catalogOf(settings: SettingsSnapshot): Catalog {
	if (settings.problems.length) {
		return { entries: [], problems: settings.problems, file: settings.file };
	}
	return { entries: readEntries(settings.clis, BUILT_IN_FACTS).map(catalogEntryOf), problems: [], file: settings.file };
}

/** Whether `entry` is a program (CONFIGURATION-2.3): an entry of type `custom`, given nothing of Facade's. */
export function isProgram(entry: CatalogEntry): boolean {
	return entry.entry.type === PROGRAM_TYPE;
}

/** The catalog's entry for the API ID `cli`; undefined for one no entry has. */
export function entryOf(catalog: Catalog, cli: string): CatalogEntry | undefined {
	return catalog.entries.find(entry => entry.adapter.id === cli);
}

/**
 * The icon the CLI of the API ID `cli` shows (CONFIGURATION-2.4): its entry's; where the file has no entry of that name now, a built-in's
 * own, else a program's.
 */
export function iconOf(catalog: Catalog, cli: string): string {
	return entryOf(catalog, cli)?.entry.icon ?? (BUILT_IN_IDS.includes(cli) ? cli : PROGRAM_ICON);
}
