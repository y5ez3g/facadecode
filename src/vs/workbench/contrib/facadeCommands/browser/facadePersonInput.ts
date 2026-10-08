/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CharCode } from '../../../../base/common/charCode.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { assertType, isNumber, isString } from '../../../../base/common/types.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

const ESC = 0x1b;
const BEL = 0x07;
const CTRL_C = 0x03;
/** The final characters of the sequences a terminal answers a program with on its own: CPR, focus, DA, DSR, size, mode. */
const ANSWERS = 'RIOcnty';

/** What `_facade.terminal.input` answers with: what the person typed into a terminal. */
export interface IFacadeTerminalInput {
	/** Whether they typed since they last pressed Enter, or Ctrl+C, there. */
	readonly pending: boolean;
	/** When they last typed there, in milliseconds since 1970. */
	readonly lastKey: number | undefined;
}

/** A piece of a terminal's input: part of a line, Enter or Ctrl+C, another key, or no key at all. */
export type InputPart = 'text' | 'submit' | 'key' | 'none';

/** Splits a terminal's input into its pieces; everything in a bracketed paste is text. */
export function partsOf(data: string): InputPart[] {
	const parts: InputPart[] = [];
	let pasting = false;
	let i = 0;
	while (i < data.length) {
		const code = data.charCodeAt(i);
		if (code !== ESC) {
			parts.push(pasting || code >= CharCode.Space || code === CharCode.Backspace ? 'text' : code === CharCode.CarriageReturn || code === CTRL_C ? 'submit' : 'key');
			i++;
		} else if (data.charCodeAt(i + 1) === CharCode.OpenSquareBracket) {
			let end = i + 2;
			while (end < data.length && !isFinalByte(data.charCodeAt(end))) {
				end++;
			}
			const params = data.slice(i + 2, end);
			const final = data.charCodeAt(end);
			if (final === CharCode.Tilde && (params === '200' || params === '201')) {
				pasting = params === '200';
			} else {
				parts.push(pasting ? 'text' : sequencePart(params, final));
			}
			i = end + 1;
		} else if (pasting) {
			parts.push('text');
			i++;
		} else if (data.charCodeAt(i + 1) === CharCode.CloseSquareBracket || data.charCodeAt(i + 1) === CharCode.P) {
			// An OSC or a DCS: the terminal's answer, which ends at BEL or at ESC and a backslash
			let end = i + 2;
			while (end < data.length && data.charCodeAt(end) !== BEL && data.charCodeAt(end) !== ESC) {
				end++;
			}
			parts.push('none');
			i = end + (data.charCodeAt(end) === ESC ? 2 : 1);
		} else {
			// Escape alone, SS3 and a key, or Alt with a key
			parts.push('key');
			i += i + 1 === data.length ? 1 : data.charCodeAt(i + 1) === CharCode.O ? 3 : 2;
		}
	}
	return parts;
}

function isFinalByte(code: number): boolean {
	return code >= CharCode.AtSign && code <= CharCode.Tilde;
}

/** A control sequence: a key as the kitty keyboard protocol or win32 input mode sends it, another key, or a terminal's answer. */
function sequencePart(params: string, final: number): InputPart {
	if (final === CharCode.u) {
		return kittyKeyPart(params);
	}
	if (final === CharCode.Underline) {
		return win32KeyPart(params);
	}
	return ANSWERS.includes(String.fromCharCode(final)) ? 'none' : 'key';
}

/** A key as `CSI code[:alternates][;modifiers[:event]][;text] u`; a key let go, and the terminal's answer to `CSI ? u`, are no key. */
function kittyKeyPart(params: string): InputPart {
	const [key, modifiers = '1'] = params.split(';');
	const [mask, event] = modifiers.split(':').map(each => parseInt(each, 10));
	if (key.startsWith('?') || event === 3) {
		return 'none';
	}
	const bits = (mask || 1) - 1;
	// Alt, Super, Hyper and Meta
	const alt = (bits & 0b111010) !== 0;
	return keyPart(parseInt(key, 10), (bits & 0b100) !== 0, alt, (bits & 0b1) !== 0);
}

/** A key as `CSI Vk;Sc;Uc;Kd;Cs;Rc _`; a key let go is no key. */
function win32KeyPart(params: string): InputPart {
	const [, , char, down, state] = params.split(';').map(each => parseInt(each, 10) || 0);
	if (down !== 1) {
		return 'none';
	}
	const ctrl = (state & 0b1100) !== 0;
	const alt = (state & 0b11) !== 0;
	// AltGr, Ctrl and Alt together, types a character
	return ctrl && alt && char >= CharCode.Space ? 'text' : keyPart(char, ctrl, alt, (state & 0x10) !== 0);
}

