# Como contribuir com o Facade Code

Obrigado por ajudar. O Facade Code é desenvolvido abertamente em [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Bugs e ideias

Abra uma [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Ajuda > Relatar Problema) abre uma nova já com a sua versão preenchida. Procure antes nas issues existentes e, se for um bug, informe:

- o que você fez, o que esperava e o que aconteceu de fato;
- a versão, que aparece em Help > About (Ajuda > Sobre), e o seu sistema operacional;
- se for um problema com um agente, qual CLI de agente e qual versão.

Vulnerabilidades de segurança não são reportadas em issues; veja o [`SECURITY.md`](SECURITY.md).

## Código

O funcionamento deste repositório está descrito em [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): como configurar uma build, os comandos que verificam uma alteração e as regras abaixo na íntegra.

- Crie o branch a partir de `main`, com o nome `feature/<name>`.
- Faça merge, nunca rebase: uma funcionalidade entra em `main` com `--no-ff`, depois da revisão.
- Mantenha os arquivos do Facade Code juntos e, nos arquivos do VS Code, adicione hooks opcionais em vez de reescrever a lógica deles, para que incorporar versões mais novas do VS Code continue dando pouco trabalho.
- Toda funcionalidade tem uma chave para ligar e desligar; desligada, o que fica é o VS Code padrão.
- Toda alteração deve vir com testes.
- Escreva documentos, comentários e mensagens de commit em inglês.

O que cada funcionalidade deve fazer está em [`docs/ide/`](../../ide/). Para mudar um comportamento, comece pela especificação ou abra antes uma issue para discutir.

## Licença

Ao contribuir, você concorda que suas contribuições sejam licenciadas sob a [licença MIT](../../../LICENSE.txt) do projeto.
