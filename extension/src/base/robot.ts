/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Facade's robots (CONFIGURATION-2.4): round faces in a gradient with two eyes. An entry shows one by `"icon": "facade-<robot>"`, and
// a program without an icon shows facade-pearl. scripts/robot-icons.py draws each twice: `media/agents/robot-<robot>.svg`,
// the image cards and pickers show, and a glyph of `media/robots.woff`, the icon `facade-robot-<robot>` a terminal tab shows.

/** The robots, in the order of their glyphs in `media/robots.woff` from U+E200: scripts/robot-icons.py's ROBOTS. */
export const ROBOTS: readonly string[] = [
	'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink', 'aurora', 'sunset', 'ocean', 'orchid', 'pearl', 'graphite'
];

/** How `icon` names a robot: `facade-sky`. */
const ROBOT_PREFIX = 'facade-';

/** Every robot as `icon` names it, in their order: `facade-red` to `facade-graphite`. */
export const ROBOT_ICONS: readonly string[] = ROBOTS.map(robot => `${ROBOT_PREFIX}${robot}`);

/** The robot the icon `icon` is - `sky` for `facade-sky` - or none for any other icon. */
export function robotOf(icon: string): string | undefined {
	return ROBOT_ICONS.includes(icon) ? icon.slice(ROBOT_PREFIX.length) : undefined;
}

/** The icon a program - an entry of type `custom` - shows without one of its own (CONFIGURATION-2.4): the whitest robot. */
export const PROGRAM_ICON = 'facade-pearl';
