/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The hosts that serve Microsoft's extension marketplace.
 *
 * ⚠️ Matched on a host boundary, so `open-vsx.org` is not caught by `vsassets.io` appearing
 * somewhere inside a longer name, and a path cannot smuggle one in.
 */
const MICROSOFT_GALLERY_HOSTS = /(^|\.)(marketplace\.visualstudio\.com|vsassets\.io|gallerycdn\.[a-z0-9-]+\.[a-z]+)$/i;

export interface IExtensionsGallery {
	readonly serviceUrl?: string;
	readonly itemUrl?: string;
	readonly resourceUrlTemplate?: string;
	readonly controlUrl?: string;
	readonly nlsBaseUrl?: string;
}

/**
 * Whether an `extensionsGallery` names Microsoft's marketplace.
 *
 * ⚠️ Upstream's hygiene check forbids the field outright, because the branded build has Microsoft's
 * gallery injected at build time and the terms for that gallery cover Microsoft's own products.
 * What that rule guards against is an unofficial build shipping *that* gallery, not a fork naming a
 * registry it is allowed to use - so this reads the urls, and the field itself is allowed.
 *
 * ⚠️ A url with a placeholder in its host (`https://{publisher}.gallerycdn.vsassets.io/...`) is not
 * a url `URL` will parse, so the host is taken by hand rather than by constructor.
 */
export function namesMicrosoftGallery(gallery: IExtensionsGallery | undefined): boolean {
	if (!gallery) {
		return false;
	}

	const urls = [gallery.serviceUrl, gallery.itemUrl, gallery.resourceUrlTemplate, gallery.controlUrl, gallery.nlsBaseUrl];

	return urls.some(url => {
		if (typeof url !== 'string' || url.length === 0) {
			return false;
		}

		// scheme, then everything up to the first `/`, `?` or `#`, then drop any userinfo and port
		const host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0].split('@').pop()!.split(':')[0];

		return MICROSOFT_GALLERY_HOSTS.test(host);
	});
}
