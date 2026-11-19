/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { isMachineBridgeRequest, machineBridgeBytes, type MachineBridgePipe, type WindowIdentity } from '../base/windowIdentity';
import { MachineBridgeReader, writeMachineBridgeBytes } from './remoteSshStreams';

/** An idle read renews the lease, and returns so VS Code can discard commands from a departed host. */
const PULL_WAIT_MS = 4_000;
const LEASE_MS = 40_000;
const EXIT_WAIT_MS = 2_000;

/** The workspace host owns only its own window's `machine serve` relay and its three pipes. */
export class RemoteSshWorkspace {
	private stream: MachineServe | undefined;
	private lease: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly homeHex: string;

	constructor(private readonly identity: WindowIdentity, private readonly program: string, private readonly home: string) {
		this.homeHex = Buffer.from(home, 'utf8').toString('hex');
	}

	async request(value: unknown): Promise<unknown> {
		if (this.disposed || !isMachineBridgeRequest(value) || value.session !== this.identity.session || value.token !== this.identity.token) {
			return undefined;
		}
		if (value.kind === 'open') {
			if (!this.stream) {
				this.stream = new MachineServe(value.stream, this.program, this.home, this.homeHex);
			}
			if (this.stream.id === value.stream) {
				this.renew();
				return true;
			}
			return undefined;
		}
		const stream = this.stream;
		if (stream?.id !== value.stream) {
			return undefined;
		}
		this.renew();
		switch (value.kind) {
			case 'read': return stream.read(value.pipe);
			case 'write': {
				const bytes = machineBridgeBytes(value.data);
				return bytes && stream.write(bytes);
			}
			case 'end': return stream.write();
			case 'close': this.close(); return true;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.close();
	}

	private renew(): void {
		clearTimeout(this.lease);
		this.lease = setTimeout(() => this.close(), LEASE_MS);
		this.lease.unref();
	}

	private close(): void {
		clearTimeout(this.lease);
		this.stream?.dispose();
		this.stream = undefined;
	}
}

class MachineServe {
	private readonly stop = new AbortController();
	private relay: { child: ChildProcessWithoutNullStreams; readers: Record<MachineBridgePipe, MachineBridgeReader> } | undefined;
	private failure: Error | undefined;
	private writing = false;

	constructor(readonly id: string, private readonly program: string, private readonly home: string, private readonly homeHex: string) { }

	/** Start only when the authorized local side begins pumping, after it has found core. */
	private start() {
		if (!this.relay) {
			const child = spawn(this.program, ['machine', 'serve', '--home-hex', this.homeHex], {
				env: { ...process.env, FACADE_HOME: this.home }, stdio: 'pipe', windowsHide: true
			});
			child.on('error', err => { this.failure = err; });
			child.stdin.on('error', () => undefined); // Writes report pipe errors through their callbacks.
			this.relay = {
				child,
				readers: {
					stdout: new MachineBridgeReader(child.stdout, this.stop.signal),
					stderr: new MachineBridgeReader(child.stderr, this.stop.signal)
				}
			};
		}
		return this.relay;
	}

	async read(pipe: MachineBridgePipe): Promise<{ data?: string; eof?: true }> {
		const { readers } = this.start();
		const bytes = await readers[pipe].read(PULL_WAIT_MS);
		if (this.failure) {
			throw this.failure;
		}
		return bytes ? { data: bytes.toString('base64') } : bytes === null ? { eof: true } : {};
	}

	async write(bytes?: Buffer): Promise<true> {
		if (this.writing) {
			throw new Error('A Facade machine bridge write is already pending.');
		}
		const { child } = this.start();
		this.writing = true;
		try {
			await writeMachineBridgeBytes(child.stdin, bytes);
			return true;
		} finally {
			this.writing = false;
		}
	}

	dispose(): void {
		this.stop.abort();
		const child = this.relay?.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		// A clean close lets serve observe stdin EOF. Drain its last writes so it can exit on its own.
		child.stdin.end();
		child.stdout.resume();
		child.stderr.resume();
		const kill = setTimeout(() => child.kill('SIGKILL'), EXIT_WAIT_MS);
		kill.unref();
		child.once('exit', () => clearTimeout(kill));
	}
}
