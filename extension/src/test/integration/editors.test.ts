import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { editorBuildCommit } from './editors';

suite('Official VS Code download layouts', () => {
	const commit = 'a'.repeat(40);
	for (const [name, executable, resources] of [
		['flat archive', 'code', 'resources/app'],
		['macOS application', 'Contents/MacOS/Code', 'Contents/Resources/app'],
		['versioned Windows archive', 'Code.exe', `${commit.slice(0, 10)}/resources/app`]
	]) {
		test(`reads the pinned version from a ${name}`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-editor-layout-'));
			try {
				const app = path.join(root, resources);
				const program = path.join(root, executable);
				fs.mkdirSync(app, { recursive: true });
				fs.mkdirSync(path.dirname(program), { recursive: true });
				fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '1.147.0' }));
				fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ applicationName: 'code', dataFolderName: '.vscode', commit }));
				assert.equal(editorBuildCommit(program, '1.147.0'), commit);
				assert.throws(() => editorBuildCommit(program, '1.105.1'), /Expected official VS Code 1\.105\.1/u);
			} finally {
				fs.rmSync(root, { force: true, recursive: true });
			}
		});
	}
});
