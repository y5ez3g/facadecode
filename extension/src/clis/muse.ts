/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CliAdapter, sigintExit } from './adapter';
import { NO_TOOLS } from './tools';

/**
 * Muse Code in its own UI (CLIS-1.3). YOLO on: its tool approvals and its shell sandbox off for the run, `--disable-approval
 * --disable-sandbox` - not `--yolo`, which also withholds its question tool. YOLO off: its approvals and its sandbox as its own
 * configuration has them, the sandbox on unless that turns it off. Every launch trusts the folder it starts in for that launch alone
 * with `--trust-workspace`, as accepting its trust question would, writing nothing (CLIS-3.3, D62). On Windows its installer's
 * `muse.cmd` runs a PowerShell launcher that picks its current program, so it goes through cmd.exe, which takes these arguments
 * safely (CLIS-1.2). It reports its activity by OSC 7501 on Linux and macOS but sends nothing on Windows, where ptyd reads it from
 * its screen instead (CLIS-2.3, D80).
 */
export const museAdapter: CliAdapter = {
	id: 'muse',
	displayName: 'Muse Code',
	setting: 'facade.muse',
	command: 'muse',
	groups: {
		yoloOn: ['--disable-approval', '--disable-sandbox'],
		trust: ['--trust-workspace']
	},
	takes: { model: false, effort: false },
	values: () => ({}),
	tools: NO_TOOLS,
	screenStatus: 'muse',
	title: { names: ['Muse Code', 'Muse', 'muse'] },
	interruptExit: sigintExit
};
