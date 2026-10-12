/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../native/common/native.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const osProperties: IOSProperties = {
		type: 'Test OS',
		release: '1.0',
		arch: 'test-arch',
		platform: 'test',
		cpus: []
	};

	function getCopilotVersionLines(runtime: string, sdk: string): { details: string[]; detailsToCopy: string[] } {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			copilotVersions: { runtime, sdk }
		};
		const { details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		const selectCopilotVersionLines = (value: string) => value.split('\n').filter(line => line.startsWith('@github/copilot'));

		return {
			details: selectCopilotVersionLines(details),
			detailsToCopy: selectCopilotVersionLines(detailsToCopy)
		};
	}

	test('formats Copilot canary versions', () => {
		assert.deepStrictEqual(
			getCopilotVersionLines('1.0.84-canary.70.gdb75d0d.unsigned', '0.1.23-canary.45.gabcdef.unsigned'),
			{
				details: [
					'@github/copilot: 1.0.84.70.gdb75d0d',
					'@github/copilot-sdk: 0.1.23.45.gabcdef'
				],
				detailsToCopy: [
					'@github/copilot: 1.0.84.70.gdb75d0d',
					'@github/copilot-sdk: 0.1.23.45.gabcdef'
				]
			}
		);
	});

	test('ID-02 About says which Facade Code this is, with the VS Code it is built on beside it', () => {
		const productService: IProductService = { _serviceBrand: undefined, ...product, nameLong: 'Facade Code', facadeVersion: '0.1.0', version: '1.138.0' };
		const { title, details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		const versionLine = (value: string) => value.split('\n').find(line => line.startsWith('Version: '));

		assert.deepStrictEqual(
			{ title, details: versionLine(details), detailsToCopy: versionLine(detailsToCopy) },
			{ title: 'Facade Code', details: 'Version: 0.1.0 (based on VS Code 1.138.0)', detailsToCopy: 'Version: 0.1.0 (based on VS Code 1.138.0)' }
		);
	});

	test('preserves stable Copilot versions', () => {
		assert.deepStrictEqual(
			getCopilotVersionLines('1.0.84', '0.1.23'),
			{
				details: [
					'@github/copilot: 1.0.84',
					'@github/copilot-sdk: 0.1.23'
				],
				detailsToCopy: [
					'@github/copilot: 1.0.84',
					'@github/copilot-sdk: 0.1.23'
				]
			}
		);
	});
});
