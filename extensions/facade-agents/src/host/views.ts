/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Kernel } from '../common/kernel/kernel';
import { Caller, LedgerEvent, Message, YOU } from '../common/kernel/model';
import { pagePath } from '../common/kernel/names';
import { pageFile } from '../common/kernel/notebook';
import { Spawner } from '../common/kernel/spawner';
import { SpawnRequest } from '../common/kernel/tools';
import { addresses, ago, conversation, needsYou, PageNode, pageTree, participantRow, ParticipantRow } from '../common/kernel/viewModels';

/*
 * The primitives drawn for the person (L2-PLAN, step 32): who is here, what needs them, the
 * conversation, and the notebook - and what the person can do from each, which is what an agent
 * can do: send, spawn, stop, write.
 */

const REFRESH_MS = 150;
const CONVERSATION_LENGTH = 300;

export class FacadeViews implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly messages: MessagesView;
	private readonly needsView: vscode.TreeView<Message>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The newest message to the person that has been announced. */
	private announcedUpTo: number;

	constructor(private readonly kernel: Kernel, private readonly spawner: Spawner, private readonly log: (message: string) => void) {
		this.announcedUpTo = kernel.state.seq;
		this.messages = new MessagesView(kernel, message => this.log(message));
		this.needsView = vscode.window.createTreeView('facade.needsYou', { treeDataProvider: new NeedsYouProvider(kernel, this.changed.event) });
		this.disposables.push(
			this.changed,
			this.needsView,
			vscode.window.createTreeView('facade.participants', { treeDataProvider: new ParticipantsProvider(kernel, this.changed.event) }),
			vscode.window.createTreeView('facade.notebook', { treeDataProvider: new NotebookProvider(kernel, this.changed.event), showCollapseAll: true }),
			vscode.window.registerWebviewViewProvider('facade.messages', this.messages, { webviewOptions: { retainContextWhenHidden: true } }),
			kernel.onDidAppend(event => this.onEvent(event)),
			// The person's own edits of a page are theirs: a save in the editor is @you's write.
			vscode.workspace.onDidSaveTextDocument(document => this.saved(document)),
			vscode.commands.registerCommand('facade.agents.newAgent', () => this.newAgent()),
			vscode.commands.registerCommand('facade.agents.stopAgent', (row?: ParticipantRow) => this.stop(row)),
			vscode.commands.registerCommand('facade.agents.showTerminal', (row?: ParticipantRow) => this.showTerminal(row)),
			vscode.commands.registerCommand('facade.agents.messageParticipant', (row?: ParticipantRow) => this.message(row)),
			vscode.commands.registerCommand('facade.agents.reply', (message?: Message) => this.reply(message)),
			vscode.commands.registerCommand('facade.agents.markAllRead', () => this.markAllRead()),
			vscode.commands.registerCommand('facade.agents.newPage', () => this.newPage())
		);
		this.refresh();
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (const disposable of this.disposables.reverse()) {
			disposable.dispose();
		}
	}

	private get you(): Caller {
		return { name: YOU, incarnation: this.kernel.participant(YOU).incarnation };
	}

	private onEvent(event: LedgerEvent): void {
		if (event.type === 'page.read' || event.type === 'folder.listed') {
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.refresh(), REFRESH_MS);
	}

	private refresh(): void {
		this.changed.fire();
		this.messages.update();
		const waiting = needsYou(this.kernel);
		this.needsView.badge = waiting.length ? { value: waiting.length, tooltip: vscode.l10n.t("{0} messages for you", waiting.length) } : undefined;
		// Each new message to the person, said once, with the way to answer it.
		const fresh = waiting.filter(message => message.seq > this.announcedUpTo);
		this.announcedUpTo = Math.max(this.announcedUpTo, this.kernel.state.seq);
		for (const message of fresh) {
			void this.announce(message);
		}
	}

	private async announce(message: Message): Promise<void> {
		const reply = vscode.l10n.t("Reply");
		const show = vscode.l10n.t("Show");
		const first = message.text.split('\n')[0];
		const choice = await vscode.window.showInformationMessage(`@${message.from}: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`, reply, show);
		if (choice === reply) {
			await this.reply(message);
		} else if (choice === show) {
			await vscode.commands.executeCommand('facade.needsYou.focus');
		}
	}

	private saved(document: vscode.TextDocument): void {
		const relative = path.relative(this.kernel.notesDir, document.uri.fsPath);
		if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.md')) {
			return;
		}
		const page = relative.slice(0, -'.md'.length).split(path.sep).join('/');
		try {
			if (pagePath(page) === page) {
				this.kernel.syncPage(page, YOU);
			}
		} catch {
			// Not a name Facade can give a page: not one it tracks.
		}
	}

	/*
	 * Commands
	 */

	private async newAgent(): Promise<void> {
		const installed = this.spawner.agents();
		if (!installed.length) {
			void vscode.window.showErrorMessage(vscode.l10n.t("No agent Facade can start is installed: claude, codex, agy, muse or grok."));
			return;
		}
		const title = vscode.l10n.t("New Agent");
		const agentPick = await vscode.window.showQuickPick(installed.map(id => ({ label: id })), { title, placeHolder: vscode.l10n.t("Which agent?") });
		if (!agentPick) {
			return;
		}
		const model = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Its model, if not its default: such as sonnet or haiku for Claude."), placeHolder: vscode.l10n.t("its default") });
		if (model === undefined) {
			return;
		}
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		type WherePick = vscode.QuickPickItem & { readonly folder?: string; readonly repo?: string };
		const wherePicks: WherePick[] = [
			...folders.map(folder => ({ label: `$(folder) ${folder.name}`, description: folder.uri.fsPath, folder: folder.uri.fsPath })),
			...folders.map(folder => ({ label: `$(git-branch) ${vscode.l10n.t("New worktree of {0}...", folder.name)}`, description: folder.uri.fsPath, repo: folder.uri.fsPath }))
		];
		const where = await vscode.window.showQuickPick(wherePicks, { title, placeHolder: vscode.l10n.t("Where does it work?") });
		if (!where) {
			return;
		}
		let branch: string | undefined;
		if (where.repo) {
			branch = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("The new worktree's branch."), validateInput: value => value.trim() ? undefined : vscode.l10n.t("A branch needs a name.") });
			if (!branch) {
				return;
			}
		}
		const suggested = this.kernel.freeName(agentPick.label);
		const name = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Its name, which the others write to."), value: suggested });
		if (name === undefined) {
			return;
		}
		const text = await vscode.window.showInputBox({
			title,
			prompt: vscode.l10n.t("Its first message."),
			placeHolder: vscode.l10n.t("Use the team skill (read protocol/team). Goal: ..."),
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("An agent starts with a message.")
		});
		if (!text) {
			return;
		}
		const groups = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Groups it joins, if any, separated by spaces."), placeHolder: '#p1' });
		if (groups === undefined) {
			return;
		}
		const request: SpawnRequest = {
			agent: model.trim() ? `${agentPick.label}:${model.trim()}` : agentPick.label,
			where: where.repo ? { repo: where.repo, branch } : { folder: where.folder },
			text,
			name: name.trim() || undefined,
			groups: groups.split(/[\s,]+/).filter(Boolean)
		};
		try {
			const started = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Starting {0}...", request.name ? `@${request.name}` : agentPick.label) },
				(progress, token) => {
					const controller = new AbortController();
					token.onCancellationRequested(() => controller.abort());
					return this.spawner.spawn(this.you, request, controller.signal, message => progress.report({ message }));
				});
			const showTerminal = vscode.l10n.t("Show Terminal");
			const choice = await vscode.window.showInformationMessage(vscode.l10n.t("@{0} started in {1}.", started.name, started.place), showTerminal);
			if (choice === showTerminal) {
				await this.spawner.reveal(started.name);
			}
		} catch (err) {
			void vscode.window.showErrorMessage((err as Error).message);
		}
	}

	private async stop(row: ParticipantRow | undefined): Promise<void> {
		const name = row?.name ?? await this.pickParticipant(vscode.l10n.t("Stop which agent?"), true);
		if (!name) {
			return;
		}
		try {
			void vscode.window.showInformationMessage(await this.spawner.stop(this.you, name));
		} catch (err) {
			void vscode.window.showErrorMessage((err as Error).message);
		}
	}

	private async showTerminal(row: ParticipantRow | undefined): Promise<void> {
		const name = row?.name ?? await this.pickParticipant(vscode.l10n.t("Whose terminal?"), true);
		if (name && !await this.spawner.reveal(name)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("@{0} has no terminal open.", name));
		}
	}

	private async message(row: ParticipantRow | undefined): Promise<void> {
		const to = row ? `@${row.name}` : await vscode.window.showQuickPick(addresses(this.kernel), { placeHolder: vscode.l10n.t("Send to whom?") });
		if (!to) {
			return;
		}
		const text = await vscode.window.showInputBox({ title: vscode.l10n.t("Message to {0}", to), prompt: vscode.l10n.t("Sent as @you.") });
		if (!text?.trim()) {
			return;
		}
		this.send([to], text);
	}

	private async reply(message: Message | undefined): Promise<void> {
		const target = message ?? needsYou(this.kernel)[0];
		if (!target) {
			return;
		}
		const text = await vscode.window.showInputBox({
			title: vscode.l10n.t("Reply to @{0}", target.from),
			prompt: target.text.length > 400 ? `${target.text.slice(0, 400)}…` : target.text
		});
		if (!text?.trim()) {
			return;
		}
		if (this.send([`@${target.from}`], text, target.seq)) {
			this.kernel.markRead(YOU, target.seq);
		}
	}

	private markAllRead(): void {
		const inbox = this.kernel.state.inboxes.get(YOU);
		if (inbox?.length) {
			this.kernel.markRead(YOU, inbox[inbox.length - 1].seq);
		}
	}

	private async newPage(): Promise<void> {
		const page = await vscode.window.showInputBox({
			title: vscode.l10n.t("New Page"),
			prompt: vscode.l10n.t("Its path, such as p1/notes."),
			validateInput: value => {
				try {
					pagePath(value);
					return undefined;
				} catch (err) {
					return (err as Error).message;
				}
			}
		});
		if (!page) {
			return;
		}
		const written = this.kernel.write(this.you, page, `# ${pagePath(page)}\n`, 'create');
		const target = pagePath(page);
		if (!written.ok && written.reason !== 'exists') {
			return;
		}
		await vscode.window.showTextDocument(vscode.Uri.file(pageFile(this.kernel.notesDir, target)));
	}

	private send(to: readonly string[], text: string, replyTo?: number): boolean {
		try {
			const sent = this.kernel.send(this.you, to, text, replyTo);
			if (sent.emptyGroups.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Nobody is in {0} yet.", sent.emptyGroups.join(', ')));
			}
			return true;
		} catch (err) {
			void vscode.window.showErrorMessage((err as Error).message);
			return false;
		}
	}

	private async pickParticipant(placeHolder: string, agentsOnly: boolean): Promise<string | undefined> {
		const rows = this.kernel.who().filter(view => !agentsOnly || view.kind === 'agent').map(view => participantRow(view, Date.now()));
		const pick = await vscode.window.showQuickPick(rows.map(row => ({ label: row.label, description: row.description, name: row.name })), { placeHolder });
		return pick?.name;
	}
}

