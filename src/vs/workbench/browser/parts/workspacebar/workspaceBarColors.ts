/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { ACTIVITY_BAR_ACTIVE_BORDER, ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND } from '../../../common/theme.js';

/**
 * The bar's own colours: the side bar's, taken whole.
 *
 * ⚠️ The side bar's, because that is what is next to it - the activity bar has moved into the title
 * bar, so `EXPLORER` and its rows are what a reader compares these rows to, eight pixels away.
 *
 * ⚠️ Taken whole. The background, the ink and the title ink are one set the theme tuned together,
 * and nothing here is derived from them: a bar that derives its own ink has to re-answer, for every
 * theme, a question the theme already answered. So a row's name is not styled by this bar at all -
 * it inherits, which is what the explorer's rows do, which is why the two come out the same.
 */
/*
 * ⚠️ The activity bar's surface, whole. This column sits against that one, and a side bar's
 * background under an activity bar's ink is half of each - the two columns then differ by a shade
 * nobody chose, which is how they came to look like two programs. Adopting one surface means
 * adopting its background, its foreground, its quiet foreground and its border together: every
 * theme picks those four as a set, and mixing a quiet ink from one set with a background from
 * another is a contrast ratio no theme author ever looked at.
 */
export const FACADE_BAR_BACKGROUND = registerColor('facadeBar.background',
	ACTIVITY_BAR_BACKGROUND,
	localize('facadeBarBackground', "Background color of the workspace bar, the column of folders along the left edge of the window."));

export const FACADE_BAR_FOREGROUND = registerColor('facadeBar.foreground',
	ACTIVITY_BAR_FOREGROUND,
	localize('facadeBarForeground', "Foreground color of the workspace bar."));

/**
 * The ink a row that the window is **not** on is drawn in.
 *
 * ⚠️ `ACTIVITY_BAR_INACTIVE_FOREGROUND`, because this bar now marks its row the way the activity
 * bar marks its item - a line down the leading edge and a difference in ink, with nothing painted
 * behind it. Taking the activity bar's quiet ink and not the active one is taking half a pair: the
 * two are chosen together by every theme, and a quiet ink from one pair against a bright one from
 * another is a contrast ratio nobody measured.
 */
export const FACADE_BAR_INACTIVE_FOREGROUND = registerColor('facadeBar.inactiveForeground',
	ACTIVITY_BAR_INACTIVE_FOREGROUND,
	localize('facadeBarInactiveForeground', "Foreground color of inactive rows in the workspace bar."));

/**
 * The line down the leading edge of the row the window is on.
 *
 * ⚠️ `activityBar.activeBorder`, so that whatever a theme does to the column beside this one
 * happens here too. Themes override it: Dark Modern paints it blue and gives its items no block at
 * all, while others leave it as the foreground and do paint one. Picking a colour here instead -
 * or inventing a block where a theme leaves none - is what made the two columns disagree in every
 * theme but the one that happened to be on the screen at the time.
 */
export const FACADE_BAR_ACTIVE_BORDER = registerColor('facadeBar.activeBorder',
	ACTIVITY_BAR_ACTIVE_BORDER,
	localize('facadeBarActiveBorder', "Color of the active indicator on the current folder row in the workspace bar."));

export const FACADE_BAR_TITLE_FOREGROUND = registerColor('facadeBar.titleForeground',
	ACTIVITY_BAR_FOREGROUND,
	localize('facadeBarTitleForeground', "Foreground color of the workspace bar header."));

export const FACADE_BAR_BORDER = registerColor('facadeBar.border',
	ACTIVITY_BAR_BORDER,
	localize('facadeBarBorder', "Border color separating the workspace bar from adjacent views."));

