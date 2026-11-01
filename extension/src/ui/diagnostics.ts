/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CliChoice, RunFacts } from '../core/ports';
import { referenceOf } from './cardView';

/** How many of a live agent's last screen rows, and of the agents log's last lines, Copy Diagnostics copies (ARCHITECTURE-3.3). */
export const SCREEN_ROWS = 12;
export const LOG_LINES = 200;

/** A built-in CLI as Copy Diagnostics names it: whether it can start, its version as its installation says it, its input reader. */
export interface DiagnosedCli {
	readonly choice: CliChoice;
	readonly version?: string;
	readonly input?: string;
}

/** An agent of this window as Copy Diagnostics names it: its facts, what its input reader reads now, its last screen rows. */
export interface DiagnosedAgent {
	readonly facts: RunFacts;
	readonly input?: string;
	readonly screen?: readonly string[];
}

/** What Copy Diagnostics copies, gathered (ARCHITECTURE-3.3, D116). */
export interface Diagnostics {
	readonly at: number;
	/** The extension's, its window component's and the editor's versions, the platform and the remote kind, each as one part. */
	readonly about: readonly string[];
	readonly collaboration: boolean;
	/** The CLI catalog for the window's first location, with its configuration problems; none where no folder is open. */
	readonly clis?: { readonly where: string; readonly each: readonly DiagnosedCli[]; readonly problems?: readonly { readonly setting: string; readonly problem: string }[] };
	readonly agents: readonly DiagnosedAgent[];
	/** The agents log's last lines, oldest first. */
	readonly log: readonly string[];
	/** The home folder, written `~` wherever it appears. */
	readonly home: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

function cliLine({ choice, version, input }: DiagnosedCli): string {
	const what = choice.notInstalled ? 'not installed'
		: !choice.available ? `cannot start: ${choice.problem ?? 'not available'}`
		: `${version ?? 'version not known'}; input reader ${input ?? 'none'}`;
	return `- ${choice.displayName} (${choice.id}): ${what}`;
}

function agentLines({ facts, input, screen }: DiagnosedAgent): string[] {
	const state = [
		facts.lifecycle === 'starting' ? `starting (${facts.phase})` : facts.lifecycle,
		...facts.lifecycle === 'ended' ? [] : [`${facts.activity}${facts.activitySince !== undefined ? ` since ${iso(facts.activitySince)}` : ''}${facts.reporting ? '' : ', its CLI not reporting'}`],
		...facts.blocker ? [`waiting on its ${facts.blocker.kind}${facts.blocker.text ? ` (${JSON.stringify(facts.blocker.text)})` : ''}`] : []
	].join(', ');
	const tools = `tools ${facts.tools}${facts.toolsReason ? ` (${facts.toolsReason})` : ''}`;
	const reader = `input reader ${facts.inputAdapter ?? 'none'}${input ? `, reads ${input}` : ''}`;
	const ended = facts.end ? [`  ended ${facts.end.kind}${facts.end.code !== undefined ? `, code ${facts.end.code}` : ''}${facts.end.signal ? `, ${facts.end.signal}` : ''} at ${iso(facts.end.at)}`] : [];
	const error = facts.error ? [`  error from ${facts.error.source}: ${facts.error.reason}`] : [];
	// Its last rows that have something on them, the rows above them blank cut
	const rows = [...screen ?? []];
	while (rows.length && !rows[0].trim()) {
		rows.shift();
	}
	return [
		`- ${referenceOf(facts)} ${facts.id}: ${facts.displayName}${facts.version ? ` ${facts.version}` : ''}, YOLO ${facts.yolo ? 'on' : 'off'}, in ${facts.cwd}`,
		`  ${state}; ${tools}; ${reader}`,
		...ended,
		...error,
		...rows.map(row => `  | ${row.trimEnd()}`)
	];
}

/**
 * `text` with the home folder written `~` wherever it appears (D116), as `platform` compares paths: whatever its case on Windows and
 * macOS, and whichever its separators on Windows - VS Code writes a drive letter in lower case, Node in upper. A home of one character,
 * a root, stays as it is.
 */
function withHomeAsTilde(text: string, home: string, platform: NodeJS.Platform): string {
	if (home.length <= 1) {
		return text;
	}
	const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = platform === 'win32' ? escaped.replace(/\\\\|\//g, '[\\\\/]') : escaped;
	return text.replace(new RegExp(pattern, platform === 'win32' || platform === 'darwin' ? 'gi' : 'g'), '~');
}

/**
 * The text Copy Diagnostics puts on the clipboard (ARCHITECTURE-3.3, D116): in English, as the agents log is, with the home folder
 * written `~`. Nothing in it is sent anywhere.
 */
export function diagnosticsText(diagnostics: Diagnostics, platform: NodeJS.Platform = process.platform): string {
	const lines = [
		`Facade Code diagnostics, ${iso(diagnostics.at)}`,
		diagnostics.about.join('; '),
		`Collaboration through Facade's tools: ${diagnostics.collaboration ? 'on' : 'off'}`,
		'',
		...diagnostics.clis ? [`CLIs for ${diagnostics.clis.where}`, ...diagnostics.clis.each.map(cliLine), ...diagnostics.clis.problems?.map(({ setting, problem }) => `- Configuration error (${setting}): ${problem}`) ?? []] : ['CLIs: no folder is open, and CLIs are found for one'],
		'',
		`Agents in this window: ${diagnostics.agents.length}`,
		...diagnostics.agents.flatMap(agentLines),
		'',
		`Agents log, its last ${diagnostics.log.length} lines`,
		...diagnostics.log
	];
	return withHomeAsTilde(`${lines.join('\n')}\n`, diagnostics.home, platform);
}
