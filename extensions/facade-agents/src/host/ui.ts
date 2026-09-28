/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Engine, EngineUi } from '../common/engine';
import { ProgramState } from '../common/model';
import { formatCommand } from '../common/validator';

/*
 * What the person sees and decides: the plan, its approval, a program's status, and what to do
 * when Facade restarted under a running program. Approval exists only here - no tool can approve a
 * plan - so a lead cannot approve its own.
 */

export const PROGRAM_SCHEME = 'facade-program';

export class AgentsUi implements EngineUi, vscode.TextDocumentContentProvider, vscode.Disposable {

	private engine: Engine | undefined;
	private readonly didChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.didChange.event;
	private readonly statusBar = vscode.window.createStatusBarItem('facade.agents.status', vscode.StatusBarAlignment.Left, 50);
	private readonly disposables: vscode.Disposable[] = [this.didChange, this.statusBar];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly dirty = new Set<string>();

	constructor() {
		this.statusBar.name = vscode.l10n.t("Facade Programs");
		this.statusBar.command = 'facade.agents.showPrograms';
		this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(PROGRAM_SCHEME, this));
	}

	attach(engine: Engine): void {
		this.engine = engine;
		this.updateStatusBar();
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/*
	 * EngineUi
	 */

	planSubmitted(program: ProgramState): void {
		const review = vscode.l10n.t("Review Plan");
		void vscode.window.showInformationMessage(vscode.l10n.t("The lead submitted a plan with {0} features for your approval: {1}", String(program.plan.features.length), firstLine(program.plan.goal)), review).then(choice => {
			if (choice === review) {
				void this.reviewPlan(program.id);
			}
		});
	}

	programInterrupted(program: ProgramState): void {
		const resume = vscode.l10n.t("Resume");
		const show = vscode.l10n.t("Show Program");
		void vscode.window.showWarningMessage(vscode.l10n.t("Program {0} was interrupted when Facade closed. Its workers stopped; resume to start them again.", program.id), resume, show).then(choice => {
			if (choice === resume) {
				void this.engine?.resume(program.id);
			} else if (choice === show) {
				void this.showStatus(program.id);
			}
		});
	}

	shipRequested(program: ProgramState): void {
		const review = vscode.l10n.t("Review and Ship");
		void vscode.window.showInformationMessage(vscode.l10n.t("The lead asks to ship program {0} into {1} ({2}).", program.id, program.plan.base, program.ship?.mode ?? 'merge'), review).then(choice => {
			if (choice === review) {
				void this.reviewShip(program.id);
			}
		});
	}

	queueHalted(program: ProgramState, reason: string): void {
		const show = vscode.l10n.t("Show Program");
		void vscode.window.showWarningMessage(vscode.l10n.t("Program {0} stopped merging: {1}. Resume it once that is sorted out.", program.id, reason), show).then(choice => {
			if (choice === show) {
				void this.showPrograms(program.id);
			}
		});
	}

	notice(message: string): void {
		void vscode.window.showInformationMessage(message);
	}

	changed(program: ProgramState): void {
		this.dirty.add(program.id);
		if (!this.refreshTimer) {
			this.refreshTimer = setTimeout(() => {
				this.refreshTimer = undefined;
				for (const id of this.dirty) {
					for (const file of ['plan.md', 'status.md', 'ship.md']) {
						this.didChange.fire(vscode.Uri.from({ scheme: PROGRAM_SCHEME, path: `/${id}/${file}` }));
					}
				}
				this.dirty.clear();
				this.updateStatusBar();
			}, 300);
		}
	}

	/*
	 * Documents
	 */

	provideTextDocumentContent(uri: vscode.Uri): string {
		const [, id, file] = uri.path.split('/');
		const program = this.engine?.getProgram(id);
		if (!program) {
			return vscode.l10n.t("There is no program {0}.", id);
		}
		switch (file) {
			case 'plan.md': return planMarkdown(program);
			case 'ship.md': return shipMarkdown(program, this.engine!.shipMessage(id));
			default: return ['```text', this.engine!.digest(id), '```'].join('\n');
		}
	}

	/*
	 * Commands
	 */

	async reviewPlan(programId?: string): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		const id = programId ?? await this.pickProgram(program => program.status === 'awaiting_approval', vscode.l10n.t("No plan is waiting for your approval."));
		const program = id ? engine.getProgram(id) : undefined;
		if (!program) {
			return;
		}
		await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.from({ scheme: PROGRAM_SCHEME, path: `/${program.id}/plan.md` }));
		if (program.status !== 'awaiting_approval') {
			return;
		}
		const approve = vscode.l10n.t("Approve Plan");
		const changes = vscode.l10n.t("Request Changes...");
		const commands = program.newCommands.length ? `\n\n${vscode.l10n.t("Approving also lets Facade run these commands in this repository:")}\n${program.newCommands.map(key => `• ${formatKey(key)}`).join('\n')}` : '';
		const detail = vscode.l10n.t("{0} features, each built by an agent in its own worktree off {1}.", String(program.plan.features.length), program.plan.base) + commands;
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Approve the plan for program {0}?", program.id), { modal: true, detail }, approve, changes);
		try {
			if (choice === approve) {
				engine.approvePlan(program.id);
			} else if (choice === changes) {
				const comment = await vscode.window.showInputBox({ title: vscode.l10n.t("What should the lead change?"), prompt: vscode.l10n.t("The lead reads this and revises the plan."), ignoreFocusOut: true });
				if (comment !== undefined) {
					engine.requestChanges(program.id, comment);
				}
			}
		} catch (err) {
			void vscode.window.showErrorMessage((err as Error).message);
		}
	}

	/** Shows the merge message and the review's outcome, then asks the person to approve shipping. */
	async reviewShip(programId?: string): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		const id = programId ?? await this.pickProgram(program => program.ship?.status === 'awaiting_approval', vscode.l10n.t("No program is waiting to ship."));
		const program = id ? engine.getProgram(id) : undefined;
		if (!program?.ship) {
			return;
		}
		await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.from({ scheme: PROGRAM_SCHEME, path: `/${program.id}/ship.md` }));
		if (program.ship.status !== 'awaiting_approval') {
			return;
		}
		const ship = vscode.l10n.t("Ship");
		const decline = vscode.l10n.t("Do Not Ship...");
		const how = program.ship.mode === 'pr'
			? vscode.l10n.t("Facade pushes {0} and opens a pull request into {1}.", program.integrationBranch ?? '', program.plan.base)
			: program.ship.mode === 'squash'
				? vscode.l10n.t("Facade adds one commit with the reviewed changes to {0}.", program.plan.base)
				: vscode.l10n.t("Facade merges {0} into {1} with a merge commit.", program.integrationBranch ?? '', program.plan.base);
		const ruled = [...program.findings.values()].filter(finding => finding.status === 'wontfix' || finding.status === 'follow-up').length;
		const detail = [how, vscode.l10n.t("Full checks passed on {0}.", program.ship.tip.slice(0, 9)), ruled ? vscode.l10n.t("{0} findings were ruled wontfix or follow-up; see the ship page.", String(ruled)) : ''].filter(Boolean).join('\n');
		const choice = await vscode.window.showWarningMessage(vscode.l10n.t("Ship program {0} into {1}?", program.id, program.plan.base), { modal: true, detail }, ship, decline);
		try {
			if (choice === ship) {
				engine.approveShip(program.id);
			} else if (choice === decline) {
				const reason = await vscode.window.showInputBox({ title: vscode.l10n.t("Why not ship it now?"), prompt: vscode.l10n.t("The lead reads this."), ignoreFocusOut: true });
				if (reason !== undefined) {
					engine.cancelShip(program.id, reason);
				}
			}
		} catch (err) {
			void vscode.window.showErrorMessage((err as Error).message);
		}
	}

	async showPrograms(programId?: string): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		const id = programId ?? await this.pickProgram(() => true, vscode.l10n.t("No programs yet. Start a lead with \"Facade: Start Lead Agent\" and ask it to build something."));
		const program = id ? engine.getProgram(id) : undefined;
		if (!program) {
			return;
		}
		const actions: (vscode.QuickPickItem & { run: () => unknown })[] = [
			{ label: vscode.l10n.t("Show Status"), run: () => this.showStatus(program.id) },
			{ label: vscode.l10n.t("Show Plan"), run: () => vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.from({ scheme: PROGRAM_SCHEME, path: `/${program.id}/plan.md` })) }
		];
		if (program.status === 'awaiting_approval') {
			actions.unshift({ label: vscode.l10n.t("Review Plan"), run: () => this.reviewPlan(program.id) });
		}
		if (program.ship?.status === 'awaiting_approval') {
			actions.unshift({ label: vscode.l10n.t("Review and Ship"), run: () => this.reviewShip(program.id) });
		}
		if (program.status === 'paused' || program.queueHalted) {
			actions.push({ label: vscode.l10n.t("Resume"), detail: program.queueHalted ?? program.pauseReason, run: () => engine.resume(program.id) });
		}
		if (program.status !== 'aborted' && program.status !== 'shipped') {
			actions.push({ label: vscode.l10n.t("Stop Program..."), run: () => this.confirmAbort(program.id) });
		}
		const action = await vscode.window.showQuickPick(actions, { title: vscode.l10n.t("Program {0}", program.id) });
		await action?.run();
	}

	private async showStatus(programId: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: PROGRAM_SCHEME, path: `/${programId}/status.md` }));
		await vscode.window.showTextDocument(document, { preview: true });
	}

	private async confirmAbort(programId: string): Promise<void> {
		const stop = vscode.l10n.t("Stop Program");
		const choice = await vscode.window.showWarningMessage(vscode.l10n.t("Stop program {0}?", programId), { modal: true, detail: vscode.l10n.t("Its workers are closed. Branches and worktrees stay, and nothing is merged.") }, stop);
		if (choice === stop) {
			this.engine?.abort(programId);
		}
	}

	private async pickProgram(filter: (program: ProgramState) => boolean, emptyMessage: string): Promise<string | undefined> {
		const programs = (this.engine?.programsState() ?? []).filter(filter).sort((a, b) => b.updatedAt - a.updatedAt);
		if (!programs.length) {
			void vscode.window.showInformationMessage(emptyMessage);
			return undefined;
		}
		if (programs.length === 1) {
			return programs[0].id;
		}
		const picked = await vscode.window.showQuickPick(programs.map(program => ({ label: program.id, description: statusLabel(program), detail: firstLine(program.plan.goal) })), { title: vscode.l10n.t("Facade Programs") });
		return picked?.label;
	}

	private updateStatusBar(): void {
		const programs = this.engine?.programsState() ?? [];
		let working = 0;
		let needsYou = 0;
		for (const program of programs) {
			if (program.status === 'awaiting_approval' || program.ship?.status === 'awaiting_approval' || program.queueHalted) {
				needsYou++;
			}
			for (const feature of program.features.values()) {
				if (feature.status === 'running' || feature.status === 'verifying') {
					working++;
				} else if (feature.status === 'needs_lead') {
					needsYou++;
				}
			}
		}
		if (!working && !needsYou) {
			this.statusBar.hide();
			return;
		}
		this.statusBar.text = needsYou ? `$(robot) ${vscode.l10n.t("{0} working · {1} waiting", String(working), String(needsYou))}` : `$(robot) ${vscode.l10n.t("{0} working", String(working))}`;
		this.statusBar.tooltip = vscode.l10n.t("Facade programs: agents working and decisions waiting");
		this.statusBar.show();
	}
}

