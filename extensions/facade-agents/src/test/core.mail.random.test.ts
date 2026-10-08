/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RING_GAP_MS } from '../core/doorbell';
import { Fetched } from '../core/mail';
import { Caller, isLive, PERSON } from '../record/events';
import { HUMAN, TEXT_IN_LINE, unreadOf } from '../record/messages';
import { sleep, useFakeClock } from './clock';
import { callerOf, fakeWorld } from './fakes';
import { tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** The runs, each from a seed of its own: the same seed makes the same run. */
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
/** How many steps a run takes. */
const STEPS = 90;
/** The least time between two doorbells of an agent's, while it has not fetched all it had. */
/** By when a message to a running agent that is still unread has rung: 2 seconds, or a minute after the doorbell before, and the time to type it. */
const RUNG_WITHIN_MS = 61_000;
/** How long messages wait unfetched, from their first doorbell, before their sender is told: the worlds' timeout, and the 2 seconds before that doorbell. */
const TOLD_AFTER_MS = 122_000;

/** A pseudo-random number generator: numbers from 0 up to 1, the same for the same seed. */
function randomFrom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A doorbell as it was typed: whose, when, the line, and the messages it named. */
interface Ring {
	readonly agent: number;
	readonly time: number;
	readonly line: string;
}

suite('Core: messages at random', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-mail-random-');
	});

	teardown(() => {
		temp.remove();
	});

	for (const seed of SEEDS) {
		test(`run ${seed}: every message delivered at least once or returned, none lost while its recipient runs; one recipient's given in number order, given again marked; a doorbell a minute at most but once all was fetched, and within a minute of a message; messages waiting told of once, after the timeout; the ledger read back the same`, async function () {
			this.timeout(120_000);
			const random = randomFrom(seed);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
			const lab = path.join(temp.dir, 'lab');
			const dir = path.join(temp.dir, 'workspace');
			fs.mkdirSync(lab, { recursive: true });
			let loads = 0;
			let session = `sim-${++loads}`;
			const rings: Ring[] = [];
			/** The messages each agent had in a result that reached it. */
			const written = new Map<number, Set<number>>();
			/** The messages each agent was given, by number: in any result, reached or not. */
			const given = new Map<number, Set<number>>();
			const problems: string[] = [];
			let names = 0;

			/** A world over the workspace, its doorbells logged as they are typed: each line with its Enter, as one input. */
			const open = (): World => {
				const made = fakeWorld(dir, { repositories: { [lab]: [] }, session });
				const type = made.terminals.type.bind(made.terminals);
				made.terminals.type = async (name, text, options) => {
					const agent = [...made.table.state.agents.values()].find(each => name.startsWith(`@${each.name} #${each.id} `));
					if (agent && made.terminals.running.has(name)) {
						if (text.startsWith('[facade]')) {
							const unread = unreadOf(made.table.state.mail, agent.id).map(message => message.id);
							const named = [...text.matchAll(/#m(?<id>\d+) from/g)].map(match => Number(match.groups?.id));
							if (!text.includes('Your task is') && named.join() !== unread.slice(0, 5).join()) {
								problems.push(`the doorbell of #a${agent.id} named ${named.join()}, its unread being ${unread.join()}`);
							}
							if (options.enter) {
								rings.push({ agent: agent.id, line: text, time: Date.now() });
							}
						}
					}
					return type(name, text, options);
				};
				return made;
			};
			let world = open();
			const running = () => [...world.table.state.agents.values()].filter(agent => agent.state === 'running');
			const terminalOf = (id: number) => {
				const agent = world.agent(id);
				return `@${agent.name} #${agent.id} · ${agent.cli === 'arg' ? 'Arg Code' : 'Told Code'}`;
			};

			/** Takes in a fetch: its order, its marks, and what reached the agent. */
			const took = (agent: number, fetched: Fetched, reached: boolean) => {
				const ids = fetched.messages.map(message => message.id);
				if (ids.join() !== [...ids].sort((a, b) => a - b).join()) {
					problems.push(`#a${agent} was given ${ids.join()}, out of order`);
				}
				const before = given.get(agent) ?? new Set<number>();
				for (const message of fetched.messages) {
					if (message.mark !== 'returned' && (message.mark === 'given before') !== before.has(message.id)) {
						problems.push(`#m${message.id} was given to #a${agent} marked ${message.mark}, ${before.has(message.id) ? '' : 'never '}given it before`);
					}
				}
				ids.forEach(id => before.add(id));
				given.set(agent, before);
				if (reached) {
					const set = written.get(agent) ?? new Set<number>();
					fetched.messages.filter(message => message.own).forEach(message => set.add(message.id));
					written.set(agent, set);
				}
			};

			const start = async (caller: Caller) => {
				const name = `a${++names}`;
				const request = { cli: random() < 0.8 ? 'arg' : 'told', model: 'm', effort: 'e', name, ...(caller.id === undefined ? { folder: lab } : { prompt: `Task of ${name}.` }) };
				await world.spawnUp(caller, request);
			};

			await start(PERSON);
			for (let step = 0; step < STEPS && !problems.length; step++) {
				const live = running();
				const roll = random();
				if (!live.length) {
					await start(PERSON);
				} else if (roll < 0.28) {
					const from = random() < 0.1 ? PERSON : callerOf(pick(live));
					const to = [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => `#a${pick(live).id}`))];
					if (from.id !== undefined && random() < 0.15) {
						to.push('@you');
					}
					world.facade.mail.send(from, to, random() < 0.05 ? 'x'.repeat(TEXT_IN_LINE + 1) : `Message ${step}.`, undefined);
				} else if (roll < 0.5) {
					const agent = pick(live).id;
					const caller = callerOf(world.agent(agent));
					const boxed = [...world.table.state.mail.entries.keys()];
					const way = random();
					const request = way < 0.7 || !boxed.length ? {} : way < 0.85 ? { all: true } : { ids: [`#m${pick(boxed)}`] };
					if (random() < 0.2) {
						// Two at once: the second waits for the first to be done
						let first: ((written: boolean) => void) | undefined;
						let second: ((written: boolean) => void) | undefined;
						const one = world.facade.mail.fetch(caller, request, listener => first = listener);
						const two = world.facade.mail.fetch(caller, {}, listener => second = listener);
						const reachedOne = random() < 0.8;
						took(agent, await one, reachedOne);
						first?.(reachedOne);
						const reachedTwo = random() < 0.8;
						took(agent, await two, reachedTwo);
						second?.(reachedTwo);
					} else {
						const reached = random() < 0.85;
						took(agent, await world.facade.mail.fetch(caller, request, listener => listener(reached)), reached);
					}
				} else if (roll < 0.78) {
					await sleep(1_000 + Math.floor(random() * 150_000));
				} else if (roll < 0.86) {
					await start(callerOf(pick(live)));
				} else if (roll < 0.93) {
					const agent = pick(live);
					const how = random();
					if (how < 0.4 && agent.parent !== undefined && isLive(world.table.get(agent.parent))) {
						await world.facade.kill(callerOf(world.agent(agent.parent)), `#a${agent.id}`);
					} else {
						world.terminals.end(terminalOf(agent.id), how < 0.7 ? { byThePerson: true } : { exitCode: how < 0.85 ? 0 : 1, byThePerson: false });
					}
				} else {
					// The window goes: reloaded, Facade turned off and on in it, or closed
					const kind = random() < 0.5 ? 'reload' : random() < 0.6 ? 'off' : 'closed';
					const before = structuredClone(world.table.state.mail);
					const names = kind === 'closed' ? [] : running().map(agent => terminalOf(agent.id));
					world.dispose(kind === 'off' ? 'facade' : 'window');
					if (kind !== 'off') {
						session = `sim-${++loads}`;
					}
					world = open();
					try {
						assert.deepStrictEqual(world.table.state.mail, before);
					} catch {
						problems.push(`the ledger read back after a ${kind} was not what it was`);
					}
					for (const name of names) {
						world.terminals.running.add(name);
					}
					await world.facade.recover(kind === 'reload');
				}

				// A message unread for longer than a doorbell takes has rung since it came, or since its agent was
				// running: a window going takes no time here, and the doorbells' times are the ledger's
				const now = Date.now();
				for (const agent of running()) {
					for (const message of unreadOf(world.table.state.mail, agent.id)) {
						const since = Math.max(message.time, agent.runningTime ?? 0);
						if (now - since > RUNG_WITHIN_MS + 2_000 && !rings.some(ring => ring.agent === agent.id && ring.time >= since && ring.time <= since + RUNG_WITHIN_MS)) {
							problems.push(`#m${message.id} to #a${agent.id} was not rung within a minute`);
						}
					}
				}
			}
			world.dispose();

			// From the ledger: every message to an agent that ended was delivered or went back; nothing was delivered that did not reach it;
			// when each mailbox was left with nothing unread; Facade told of messages waiting once while they waited, and not before the timeout
			const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
			const sent = new Map<number, number | string>();
			const sentAt = new Map<number, number>();
			const delivered = new Map<number, Set<number>>();
			const returned = new Set<number>();
			const ended = new Set<number>();
			const unread = new Map<number, Set<number>>();
			const emptied: { readonly agent: number; readonly time: number }[] = [];
			const toldAt = new Map<number, number>();
			for (const line of lines) {
				if (line.type === 'message.sent') {
					if (line.facade === 'delayed') {
						const waiting = [...unread.get(line.about) ?? []].map(id => sentAt.get(id) ?? Infinity);
						const since = Math.min(...waiting);
						if (!waiting.length) {
							problems.push(`#a${line.about}'s messages were told of as waiting, none waiting`);
						} else if ((toldAt.get(line.about) ?? -Infinity) >= since) {
							problems.push(`#a${line.about}'s messages waiting since ${since} were told of twice`);
						} else if (line.time < since + TOLD_AFTER_MS) {
							problems.push(`#a${line.about}'s messages were told of as waiting ${line.time - since} ms after the oldest came`);
						}
						toldAt.set(line.about, line.time);
					}
					sent.set(line.id, line.to);
					sentAt.set(line.id, line.time);
					if (line.to !== HUMAN) {
						const set = unread.get(line.to) ?? new Set<number>();
						set.add(line.id);
						unread.set(line.to, set);
					}
				} else if (line.type === 'message.delivered') {
					const set = delivered.get(line.agent) ?? new Set<number>();
					let own = false;
					for (const id of line.ids) {
						set.add(id);
						if (sent.get(id) === line.agent) {
							own = true;
							unread.get(line.agent)?.delete(id);
							if (!written.get(line.agent)?.has(id)) {
								problems.push(`#m${id} was recorded delivered to #a${line.agent}, which no result of its reached`);
							}
						}
					}
					delivered.set(line.agent, set);
					if (own && !unread.get(line.agent)?.size) {
						emptied.push({ agent: line.agent, time: line.time });
					}
				} else if (line.type === 'message.returned') {
					returned.add(line.id);
					unread.get(Number(sent.get(line.id)))?.delete(line.id);
				} else if (line.type === 'agent.exited') {
					ended.add(line.id);
				}
			}

			// A doorbell a minute at most, but where the agent fetched all it had in between
			for (const [index, ring] of rings.entries()) {
				const last = rings.slice(0, index).filter(each => each.agent === ring.agent).pop();
				if (last && ring.time - last.time < RING_GAP_MS && !emptied.some(each => each.agent === ring.agent && each.time >= last.time && each.time <= ring.time)) {
					problems.push(`#a${ring.agent} was rung ${ring.time - last.time} ms after its doorbell before`);
				}
			}
			for (const [id, to] of sent) {
				if (to !== HUMAN && ended.has(Number(to)) && !delivered.get(Number(to))?.has(id) && !returned.has(id)) {
					problems.push(`#m${id} to #a${to}, which ended, was neither delivered nor returned`);
				}
			}

			assert.deepStrictEqual({ seed, problems }, { seed, problems: [] });
		});
	}
});
