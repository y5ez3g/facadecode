/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { WorkspaceBarAgentsService } from '../../../../browser/parts/workspacebar/workspaceBarAgents.js';

class TestFileService extends mock<IFileService>() {
	override onDidChangeFileSystemProviderCapabilities = Event.None;
	override onDidChangeFileSystemProviderRegistrations = Event.None;
	override hasProvider(): boolean { return true; }
	override hasCapability(): boolean { return true; }
}

suite('Workspace bar - the agents each folder runs', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('told what runs where, it answers for each folder, and says so only when what a row draws has changed', () => {
		const agents = store.add(new WorkspaceBarAgentsService(store.add(new UriIdentityService(new TestFileService()))));
		let changes = 0;
		store.add(agents.onDidChange(() => changes++));
		const lab = URI.file('/lab');
		const notes = URI.file('/notes');
		const icons = (folder: URI) => agents.agentsIn(folder).map(icon => icon.id);

		agents.set([{ folder: lab, icons: [ThemeIcon.fromId('agent-claude'), ThemeIcon.fromId('agent-codex')] }, { folder: notes, icons: [] }]);
		const told = { lab: icons(lab), notes: icons(notes), changes };

		agents.set([{ folder: URI.file('/lab'), icons: [ThemeIcon.fromId('agent-claude'), ThemeIcon.fromId('agent-codex')] }]);
		const toldTheSame = changes;

		agents.set([{ folder: notes, icons: [ThemeIcon.fromId('agent-grok')] }]);

		assert.deepStrictEqual({ told, toldTheSame, afterMoving: { lab: icons(lab), notes: icons(notes), changes } }, {
			told: { lab: ['agent-claude', 'agent-codex'], notes: [], changes: 1 },
			toldTheSame: 1,
			afterMoving: { lab: [], notes: ['agent-grok'], changes: 2 },
		});
	});
});
