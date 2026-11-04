/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ptyd's entry: `node ptyd.js <socket> [<log file> [<build>]]`, started detached by the first window that needs it, run by the editor's
// own extension-host binary as Node (ELECTRON_RUN_AS_NODE). It exits by itself once it has no runs and no windows a while.

import { logTo } from './log';
import * as path from 'path';
import { forgetPtyd, ptydRecords, recordPtyd } from '../base/ptydRegistry';
import { PTYD_PROTOCOL } from './protocol';
import { PtydServer } from './server';

const [socketPath, logFile, build] = process.argv.slice(2);
// Its size bounded, its oldest lines let go of first (ARCHITECTURE-3.3)
const log = logTo(logFile);

if (!socketPath) {
	process.stderr.write('usage: ptyd <socket> [<log file> [<build>]]\n');
	process.exit(2);
}

const server = new PtydServer(socketPath, log);
server.build = build || undefined;
// Recorded beside its log while it listens, by its build, so that a window of another build finds its runs (ARCHITECTURE-2.4)
const records = logFile && build ? ptydRecords(path.dirname(logFile)) : undefined;
server.listen().then(listening => {
	if (!listening) {
		log('Another ptyd answers on the socket: this one exits.');
		process.exit(0);
	}
	log(`ptyd ${process.pid} listening on ${socketPath}${build ? ` for build ${build}` : ''}.`);
	if (records && build) {
		try {
			recordPtyd(records, { protocol: PTYD_PROTOCOL, build, socket: socketPath, pid: process.pid });
			process.on('exit', () => forgetPtyd(records, socketPath, process.pid));
		} catch (err) {
			log(`Could not record this ptyd for windows of other builds: ${(err as Error)?.message ?? err}`);
		}
	}
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
