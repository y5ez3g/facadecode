/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { isICommandActionToggleInfo } from '../../../../../platform/action/common/action.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ActivitybarPart } from '../../../../browser/parts/activitybar/activitybarPart.js';
import { SidebarPart } from '../../../../browser/parts/sidebar/sidebarPart.js';
import { getTitlebarCompositeBarOptions } from '../../../../browser/parts/titlebar/titlebarCompositeBar.js';
import '../../../../common/facadeDefaults.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings } from '../../../../services/layout/browser/layoutService.js';
import { TestLayoutService, workbenchInstantiationService } from '../../workbenchTestServices.js';

const LOCATIONS = [ActivityBarPosition.DEFAULT, ActivityBarPosition.TOP, ActivityBarPosition.BOTTOM, ActivityBarPosition.TOOLBAR, ActivityBarPosition.HIDDEN];

class TestViewDescriptorService extends mock<IViewDescriptorService>() {
	override readonly onDidChangeViewContainers = Event.None;
	override readonly onDidChangeContainerLocation = Event.None;

	override getDefaultViewContainer(_location: ViewContainerLocation) {
		return undefined;
	}

	override getViewContainersByLocation(_location: ViewContainerLocation) {
		return [];
	}
}

suite('Activity bar at `toolbar` (ACTIVITY-BAR.md)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-45 the context menu offers the five locations, the one in use checked', () => {
		const items = MenuRegistry.getMenuItems(MenuId.ActivityBarPositionMenu).filter(isIMenuItem).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		const checkedAt = (location: string) => {
			const context: IContext = { getValue: <T>(key: string) => (key === `config.${LayoutSettings.ACTIVITY_BAR_LOCATION}` ? location : undefined) as T };
			return items.filter(item => {
				const toggled = item.command.toggled;
				const condition = isICommandActionToggleInfo(toggled) ? toggled.condition : toggled;
				return condition?.evaluate(context);
			}).map(item => item.command.id);
		};

		assert.deepStrictEqual({
			offered: items.map(item => item.command.id),
			checked: LOCATIONS.map(checkedAt)
		}, {
			offered: ['default', 'top', 'bottom', 'toolbar', 'hide'].map(name => `workbench.action.activityBarLocation.${name}`),
			checked: ['default', 'top', 'bottom', 'toolbar', 'hide'].map(name => [`workbench.action.activityBarLocation.${name}`])
		});
	});

	test('WS-45 at `toolbar` the side bar draws neither an icon strip nor the activity bar column', () => {
		const drawn = LOCATIONS.map(location => {
			const instantiationService = workbenchInstantiationService(undefined, store);
			instantiationService.stub(IWorkbenchLayoutService, new TestLayoutService());
			instantiationService.stub(IViewDescriptorService, new TestViewDescriptorService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService({ [LayoutSettings.ACTIVITY_BAR_LOCATION]: location }));
			const part = store.add(instantiationService.createInstance(SidebarPart));
			const decisions = part as unknown as { shouldShowCompositeBar(): boolean; shouldShowActivityBar(): boolean };
			const result = { location, strip: decisions.shouldShowCompositeBar(), column: decisions.shouldShowActivityBar() };
			part.dispose();
			return result;
		});

		assert.deepStrictEqual(drawn, [
			{ location: ActivityBarPosition.DEFAULT, strip: false, column: true },
			{ location: ActivityBarPosition.TOP, strip: true, column: false },
			{ location: ActivityBarPosition.BOTTOM, strip: true, column: false },
			{ location: ActivityBarPosition.TOOLBAR, strip: false, column: false },
			{ location: ActivityBarPosition.HIDDEN, strip: false, column: false },
		]);
	});

	test('WS-46 the icons in the title bar keep the activity bar\'s pinned, hidden and ordered state, so it survives a move between locations', () => {
		const unused = <T>() => undefined as unknown as T;
		const options = getTitlebarCompositeBarOptions(unused(), unused(), unused(), unused(), unused());

		assert.deepStrictEqual(
			[options.pinnedViewContainersKey, options.placeholderViewContainersKey, options.viewContainersWorkspaceStateKey],
			[ActivitybarPart.pinnedViewContainersKey, ActivitybarPart.placeholderViewContainersKey, ActivitybarPart.viewContainersWorkspaceStateKey]);
	});

	test('WS-47 a fresh profile starts with the secondary side bar hidden, where upstream shows it', () => {
		// Read back out of the registry, which importing facadeDefaults fills: a default that did not
		// land reads as upstream's here
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();

		assert.strictEqual(overrides.get('workbench.secondarySideBar.defaultVisibility')?.value, 'hidden');
	});
});
