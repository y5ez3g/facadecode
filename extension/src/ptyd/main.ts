/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ptyd's entry: `node ptyd.js <socket> [<log file>]`, started detached by the first window that needs it, run by the editor's
// own extension-host binary as Node (ELECTRON_RUN_AS_NODE). It exits by itself once it has no runs and no windows a while.

import { logTo } from './log';
import { PtydServer } from './server';

const [socketPath, logFile] = process.argv.slice(2);
// Its size bounded, its oldest lines let go of first (ARCHITECTURE-3.3)
const log = logTo(logFile);

if (!socketPath) {
	process.stderr.write('usage: ptyd <socket> [<log file>]\n');
	process.exit(2);
}

const server = new PtydServer(socketPath, log);
server.listen().then(listening => {
	if (!listening) {
		log('Another ptyd answers on the socket: this one exits.');
		process.exit(0);
	}
	log(`ptyd ${process.pid} listening on ${socketPath}.`);
}, err => {
	log(`ptyd could not listen on ${socketPath}: ${err?.stack ?? err}`);
	process.exit(1);
});

process.on('SIGTERM', () => {
	server.close();
	process.exit(0);
});
// A window going away is no reason for ptyd to: it keeps its runs
process.on('SIGHUP', () => undefined);
process.on('uncaughtException', err => log(`Uncaught: ${err?.stack ?? err}`));
