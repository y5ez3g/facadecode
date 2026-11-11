<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**L'orchestrateur multi-agents pour VS Code.**

Exécutez des CLI natives d'agents, modifiez du code et relisez les modifications dans la même fenêtre d'IDE. Utilisez vos propres comptes et abonnements, et laissez les agents collaborer entre fenêtres et machines.

[![Site web: facadecode.com](https://img.shields.io/badge/Site%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: installer](https://img.shields.io/badge/VS%20Code%20Marketplace-installer-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: installer](https://img.shields.io/badge/Open%20VSX-installer-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: télécharger l'IDE](https://img.shields.io/badge/Releases-t%C3%A9l%C3%A9charger%20l%27IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: signaler un bug](https://img.shields.io/badge/Issues-signaler%20un%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · **Français** · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![Regardez la démonstration de 2 minutes sur facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Installation

```sh
code --install-extension facade.facadecode
```

Ou installez **Facade Code** depuis le [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) ou [Open VSX](https://open-vsx.org/extension/facade/facadecode). Il fonctionne sous macOS (Apple silicon), Linux (x64) et Windows (x64).

Ensuite, installez les CLI d'agents prises en charge que vous prévoyez d'utiliser et connectez-vous-y : Claude Code, Codex, Antigravity, Muse Code, OpenCode ou Pi. Facade Code démarre chaque CLI en utilisant ses propres identifiants et abonnements.

> **Les agents s'exécutent sans invite d'approbation par défaut.** Avec `yolo` activé par défaut, les agents peuvent exécuter des commandes et modifier des fichiers sans demander confirmation au préalable. Désactivez-le pour rétablir les invites d'approbation standard de chaque CLI. Consultez l'[extension README](../../../extension/README.md#install).

## Agent Panel

**Vos agents et votre IDE, dans la même fenêtre.**

Facade Code exécute les CLI natives d'agents (Claude Code, Codex, Antigravity, Muse Code, OpenCode et Pi) dans des onglets de terminal d'éditeur aux côtés de vos fichiers, en s'appuyant sur les commandes, les outils, les comptes et les abonnements propres à chaque CLI. Une carte dans le panneau suit l'état de chaque agent.

- **Travaillez aux côtés de votre code.** Chaque agent tourne dans son propre onglet de terminal au sein de la zone d'édition. Fermer un onglet le masque sans interrompre l'agent ; cliquer sur sa carte l'affiche à nouveau.
- **Suivez l'état de l'ensemble des agents.** Les cartes indiquent ce qui a été envoyé en dernier à chaque agent et s'il travaille, attend une autorisation ou a rencontré une erreur, avec des détails affichant son titre, son dossier et qui l'a lancé. Les agents continuent de fonctionner lors des rechargements de fenêtre et des redémarrages de l'extension.
- **Dossiers et worktrees.** Exécutez des agents dans n'importe quel dossier de l'espace de travail ou créez un worktree Git à la volée pour isoler les modifications de code. Épinglez une conversation pour la restaurer à la réouverture de l'espace de travail, ou reprenez des sessions passées depuis l'historique.

## Agent Use

**Laissez les agents piloter d'autres agents, exactement comme vous.**

Grâce à MCP et à un protocole de terminal, les agents peuvent démarrer, arrêter, trouver et contacter d'autres agents, lire leurs écrans de terminal, taper du texte et appuyer sur des touches.

- **Démarrer et arrêter des agents.** Un agent peut démarrer d'autres agents avec n'importe laquelle des six CLI, dans n'importe quel dossier ou nouveau worktree de vos fenêtres Facade sur cet ordinateur, et leur confier leur première tâche. Une requête réessayée avec le même identifiant de requête ne démarre jamais un deuxième agent.
- **Envoyer des messages.** Les agents échangent des messages entre eux et peuvent vous envoyer des messages. Facade colle le message entier en une seule fois et l'envoie. Si du texte non envoyé ou une question d'invite bloque la saisie, la transmission attend que la saisie soit libre.
- **Contrôle du terminal.** Un agent peut lire l'écran d'un autre agent, taper des commandes et appuyer sur des touches pour répondre aux invites ou débloquer un pair. Lorsqu'un agent enfant attend une autorisation, une réponse ou une connexion pendant 20 secondes, l'agent qui l'a démarré est averti.

## Agent Mesh

**Connectez des agents entre fenêtres, machines et environnements.**

Facade Code connecte les agents de toutes vos fenêtres Facade sur cet ordinateur au sein d'un même réseau. Ouvrez une fenêtre [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) pour étendre cette collaboration à une autre machine.

- **Entre les fenêtres.** Avec `yolo` activé, un agent peut joindre tous les agents de vos fenêtres Facade sur cet ordinateur, qu'ils soient locaux ou issus de Remote - SSH. Lorsqu'il est désactivé, un agent ne peut joindre que son propre groupe : l'agent que vous avez démarré et ceux lancés à partir de lui.
- **Étendre via SSH.** Dans une fenêtre [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), les agents tournent directement sur la machine distante avec les outils, fichiers et comptes présents sur place. Les agents locaux peuvent démarrer des agents et leur envoyer des messages directement dans les fenêtres Remote - SSH.
- **Coordonner depuis votre téléphone.** Connectez l'application mobile Claude à une session Claude Code sur votre ordinateur à l'aide de [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Cette session peut coordonner d'autres agents via Facade et transmettre l'avancement directement sur votre téléphone.

<sub>Remote Control nécessite une version prise en charge de Claude Code, un abonnement éligible et une connexion avec étendue complète. Consultez ses [conditions de configuration](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Plusieurs projets. Une seule fenêtre.**

Organisez vos projets, vos worktrees de fonctionnalités et vos équipes d'agents dans une barre d'espace de travail dédiée. Basculez entre vos projets avec leurs fichiers et terminaux associés, pendant que les agents continuent de travailler en arrière-plan.

Téléchargez la préversion de l'IDE : [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Toutes les versions](https://github.com/y5ez3g/facadecode/releases)

L'IDE est un fork de VS Code qui s'installe aux côtés de votre éditeur existant sans rien partager avec lui : les paramètres, les extensions et la commande `facade` sont totalement indépendants. Ses extensions proviennent d'[Open VSX](https://open-vsx.org) ; quelques extensions propriétaires de Microsoft, telles que Remote Development et C/C++, fonctionnent uniquement sur les versions officielles de Microsoft. L'architecture et les spécifications sont détaillées dans [`docs/ide/`](../../ide/).

## Compilation depuis les sources

- **Extension :** Fournissez [`extension/AGENTS.md`](../../../extension/AGENTS.md) à votre agent de code pour compiler le package.
- **IDE :** Fournissez [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) à votre agent de code pour compiler l'application.

Pour consulter les directives de contribution et la discipline relative aux branches, reportez-vous à [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) et [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Retours

- **Bugs et idées** : [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), ou **Aide > Signaler un problème** dans l'IDE.
- **Vulnérabilités de sécurité** : Veuillez les signaler de manière privée conformément à [`SECURITY.md`](../../../SECURITY.md).

## Licence

MIT, identique à la version amont de VS Code. Consultez [`LICENSE.txt`](../../../LICENSE.txt) pour prendre connaissance de la notice de copyright de Microsoft et des avis des contributeurs de Facade Code.

<sub>Facade Code est un produit indépendant qui n'est ni affilié, ni approuvé, ni sponsorisé par les fournisseurs des outils tiers présentés. Toutes les marques et tous les logos de tiers appartiennent à leurs propriétaires respectifs.</sub>
