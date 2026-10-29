/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { parse } from '../../../../base/common/json.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { language, platformLocale } from '../../../../base/common/platform.js';
import { format } from '../../../../base/common/strings.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionManagementService, ILocalExtension } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType, ILocalizationContribution } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';
import { bilingual, BuiltInPackIdPrefix, isDisplayLanguageChosen, packLocaleFor, SuggestDisplayLanguageSettingId } from '../common/facadeLocalization.js';

/** The display languages a person answered Don't Show Again for, on this machine. */
const DeclinedStorageKey = 'facade.localization.suggestionDeclined';

/** This file's module id, under which a pack holds the suggestion's own words. */
const ModuleId = 'vs/workbench/contrib/facadeLocalization/electron-browser/facadeLocalization.contribution';

interface IBuiltInPack {
	readonly extension: ILocalExtension;
	readonly localization: ILocalizationContribution;
}

/**
 * Asks once per start, in the operating system's language and in English, whether to switch to its
 * built-in pack, while no display language has been chosen (LOCALIZATION.md LC4).
 */
class DisplayLanguageSuggestion extends Disposable {

	static readonly ID = 'workbench.contrib.facadeDisplayLanguageSuggestion';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IFileService private readonly fileService: IFileService,
		@ILocaleService private readonly localeService: ILocaleService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProductService private readonly productService: IProductService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.suggest().catch(onUnexpectedError);
	}

	private async suggest(): Promise<void> {
		if (!this.configurationService.getValue<boolean>(SuggestDisplayLanguageSettingId) || language !== 'en' || await this.isLocaleChosen()) {
			return;
		}
		const packs = new Map<string, IBuiltInPack>();
		for (const extension of await this.extensionManagementService.getInstalled(ExtensionType.System)) {
			if (extension.identifier.id.toLowerCase().startsWith(BuiltInPackIdPrefix)) {
				for (const localization of extension.manifest.contributes?.localizations ?? []) {
					packs.set(localization.languageId.toLowerCase(), { extension, localization });
				}
			}
		}
		const locale = packLocaleFor(platformLocale, [...packs.keys()]);
		const declined = this.declined();
		if (!locale || declined.includes(locale)) {
			return;
		}

		const { extension, localization } = packs.get(locale)!;
		const translations = await this.ownTranslations(extension, localization);
		const product = this.productService.nameLong;
		const nativeName = localization.localizedLanguageName ?? localization.languageName ?? locale;
		const englishName = localization.languageName ?? locale;
		const text = (key: string, english: string, ...args: string[]) => bilingual(translations[key] !== undefined ? format(translations[key], ...args) : undefined, english);

		this.notificationService.prompt(
			Severity.Info,
			text('suggestDisplayLanguage', localize('suggestDisplayLanguage', "{0} is also available in {1}. Change the display language and restart?", product, englishName), product, nativeName),
			[{
				label: text('changeAndRestart', localize('changeAndRestart', "Change and Restart")),
				run: () => this.localeService.setLocale({ id: locale, label: nativeName, extensionId: extension.identifier.id }, true),
			}, {
				label: text('dontShowAgain', localize('dontShowAgain', "Don't Show Again")),
				isSecondary: true,
				run: () => this.storageService.store(DeclinedStorageKey, JSON.stringify([...declined, locale]), StorageScope.APPLICATION, StorageTarget.MACHINE),
			}],
			// It stays until answered, as VS Code's question after a language pack is installed does.
			{ sticky: true, priority: NotificationPriority.URGENT }
		);
	}

	/** Whether a display language was chosen, in `argv.json` or with `--locale`: English included, it is never questioned. */
	private async isLocaleChosen(): Promise<boolean> {
		let argv: unknown;
		try {
			argv = parse((await this.fileService.readFile(this.environmentService.argvResource)).value.toString());
		} catch {
			argv = undefined;
		}
		return isDisplayLanguageChosen(argv, this.environmentService.args.locale);
	}

	private declined(): string[] {
		try {
			const value = JSON.parse(this.storageService.get(DeclinedStorageKey, StorageScope.APPLICATION, '[]'));
			return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		} catch {
			return [];
		}
	}

	/** This file's strings as `localization`'s pack translates them, so the question is asked in it. */
	private async ownTranslations(extension: ILocalExtension, localization: ILocalizationContribution): Promise<Record<string, string>> {
		const main = localization.translations.find(translation => translation.id === 'vscode');
		if (!main) {
			return {};
		}
		try {
			const file = await this.fileService.readFile(joinPath(extension.location, main.path));
			return JSON.parse(file.value.toString()).contents?.[ModuleId] ?? {};
		} catch (error) {
			onUnexpectedError(error);
			return {};
		}
	}
}

registerWorkbenchContribution2(DisplayLanguageSuggestion.ID, DisplayLanguageSuggestion, WorkbenchPhase.Eventually);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[SuggestDisplayLanguageSettingId]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('suggestDisplayLanguageSetting', "Controls whether, while no display language has been chosen, the window offers to switch to the operating system's language when it has a built-in language pack for it."),
		},
	},
});