/**
 * The ten colours a folder can be tagged with.
 *
 * ⚠️ Written down here, not pointed at another token, and that is the opposite of what every colour
 * above this line does. The difference is what the colour *is*. The ones above are a **surface** -
 * this column's background, its ink, the line down its marked row - and a theme has an opinion about
 * every one of them, so taking anything but the theme's own answer is inventing a shade nobody
 * chose. These ten are a **label somebody stuck on their own folder**. No theme has an opinion about
 * what colour a person's tag for `~/work/api` should be, so there is nothing to inherit, and
 * following the theme means the colour a person picked is not the colour they get.
 *
 * ⚠️ `charts.*` is what these were, and it was wrong twice over. `charts.orange` is not an ink: it
 * is an alias of `minimapFindMatch`, the FILL behind a search hit in the minimap, which is
 * translucent by construction - `rgba(234, 92, 0, 0.33)` - and undefined in both high-contrast
 * themes, where the minimap has no find colour. Measured, the orange tag came out at 1.17-2.83
 * against this column in seventeen themes, and in the other two it painted nothing at all: picking
 * orange and picking no colour gave the same folder. In Abyss and Quiet Light it was not even
 * orange, because their find highlight is grey and pink. WORKSPACE.md section 7.4.
 *
 * ⚠️ Ten, and the four that came after the first six - lime, teal, indigo, pink - sit in the gaps
 * those six left on the hue wheel: yellow to green, green to blue, blue to purple, purple back to
 * red. Placed there so no tag is a shade of another, and picked the same way, so all ten come out at
 * the same worst case.
 *
 * ⚠️ **One value each**, and no per-theme-kind branch. A tag is not a surface, so it does not
 * change with the theme. Each lightness is the one whose worst case across every surface this glyph
 * can land on - the column's background in nineteen themes, and the block behind the marked row - is
 * as high as a single value can make it: 2.90. It cannot reach 3.0, because those surfaces fall in
 * two clusters with a gap, and one value would have to be at once brighter than L=0.2068 (to clear
 * Monokai Dimmed) and darker than L=0.1908 (to clear Light 2026's marked row). WORKSPACE.md
 * section 7.4.
 *
 * ⚠️ **And one state.** A second, quieter variant was tried - the same colour at 55% on a row at
 * rest, full under the pointer - so the glyph would brighten with its name. On a glyph drawn as a
 * one-pixel outline the two states are barely a difference, which is what that measurement missed by
 * only checking the ratio. The row's states are said with the row's **background** instead, the way
 * the explorer says them, and the tag keeps its colour throughout. A tag that changes shade is also
 * answering a question nobody asked it: which folder is live is the row's business, not the
 * colour's.
 */
function folderColor(id: string, value: string, description: string) {
	return registerColor(`facadeBar.folder${id}`, value, description);
}

export const FACADE_FOLDER_RED = folderColor('Red', '#DD443F',
	localize('facadeBarFolderRed', "The red accent color for folders in the workspace bar."));

export const FACADE_FOLDER_ORANGE = folderColor('Orange', '#C26016',
	localize('facadeBarFolderOrange', "The orange accent color for folders in the workspace bar."));

export const FACADE_FOLDER_YELLOW = folderColor('Yellow', '#9A760A',
	localize('facadeBarFolderYellow', "The yellow accent color for folders in the workspace bar."));

export const FACADE_FOLDER_LIME = folderColor('Lime', '#618720',
	localize('facadeBarFolderLime', "The lime accent color for folders in the workspace bar."));

export const FACADE_FOLDER_GREEN = folderColor('Green', '#2C8C46',
	localize('facadeBarFolderGreen', "The green accent color for folders in the workspace bar."));

export const FACADE_FOLDER_TEAL = folderColor('Teal', '#208986',
	localize('facadeBarFolderTeal', "The teal accent color for folders in the workspace bar."));

export const FACADE_FOLDER_BLUE = folderColor('Blue', '#277CDC',
	localize('facadeBarFolderBlue', "The blue accent color for folders in the workspace bar."));

export const FACADE_FOLDER_INDIGO = folderColor('Indigo', '#7B6CD8',
	localize('facadeBarFolderIndigo', "The indigo accent color for folders in the workspace bar."));

export const FACADE_FOLDER_PURPLE = folderColor('Purple', '#A15FC7',
	localize('facadeBarFolderPurple', "The purple accent color for folders in the workspace bar."));

export const FACADE_FOLDER_PINK = folderColor('Pink', '#CA4A9B',
	localize('facadeBarFolderPink', "The pink accent color for folders in the workspace bar."));

/**
 * The agents' colour: the `+N` of agents past a row's logos, the dot a row with agents carries while
 * the bar is collapsed to its icons, and the count on the title bar's agent button (WORKTREE.md
 * WT-1.15).
 *
 * ⚠️ A colour of its own rather than the badges'. The default themes (`Dark 2026`, `Light 2026`) give
 * `badge.background` and `activityBarBadge.background` one blue, which a closed repository's
 * worktree count already is, and the agents would read as more of the same count.
 *
 * ⚠️ Green, the workbench's "passed, started, running" (`testing.iconPassed`, the debug start
 * button); orange is its "warning, modified", and Claude's logo beside it. Darker than the folder
 * green, so that 11px white text clears 4.5:1 on it (4.97; the folder green gives 4.25).
 */
export const FACADE_AGENT_BADGE_BACKGROUND = registerColor('facadeAgentBadge.background',
	'#23803C',
	localize('facadeAgentBadgeBackground', "Background color of agent badge indicators on workspace rows and the title bar agent button."));

export const FACADE_AGENT_BADGE_FOREGROUND = registerColor('facadeAgentBadge.foreground',
	'#FFFFFF',
	localize('facadeAgentBadgeForeground', "Foreground color of agent badge counts."));