function firstLine(text: string): string {
	const line = text.split('\n')[0].trim();
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function statusLabel(program: ProgramState): string {
	switch (program.status) {
		case 'draft': return vscode.l10n.t("Draft");
		case 'awaiting_approval': return vscode.l10n.t("Waiting for your approval");
		case 'approved': return vscode.l10n.t("Approved");
		case 'running': return vscode.l10n.t("Running");
		case 'paused': return vscode.l10n.t("Paused");
		case 'aborted': return vscode.l10n.t("Stopped");
		case 'shipped': return vscode.l10n.t("Shipped");
	}
}

/** What the person reads before approving shipping: the merge message and what the review decided. */
export function shipMarkdown(program: ProgramState, message: string): string {
	const lines = [`# ${vscode.l10n.t("Ship {0}", program.id)}`, ''];
	if (program.ship) {
		lines.push(`**${vscode.l10n.t("How")}:** ${program.ship.mode} → \`${program.plan.base}\` · ${program.ship.status}${program.ship.reason ? ` (${escape(program.ship.reason)})` : ''}`, '');
		if (program.ship.url) {
			lines.push(`**${vscode.l10n.t("Pull request")}:** ${program.ship.url}`, '');
		}
		if (program.ship.kept?.length) {
			lines.push(`**${vscode.l10n.t("Kept")}:** ${program.ship.kept.map(escape).join(', ')}`, '');
		}
	}
	lines.push(`## ${vscode.l10n.t("Merge message")}`, '', '```text', message.trimEnd(), '```');
	const findings = [...program.findings.values()];
	if (findings.length) {
		lines.push('', `## ${vscode.l10n.t("Review findings")}`, '', `| | ${vscode.l10n.t("Severity")} | ${vscode.l10n.t("Status")} | ${vscode.l10n.t("Finding")} | ${vscode.l10n.t("Ruling")} |`, '|---|---|---|---|---|');
		for (const finding of findings) {
			lines.push(`| ${finding.id} | ${finding.severity} | ${finding.status} | ${escape(finding.title)} | ${escape(finding.ruling ?? '')} |`);
		}
	}
	return lines.join('\n');
}

function formatKey(key: string): string {
	const [cwd, ...argv] = JSON.parse(key) as string[];
	return formatCommand({ argv, cwd });
}

function escape(text: string): string {
	return text.replace(/[|\\`*_<>]/g, match => `\\${match}`).replace(/\n/g, ' ');
}

/** The plan as the person reads it before approving. */
export function planMarkdown(program: ProgramState): string {
	const plan = program.plan;
	const lines = [
		`# ${vscode.l10n.t("Plan {0}", program.id)} · ${statusLabel(program)}`,
		'',
		`**${vscode.l10n.t("Goal")}:** ${escape(plan.goal)}`,
		'',
		`**${vscode.l10n.t("Approach")}:** ${escape(plan.approach)}`,
		'',
		`**${vscode.l10n.t("Starts from")}:** \`${plan.base}\`${program.baseCommit ? ` @ \`${program.baseCommit.slice(0, 9)}\`` : ''}${program.integrationBranch ? ` → \`${program.integrationBranch}\`` : ''}`,
		'',
		`## ${vscode.l10n.t("Scaffold")}`,
		escape(plan.scaffold.summary) || vscode.l10n.t("None."),
		'',
		...plan.scaffold.paths.map(file => `- \`${file}\``),
		'',
		`## ${vscode.l10n.t("Features")}`,
		'',
		`| | ${vscode.l10n.t("Feature")} | ${vscode.l10n.t("Owns")} | ${vscode.l10n.t("Size")} | ${vscode.l10n.t("Risk")} | ${vscode.l10n.t("Checked by")} |`,
		'|---|---|---|---|---|---|'
	];
	for (const feature of plan.features) {
		lines.push(`| ${feature.id} | ${escape(feature.title)} | ${feature.owns.map(file => `\`${file}\``).join('<br>')} | ${feature.size} | ${feature.risk} | ${feature.acceptance.commands.map(cmd => `\`${escape(formatCommand(cmd))}\``).join('<br>')} |`);
	}
	lines.push('', `## ${vscode.l10n.t("Checks")}`, '', `- ${vscode.l10n.t("Fast")}: ${plan.checks.fast.map(cmd => `\`${formatCommand(cmd)}\``).join(', ')}`, `- ${vscode.l10n.t("Full")}: ${plan.checks.full.map(cmd => `\`${formatCommand(cmd)}\``).join(', ') || vscode.l10n.t("none")}`);
	if (program.newCommands.length) {
		lines.push('', `## ${vscode.l10n.t("New commands to approve")}`, '', ...program.newCommands.map(key => `- \`${formatKey(key)}\``));
	}
	if (plan.conventions.length) {
		lines.push('', `## ${vscode.l10n.t("Conventions every worker gets")}`, '', ...plan.conventions.map(rule => `- ${escape(rule)}`));
	}
	return lines.join('\n');
}