class ParticipantsProvider implements vscode.TreeDataProvider<ParticipantRow> {

	constructor(private readonly kernel: Kernel, readonly onDidChangeTreeData: vscode.Event<void>) { }

	getChildren(element?: ParticipantRow): ParticipantRow[] {
		return element ? [] : this.kernel.who().map(view => participantRow(view, Date.now()));
	}

	getTreeItem(row: ParticipantRow): vscode.TreeItem {
		const item = new vscode.TreeItem(row.label);
		item.id = row.name;
		item.description = row.description;
		item.tooltip = row.tooltip;
		item.iconPath = new vscode.ThemeIcon(row.icon, row.state === 'waiting' ? new vscode.ThemeColor('list.warningForeground') : row.state === 'failed' ? new vscode.ThemeColor('list.errorForeground') : undefined);
		item.contextValue = row.contextValue;
		if (row.contextValue === 'agent') {
			item.command = { command: 'facade.agents.showTerminal', title: vscode.l10n.t("Show Terminal"), arguments: [row] };
		}
		return item;
	}
}

class NotebookProvider implements vscode.TreeDataProvider<PageNode> {

	constructor(private readonly kernel: Kernel, readonly onDidChangeTreeData: vscode.Event<void>) { }

	getChildren(element?: PageNode): PageNode[] {
		if (element) {
			return element.children;
		}
		// From the state, not `list`: the person looking is not an agent asking to hear of changes.
		const entries = [...this.kernel.state.pages.values()]
			.filter(info => !info.deleted)
			.map(info => ({ page: info.page, version: info.version, author: info.author, ts: info.ts, size: info.size }));
		return pageTree(entries);
	}

