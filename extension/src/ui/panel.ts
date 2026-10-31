/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { isJsonObject, JsonObject } from '../base/json';
import type { LogPort } from '../core/ports';
import type { Act, Outcome, PanelState, Strings } from '../webview/protocol';
import { CONTEXT, PANEL_VIEW } from './catalog';
import { PanelModel } from './model';

/** Defined by the build: true only in the integration suite's build (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

/** What a field of a message from the webview must be: a check of its value. */
type Check = (value: unknown) => boolean;

const isText: Check = value => typeof value === 'string';
/** A page's generation, as the webview makes it as it loads: 16 random bytes, in hex. */
const isPage: Check = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const isAction: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 64;
const isTarget: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** What the person can do on the page (PANEL-3.1, 1.2), each with whether it is a card's and so names the card's run. */
const ACTS: { readonly [what in Act]: { readonly target: boolean } } = {
	open: { target: true },
	new: { target: false },
	openFolder: { target: false }
};

/**
 * What the webview may say, by type: the fields each has beside its type, and those it may have. A message of another type, without one
 * of its fields, with one of another type or with any other field is refused (PANEL-3.2).
 */
const MESSAGES: { readonly [type: string]: readonly [required: Readonly<Record<string, Check>>, optional?: Readonly<Record<string, Check>>] } = {
	ready: [{ page: isPage }],
	error: [{ page: isPage, message: isText }],
	act: [{ page: isPage, action: isAction, what: value => typeof value === 'string' && Object.hasOwn(ACTS, value) }, { target: isTarget }],
	// A probe's answer, in the integration suite's build alone: the shipped one has none of its code (UX-3.2)
	...(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? { probed: [{ page: isPage, id: Number.isSafeInteger, value: () => true }] as const } : {})
};

/** Whether `value` is an object with each field of `required`, those of `optional` it has, each as its check says - and no other. */
function isShaped(value: unknown, required: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): value is JsonObject {
	return isJsonObject(value)
		&& Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
		&& Object.keys(value).every(key => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](value[key])));
}

/** A message from the webview, checked: its type one the panel knows, its fields each what that type has; none for any other. */
function webviewMessageOf(raw: unknown): (JsonObject & { readonly type: string; readonly page: string }) | undefined {
	if (!isJsonObject(raw) || typeof raw.type !== 'string' || !Object.hasOwn(MESSAGES, raw.type)) {
		return undefined;
	}
	const [required, optional] = MESSAGES[raw.type];
	if (!isShaped(raw, { type: isText, ...required }, optional)) {
		return undefined;
	}
	// A card's action names its card's run, and no other has one
	if (raw.type === 'act' && ACTS[raw.what as Act].target !== (raw.target !== undefined)) {
		return undefined;
	}
	return raw as JsonObject & { readonly type: string; readonly page: string };
}

/** What the page's actions do: `undefined` when done, else why not (PANEL-3.1). Targets are revalidated by run ID, never by row. */
export type PanelActions = (what: Act, target: string | undefined) => Promise<Outcome['reason'] | undefined>;

/**
 * The panel's view (PANEL-1.1, 3.1, 3.2): one webview of this window's cards. The page of the generation that said it is ready gets
 * every state; badge, description and context keys come from the same state; an action's outcome goes to the page that asked alone.
 */
