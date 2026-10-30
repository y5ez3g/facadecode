/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalFolder } from '../base/files';
import { CliAdapter, sigintExit } from './adapter';

/** A TOML basic string for Codex's per-launch configuration (CLIS-3.2), including every control character. */
export function tomlString(text: string): string {
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
		throw new Error('A Codex configuration value contains an unpaired UTF-16 surrogate.');
	}
	const escapes: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
	return `"${text.replace(/["\\\u0000-\u001F\u007F]/g, char => escapes[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`;
}

/**
 * Codex in its interactive terminal (CLIS-1.3, 3.3): trust applies to this launch through a TOML override, without writing its
 * configuration. YOLO bypasses approvals and sandbox; otherwise workspace-write keeps its native approval policy.
 */
export const codexAdapter: CliAdapter = {
	id: 'codex',
	displayName: 'Codex',
	setting: 'facade.codex',
	command: 'codex',
	groups: {
		yoloOn: ['--dangerously-bypass-approvals-and-sandbox'],
		yoloOff: ['--sandbox', 'workspace-write'],
		trust: ['-c', 'projects={ ${folderToml} = { trust_level = "trusted" } }']
	},
	values: ({ cwd, platform }) => {
		const folder = canonicalFolder(cwd);
		return { folderToml: tomlString(platform === 'win32' ? folder.replace(/[A-Z]/g, letter => letter.toLowerCase()) : folder) };
	},
	title: { names: ['Codex', 'codex'] },
	interruptExit: sigintExit
};