/** A key by its character: Enter sends the line and Shift+Enter breaks it, Ctrl+C drops it, a character is text. */
function keyPart(char: number, ctrl: boolean, alt: boolean, shift: boolean): InputPart {
	if (char === CharCode.CarriageReturn) {
		return ctrl || alt ? 'key' : shift ? 'text' : 'submit';
	}
	if (char === CTRL_C || (ctrl && (char === CharCode.c || char === CharCode.C))) {
		return 'submit';
	}
	// The kitty protocol's function keys are in the private use area
	const typed = (char >= CharCode.Space && (char < 0xe000 || char > 0xf8ff)) || char === CharCode.Backspace;
	return typed && !ctrl && !alt ? 'text' : 'key';
}

/** The one terminal whose process `processId` runs: not an ended one, whose id can be another process's by now. */
export function runningTerminalOf(terminalService: ITerminalService, processId: number): ITerminalInstance | undefined {
	const running = terminalService.instances.filter(instance => instance.processId === processId && instance.exitCode === undefined);
	return running.length === 1 ? running[0] : undefined;
}

/** What the person typed into one terminal, and what Facade typed there that it has not taken in yet. */
interface IPersonInput {
	pending: boolean;
	lastKey: number | undefined;
	readonly facadeTyped: { readonly text: string }[];
}

/**
 * Keeps whether the person has a line half typed in each terminal (`_facade.terminal.input`), and types
 * Facade's lines into them (`_facade.terminal.type`): all a terminal takes in is the person's but those.
 */
export class FacadePersonInput extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadePersonInput';

	private readonly _inputs = new Map<ITerminalInstance, IPersonInput>();
	private readonly _listeners = this._register(new DisposableMap<ITerminalInstance>());

	constructor(@ITerminalService private readonly _terminalService: ITerminalService) {
		super();
		for (const instance of _terminalService.instances) {
			this._track(instance);
		}
		this._register(_terminalService.onDidCreateInstance(instance => this._track(instance)));

		// `(processId)`: whether the person typed into the terminal running `processId` since they last pressed Enter there, and when they last typed
		this._register(CommandsRegistry.registerCommand('_facade.terminal.input', (_accessor, processId: unknown): IFacadeTerminalInput | undefined => {
			assertType(isNumber(processId), 'number');
			const running = runningTerminalOf(this._terminalService, processId);
			const input = running && this._inputs.get(running);
			return input && { pending: input.pending, lastKey: input.lastKey };
		}));

		// `(processId, text)`: types Facade's `text` into the terminal running `processId`; answers whether one runs it
		this._register(CommandsRegistry.registerCommand('_facade.terminal.type', async (_accessor, processId: unknown, text: unknown): Promise<boolean> => {
			assertType(isNumber(processId), 'number');
			assertType(isString(text), 'string');
			const running = runningTerminalOf(this._terminalService, processId);
			if (!running) {
				return false;
			}
			await this._type(running, text);
			return true;
		}));
	}

	private _track(instance: ITerminalInstance): IPersonInput {
		const known = this._inputs.get(instance);
		if (known) {
			return known;
		}
		const input: IPersonInput = { pending: false, lastKey: undefined, facadeTyped: [] };
		this._inputs.set(instance, input);
		const listeners = new DisposableStore();
		listeners.add(instance.onDidInputData(data => this._onInputData(input, data)));
		listeners.add(instance.onDisposed(() => {
			this._inputs.delete(instance);
			this._listeners.deleteAndDispose(instance);
		}));
		this._listeners.set(instance, listeners);
		return input;
	}

	/** What the terminal took in: Facade's own, whose Enter sends what the person typed along with it, or the person's. */
	private _onInputData(input: IPersonInput, data: string): void {
		const facade = input.facadeTyped.findIndex(each => each.text === data);
		if (facade !== -1) {
			input.facadeTyped.splice(facade, 1);
			if (data.includes(String.fromCharCode(CharCode.CarriageReturn))) {
				input.pending = false;
			}
			return;
		}
		for (const part of partsOf(data)) {
			if (part === 'submit') {
				input.pending = false;
			} else if (part === 'text' || (part === 'key' && input.pending)) {
				input.pending = true;
				input.lastKey = Date.now();
			}
		}
	}

	/** Facade's lines hold no line break, so the terminal takes them in as they are given. */
	private async _type(instance: ITerminalInstance, text: string): Promise<void> {
		const typed = { text };
		const input = this._track(instance);
		input.facadeTyped.push(typed);
		try {
			await instance.sendText(text, false);
		} finally {
			const index = input.facadeTyped.indexOf(typed);
			if (index !== -1) {
				input.facadeTyped.splice(index, 1);
			}
		}
	}
}
