/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Built-in test inputs in catalog order, with the setting the released build reads and the expected card avatar. */
export const BUILT_INS: readonly { readonly id: string; readonly segment: string; readonly avatar: string }[] = [
	{ id: 'claude', segment: 'claude', avatar: 'avatar-claude.png' },
	{ id: 'codex', segment: 'codex', avatar: 'avatar-codex.png' },
	{ id: 'agy', segment: 'antigravity', avatar: 'avatar-antigravity.png' },
	{ id: 'muse', segment: 'muse', avatar: 'avatar-muse.png' },
	{ id: 'opencode', segment: 'opencode', avatar: 'avatar-opencode.png' },
	{ id: 'pi', segment: 'pi', avatar: 'avatar-pi.png' }
];
