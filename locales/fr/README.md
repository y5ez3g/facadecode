<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Un seul IDE pour vous et votre équipe d'IA.**

Basé sur VS Code. Exécute les CLI natives de vos agents, comme Claude Code, Codex, Antigravity, Muse Code et Qwen Code.

[Télécharger](https://github.com/y5ez3g/facadecode/releases) ·
[Spécifications](../../facade-code-spec/) ·
[Signaler un bug](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · **Français** · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code est un fork de VS Code dans lequel des agents natifs de tous les fournisseurs collaborent sur vos projets et vos fonctionnalités, pendant que vous relisez le code et pilotez n'importe quel agent dans la même fenêtre.

- 🧑‍💻 **Tout VS Code, organisé par projets et par fonctionnalités.** Développez plusieurs projets et fonctionnalités dans une seule fenêtre. Chaque fonctionnalité correspond à un worktree Git, avec sa propre équipe d'agents.
- 🤖 **Une équipe de CLI d'agents natives, tous fournisseurs confondus.** Les agents tournent sur vos propres abonnements. Dans Facade Code, les agents se lancent les uns les autres, s'envoient des messages et se débloquent mutuellement.
- 👥 **Super Engineer ou Super Team.** Dirigez vous-même plusieurs agents, ou désignez un modèle principal qui coordonne des spécialistes en parallèle.

## Installation

Téléchargez la dernière version depuis [Releases](https://github.com/y5ez3g/facadecode/releases) : un `.dmg` pour macOS (Apple silicon), un programme d'installation pour Windows (x64) ou un `.deb` pour Ubuntu (x64).

**Prérequis** : installez les CLI d'agents que vous voulez utiliser et connectez-vous-y (n'importe quelle combinaison de Claude Code, Codex, Antigravity, Muse Code ou Qwen Code). Facade Code les exécute directement, avec leur propre authentification et leurs propres abonnements.

Facade Code s'installe à côté de VS Code et ne partage rien avec lui : les paramètres, les extensions et l'outil en ligne de commande `facade` sont entièrement séparés.

## Démarrage rapide

1. **Ouvrez un projet** :
   ```sh
   facade ~/code/space-shooter
   ```
   Ou utilisez **File > Open Folder** (Fichier > Ouvrir le dossier), ou déposez un dossier sur la barre des espaces de travail. Le dossier doit être un dépôt git (les worktrees nécessitent git ; lancez d'abord `git init` si vous partez de zéro).

2. **Lancez un tech lead** :
   Cliquez sur l'icône du robot dans la barre de titre (menu Agent), ou exécutez **Agents: Start Agent...** (démarrer un agent) dans la palette de commandes, puis choisissez Claude Code ou Codex. Un agent lancé depuis Facade Code est équipé des outils MCP de Facade.

3. **Donnez-lui le prompt de tech lead** :
   ```text
   Tu es le tech lead. Utilise Facade pour créer un shoot'em up spatial néon pour
   navigateur (desktop) destiné à une démo, avec un PD sur GPT Sol 6 (gpt-6-sol, max)
   via Codex, responsable du look and feel, et trois ingénieurs Muse 1.3
   (muse-spark-1.3, max) qui travaillent en parallèle. Reste modeste, environ une
   demi-heure de développement : un niveau, trois types d'ennemis, un boss en deux
   phases, des bonus, un score et des combos. Mieux vaut un jeu fini et soigné que
   davantage de fonctionnalités. Les ingénieurs fusionnent leur propre travail et tu relis ensuite.
   Envoie-moi une page HTML avec un plan court, un diagramme en couloirs et la maquette
   du PD, puis attends mon accord avant de commencer.
   ```

4. **Regardez l'équipe collaborer** :
   Le PD et les ingénieurs lancés apparaissent dans la barre des espaces de travail, sous leur projet et leur fonctionnalité. Dès que vous approuvez le plan HTML, ils se mettent au travail. Vous pouvez à tout moment ouvrir le terminal de n'importe quel agent pour consulter sa sortie ou lui parler directement.

*(Remarque : cet exemple de prompt lance 5 agents au niveau de raisonnement maximal. Adaptez les CLI, les modèles, les niveaux de raisonnement et le nombre d'ingénieurs aux abonnements dont vous disposez.)*

## Fonctionnalités

### Des projets et des fonctionnalités, pas des sessions

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

La plupart des outils d'agents créent un worktree par session d'agent. Facade Code fait l'inverse : chaque worktree est une fonctionnalité, rangée sous son dépôt, et c'est vous qui y affectez des agents.

Une fonctionnalité a souvent besoin de plus d'un agent. Celui qui écrit le code n'explique pas forcément bien son travail et n'a pas toujours l'œil pour le design ; d'autres agents l'aident donc pour la documentation, le design et la relecture, tous dans le même worktree. Les agents vont et viennent ; la fonctionnalité reste.

- **Barre des espaces de travail** : affiche tous les dépôts et toutes les fonctionnalités dans une seule colonne. Un clic bascule toute la fenêtre (explorateur, éditeurs, terminaux et contrôle de code source), restaurée telle que vous l'avez laissée. Les projets ne se mélangent jamais. Voir [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Cycle de vie des worktrees** : **New Worktree** (nouveau worktree) crée la branche, synchronise les fichiers locaux listés dans `.worktreeinclude` et lance la configuration initiale. **Delete Worktree** (supprimer le worktree) détaille ce qui serait perdu avant la suppression. Voir [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Sous-tâches en parallèle** : les tâches indépendantes peuvent partir dans des worktrees séparés.

### Une équipe issue de tous les fournisseurs

- **Des CLI natives sur vos propres abonnements** : Claude Code, Codex, Muse Code, Antigravity et Qwen Code tournent dans leurs propres terminaux intégrés, avec les abonnements que vous avez déjà.
- **Des agents qui lancent des agents** : un agent peut lancer d'autres agents (avec la CLI ou le modèle de n'importe quel fournisseur) dans la fonctionnalité en cours ou dans un nouveau worktree, et leur confier des tâches. Voir [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) et [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Messagerie** : les agents s'envoient des messages, rendent compte de leurs résultats à celui qui les a sollicités et vous préviennent quand une décision demande une validation humaine. Voir [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Ils se débloquent entre eux** : un agent peut lire le terminal d'un autre agent, répondre à ses invites et lui envoyer des frappes clavier pour aider un collègue bloqué, sans vous interrompre. Voir [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Vous pouvez intervenir sur chacun** : chaque agent a sa propre ligne de terminal sous sa fonctionnalité. Vous voyez ce qu'il fait et pouvez y taper directement à tout moment.
- **MCP standard** : tous les outils d'orchestration sont exposés par un serveur MCP standard.

## Deux façons de travailler

L'attention du développeur est le goulot d'étranglement. Les deux modes correspondent à deux niveaux de délégation :

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Votre rôle** | Ingénieur qui met les mains dans le code | Engineering manager |
| **Votre interlocuteur** | Plusieurs agents, directement | Un agent tech lead, en tête-à-tête |
| **Qui coordonne les agents** | Vous | Le tech lead |
| **Idéal pour** | Les fonctionnalités qui demandent un suivi rapproché : travail exploratoire, décisions de design que vous voulez juger vous-même, exigences changeantes | Les grosses fonctionnalités bien définies qui se découpent proprement |

Vous pouvez combiner les deux dans la même fenêtre : garder un contrôle étroit sur les fonctionnalités sensibles et déléguer à un lead le travail bien cadré.

- **Super Engineer** : vous ouvrez les worktrees, confiez des tâches aux agents dans différents dépôts et relisez le code à mesure que chacun termine.
- **Super Team** : vous confiez une fonctionnalité à un agent en tant que tech lead. Il découpe les tâches, définit les contrats d'interface, lance les exécutants et relit leur travail.
  - Un modèle puissant dirige ; des modèles plus rapides et moins chers, sur vos abonnements existants, implémentent en parallèle ; et des modèles de fournisseurs différents relisent le travail les uns des autres.
  - Un prompt suffit pour mettre tout cela en place (voir [Démarrage rapide](#démarrage-rapide)) ; les workflows d'équipe que vous réutilisez peuvent s'écrire sous forme de skills.

*(Ce README a été écrit de la même manière : un agent a analysé, un autre a rédigé, et une personne a tranché.)*

## Pourquoi

La plupart des outils de code avec IA se rangent dans deux camps : les IDE façon Copilot, où un humain doit suivre ligne par ligne, et les IDE d'agents, où la relecture de code et le débogage sont délégués à un éditeur externe. Aucun des deux ne réunit une équipe d'agents natifs de plusieurs fournisseurs au sein de votre IDE principal.

Nous pensons que l'avenir, c'est un développeur qui mène plusieurs projets et fonctionnalités avec une équipe d'agents. Chaque modèle excelle dans des tâches différentes, l'équipe doit donc réunir plusieurs fournisseurs. Et puisque ce sont les agents qui écrivent le code que vous relisez, cette équipe a sa place dans votre IDE.

## Toujours VS Code

Facade Code ne modifie que ce qu'exige la gestion de plusieurs projets et de plusieurs agents :

- La **barre des espaces de travail** occupe la première colonne ; la **barre d'activité** passe en haut à droite de la barre de titre (rétablissable avec `workbench.activityBar.location`).
- Copilot et le chat d'upstream sont désactivés par défaut (un seul paramètre suffit à les réactiver).
- Tout le reste est du VS Code d'origine : éditeur, paramètres, raccourcis clavier, `.vscode/` et fichiers `.code-workspace`.
- Les extensions s'installent depuis [Open VSX](https://open-vsx.org). Quelques extensions propriétaires de Microsoft, comme Remote Development et C/C++, ne sont licenciées que pour les builds officielles de Microsoft et ne peuvent pas fonctionner dans les forks.

## Compiler depuis les sources

Confiez [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) à votre agent et laissez-le compiler.

Pour les règles de contribution et la discipline de branches, voir [`CONTRIBUTING.md`](CONTRIBUTING.md) et [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Retours

- **Bugs et idées** : [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) ou **Help > Report Issue** (Aide > Signaler un problème) dans l'éditeur.
- **Failles de sécurité** : merci de les signaler en privé, comme indiqué dans [`SECURITY.md`](SECURITY.md).

## Licence

MIT, comme VS Code en amont. Voir [`LICENSE.txt`](../../LICENSE.txt) pour la mention de copyright de Microsoft et celles des contributeurs de Facade Code.
