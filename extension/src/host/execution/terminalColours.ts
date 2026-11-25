/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Each kind of theme's terminal colours, as VS Code's own themes of that kind draw them: what ptyd answers a program asking its
 * terminal's colours until the window's editor terminals have reported their own (ARCHITECTURE-2.3). A program that asks wants to
 * know whether its terminal is light or dark, and that these say right.
 */
/** Colors reported by the editor terminal in OSC query responses. */
export interface TerminalColours {
	readonly foreground?: string;
	readonly background?: string;
	readonly cursor?: string;
}

const BY_KIND: Readonly<Record<number, Required<TerminalColours>>> = {
	[1]: { foreground: '3b3b/3b3b/3b3b', background: 'ffff/ffff/ffff', cursor: '3b3b/3b3b/3b3b' },
	[2]: { foreground: 'cccc/cccc/cccc', background: '1f1f/1f1f/1f1f', cursor: 'cccc/cccc/cccc' },
	[3]: { foreground: 'ffff/ffff/ffff', background: '0000/0000/0000', cursor: 'ffff/ffff/ffff' },
	[4]: { foreground: '0000/0000/0000', background: 'ffff/ffff/ffff', cursor: '0000/0000/0000' }
};

/** The Orchestrator takes #rrggbb instead of the OSC reply's variable-width components. */
function hex(rgb: string): string {
	return `#${rgb.split('/').map(part => (part.length === 1 ? part.repeat(2) : part.slice(0, 2))).join('')}`;
}

/**
 * The colours this window's editor terminals draw with (ARCHITECTURE-2.3): its theme kind's until one of its terminals reports them
 * - in answer to a program's question, or to the window's own as a terminal opens - then those, until the theme changes.
 */
export class WindowColours implements vscode.Disposable {
	private reported: { -readonly [K in keyof TerminalColours]: TerminalColours[K] } = {};
	private readonly changes = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changes.event;
	private readonly themes: vscode.Disposable;

	constructor() {
		this.themes = vscode.window.onDidChangeActiveColorTheme(() => {
			// A new theme's colours are its kind's until a terminal reports them again
			this.reported = {};
			this.changes.fire();
		});
	}

	current(): Required<TerminalColours> {
		return { ...BY_KIND[vscode.window.activeColorTheme.kind] ?? BY_KIND[2], ...this.reported };
	}

	currentHex(): Required<TerminalColours> {
		const { foreground, background, cursor } = this.current();
		return { foreground: hex(foreground), background: hex(background), cursor: hex(cursor) };
	}

	/** An editor terminal reported its colour of OSC `osc`. */
	learn(osc: '10' | '11' | '12', rgb: string): void {
		const key = osc === '10' ? 'foreground' : osc === '11' ? 'background' : 'cursor';
		if (this.reported[key] !== rgb.toLowerCase()) {
			this.reported[key] = rgb.toLowerCase();
			this.changes.fire();
		}
	}

	dispose(): void {
		this.themes.dispose();
		this.changes.dispose();
	}
}
