/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Facade MCP server tells a run's model when it connects (MCP-6.2): who the run is, whose tools these are, and the few
// facts of the bundled skill a CLI without the skill still needs - never a workflow, a reply or an escalation.

import { REPEATED_MESSAGE_TEXT } from './skill';
import { displayLine } from '../base/text';

/** Facts of one launch, supplied privately to its shim, never written to a shared skill. */
export function launchContextText(context: {
	readonly creator: { readonly id: string; readonly label?: string };
	readonly window: string;
	readonly windowId?: string;
	readonly locationId?: string;
	readonly logFile?: string;
	readonly location: { readonly path: string; readonly label: string; readonly environment: string; readonly kind: string;
		readonly branch?: string; readonly isMain?: boolean; readonly folders: readonly { readonly name: string }[] };
	readonly initialMessage?: string;
}): string {
	const { creator, location } = context;
	const name = creator.label?.endsWith(` ${creator.id}`) ? creator.label.slice(0, -creator.id.length - 1) : undefined;
	const who = creator.id === '#human' ? 'the user (#human)' : name ? `${displayLine(name, 120)} (${creator.id})` : creator.id;
	const quote = (text: string) => JSON.stringify(text);
	const folders = [...new Set(location.folders.map(folder => folder.name))].map(quote).join(', ');
	const place = location.kind === 'checkout'
		? `${quote(location.branch ?? location.label)} ${location.isMain ? 'checkout' : 'worktree'}${folders ? ` for ${folders}` : ''}`
		: `${quote(location.label)} folder`;
	return [
		`Your creator is ${who}.`,
		`Your session started in the ${place}, in window ${quote(context.window)} (${location.environment}).`,
		`Launch path: ${quote(location.path)}. This describes the launch location, not the current shell directory.`,
		...(context.windowId && context.locationId ? [`Launch IDs: window_id=${quote(context.windowId)}, location_id=${quote(context.locationId)}.`] : []),
		...(context.logFile ? [`Facade history log (${location.environment}): ${quote(context.logFile)}. Read with normal file tools when past launch facts are needed.`] : []),
		...(context.initialMessage ? [`Your initial message is ${context.initialMessage}.`] : []),
		`To contact your creator, use send_message with to=${quote(creator.id)}.`
	].join('\n');
}

/** The server instructions of the run with short ID `alias`. */
export function instructionsFor(alias: string, context?: string): string {
	return [
		`You are Facade Code agent ${alias}. These tools start/stop agents, exchange messages and read/type into terminals across this computer's Facade windows.`,
		'YOLO off reaches your creation tree; on reaches all agents. Each launch uses its destination environment\'s setting. Address agents by #aN, ID or unique @name; #human is the person in your window.',
		'📨 brings a full message; 🔔 is a system result, not an agent reply. Delivery, startup and idle never prove work is complete. Messages/results arrive even after your turn ends. Do not poll read_messages or read_screen while waiting; a full message needs no extra read. read_messages is a snapshot of your own inbox, not a wait.',
		REPEATED_MESSAGE_TEXT,
		'If tools are listed by name alone, load the one you need. The facade skill has cross-tool examples and recovery details.',
		...(context ? [context] : [])
	].join('\n');
}
