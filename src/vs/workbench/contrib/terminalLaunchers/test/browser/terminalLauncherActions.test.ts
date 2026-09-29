/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { AGENT_MENU_GROUP, agentMenuRows } from '../../browser/terminalLauncherActions.js';
import { agentIcon } from '../../common/terminalLaunchers.js';

/** Runs every command, except the one that fails and the one somebody cancels. */
class TestCommandService extends mock<ICommandService>() {

	readonly ran: string[] = [];

	override async executeCommand<R>(id: string): Promise<R | undefined> {
		if (id === 'fails') {
			throw new Error('No shell to start the agent in');
		}
		if (id === 'cancelled') {
			throw new CancellationError();
		}
		this.ran.push(id);
		return undefined;
	}
}

class TestNotificationService extends mock<INotificationService>() {

	readonly errors: NotificationMessage[] = [];

	override error(message: NotificationMessage): void {
		this.errors.push(message);
	}
}

suite('Agent menu - the dropdown the agent button opens', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const contextKeyService = new class extends mock<IContextKeyService>() { };

	function row(commandService: ICommandService, id: string, title: string, icon?: ThemeIcon): MenuItemAction {
		return new MenuItemAction({ id, title, icon }, undefined, undefined, undefined, undefined, contextKeyService, commandService);
	}

	test('the agents above the line, each with its logo, and the rest of the menu below it', () => {
		const commandService = new TestCommandService();

		const { agents, rest } = agentMenuRows([
			[AGENT_MENU_GROUP, [row(commandService, 'claude', 'Claude Code', agentIcon('claude')), row(commandService, 'mine', 'My Agent', agentIcon('my-agent --fast'))]],
			['z_configure', [row(commandService, 'active', 'Show Active Agents...'), row(commandService, 'configure', 'Configure Agents...')]]
		], new TestNotificationService());

		assert.deepStrictEqual(agents.map(agent => [agent.label, agent.icon?.id]), [['Claude Code', 'agent-claude'], ['My Agent', 'robot']]);
		assert.deepStrictEqual(rest.map(other => other.label), ['Show Active Agents...', 'Configure Agents...']);
	});

	test('a row runs its command, and one that fails says so - as a row of a context menu does - unless it was cancelled', async () => {
		const commandService = new TestCommandService();
		const notificationService = new TestNotificationService();

		const { agents } = agentMenuRows([
			[AGENT_MENU_GROUP, [row(commandService, 'claude', 'Claude Code'), row(commandService, 'fails', 'Codex'), row(commandService, 'cancelled', 'Grok Build')]]
		], notificationService);
		await Promise.all(agents.map(agent => agent.run()));

		assert.deepStrictEqual(commandService.ran, ['claude']);
		assert.deepStrictEqual(notificationService.errors.map(error => error instanceof Error ? error.message : error), ['No shell to start the agent in']);
	});
});
