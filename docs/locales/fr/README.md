<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Exécutez des agents de programmation IA sur vos machines.**

Facade Code exécute plusieurs CLI de programmation IA sur vos machines. Les agents peuvent se trouver, échanger des messages, lire des écrans et saisir du texte dans les terminaux. Dirigez-les dans le Shell, VS Code ou une application compatible MCP. Chaque machine exécute son propre Orchestrator et les machines se connectent par SSH.

[![Site web: facadecode.com](https://img.shields.io/badge/Site%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: installer](https://img.shields.io/badge/VS%20Code%20Marketplace-installer-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: installer](https://img.shields.io/badge/Open%20VSX-installer-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: signaler un bug](https://img.shields.io/badge/Issues-signaler%20un%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · **Français** · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Regardez la démonstration de 2 minutes sur facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Installation

### Shell

Les commandes d’installation en une ligne sont disponibles à partir de la première version qui inclut les paquets autonomes.
Les paquets Shell couvrent macOS, Linux et Windows sur x64 et arm64.

Exécutez cette commande sous macOS ou Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Sous Windows, exécutez cette commande dans PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Le programme d’installation ajoute `facade` et `facade-mcp` au PATH. Ouvrez un nouveau terminal pour utiliser le PATH mis à jour. Mettez à jour avec `facade upgrade`. Installez les CLI nécessaires et connectez-vous sur chaque machine. Les CLI intégrées sont Claude Code, Codex, Antigravity, Muse Code, OpenCode et Pi.

Son lanceur s’appelle aussi `facade`. Si les deux sont installés, le shell utilise le premier `facade` du PATH. Après le retrait de l’aperçu, ce nom de commande revient à Orchestrator. Exécutez `facade version`. Une ligne au format `facade <version>` confirme que vous utilisez la commande Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

L’extension embarque son Orchestrator. Ouvrez **Facade Code** dans la barre d’activité, puis choisissez **Nouvel agent**, **Go to Agent** ou **Resume Agent**. Les paquets macOS, Linux et Windows existent pour x64 et arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Ajoutez `facade-mcp` comme serveur MCP stdio. L’exemple utilise un objet `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Une connexion externe rejoint le réseau en tant que Guest lors de son premier appel d’outil. Après l’envoi, attendez la réponse avec l’appel `read_messages` renvoyé par `send_message`.

## Travailler sur plusieurs machines

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Utilisez l’adresse affichée par `facade list`. Enregistrez les autres machines avec votre cible et vos options SSH habituelles. Pour joindre WSL ou un Dev Container depuis l’extérieur, configurez SSH dans l’environnement et enregistrez-le de la même manière. Vous pouvez aussi y exécuter Facade directement.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --folder /work/app --worktree feat-x claude
```

Facade installe au besoin la version correspondante sur la machine distante. Facade utilise le chemin d’installation fixe sur la machine distante. Pour une installation manuelle, utilisez la même version que votre Orchestrator local. Dans VS Code, **Go to Agent** ouvre le terminal d’un agent actif. L’espace de travail mémorise les agents ouverts, leurs assistants et vos Pins. Fermer l’onglet du terminal laisse l’agent travailler. **Resume Agent** et `facade resume` proposent le travail enregistré.

> **YOLO est activé par défaut.** Un agent avec YOLO actif peut atteindre les autres agents sur les machines connectées. Définissez `"yolo": false` dans le `facade.json` de sa machine pour conserver les autorisations et le bac à sable de la CLI et limiter MCP à l’arbre de création de l’appelant. Le changement s’applique au prochain démarrage ou resume. `facade status` indique le chemin du fichier.

[Documentation du produit (中文)](../../facade-code.md) · [Glossaire](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Plusieurs projets. Une seule fenêtre.**

Organisez vos projets, vos worktrees de fonctionnalités et vos équipes d'agents dans une barre d'espace de travail dédiée. Basculez entre vos projets avec leurs fichiers et terminaux associés, pendant que les agents continuent de travailler en arrière-plan.

Téléchargez la préversion de l'IDE : [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Toutes les versions](https://github.com/y5ez3g/facadecode/releases)

L’aperçu de l’IDE utilise ses propres paramètres et extensions à côté de votre éditeur. Ses extensions proviennent d'[Open VSX](https://open-vsx.org) ; quelques extensions propriétaires de Microsoft, telles que Remote Development et C/C++, fonctionnent uniquement sur les versions officielles de Microsoft. L'architecture et les spécifications sont détaillées dans [`docs/ide/`](../../ide/).

## Compilation depuis les sources

- **Extension :** Fournissez [`extension/AGENTS.md`](../../../extension/AGENTS.md) à votre agent de code pour compiler le package.
- **Orchestrator / Shell.** [Instructions de compilation](../../../core/README.md).
- **IDE :** Fournissez [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) à votre agent de code pour compiler l'application.

Pour consulter les directives de contribution et la discipline relative aux branches, reportez-vous à [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) et [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Retours

- **Bugs et idées** : [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), ou **Aide > Signaler un problème** dans l'IDE.
- **Vulnérabilités de sécurité** : Veuillez les signaler de manière privée conformément à [`SECURITY.md`](../../../SECURITY.md).

## Licence

MIT, identique à la version amont de VS Code. Consultez [`LICENSE.txt`](../../../LICENSE.txt) pour prendre connaissance de la notice de copyright de Microsoft et des avis des contributeurs de Facade Code.

<sub>Facade Code est un produit indépendant qui n'est ni affilié, ni approuvé, ni sponsorisé par les fournisseurs des outils tiers présentés. Toutes les marques et tous les logos de tiers appartiennent à leurs propriétaires respectifs.</sub>
