/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CliAdapter, sigintExit } from './adapter';

/**
 * OpenCode in its own UI, its 2.x line (CLIS-1.3, D78). YOLO on: `--auto`, which answers each of its permission questions for the
 * run - its `--yolo` and `--dangerously-skip-permissions` are the same switch - while a rule its configuration denies still holds.
 * YOLO off: its own permission configuration, whose defaults allow every tool (D79). It has no sandbox and asks no trust question,
 * so a launch is given none (CLIS-3.3). From 2.x it reports by OSC 7501 itself - its own record, and one for each session with the
 * session's `id`, which is not the run's (CLIS-2.3); 1.x sends no reports. npm's shim starts its native program (CLIS-1.2).
 */
export const openCodeAdapter: CliAdapter = {
	id: 'opencode',
	displayName: 'OpenCode',
	setting: 'facade.opencode',
	command: 'opencode',
	groups: {
		yoloOn: ['--auto']
	},
	values: () => ({}),
	// `OpenCode` until a session has a title, then `OC | {title}`. Its reports title a session it has not named yet with its own
	// default, `New session - {ISO time}` - `Child session` for a subagent's - which its terminal title never shows
	title: { names: ['OpenCode', 'opencode', 'OC'], placeholder: /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
	sandbox: () => ({ state: 'none' }),
	// Its own permission configuration, whose defaults allow every tool, where YOLO is off (D79)
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--auto'] } : { state: 'native' },
	interruptExit: sigintExit
};
