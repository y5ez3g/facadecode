/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../../base/common/arrays.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { openLinkFromMarkdown } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { repositoryFolderOf, worktreeRepositoryOf } from '../../../services/workspaces/common/gitFiles.js';

/** The folders to add here after the trust question: all of them, or none when they went to a new window (WORKSPACE.md W5). */
export interface IAdmission {
	readonly here: readonly URI[];
}

/** Trust and Add, with the parent folder to trust when its box is ticked, or the link to a new window. */
type TrustAnswer = { readonly kind: 'trust'; readonly parent: URI | undefined } | { readonly kind: 'elsewhere' };

/** The most folders the trust question names; the rest are counted. */
const LISTED_FOLDERS = 10;

/** The trust question's link to a new window, which the question follows itself rather than running. */
const OPEN_ELSEWHERE = 'command:_facade.workspaceBar.openElsewhere';

/**
 * Asks VS Code's trust question once before folders that are not trusted join a trusted window, for every way
 * Facade adds folders: one such folder would put the whole window in Restricted Mode (WORKSPACE.md W5).
 */
export class WorkspaceBarTrustGate {

	constructor(
		@IWorkspaceTrustEnablementService private readonly enablementService: IWorkspaceTrustEnablementService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILabelService private readonly labelService: ILabelService,
		@ILogService private readonly logService: ILogService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IHostService private readonly hostService: IHostService,
		@IFileService private readonly fileService: IFileService,
	) { }

	async admit(uris: readonly URI[]): Promise<IAdmission | undefined> {
		// A window already in Restricted Mode loses nothing more, as VS Code asks nothing then either
		if (!this.enablementService.isWorkspaceTrustEnabled() || !this.trustService.isWorkspaceTrusted()) {
			return { here: uris };
		}

		const trust = await Promise.all(uris.map(uri => this.trustService.getUriTrustInfo(uri)));
		const untrusted = uris.filter((_, at) => !trust[at].trusted);
		if (!untrusted.length) {
			return { here: uris };
		}

		const asked = await this.askedFor(untrusted);
		const answer = await this.ask(asked, uris.length);
		this.logService.trace(`[workspaceBar] ${asked.length} folder(s) untrusted: ${answer?.kind ?? 'cancelled'}`);
		if (!answer) {
			return undefined;
		}

		if (answer.kind === 'elsewhere') {
			await this.hostService.openWindow(uris.map(uri => ({ folderUri: uri })), { forceNewWindow: true });
			return { here: [] };
		}

		await this.trustService.setUrisTrust(answer.parent ? [answer.parent] : asked, true);
		return { here: uris };
	}

	/**
	 * What the question asks about for `untrusted`: each folder, but for a worktree its repository's folder - a worktree's
	 * trust is its repository's (WORKTREE.md), so trusting the repository trusts it and every other worktree of it. Each once.
	 */
	private async askedFor(untrusted: readonly URI[]): Promise<URI[]> {
		const extUri = this.uriIdentityService.extUri;
		const asked = await Promise.all(untrusted.map(async uri => {
			const repository = await worktreeRepositoryOf(this.fileService, extUri, uri);
			return repository ? repositoryFolderOf(repository) : uri;
		}));
		return distinct(asked, uri => extUri.getComparisonKey(uri));
	}

	private async ask(untrusted: readonly URI[], adding: number): Promise<TrustAnswer | undefined> {
		const one = untrusted.length === 1;

		// The paths as VS Code's question shows its own, as code, one to a line; past ten, counted
		const paths = untrusted.slice(0, LISTED_FOLDERS).map(uri => `\`${this.labelService.getUriLabel(uri)}\``);
		if (untrusted.length > LISTED_FOLDERS) {
			paths.push(localize('workspaceBar.untrustedMore', "and {0} more", untrusted.length - LISTED_FOLDERS));
		}

		// The link closes the question as Cancel would, and says it was the link
		const close = new CancellationTokenSource();
		let elsewhere = false;
		const links = new MarkdownString(adding === 1
			? localize('workspaceBar.untrustedLinks', "See [our docs](https://aka.ms/vscode-workspace-trust) to learn more, or [open in a new window]({0}) in Restricted Mode.", OPEN_ELSEWHERE)
			: localize('workspaceBar.untrustedLinksMany', "See [our docs](https://aka.ms/vscode-workspace-trust) to learn more, or [open all {0} folders in a new window]({1}) in Restricted Mode.", adding, OPEN_ELSEWHERE),
			{ isTrusted: { enabledCommands: [OPEN_ELSEWHERE.slice('command:'.length)] } });

		const parent = this.parentOf(untrusted);
		try {
			const { result, checkboxChecked } = await this.dialogService.prompt<'trust'>({
				type: Severity.Info,
				message: one
					? localize('workspaceBar.untrustedMessage', "Do you trust the authors of the files in this folder?")
					: localize('workspaceBar.untrustedMessageMany', "Do you trust the authors of the files in these {0} folders?", untrusted.length),
				buttons: [
					{ label: localize({ key: 'workspaceBar.trustAndAdd', comment: ['&& denotes a mnemonic'] }, "&&Trust and Add"), run: () => 'trust' }
				],
				cancelButton: true,
				checkbox: parent ? { label: localize('workspaceBar.trustParent', "Trust the authors of all files in the parent folder '{0}'", basename(parent)), checked: false } : undefined,
				token: close.token,
				custom: {
					icon: Codicon.shield,
					markdownDetails: [
						{ markdown: new MarkdownString(paths.join('  \n')) },
						{
							markdown: new MarkdownString(one
								? localize('workspaceBar.untrustedConsequence', "This workspace is trusted. Adding an untrusted folder will switch the entire workspace and active agents to Restricted Mode.")
								: localize('workspaceBar.untrustedConsequenceMany', "This workspace is trusted. Adding untrusted folders will switch the entire workspace and active agents to Restricted Mode."))
						},
						{
							markdown: links,
							actionHandler: async link => {
								if (link === OPEN_ELSEWHERE) {
									elsewhere = true;
									close.cancel();
									return true;
								}
								return openLinkFromMarkdown(this.openerService, link, links.isTrusted, true);
							}
						}
					]
				}
			});

			if (elsewhere) {
				return { kind: 'elsewhere' };
			}
			return result === 'trust' ? { kind: 'trust', parent: checkboxChecked ? parent : undefined } : undefined;
		} finally {
			close.dispose();
		}
	}

	/** The folder all of `uris` are in, when they are all in one: what the question offers to trust whole. */
	private parentOf(uris: readonly URI[]): URI | undefined {
		const extUri = this.uriIdentityService.extUri;
		const parent = extUri.dirname(uris[0]);
		// A drive's or a share's root is its own parent, and has none to offer
		if (extUri.isEqual(parent, uris[0])) {
			return undefined;
		}
		return uris.every(uri => extUri.isEqual(extUri.dirname(uri), parent)) ? parent : undefined;
	}
}
