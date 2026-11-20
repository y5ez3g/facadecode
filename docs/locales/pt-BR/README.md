<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Execute agentes de programação com IA nas suas máquinas.**

Facade Code executa várias CLIs de programação com IA nas suas máquinas. Os agentes podem se encontrar, trocar mensagens, ler telas e digitar em terminais. Controle-os pelo Shell, VS Code ou qualquer aplicativo com suporte a MCP. Cada máquina executa seu próprio Orchestrator e se conecta por SSH.

[![Site: facadecode.com](https://img.shields.io/badge/Site-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: instalar](https://img.shields.io/badge/VS%20Code%20Marketplace-instalar-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: instalar](https://img.shields.io/badge/Open%20VSX-instalar-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: reportar um bug](https://img.shields.io/badge/Issues-reportar%20um%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · **Português (Brasil)** · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Assista à demonstração de 2 minutos em facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalação

### Shell

Os instaladores de uma linha ficam disponíveis a partir da primeira versão com pacotes independentes.
Os pacotes de Shell cobrem macOS, Linux e Windows em x64 e arm64.

Execute este comando no macOS ou Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

No Windows, execute este comando no PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

O instalador adiciona `facade` e `facade-mcp` ao PATH. Abra um novo terminal para usar o PATH atualizado. Atualize com `facade upgrade`. Instale as CLIs necessárias e faça login em cada máquina. As opções integradas são Claude Code, Codex, Antigravity, Muse Code, OpenCode e Pi.

Seu inicializador também se chama `facade`. Com ambos instalados, o Shell executa o primeiro no PATH. Após a retirada da prévia, o nome do comando fica com o Orchestrator. Execute `facade --version`. Uma linha no formato `facade <version>` confirma que você está usando o comando de Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

A extensão inclui o Orchestrator. Abra **Facade Code** na barra de atividades e escolha **Novo Agente**, **Go to Agent** ou **Resume Agent**. Há pacotes para macOS, Linux e Windows em x64 e arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Adicione `facade-mcp` como um servidor MCP stdio. O exemplo usa um objeto `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Uma conexão externa entra como Guest na primeira chamada a uma ferramenta. Depois de enviar a mensagem, aguarde a resposta com a chamada a `read_messages` retornada por `send_message`.

## Trabalhe em várias máquinas

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Use o endereço exibido por `facade list`. Registre outra máquina com o destino e as opções de SSH que você usa normalmente. Para acessar o WSL ou um Dev Container de fora, configure o SSH dentro do ambiente e registre-o da mesma forma. Você também pode executar o Facade diretamente nele.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade instala a versão correspondente na máquina remota quando necessário. O Facade usa o caminho fixo de instalação na máquina remota. Em uma instalação manual, use a mesma versão do seu Orchestrator local. No VS Code, **Go to Agent** abre o terminal do agente em execução. O espaço de trabalho guarda os agentes abertos, seus ajudantes e seus Pins. Fechar a aba do terminal mantém o agente em execução. **Resume Agent** e `facade resume` mostram o trabalho salvo.

> **YOLO vem ativado.** Com YOLO, um agente pode acessar outros agentes nas máquinas conectadas. Defina `"yolo": false` no `facade.json` da máquina para manter as aprovações e o sandbox da CLI e limitar o acesso MCP à árvore de criação de quem faz a chamada. A mudança vale no próximo início ou resume. `facade status` mostra o caminho do arquivo.

[Documentação do produto (chinês)](../../facade-code.md) · [Glossário](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Múltiplos projetos. Uma única janela.**

Organize projetos, worktrees de funcionalidades e equipes de agentes em uma barra de espaço de trabalho dedicada. Alterne entre projetos com seus respectivos arquivos e terminais, enquanto os agentes continuam trabalhando em segundo plano.

Baixe a versão prévia da IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Todas as versões](https://github.com/y5ez3g/facadecode/releases)

A versão prévia da IDE pode ser instalada ao lado do seu editor e tem configurações e extensões próprias. Suas extensões vêm do [Open VSX](https://open-vsx.org); algumas extensões proprietárias da Microsoft, como o Remote Development e o C/C++, funcionam apenas em compilações oficiais da Microsoft. A arquitetura e as especificações estão em [`docs/ide/`](../../ide/).

## Compilando a partir do código-fonte

- **Extensão:** Forneça [`extension/AGENTS.md`](../../../extension/AGENTS.md) ao seu agente de codificação para compilar o pacote.
- **Orchestrator / Shell.** [Instruções de compilação](../../../core/README.md).
- **IDE:** Forneça [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) ao seu agente de codificação para compilar o aplicativo.

Para diretrizes de contribuição e disciplina de branches, consulte [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) e [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Feedback

- **Bugs e ideias**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), ou **Ajuda > Reportar Problema** na IDE.
- **Vulnerabilidades de segurança**: Relate de forma privada de acordo com o [`SECURITY.md`](../../../SECURITY.md).

## Licença

MIT, compatível com o VS Code upstream. Consulte [`LICENSE.txt`](../../../LICENSE.txt) para ver o aviso de direitos autorais da Microsoft e os avisos dos colaboradores do Facade Code.

<sub>O Facade Code é um produto independente e não é afiliado, endossado ou patrocinado pelos provedores das ferramentas de terceiros exibidas. Todas as marcas registradas e logotipos de terceiros pertencem aos seus respectivos proprietários.</sub>
