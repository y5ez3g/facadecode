// After `npm ci` or `npm install` of this checkout: node-pty's prebuilt `spawn-helper` is packed without its executable mode, and
// npm runs no install script of a dependency it has not been told to allow, so nothing else gives it one. Without it no PTY starts
// in the unit tests. The packaged extension does not depend on this: its build stages the helper executable (ARCHITECTURE-4.3).
import * as fs from 'node:fs';
import * as path from 'node:path';

const prebuilds = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
for (const target of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
	const helper = path.join(prebuilds, target, 'spawn-helper');
	if (fs.existsSync(helper)) {
		fs.chmodSync(helper, 0o755);
	}
}
