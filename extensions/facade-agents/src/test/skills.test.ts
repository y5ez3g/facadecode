/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Kernel } from '../common/kernel/kernel';
import { FACADE, YOU } from '../common/kernel/model';
import { SKILLS, skillText, writeProtocolPages, writeSkillsPlugin } from '../common/kernel/skills';
import { INSTRUCTIONS, TOOL_NAMES } from '../common/kernel/tools';
import { tempDir } from './util';

suite('Process skills', () => {

	let temp: { dir: string; remove(): void };
	let kernel: Kernel;

	setup(() => {
		temp = tempDir('facade-skills-');
		kernel = Kernel.open({ dir: path.join(temp.dir, 'workspace') });
	});

	teardown(() => {
		kernel.dispose();
		temp.remove();
	});

	test('the seven skills name only the twelve tools and their arguments', () => {
		assert.deepStrictEqual(SKILLS.map(skill => skill.name), ['team', 'work', 'review', 'supervise', 'notebook', 'resume', 'etiquette']);
		const allowed = new Set<string>([...TOOL_NAMES, 'reply_to', 'wait_sec', 'if_version']);
		for (const skill of SKILLS) {
			for (const match of skill.body.matchAll(/`([a-z_]+)`/g)) {
				assert.ok(allowed.has(match[1]), `${skill.name} names \`${match[1]}\`, which is not a tool`);
			}
			assert.ok(skill.description.length < 400, `${skill.name}'s description is short enough to match on`);
		}
		assert.match(INSTRUCTIONS, /protocol\/<skill>/);
	});

	test('the pages are Facade\'s until someone changes them; Facade\'s own are brought up to date', () => {
		writeProtocolPages(kernel);
		const work = kernel.state.pages.get('protocol/work')!;
		assert.strictEqual(work.author, FACADE);
		assert.strictEqual(fs.readFileSync(path.join(kernel.notesDir, 'protocol', 'work.md'), 'utf8'), skillText(SKILLS[1]));
		// Nothing changed: nothing written.
		const seq = kernel.state.seq;
		writeProtocolPages(kernel);
		assert.strictEqual(kernel.state.seq, seq);
		// The person makes the team skill their own.
		kernel.write({ name: YOU, incarnation: 1 }, 'protocol/team', '# Our team\nAlways ask me first.');
		const newer = SKILLS.map(skill => ({ ...skill, body: `${skill.body}\n\nNewer.` }));
		writeProtocolPages(kernel, newer);
		assert.strictEqual(kernel.read({ name: YOU, incarnation: 1 }, 'protocol/team').text, '# Our team\nAlways ask me first.');
		assert.ok(kernel.read({ name: YOU, incarnation: 1 }, 'protocol/work').text.endsWith('Newer.\n'));
	});

	test('the Claude plugin carries the pages as they are now, in a folder named by its content', () => {
		writeProtocolPages(kernel);
		const root = path.join(temp.dir, 'plugins');
		const first = writeSkillsPlugin(root, kernel);
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(first, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'facade');
		assert.strictEqual(fs.readFileSync(path.join(first, 'skills', 'work', 'SKILL.md'), 'utf8'), skillText(SKILLS[1]));
		assert.strictEqual(writeSkillsPlugin(root, kernel), first);
		fs.writeFileSync(path.join(kernel.notesDir, 'protocol', 'work.md'), '---\nname: work\ndescription: ours\n---\n\nOur way.\n');
		kernel.scanNotebook();
		const second = writeSkillsPlugin(root, kernel);
		assert.notStrictEqual(second, first);
		assert.match(fs.readFileSync(path.join(second, 'skills', 'work', 'SKILL.md'), 'utf8'), /Our way\./);
	});
});