	getTreeItem(node: PageNode): vscode.TreeItem {
		if (node.kind === 'folder') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.id = `folder:${node.path}`;
			item.iconPath = vscode.ThemeIcon.Folder;
			return item;
		}
		const file = vscode.Uri.file(pageFile(this.kernel.notesDir, node.path));
		const item = new vscode.TreeItem(node.label);
		item.id = `page:${node.path}`;
		item.resourceUri = file;
		item.description = node.entry ? `v${node.entry.version} · ${node.entry.author ? `@${node.entry.author}` : vscode.l10n.t("edited directly")} · ${ago(Date.now() - node.entry.ts)}` : undefined;
		item.tooltip = node.path;
		item.contextValue = 'page';
		item.command = { command: 'vscode.open', title: vscode.l10n.t("Open Page"), arguments: [file] };
		return item;
	}
}

class NeedsYouProvider implements vscode.TreeDataProvider<Message> {

	constructor(private readonly kernel: Kernel, readonly onDidChangeTreeData: vscode.Event<void>) { }

	getChildren(element?: Message): Message[] {
		return element ? [] : needsYou(this.kernel);
	}

	getTreeItem(message: Message): vscode.TreeItem {
		const first = message.text.split('\n')[0];
		const item = new vscode.TreeItem(`@${message.from}`);
		item.id = `message:${message.seq}`;
		item.description = first.length > 120 ? `${first.slice(0, 120)}…` : first;
		item.tooltip = new vscode.MarkdownString().appendText(`@${message.from} → ${message.to.join(', ')}, ${new Date(message.ts).toLocaleString()}\n\n${message.text}`);
		item.iconPath = new vscode.ThemeIcon('mail');
		item.contextValue = 'message';
		item.command = { command: 'facade.agents.reply', title: vscode.l10n.t("Reply"), arguments: [message] };
		return item;
	}
}

