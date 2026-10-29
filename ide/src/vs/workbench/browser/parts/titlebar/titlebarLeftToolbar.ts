/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/titlebarLeftToolbar.css';
import { MenuId } from '../../../../platform/actions/common/actions.js';

/**
 * The actions at the front of the title bar, ahead of the menus: at the window's left edge on
 * Windows and Linux, and just past the traffic lights on macOS. The main window's title bar only.
 *
 * ⚠️ `FacadeTitleBarLeft`, not `TitleBarLeft`. A menu id is a string and `MenuId` refuses a second
 * one with the same name, so a plain name is one upstream can take tomorrow and break us with.
 */
export const TitleBarLeftMenu = new MenuId('FacadeTitleBarLeft');
