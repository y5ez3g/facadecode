/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

/** Loads the compiled adapters with their outside world supplied, without changing Node's shared module cache. */
export function withModules(modules: Readonly<Record<string, unknown>>): <T>(file: string) => T {
	const cache = new Map<string, { exports: unknown }>();
	function load<T>(file: string): T {
		const cached = cache.get(file);
		if (cached) {
			return cached.exports as T;
		}
		const loaded = { exports: {} as unknown };
		cache.set(file, loaded);
		const requireAt = createRequire(file);
		const requireWith = (id: string) => Object.hasOwn(modules, id) ? modules[id] : id.startsWith('.') ? load(requireAt.resolve(id)) : requireAt(id);
		new Function('require', 'module', 'exports', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(requireWith, loaded, loaded.exports, file, path.dirname(file));
		return loaded.exports as T;
	}
	return load;
}

/** The event shape the adapters use, with no extension host or running window behind it. */
export class TestEmitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void) => {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	};
	fire(value: T): void { this.listeners.forEach(listener => listener(value)); }
	dispose(): void { this.listeners.clear(); }
}
