/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An agent another agent started, waiting on its CLI's own question - a permission, a question or a sign-in - is reported to that
// creator once it has waited twenty seconds, once for each time it starts waiting (RULES-1.8, D103): Orca tells its coordinator of a
// worker stopped at a prompt, and T3 Code routes a child's question to its parent. The creator is an agent; a person is never told.

import { messageOf } from '../base/errors';
import type { Messages } from './messagePorts';
import type { Agents, Disposable, RunFacts, RunId } from './ports';
import { referenceOf } from './reach';

/** How long a started agent waits on its CLI's question before its creator is told. */
export const ATTENTION_MS = 20_000;

export interface AttentionDeps {
	readonly agents: Pick<Agents, 'get' | 'onDidChange'>;
	readonly messages: Pick<Messages, 'report'>;
	readonly log: (text: string) => void;
	/** Runs `fn` after `ms`, answering how to stop it first. */
	readonly after?: (ms: number, fn: () => void) => { dispose(): void };
}

/** What a started agent waits on: its CLI's question, by kind and its own words. */
type Waiting = NonNullable<RunFacts['blocker']>;

/** The notice its creator gets, in the words of a Facade result (RULES-1.7): what the agent waits on, and who can answer it. */
export function attentionText(run: Pick<RunFacts, 'name' | 'alias'>, waiting: Waiting): string {
	const who = `${referenceOf(run)}, which you started,`;
	const said = waiting.text ? ` (${JSON.stringify(waiting.text)})` : '';
	const notice = 'This is a Facade status notice. It does not request human contact or authorize answering the prompt; follow the person\'s task instructions.';
	switch (waiting.kind) {
		case 'permission':
			return `${who} is waiting for permission in its terminal${said}. Permission is the person's to give. ${notice}`;
		case 'question':
			return `${who} is waiting for an answer in its terminal${said}. ${notice}`;
		case 'auth':
			return `${who} is waiting for a sign-in in its terminal${said}. Only the person can sign in. ${notice}`;
	}
}

/**
 * Watches the runs of this window that an agent of this window started (RULES-1.8, D103): one whose CLI reports its own question for
 * twenty seconds has its creator told once; the count starts again once it stops waiting. A creator gone, or of another window, is
 * told nothing.
 */
export class AttentionNotices implements Disposable {
	private readonly waiting = new Map<RunId, { readonly kind: Waiting['kind']; readonly timer: { dispose(): void } }>();
	private readonly subscription: Disposable;
	private readonly after: NonNullable<AttentionDeps['after']>;

	constructor(private readonly deps: AttentionDeps) {
		this.after = deps.after ?? ((ms, fn) => {
			const timer = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(timer) };
		});
		this.subscription = deps.agents.onDidChange(change => this.changed(change.run));
	}

	dispose(): void {
		this.subscription.dispose();
		for (const { timer } of this.waiting.values()) {
			timer.dispose();
		}
		this.waiting.clear();
	}

	private changed(run: RunId): void {
		const waits = this.waitsOn(run);
		const known = this.waiting.get(run);
		if (known && known.kind === waits?.kind) {
			return;
		}
		known?.timer.dispose();
		this.waiting.delete(run);
		if (waits) {
			this.waiting.set(run, { kind: waits.kind, timer: this.after(ATTENTION_MS, () => this.tell(run, waits.kind)) });
		}
	}

	/** What `run` waits on, where an agent of this window started it and its CLI reports its own question. */
	private waitsOn(run: RunId): Waiting | undefined {
		const facts = this.deps.agents.get(run);
		if (!facts || facts.lifecycle === 'ended' || facts.origin !== 'agent' || facts.creator === undefined || !facts.blocker) {
			return undefined;
		}
		return facts.blocker;
	}

	private tell(run: RunId, kind: Waiting['kind']): void {
		const waits = this.waitsOn(run);
		const facts = this.deps.agents.get(run);
		const creator = facts?.creator !== undefined ? this.deps.agents.get(facts.creator) : undefined;
		if (!waits || waits.kind !== kind || !facts || !creator || creator.lifecycle === 'ended') {
			return;
		}
		this.deps.log(`${facts.alias} has waited on its CLI's ${kind} for ${ATTENTION_MS / 1000} seconds: its creator ${creator.alias} is told`);
		try {
			this.deps.messages.report({ to: creator.id, agent: run, text: attentionText(facts, waits) });
		} catch (err) {
			// Its timer is nobody's call: a notice that could not be recorded is logged, never thrown
			this.deps.log(`Could not tell ${creator.alias} that ${facts.alias} waits: ${messageOf(err)}`);
		}
	}
}
