/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import type { Agents, LocationPort, RunFacts, RunId } from '../core/ports';
import type { ScreenRead } from '../ptyd/protocol';
import { DiagnosedAgent, Diagnostics, diagnosticsText, LOG_LINES, SCREEN_ROWS } from '../ui/diagnostics';
import type { HostClis } from './clis';
import { WINDOW_COMPONENT } from './windowComponent';

export const COPY_DIAGNOSTICS_COMMAND = 'facade.copyDiagnostics';

/** How long an agent's screen or input reader is waited for: one that does not answer is said not to. */
const READ_MS = 3_000;
/** How much of the agents log's end is read for its last lines. */
const LOG_TAIL_BYTES = 256 * 1024;

export interface DiagnosticsDeps {
	readonly agents: Pick<Agents, 'list'>;
	readonly locations: Pick<LocationPort, 'snapshot'>;
	readonly clis: Pick<HostClis, 'list' | 'describe' | 'collaborationEnabled'>;
	readonly readScreen: (run: RunId, lines: number) => Promise<ScreenRead>;
	readonly inspect: (run: RunId) => Promise<string>;
	readonly logFile: string;
	readonly version: string;
	/** The window component's version as it answered this window's identity, which a remote extension host sees no other way. */
	readonly component?: string;
	readonly home: string;
}

/** `promise`'s value, or `late` once it took longer than READ_MS, or what it failed with. */
async function within<T>(promise: Promise<T>, late: string, failed: (why: string) => string): Promise<T | string> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<string>(resolve => { timer = setTimeout(() => resolve(late), READ_MS); })]);
	} catch (err) {
		return failed(messageOf(err));
	} finally {
		clearTimeout(timer);
	}
}

/** The agents log's last lines, read from its end alone. */
function logTail(file: string): readonly string[] {
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const { size } = fs.fstatSync(fd);
			const start = Math.max(0, size - LOG_TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			const lines = buffer.toString('utf8').split('\n');
			// A line the read began within is not whole
			return (start > 0 ? lines.slice(1) : lines).filter(Boolean).slice(-LOG_LINES);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		return [`(the agents log could not be read: ${messageOf(err)})`];
	}
}

async function agentOf(deps: DiagnosticsDeps, facts: RunFacts): Promise<DiagnosedAgent> {
	if (facts.lifecycle === 'ended') {
		return { facts };
	}
	const [screen, input] = await Promise.all([
		within(deps.readScreen(facts.id, SCREEN_ROWS), '(its screen did not answer)', why => `(its screen could not be read: ${why})`),
		within(deps.inspect(facts.id), 'nothing: it did not answer', why => `nothing: ${why}`)
	]);
	return { facts, input, screen: typeof screen === 'string' ? [screen] : screen.text };
}

/** Everything Copy Diagnostics copies, gathered now (ARCHITECTURE-3.3, D116). */
export async function diagnosticsOf(deps: DiagnosticsDeps): Promise<string> {
	const component: unknown = deps.component ?? vscode.extensions.getExtension(WINDOW_COMPONENT)?.packageJSON?.version;
	const location = deps.locations.snapshot().locations[0];
	let clis: Diagnostics['clis'];
	if (location) {
		const launches = deps.clis.describe(location, false).launches;
		const choices = await deps.clis.list(location);
		clis = {
			where: location.path,
			problems: choices.problems.map(({ setting, problem }) => ({ setting, problem })),
			each: choices.clis.map(choice => {
				const known = launches.find(each => each.cli === choice.id);
				return { choice, ...known?.version ? { version: known.version.version } : {}, ...known?.input?.adapter ? { input: known.input.adapter } : {} };
			})
		};
	}
	return diagnosticsText({
		at: Date.now(),
		about: [
			`Facade Code ${deps.version}`,
			// In a remote window the component runs on this computer, out of the remote extension host's sight but for its own answer
			`window component ${typeof component === 'string' ? component : 'out of sight of this extension host'}`,
			`${vscode.env.appName} ${vscode.version}`,
			`${process.platform} ${process.arch}`,
			vscode.env.remoteName ? `remote ${vscode.env.remoteName}` : 'local'
		],
		collaboration: deps.clis.collaborationEnabled(),
		...clis ? { clis } : {},
		agents: await Promise.all(deps.agents.list().map(facts => agentOf(deps, facts))),
		log: logTail(deps.logFile),
		home: deps.home
	});
}

/** Copy Diagnostics (UX-3.1): the text on the clipboard, and a notification that says what it holds. */
export function registerDiagnostics(deps: DiagnosticsDeps): vscode.Disposable[] {
	return [vscode.commands.registerCommand(COPY_DIAGNOSTICS_COMMAND, async () => {
		await vscode.env.clipboard.writeText(await diagnosticsOf(deps));
		void vscode.window.showInformationMessage(vscode.l10n.t("Facade's diagnostics are copied. They include your agents' screens, which can show code or keys: read them before you share them."));
	})];
}
