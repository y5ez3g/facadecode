/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The automated input of one run, in turn (RULES-1.10): each operation whole - text and its Enter, every key of a call - before
// the next begins. The person's own typing is no operation: it goes straight to the process. Once the run ends or is being
// stopped, nothing waiting goes in.

/** What automated input into a run did: what went in, and why the rest did not. */
export interface InputEffect {
	/** `applied`: all of it; `partial`: a first part, the run ending before the rest; `not_applied`: nothing. */
	readonly outcome: 'applied' | 'partial' | 'not_applied';
	/** Why not all of it went in: the run ended or is being stopped. */
	readonly reason?: 'ended';
	/** For text: whether it was pasted, and whether Enter followed. */
	readonly pasted?: boolean;
	readonly entered?: boolean;
	/** For keys: how many went in, from the first. */
	readonly keysSent?: number;
}

/** One operation waiting its turn. */
interface QueuedInput {
	/** Runs it, `alive` saying whether the run still takes input. */
	readonly run: (alive: () => boolean) => Promise<InputEffect>;
	readonly resolve: (effect: InputEffect) => void;
	readonly reject: (err: unknown) => void;
	/** What it answers with, should it never begin. */
	readonly notApplied: InputEffect;
}

/** A run's automated input, one operation at a time in the order they came. */
export class InputQueue {

	private readonly queued: QueuedInput[] = [];
	private draining = false;
	private ended = false;

	add(run: QueuedInput['run'], notApplied: InputEffect): Promise<InputEffect> {
		if (this.ended) {
			return Promise.resolve({ ...notApplied, reason: 'ended' });
		}
		return new Promise((resolve, reject) => {
			this.queued.push({ run, resolve, reject, notApplied });
			void this.drain();
		});
	}

	/** Nothing waiting goes in any more, nor what is left of an operation going in: the run ended, or is being stopped. */
	end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		for (const item of this.queued.splice(0)) {
			item.resolve({ ...item.notApplied, reason: 'ended' });
		}
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			for (let item = this.queued.shift(); item; item = this.queued.shift()) {
				try {
					item.resolve(await item.run(() => !this.ended));
				} catch (err) {
					// What went in before it failed is not known: the caller is told it failed, never that nothing did
					item.reject(err);
				}
			}
		} finally {
			this.draining = false;
		}
	}
}
