# Contribuer à Facade Code

Merci de votre aide. Facade Code est développé ouvertement sur [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Bugs et idées

Ouvrez une [issue](https://github.com/y5ez3g/facadecode/issues) ; Help > Report Issue (Aide > Signaler un problème) en ouvre une nouvelle avec votre version déjà renseignée. Cherchez d'abord parmi les issues existantes et, pour un bug, indiquez :

- ce que vous avez fait, ce que vous attendiez et ce qui s'est passé à la place ;
- la version, visible dans Help > About (Aide > À propos), et votre système d'exploitation ;
- pour un problème d'agent, quelle CLI d'agent et quelle version.

Les failles de sécurité ne se signalent pas dans les issues ; voir [`SECURITY.md`](SECURITY.md).

## Code

Le fonctionnement de ce dépôt est décrit dans [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md) : comment préparer une build, les commandes qui vérifient une modification, et les règles ci-dessous dans leur intégralité.

- Créez votre branche à partir de `main` sous le nom `feature/<name>`.
- Fusionnez, ne rebasez jamais : une fonctionnalité arrive sur `main` avec `--no-ff`, après relecture.
- Gardez les fichiers de Facade Code regroupés et, dans les fichiers de VS Code, ajoutez des hooks optionnels plutôt que de réécrire leur logique, pour que l'intégration d'une version plus récente de VS Code reste peu coûteuse.
- Chaque fonctionnalité a un interrupteur ; une fois celui-ci désactivé, on retrouve VS Code d'origine.
- Toute modification doit être accompagnée de tests.
- Rédigez en anglais les documents, les commentaires et les messages de commit.

Ce que doit faire chaque fonctionnalité est décrit dans [`facade-code-spec/`](../../facade-code-spec/). Pour modifier un comportement, partez de la spécification, ou ouvrez d'abord une issue pour en discuter.

## Licence

En contribuant, vous acceptez que vos contributions soient placées sous la [licence MIT](../../LICENSE.txt) du projet.