export class PanelView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private viewDisposables: vscode.Disposable[] = [];
	private readonly probing = new Map<number, (value: unknown) => void>();
	private nextProbe = 1;
	private waiting: (() => void)[] = [];
	/**
	 * The generation of the page shown, as it said it is ready; none until it has. What is sent goes to it alone, and what an earlier
	 * one says, late, is not acted on (PANEL-3.1).
	 */
	private page: string | undefined;
	private readonly contextSaid = new Map<string, boolean>();
	private progressing = false;

	constructor(private readonly extensionUri: vscode.Uri, private readonly model: PanelModel, private readonly actions: PanelActions, private readonly log: LogPort) {
		this.disposables.push(model.onDidChange(state => this.publish(state)));
		this.sayContext(model.state());
		this.showLoading();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewDisposables.forEach(each => each.dispose());
		this.view = view;
		this.page = undefined;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		// The page's own bundle alone: never the extension's or ptyd's code beside it (PANEL-3.2)
		const page = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
		// No retainContextWhenHidden: a page made as the view shows again is rebuilt from the model (PANEL-3.1)
		view.webview.options = { enableScripts: true, localResourceRoots: [media, page] };
		view.webview.html = this.html(view.webview, media, page);
		this.viewDisposables = [
			view.webview.onDidReceiveMessage((message: unknown) => void this.received(view, message)),
			view.onDidChangeVisibility(() => {
				if (!view.visible) {
					// Hidden, its document goes: what is asked of it waits for the one made as it shows again
					this.page = undefined;
				}
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.page = undefined;
				}
			})
		];
		this.publish(this.model.state());
		this.showLoading();
	}

	/**
	 * For the integration suite alone, in its build: has the page click, focus or read the elements `selector` finds,
	 * answering with what it found. The shipped build has none of it (UX-3.2).
	 */
	async probe(args: { readonly op: string; readonly selector: string; readonly index?: number }): Promise<unknown> {
		if (!(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE)) {
			return undefined;
		}
		if (!this.view?.visible) {
			await vscode.commands.executeCommand(`${PANEL_VIEW}.focus`);
		}
		const id = this.nextProbe++;
		return new Promise(resolve => {
			this.probing.set(id, resolve);
			this.whenReady(() => void this.view?.webview.postMessage({ type: 'probe', page: this.page, id, op: args.op, selector: args.selector, ...(args.index !== undefined ? { index: args.index } : {}) }));
		});
	}

	dispose(): void {
		this.viewDisposables.forEach(each => each.dispose());
		this.disposables.forEach(each => each.dispose());
	}

	private whenReady(then: () => void): void {
		if (this.view && this.page !== undefined) {
			then();
		} else {
			this.waiting.push(then);
		}
	}

	/**
	 * What the webview of `view` said, checked first: what the panel does not know is refused. What an earlier page said, late, is not
	 * acted on; a current page's action acts on its card's own run while it is listed, never on another; and the outcome goes back to
	 * the page that asked alone (PANEL-3.1, 3.2).
	 */
	private async received(view: vscode.WebviewView, raw: unknown): Promise<void> {
		const message = webviewMessageOf(raw);
		if (!message) {
			this.log.event(`The panel refused a message from its webview: ${describe(raw)}`);
			return;
		}
		if (message.type === 'error') {
			this.log.event(`The panel's webview failed: ${message.message as string}`);
			return;
		}
		if (message.type === 'ready') {
			this.page = message.page;
			this.post(this.model.state());
			this.waiting.splice(0).forEach(then => then());
			return;
		}
		if (message.page !== this.page) {
			return;
		}
		if (message.type === 'probed') {
			if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE) {
				const resolve = this.probing.get(message.id as number);
				this.probing.delete(message.id as number);
				resolve?.(message.value);
			}
			return;
		}
		let reason: Outcome['reason'] | undefined;
		try {
			reason = await this.actions(message.what as Act, message.target as string | undefined);
		} catch (err) {
			this.log.event(`The panel could not ${message.what as string}: ${err instanceof Error ? err.message : String(err)}`);
			reason = 'failed';
		}
		if (this.view === view && this.page === message.page) {
			const outcome: Outcome = { action: message.action as string, ok: reason === undefined, ...(reason ? { reason } : {}) };
			void view.webview.postMessage({ type: 'outcome', page: message.page, ...outcome });
		}
	}

	/** Says a state: on the badge, the description and the context keys at once, and to the page shown once it said it is ready. */
	private publish(state: PanelState): void {
		this.sayContext(state);
		if (this.view) {
			// The badge counts every card, starting and failed ones too (PANEL-1.1)
			this.view.badge = state.cardCount ? { value: state.cardCount, tooltip: state.cardCount === 1 ? vscode.l10n.t("1 agent") : vscode.l10n.t("{0} agents", state.cardCount) } : undefined;
		}
		this.post(state);
	}

	private post(state: PanelState): void {
		if (this.view && this.page !== undefined) {
			void this.view.webview.postMessage({ type: 'state', page: this.page, state });
		}
	}

	/** The context keys of UX-3.2, from the same state, each set only where it changed. */
	private sayContext(state: PanelState): void {
		const selected = this.model.selectedAgent();
		const keys: readonly [string, boolean][] = [
			[CONTEXT.hasAgents, state.cardCount > 0],
			[CONTEXT.agentSelected, selected !== undefined],
			[CONTEXT.agentSelectedEnded, selected?.ended === true]
		];
		for (const [key, value] of keys) {
			if (this.contextSaid.get(key) !== value) {
				this.contextSaid.set(key, value);
				void vscode.commands.executeCommand('setContext', key, value);
			}
		}
	}

	/** The view's own progress until this window's runs are known: no false empty state is drawn meanwhile (PANEL-1.1). */
	private showLoading(): void {
		if (!this.model.state().loading || this.progressing) {
			return;
		}
		this.progressing = true;
		void vscode.window.withProgress({ location: { viewId: PANEL_VIEW } }, () => new Promise<void>(resolve => {
			const changed = this.model.onDidChange(state => {
				if (!state.loading) {
					changed.dispose();
					this.progressing = false;
					resolve();
				}
			});
		}));
	}

	private html(webview: vscode.Webview, media: vscode.Uri, page: vscode.Uri): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const styles = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(page, 'webview.js'));
		const avatars = webview.asWebviewUri(vscode.Uri.joinPath(media, 'agents')).toString();
		const strings: Strings = {
			agents: vscode.l10n.t("Agents"),
			newAgent: vscode.l10n.t("New Agent"),
			// The empty panel, for why it is empty (PANEL-1.2)
			noAgents: vscode.l10n.t("Launch an agent in this workspace."),
			noFolder: vscode.l10n.t("Open a folder to launch agents."),
			openFolder: vscode.l10n.t("Open Folder"),
			// {0} is how long ago, as the browser says it in the window's language: now, 5 min. ago, yesterday
			started: vscode.l10n.t("Started {0}"),
			// {0} is how long ago, as in "5 min. ago": a long time with no other report is for the person to judge (RULES-3.2)
			workingSince: vscode.l10n.t("Reported working {0}")
		};
		return `<!DOCTYPE html>
<html lang="${escapeAttribute(vscode.env.language)}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styles}">
</head>
<body>
<div id="list" role="listbox" aria-label="${escapeAttribute(strings.agents)}"></div>
<div id="empty" hidden></div>
<script nonce="${nonce}">window.FACADE_STRINGS = ${JSON.stringify(strings).replace(/</g, '\\u003c')}; window.FACADE_LOGOS = ${JSON.stringify(avatars).replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

/** What the webview sent, for the log: its JSON's start, or its kind where it has none. */
function describe(raw: unknown): string {
	try {
		return String(JSON.stringify(raw)).slice(0, 200);
	} catch {
		return typeof raw;
	}
}

function escapeAttribute(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
