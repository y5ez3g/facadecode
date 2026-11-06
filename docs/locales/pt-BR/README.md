<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**O orquestrador multiagente para o VS Code.**

Execute CLIs nativas de agentes, edite código e revise alterações na mesma janela da IDE. Use suas próprias contas e planos de assinatura, e deixe os agentes colaborarem entre janelas e máquinas.

[![Site: facadecode.com](https://img.shields.io/badge/Site-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: instalar](https://img.shields.io/badge/VS%20Code%20Marketplace-instalar-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: instalar](https://img.shields.io/badge/Open%20VSX-instalar-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: baixar o IDE](https://img.shields.io/badge/Releases-baixar%20o%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: reportar um bug](https://img.shields.io/badge/Issues-reportar%20um%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · **Português (Brasil)** · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![Assista à demonstração de 2 minutos em facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalação

```sh
code --install-extension facade.facadecode
```

Ou instale o **Facade Code** pelo [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) ou [Open VSX](https://open-vsx.org/extension/facade/facadecode). Ele funciona no macOS (Apple silicon), Linux (x64) e Windows (x64).

Em seguida, instale e faça login nas CLIs de agentes suportadas que planeja usar: Claude Code, Codex, Antigravity, Muse Code, OpenCode ou Pi. O Facade Code inicia cada CLI usando seus próprios dados de login e planos de assinatura.

> **Os agentes são executados sem solicitações de aprovação por padrão.** Com o `facade.yolo` ativado por padrão, os agentes podem executar comandos e alterar arquivos sem perguntar primeiro. Desative-o para restaurar as solicitações de aprovação padrão de cada CLI. Consulte o [extension README](../../../extension/README.md#install).

## Agent Panel

**Seus agentes e seu IDE, na mesma janela.**

O Facade Code executa CLIs nativas de agentes (Claude Code, Codex, Antigravity, Muse Code, OpenCode e Pi) em guias de terminal do editor ao lado dos seus arquivos, usando os comandos, as ferramentas, as contas e os planos de assinatura de cada CLI. Um cartão no painel monitora o status de cada agente.

- **Trabalhe ao lado do seu código.** Cada agente roda em sua própria guia de terminal na área do editor. Fechar uma guia apenas a oculta enquanto o agente continua em execução; clicar no cartão dele o abre novamente.
- **Acompanhe o status entre os agentes.** Os cartões mostram o que foi enviado por último a cada agente e se ele está trabalhando, precisa de permissão ou encontrou um erro, com detalhes mostrando seu título, sua pasta e quem o iniciou. Os agentes continuam em execução após recarregar a janela e reiniciar a extensão.
- **Pastas e worktrees.** Execute agentes em qualquer pasta do espaço de trabalho ou crie um worktree do Git em tempo real para manter as alterações de código isoladas. Fixe uma conversa para restaurá-la ao reabrir o espaço de trabalho ou retome sessões anteriores a partir do histórico.

## Agent Use

**Deixe os agentes operarem outros agentes, assim como você.**

Por meio do MCP e de um protocolo de terminal, os agentes podem iniciar, parar, localizar e enviar mensagens para outros agentes, ler suas telas de terminal, digitar texto e pressionar teclas.

- **Iniciar e parar agentes.** Um agente pode iniciar outros agentes com qualquer uma das seis CLIs, em qualquer pasta ou novo worktree das suas janelas do Facade neste computador, e atribuir a eles sua primeira tarefa. Uma solicitação repetida com o mesmo ID de solicitação nunca inicia um segundo agente.
- **Enviar mensagens.** Os agentes trocam mensagens entre si e podem enviar mensagens para você. O Facade cola a mensagem inteira de uma só vez e a envia. Se houver texto não enviado ou uma pergunta na linha de comando no caminho, o envio aguarda até que a entrada esteja livre.
- **Controle de terminal.** Um agente pode ler a tela de outro agente, digitar comandos e pressionar teclas para responder a perguntas ou ajudar um colega que esteja travado. Quando um agente filho aguarda 20 segundos por permissão, uma resposta ou login, o agente que o iniciou é notificado.

## Agent Mesh

**Conecte agentes entre janelas, máquinas e locais.**

O Facade Code conecta os agentes de todas as suas janelas do Facade neste computador em uma única rede. Abra uma janela do [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) para estender essa colaboração a outra máquina.

- **Entre janelas.** Com o `facade.yolo` ativado, um agente alcança todos os agentes em suas janelas do Facade neste computador, tanto locais quanto do Remote - SSH. Com ele desativado, o agente alcança apenas seu próprio grupo: o agente que você iniciou e os iniciados a partir dele.
- **Estenda via SSH.** Em uma janela do [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), os agentes rodam diretamente na máquina remota com as ferramentas, os arquivos e as contas de lá. Agentes locais podem iniciar e enviar mensagens diretamente para agentes em janelas do Remote - SSH.
- **Coordene pelo celular.** Conecte o aplicativo móvel do Claude a uma sessão do Claude Code em seu computador usando o [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Essa sessão pode coordenar outros agentes pelo Facade e relatar o progresso de volta ao seu telefone.

<sub>O Remote Control requer uma versão compatível do Claude Code, um plano de assinatura elegível e login de escopo completo. Consulte seus [requisitos de configuração](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Múltiplos projetos. Uma única janela.**

Organize projetos, worktrees de funcionalidades e equipes de agentes em uma barra de espaço de trabalho dedicada. Alterne entre projetos com seus respectivos arquivos e terminais, enquanto os agentes continuam trabalhando em segundo plano.

Baixe a versão prévia da IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Todas as versões](https://github.com/y5ez3g/facadecode/releases)

A IDE é um fork do VS Code que é instalado ao lado do seu editor existente e não compartilha nada com ele: configurações, extensões e o comando `facade` são totalmente separados. Suas extensões vêm do [Open VSX](https://open-vsx.org); algumas extensões proprietárias da Microsoft, como o Remote Development e o C/C++, funcionam apenas em compilações oficiais da Microsoft. A arquitetura e as especificações estão em [`docs/ide/`](../../ide/).

## Compilando a partir do código-fonte

- **Extensão:** Forneça [`extension/AGENTS.md`](../../../extension/AGENTS.md) ao seu agente de codificação para compilar o pacote.
- **IDE:** Forneça [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) ao seu agente de codificação para compilar o aplicativo.

Para diretrizes de contribuição e disciplina de branches, consulte [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) e [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Feedback

- **Bugs e ideias**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), ou **Ajuda > Reportar Problema** na IDE.
- **Vulnerabilidades de segurança**: Relate de forma privada de acordo com o [`SECURITY.md`](../../../SECURITY.md).

## Licença

MIT, compatível com o VS Code upstream. Consulte [`LICENSE.txt`](../../../LICENSE.txt) para ver o aviso de direitos autorais da Microsoft e os avisos dos colaboradores do Facade Code.

<sub>O Facade Code é um produto independente e não é afiliado, endossado ou patrocinado pelos provedores das ferramentas de terceiros exibidas. Todas as marcas registradas e logotipos de terceiros pertencem aos seus respectivos proprietários.</sub>