/** The conversation as a chat, with a place for the person to write as @you. */
class MessagesView implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;

	constructor(private readonly kernel: Kernel, private readonly log: (message: string) => void) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = messagesHtml(crypto.randomBytes(16).toString('base64'));
		view.webview.onDidReceiveMessage((message: { type?: string; to?: string; text?: string; replyTo?: number }) => {
			if (message.type === 'ready') {
				this.update();
			} else if (message.type === 'send' && typeof message.to === 'string' && typeof message.text === 'string') {
				try {
					const you = { name: YOU, incarnation: this.kernel.participant(YOU).incarnation };
					const sent = this.kernel.send(you, message.to, message.text, typeof message.replyTo === 'number' ? message.replyTo : undefined);
					void view.webview.postMessage({ type: 'sent', note: sent.emptyGroups.length ? vscode.l10n.t("Nobody is in {0} yet.", sent.emptyGroups.join(', ')) : undefined });
				} catch (err) {
					void view.webview.postMessage({ type: 'error', message: (err as Error).message });
				}
			}
		});
		view.onDidDispose(() => this.view = undefined);
	}

	update(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.postMessage({ type: 'state', messages: conversation(this.kernel, CONVERSATION_LENGTH), addresses: addresses(this.kernel) }).then(undefined, err => this.log(`[views] ${err}`));
	}
}

