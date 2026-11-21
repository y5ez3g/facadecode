<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Запускайте ИИ-агентов для программирования на своих компьютерах.**

Facade Code запускает несколько ИИ-инструментов программирования с интерфейсом командной строки на ваших компьютерах. Агенты могут находить друг друга, обмениваться сообщениями, читать экраны и вводить текст в терминалы. Управляйте ими из Shell, VS Code или приложения с поддержкой MCP. На каждой машине работает собственный Orchestrator, а машины соединяются по SSH.

[![Сайт: facadecode.com](https://img.shields.io/badge/Сайт-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: установить](https://img.shields.io/badge/VS%20Code%20Marketplace-установить-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: установить](https://img.shields.io/badge/Open%20VSX-установить-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Проблемы: сообщить об ошибке](https://img.shields.io/badge/Проблемы-сообщить%20об%20ошибке-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · **Русский** · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Посмотрите 2-минутное демо на facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Установка

### Shell

Однострочные команды установки доступны с первого выпуска, в котором есть отдельные пакеты.
Пакеты для Shell доступны для macOS, Linux и Windows на x64 и arm64.

В macOS или Linux выполните эту команду.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

В Windows выполните эту команду в PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Установщик добавляет `facade` и `facade-mcp` в PATH. Откройте новый терминал, чтобы применить обновлённый PATH. Для обновления выполните `facade upgrade`. Установите нужные CLI и войдите в них на каждой машине. Встроенные варианты включают Claude Code, Codex, Antigravity, Muse Code, OpenCode и Pi.

Её команда запуска тоже называется `facade`. Если установлены обе программы, Shell запускает первую найденную в PATH. После прекращения выпуска IDE имя команды останется за Orchestrator. Выполните `facade --version`. Строка в формате `facade <version>` подтверждает, что используется команда Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

В расширение входит Orchestrator. Откройте **Facade Code** на панели действий и выберите **Новый агент**, **Go to Agent** или **Resume Agent**. Пакеты для macOS, Linux и Windows собираются для x64 и arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Добавьте `facade-mcp` как сервер MCP со стандартным вводом и выводом. В примере используется объект `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Внешнее соединение входит как Guest при первом вызове инструмента. Отправив сообщение, дождитесь ответа с помощью вызова `read_messages`, возвращённого `send_message`.

## Работа на нескольких машинах

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Используйте адрес из вывода `facade list`. Зарегистрируйте другую машину с обычной целью и параметрами SSH. Для подключения к WSL или Dev Container извне настройте SSH внутри среды и зарегистрируйте её тем же способом. Facade можно запустить и непосредственно в этой среде.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade при необходимости устанавливает подходящую версию на удалённой машине. На удалённой машине Facade использует фиксированный путь установки. При ручной установке берите ту же версию, что у локального Orchestrator. В VS Code команда **Go to Agent** открывает терминал запущенного агента. Рабочая область запоминает открытых агентов, их помощников и ваши Pins. При закрытии вкладки терминала агент продолжает работу. **Resume Agent** и `facade resume` показывают сохранённую работу.

> **YOLO включён по умолчанию.** Агент с YOLO может обращаться к другим агентам на подключённых машинах. Укажите `"yolo": false` в `facade.json` его машины, чтобы сохранить подтверждения и песочницу CLI и ограничить MCP деревом создания вызывающего агента. Изменение действует при следующем запуске или resume. Команда `facade status` показывает путь к файлу.

[Документация продукта (на английском)](../../PRODUCT.md) · [Глоссарий](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Несколько проектов. Одно окно.**

Организуйте проекты, рабочие деревья фич и команды агентов на специальной панели рабочей области. Переключайтесь между проектами с их файлами и терминалами, пока агенты продолжают работать в фоновом режиме.

Скачайте превью IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Все релизы](https://github.com/y5ez3g/facadecode/releases)

Предварительная версия IDE устанавливается рядом с вашим редактором и использует собственные настройки и расширения. Расширения загружаются из [Open VSX](https://open-vsx.org); некоторые проприетарные расширения Microsoft (такие как Remote Development и C/C++) работают только в официальных сборках Microsoft. Архитектура и спецификации находятся в [`docs/ide/`](../../ide/).

## Сборка из исходного кода

- **Расширение:** передайте [`extension/AGENTS.md`](../../../extension/AGENTS.md) вашему агенту-разработчику для сборки пакета.
- **Orchestrator / Shell.** [Инструкции по сборке](../../../core/README.md).
- **IDE:** передайте [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) вашему агенту-разработчику для сборки приложения.

Руководство по внесению вклада и правила работы с ветками см. в [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) и [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Обратная связь

- **Ошибки и идеи:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) или **Справка > Сообщить о проблеме** в IDE.
- **Уязвимости безопасности:** пожалуйста, сообщайте о них конфиденциально в соответствии с [`SECURITY.md`](../../../SECURITY.md).

## Лицензия

MIT, как и у вышестоящего VS Code. Уведомление об авторских правах Microsoft и авторов Facade Code см. в файле [`LICENSE.txt`](../../../LICENSE.txt).

<sub>Facade Code является независимым продуктом и не связан с поставщиками указанных сторонних инструментов, не одобрен ими и не спонсируется ими. Все сторонние товарные знаки и логотипы принадлежат их соответствующим владельцам.</sub>
