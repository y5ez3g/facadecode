/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import { createServer } from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { officialProducts, type editorProfile } from './editors';

const exec = promisify(execFile);

export async function runEditorCli(
	executable: string, profile: ReturnType<typeof editorProfile>, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number
): Promise<string> {
	const products = officialProducts(executable).map(({ file }) => ({
		app: path.dirname(file), script: path.join(path.dirname(file), 'out', 'cli.js')
	})).filter(({ script }) => fs.statSync(script, { throwIfNoEntry: false })?.isFile());
	assert.strictEqual(products.length, 1, `Expected one official CLI beside ${executable}, found ${JSON.stringify(products)}`);
	const [{ app, script }] = products;
	const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')) as { version: string };
	// The Linux 1.105.1 archive keeps its dependencies unpacked. Use Node for that build to avoid
	// its Electron loader's abort during CLI shutdown. Newer archives can require Electron's ASAR loader.
	const useNode = process.platform === 'linux' && version === '1.105.1';
	const cliEnv: NodeJS.ProcessEnv = { ...env, ...profile.env };
	if (useNode) {
		delete cliEnv.ELECTRON_RUN_AS_NODE;
	} else {
		cliEnv.ELECTRON_RUN_AS_NODE = '1';
	}
	const { stdout } = await exec(useNode ? process.execPath : executable, [script, ...profile.args, ...args], {
		env: cliEnv, encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true
	});
	return stdout;
}

/** Both required VSIXs are local. Refuse incidental Marketplace connections immediately in this CLI's environment. */
export async function installLocalVsixes(
	executable: string, profile: ReturnType<typeof editorProfile>, files: readonly string[], env: NodeJS.ProcessEnv, timeout: number
): Promise<void> {
	const deny = createServer(socket => socket.destroy());
	try {
		deny.listen(0, '127.0.0.1');
		await once(deny, 'listening');
		const address = deny.address();
		assert.ok(address && typeof address !== 'string');
		const proxy = `http://127.0.0.1:${address.port}`;
		const offline = { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '' };
		for (const file of files) {
			await runEditorCli(executable, profile, ['--install-extension', file, '--force', '--do-not-include-pack-dependencies'], offline, timeout);
		}
	} finally {
		deny.close();
	}
}
