/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Settings for tests: a settings file's text or value read as Facade reads it (CONFIGURATION-1), or the editor settings an
// earlier build read, carried into a settings file as a migration would carry them (CONFIGURATION-6).

import { Catalog, catalogOf } from '../clis/catalog';
import { LegacyReader, migrationOf } from '../clis/migration';
import { parseSettings, SettingsSnapshot } from '../clis/settingsFile';

/** The settings file of a test, as problems name it. */
export const TEST_SETTINGS_FILE = '~/.facade/facade.json';

/** The settings `value` holds: a settings file's text as it is, or a value written as JSON. */
export function settingsOf(value: string | { readonly yolo?: unknown; readonly clis?: unknown; readonly [key: string]: unknown } = {}): SettingsSnapshot {
	return parseSettings(typeof value === 'string' ? value : JSON.stringify(value), TEST_SETTINGS_FILE);
}

/** The catalog of the settings `value` holds. */
export function catalogFrom(value: Parameters<typeof settingsOf>[0] = {}): Catalog {
	return catalogOf(settingsOf(value));
}

/**
 * The settings an earlier build's editor settings `read` stand for: the file a migration makes of them, read as Facade reads it. A
 * migration that makes no file - two old settings that would be one entry - throws, as no test means one.
 */
export function legacy(read: LegacyReader): SettingsSnapshot {
	const migration = migrationOf(read);
	if (migration.kind === 'conflict') {
		throw new Error(`The test's settings make no settings file: ${migration.problems.map(each => each.text).join('; ')}`);
	}
	return settingsOf(migration.kind === 'file' ? migration.text : '{}');
}

/**
 * A settings source of `snapshot`, as HostClis and FacadeSettings users take one: the same settings at every read, or - given a
 * function - the settings it reads at each, as a file saved between two reads would give.
 */
export function sourceOf(snapshot: SettingsSnapshot | (() => SettingsSnapshot)): { readonly snapshot: () => SettingsSnapshot; readonly file: string; readonly shown: string } {
	return { snapshot: typeof snapshot === 'function' ? snapshot : () => snapshot, file: '/home/test/.facade/facade.json', shown: TEST_SETTINGS_FILE };
}

/**
 * The settings `planned` gives its CLI by `--settings`: the JSON of a file of the run, never the option's text, which a process list
 * would show (CONFIGURATION-5.1). It fails where the value is no file the plan writes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runSettingsOf(planned: { readonly args?: readonly string[]; readonly files?: readonly { readonly file: string; readonly content: string }[] }): { readonly [key: string]: any } {
	const args = planned.args ?? [];
	const file = args[args.indexOf('--settings') + 1];
	const written = planned.files?.find(each => each.file === file);
	if (!written) {
		throw new Error(`--settings ${file} is no file of the run`);
	}
	return JSON.parse(written.content);
}
