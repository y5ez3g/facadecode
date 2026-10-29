/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import product from '../../../product/common/product.js';
import { logHeader } from '../../../product/common/releaseVersion.js';
import { FileLoggerService } from '../../common/fileLog.js';
import { LogLevel, NullLogService } from '../../common/log.js';

suite('FileLoggerService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('ID-09 a log opens with which build wrote it, whatever its level; output that is not a log does not', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const logs = URI.from({ scheme: Schemas.inMemory, path: '/logs' });
		const loggerService = disposables.add(new FileLoggerService(LogLevel.Warning, logs, fileService));

		const log = loggerService.createLogger(joinPath(logs, 'window.log'), {});
		const output = loggerService.createLogger(joinPath(logs, 'tasks.log'), { donotUseFormatters: true });
		log.info('below the level');
		log.warn('at the level');
		output.warn('output\n');

		// the lines as written, without their times
		const linesOf = async (name: string, count: number) => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const text = await fileService.readFile(joinPath(logs, name)).then(content => content.value.toString(), () => '');
				const lines = text.split('\n').filter(line => !!line);
				if (lines.length >= count) {
					return lines.map(line => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /, ''));
				}
				await timeout(20);
			}
			return [];
		};

		assert.deepStrictEqual({
			log: await linesOf('window.log', 2),
			output: await linesOf('tasks.log', 1)
		}, {
			log: [`[info] ${logHeader(product)}`, '[warning] at the level'],
			output: ['output']
		});
	});
});
