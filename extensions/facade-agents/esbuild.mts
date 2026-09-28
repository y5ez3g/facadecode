/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		// The extension host side: engine, pipe server, terminals, approvals.
		'extension': path.join(srcDir, 'extension.ts'),
		// Facade's helper process: the MCP server each agent starts, the runner of headless
		// workers and the handler of agents' command hooks. It runs outside the extension host,
		// as its own process under ELECTRON_RUN_AS_NODE, and must sit next to `extension.js`.
		'shim': path.join(srcDir, 'shim.ts'),
	},
	srcDir,
	outdir: outDir,
}, process.argv);
