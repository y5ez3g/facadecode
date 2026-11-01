/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Facade MCP server tells a run's model when it connects (MCP-6.2): who the run is, whose tools these are, and the few
// facts of the bundled skill a CLI without the skill still needs - never a workflow, a reply or an escalation.

import { REPEATED_MESSAGE_TEXT } from './skill';

/** The server instructions of the run with short ID `alias`. */
export function instructionsFor(alias: string): string {
	return [
		`You are Facade Code agent ${alias}. These are the Facade Code tools: start and stop agents, send and read messages, and read or type into agent terminals, in every Facade window on this computer.`,
		'start_agent needs name, window_id, location_id and cli; list_start_options finds them. An agent you start joins your creation tree; its YOLO comes from its environment\'s setting at launch. With YOLO on you reach every agent; with YOLO off only your whole creation tree: every agent under the same root.',
		'Refer to an agent by ID, #aN or a unique @name; #human is the person in your window. Messages to you arrive in your terminal as [Facade message #mN | from ...] blocks, and the outcome of your accepted sends as [Facade result ...] blocks. read_messages reads your own inbox only: by default what has not reached you yet, or any message by ID.',
		REPEATED_MESSAGE_TEXT,
		'Where your CLI lists these tools by name alone until they are loaded, load the one you need before you call it.',
		'The facade skill, where your CLI has it, describes each tool.'
	].join('\n');
}
