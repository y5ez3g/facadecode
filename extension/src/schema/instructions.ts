/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Facade MCP server tells a run's model when it connects (MCP-6.2): who the run is, whose tools these are, and the few
// facts of the bundled skill a CLI without the skill still needs - never a workflow, a reply or an escalation.

import { REPEATED_MESSAGE_TEXT } from './skill';
/** The server instructions of the run with short ID `alias`. */
export function instructionsFor(alias: string): string {
	return [
		`You are Facade Code agent ${alias}. These tools start/stop agents, exchange messages and read/type into terminals across this computer's Facade windows.`,
		"list_start_options defaults to your launch location and CLIs. start_agent needs name, window_id, location_id and cli. With YOLO off you reach your creation tree; with it on, every agent. Each launch uses its environment's YOLO setting.",
		'Address agents by #aN, ID or unique @name; #human is the person in your window. 📨 introduces a full incoming message; 🔔 reports a system result, not an agent reply. Delivery notices cite the original message; async start/stop notices match result_message_id. Neither confirms task completion.',
		'Messages and final results are pushed into your terminal, even after your turn ends. Do not poll read_messages or read_screen while waiting. read_messages returns an immediate snapshot of your own inbox: undelivered messages by default, or specific IDs. Full messages need no extra read. type_text/press_keys write raw input without a message wrapper or draft protection.',
		REPEATED_MESSAGE_TEXT,
		'If tools are listed by name alone, load the one you need before calling it. The facade skill describes the tools.'
	].join('\n');
}
