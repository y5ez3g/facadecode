/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IProductConfiguration } from '../../../base/common/product.js';

/**
 * Facade Code: which Facade Code this is, with the VS Code it is built on beside it (IDENTITY.md I7) -
 * `0.1.0 (based on VS Code 1.138.0)`. About, `facade --version` and the issue reporter say it. Without a
 * release version, VS Code's alone: what a build of upstream's says.
 */
export function releaseVersionLabel(product: Pick<IProductConfiguration, 'facadeVersion' | 'version'>): string {
	return product.facadeVersion
		? localize('releaseVersion', "{0} (based on VS Code {1})", product.facadeVersion, product.version)
		: product.version;
}

/**
 * Facade Code: the first line of every log, which build wrote it - the name and both versions (IDENTITY.md
 * I7). In English whatever the display language: a log is read in a bug report.
 */
export function logHeader(product: Pick<IProductConfiguration, 'nameLong' | 'facadeVersion' | 'version'>): string {
	return product.facadeVersion
		? `${product.nameLong} ${product.facadeVersion} (based on VS Code ${product.version})`
		: `${product.nameLong} ${product.version}`;
}
