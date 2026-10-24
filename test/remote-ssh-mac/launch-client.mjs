// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
	app: { type: 'string' },
	campaign: { type: 'string' },
	name: { type: 'string' },
	mirror: { type: 'string' }
} });
if (process.platform !== 'darwin' || !values.app || !values.campaign || !values.name || !/^[a-z0-9-]+$/.test(values.name)) {
	throw new Error('Usage on macOS: node launch-client.mjs --app <app bundle> --campaign <directory> --name <name> [--mirror <URL template>]');
}

const app = resolve(values.app);
const executable = join(app, 'Contents/MacOS/Facade Code');
if (!existsSync(executable)) {
	throw new Error(`Packaged application missing: ${executable}`);
}
const campaign = resolve(values.campaign);
const evidenceDir = join(campaign, 'client-' + values.name);
mkdirSync(evidenceDir, { recursive: true });
// A short path is required by macOS's Unix-domain socket limit.
const runDir = mkdtempSync('/tmp/fssh24-' + values.name + '-');
for (const folder of ['user-data/User', 'extensions', 'shared-data', 'facade-home', 'local-fixture']) {
	mkdirSync(join(runDir, folder), { recursive: true, mode: 0o700 });
}
const settings = {
	'window.title': 'Remote SSH 24h - ${rootName} - ${remoteName} - ${activeEditorShort}',
	'files.simpleDialog.enable': true,
	'telemetry.telemetryLevel': 'off',
	'update.mode': 'none',
	'extensions.autoUpdate': false,
	'extensions.autoCheckUpdates': false,
	'workbench.startupEditor': 'none',
	'remote.SSH.configFile': join(campaign, 'auth/ssh_config'),
	'remote.SSH.serverInstallPath': {
		'facade-test-linux': '/home/aaron/facade-ssh-test-20261023/server-data',
		'facade-test-windows': 'C:\\fssh24-a447\\server-data'
	}
};
if (values.mirror) {
	settings['remote.SSH.serverDownloadUrlTemplate'] = values.mirror;
}
writeFileSync(join(runDir, 'user-data/User/settings.json'), JSON.stringify(settings, null, 2) + '\n');
writeFileSync(join(runDir, 'local-fixture/sentinel.txt'), 'Local client fixture; remote assertions must name their actual host.\n');

const listener = net.createServer();
await new Promise((resolve, reject) => {
	listener.once('error', reject);
	listener.listen(0, '127.0.0.1', resolve);
});
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const env = { ...process.env, FACADE_HOME: join(runDir, 'facade-home') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'VSCODE_DEV']) {
	delete env[key];
}
const log = openSync(join(evidenceDir, 'application.log'), 'a', 0o600);
const child = spawn(executable, [
	'--new-window',
	'--user-data-dir=' + join(runDir, 'user-data'),
	'--extensions-dir=' + join(runDir, 'extensions'),
	'--shared-data-dir=' + join(runDir, 'shared-data'),
	'--remote-debugging-port=' + port,
	'--disable-renderer-backgrounding',
	'--disable-backgrounding-occluded-windows',
	'--disable-updates', '--skip-welcome', '--skip-release-notes', '--locale=en',
	join(runDir, 'local-fixture')
], { env, detached: true, stdio: ['ignore', log, log] });
child.unref();
const info = { pid: child.pid, cdpPort: port, runDir, evidenceDir, app, name: values.name };
writeFileSync(join(evidenceDir, 'launch.json'), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info));