function messagesHtml(nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	body { padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
	#list { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px; }
	.message { margin: 0 0 8px; }
	.message .head { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.message .head .from { color: var(--vscode-foreground); font-weight: 600; }
	.message .text { white-space: pre-wrap; word-break: break-word; }
	.message.notice { opacity: 0.6; font-size: 0.9em; }
	.message.mine .from { color: var(--vscode-textLink-foreground); }
	#empty { color: var(--vscode-descriptionForeground); padding: 10px; }
	#composer { border-top: 1px solid var(--vscode-panel-border, transparent); padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }
	#composer input, #composer textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font: inherit; padding: 3px 5px; }
	#composer textarea { resize: vertical; min-height: 3em; }
	#row { display: flex; gap: 6px; align-items: center; }
	#to { flex: 1 1 auto; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	#note { color: var(--vscode-descriptionForeground); font-size: 0.9em; min-height: 1em; }
	#note.error { color: var(--vscode-errorForeground); }
	label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>
</head>
<body>
<div id="list"><div id="empty">No messages yet.</div></div>
<div id="composer">
	<div id="row"><input id="to" list="addresses" placeholder="@name or #group" aria-label="To"><label><input type="checkbox" id="notices"> notices</label></div>
	<datalist id="addresses"></datalist>
	<textarea id="text" placeholder="Message, as @you. Ctrl+Enter sends." aria-label="Message"></textarea>
	<div id="row2" style="display:flex;justify-content:space-between;align-items:center"><span id="note"></span><button id="send">Send</button></div>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const saved = vscode.getState() || {};
	const list = document.getElementById('list');
	const to = document.getElementById('to');
	const text = document.getElementById('text');
	const note = document.getElementById('note');
	const notices = document.getElementById('notices');
	const datalist = document.getElementById('addresses');
	to.value = saved.to || '';
	notices.checked = !!saved.notices;
	let last = { messages: [], addresses: [] };

	function remember() { vscode.setState({ to: to.value, notices: notices.checked }); }

	function render() {
		const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
		list.textContent = '';
		const shown = last.messages.filter(message => notices.checked || !message.notice);
		if (!shown.length) {
			const empty = document.createElement('div');
			empty.id = 'empty';
			empty.textContent = 'No messages yet.';
			list.appendChild(empty);
		}
		for (const message of shown) {
			const item = document.createElement('div');
			item.className = 'message' + (message.notice ? ' notice' : '') + (message.mine ? ' mine' : '');
			const head = document.createElement('div');
			head.className = 'head';
			const from = document.createElement('span');
			from.className = 'from';
			from.textContent = message.notice ? 'Facade' : '@' + message.from;
			head.appendChild(from);
			head.appendChild(document.createTextNode(' → ' + message.to + ' · ' + new Date(message.ts).toLocaleTimeString() + ' · ' + message.seq + (message.replyTo ? ' (re ' + message.replyTo + ')' : '')));
			const body = document.createElement('div');
			body.className = 'text';
			body.textContent = message.text;
			item.appendChild(head);
			item.appendChild(body);
			item.addEventListener('dblclick', () => {
				if (!message.notice && message.from !== 'you') {
					to.value = '@' + message.from;
					text.dataset.replyTo = String(message.seq);
					remember();
					text.focus();
				}
			});
			list.appendChild(item);
		}
		if (nearBottom) {
			list.scrollTop = list.scrollHeight;
		}
		datalist.textContent = '';
		for (const address of last.addresses) {
			const option = document.createElement('option');
			option.value = address;
			datalist.appendChild(option);
		}
	}

	function send() {
		if (!to.value.trim() || !text.value.trim()) {
			note.className = 'error';
			note.textContent = 'Say to whom, and what.';
			return;
		}
		const replyTo = text.dataset.replyTo ? Number(text.dataset.replyTo) : undefined;
		vscode.postMessage({ type: 'send', to: to.value, text: text.value, replyTo });
		remember();
	}

	document.getElementById('send').addEventListener('click', send);
	text.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			send();
		}
	});
	to.addEventListener('change', remember);
	notices.addEventListener('change', () => { remember(); render(); });

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'state') {
			last = message;
			render();
		} else if (message.type === 'sent') {
			text.value = '';
			delete text.dataset.replyTo;
			note.className = '';
			note.textContent = message.note || '';
		} else if (message.type === 'error') {
			note.className = 'error';
			note.textContent = message.message;
		}
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
