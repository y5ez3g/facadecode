/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A transparent TCP relay to the two real SSH servers. It never interprets SSH bytes.
// Closing only these task-owned sockets produces actual connection loss without changing host networking.
import net, { type Server, type Socket } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { campaign: { type: 'string' }, until: { type: 'string' } } });
const until = Date.parse(values.until || '');
if (!values.campaign || !Number.isFinite(until) || until <= Date.now()) {
	throw new Error('Usage: relay.ts --campaign <directory> --until <UTC timestamp>');
}
const campaign = resolve(values.campaign);
interface IRelayConnection { id: number; client: Socket; remote: Socket; up: number; down: number }
const targets: Record<string, string> = { linux: '192.168.1.242', windows: '192.168.1.241' };
const sockets: Record<string, Set<IRelayConnection>> = { linux: new Set(), windows: new Set() };
const blocked: Record<string, boolean> = { linux: false, windows: false };
const servers: Server[] = [];
const ports: Record<string, number> = {};
let counter = 0;
const log = (value: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
for (const [target, host] of Object.entries(targets)) {
	const server = net.createServer(client => {
		if (blocked[target]) { client.destroy(); return; }
		const remote = net.createConnection({ host, port: 22 });
		const connection = { id: ++counter, client, remote, up: 0, down: 0 };
		sockets[target].add(connection);
		client.pipe(remote);
		remote.pipe(client);
		const timer = setTimeout(() => remote.destroy(), 10000);
		remote.once('connect', () => {
			clearTimeout(timer);
			log({ event: 'connected-to-real-ssh', target, id: connection.id });
		});
		client.on('data', data => connection.up += data.length);
		remote.on('data', data => connection.down += data.length);
		for (const socket of [client, remote]) {
			socket.on('error', () => socket.destroy());
			socket.once('close', () => {
				clearTimeout(timer);
				client.destroy(); remote.destroy();
				if (sockets[target].delete(connection)) {
					log({ event: 'closed', target, id: connection.id, bytesToHost: connection.up, bytesFromHost: connection.down });
				}
			});
		}
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Actual relay has no TCP address.'); }
	ports[target] = address.port;
	servers.push(server);
}
writeFileSync(join(campaign, 'network-relay.json'), JSON.stringify({ pid: process.pid, ports, targets, until: values.until }, null, 2) + '\n', { mode: 0o600 });
log({ event: 'ready', ports, until: values.until });
const poll = setInterval(() => {
	let policy;
	try { policy = JSON.parse(readFileSync(join(campaign, 'network-policy.json'), 'utf8')); } catch { return; }
	for (const target of Object.keys(targets)) {
		const pauseUntil = Date.parse(policy[target]?.pauseUntil || '');
		const pause = Number.isFinite(pauseUntil) && pauseUntil > Date.now();
		if (pause === blocked[target]) { continue; }
		blocked[target] = pause;
		log({ event: pause ? 'real-network-cut' : 'network-restored', target, pauseUntil: policy[target]?.pauseUntil });
		if (pause) {
			for (const connection of sockets[target]) { connection.client.destroy(); connection.remote.destroy(); }
		}
	}
}, 200);
const finish = () => {
	clearInterval(poll);
	for (const server of servers) { server.close(); }
	for (const set of Object.values(sockets)) { for (const connection of set) { connection.client.destroy(); connection.remote.destroy(); } }
	log({ event: 'campaign-relay-finished' });
	process.exit(0);
};
setTimeout(finish, until - Date.now());
process.once('SIGTERM', finish);
process.once('SIGINT', finish);
