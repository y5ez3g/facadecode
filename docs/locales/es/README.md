<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Ejecute agentes de programación con IA en sus propias máquinas.**

Facade Code ejecuta varias CLI de programación con IA en sus máquinas. Los agentes pueden encontrarse, intercambiar mensajes, leer pantallas y escribir en terminales. Diríjalos desde Shell, VS Code o cualquier aplicación compatible con MCP. Cada máquina ejecuta su propio Orchestrator y las máquinas se conectan por SSH.

[![Sitio web: facadecode.com](https://img.shields.io/badge/Sitio%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: instalar](https://img.shields.io/badge/VS%20Code%20Marketplace-instalar-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: instalar](https://img.shields.io/badge/Open%20VSX-instalar-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: reportar un error](https://img.shields.io/badge/Issues-reportar%20un%20error-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · **Español** · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Vea la demostración de 2 minutos en facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalación

### Shell

Los instaladores de una sola línea estarán disponibles a partir de la primera versión que incluya los paquetes independientes.
Hay paquetes de Shell para macOS, Linux y Windows en x64 y arm64.

Ejecute este comando en macOS o Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Ejecute este comando en PowerShell en Windows.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

El instalador añade `facade` y `facade-mcp` al PATH. Abra un terminal nuevo para usar el PATH actualizado. Actualice con `facade upgrade`. Instale las CLI necesarias e inicie sesión en cada máquina. Las opciones integradas son Claude Code, Codex, Antigravity, Muse Code, OpenCode y Pi.

Su lanzador también se llama `facade`. Con ambos instalados, la shell usa el primero en el PATH. Tras retirar la versión preliminar del IDE, el nombre queda para Orchestrator. Ejecute `facade --version`. Una línea con el formato `facade <version>` confirma que está usando el comando de Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

La extensión incluye su Orchestrator. Abra **Facade Code** en la barra de actividad y elija **Nuevo agente**, **Go to Agent** o **Resume Agent**. Hay paquetes de macOS, Linux y Windows para x64 y arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Añada `facade-mcp` como servidor MCP mediante stdio. El ejemplo usa un objeto `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Una conexión externa se une como Guest en su primera llamada a una herramienta. Tras enviar un mensaje, use la llamada a `read_messages` que devuelve `send_message` para esperar la respuesta.

## Trabajar en varias máquinas

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Use la dirección que muestra `facade list`. Registre otra máquina con el destino y las opciones SSH habituales. Para acceder a WSL o a un Dev Container desde fuera, active SSH dentro de ese entorno y regístrelo del mismo modo. También puede ejecutar Facade directamente dentro del entorno.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade instala la versión correspondiente en la máquina remota cuando hace falta. Facade usa la ruta fija de instalación en la máquina remota. Si instala a mano, use la misma versión que su Orchestrator local. En VS Code, **Go to Agent** abre el terminal de un agente activo. El espacio de trabajo recuerda los agentes abiertos, sus ayudantes y sus Pins. Al cerrar la pestaña del terminal, el agente sigue en ejecución. **Resume Agent** y `facade resume` muestran el trabajo guardado.

> **YOLO está activado de forma predeterminada.** Con YOLO, un agente puede acceder a otros agentes de las máquinas conectadas. Establezca `"yolo": false` en el `facade.json` de su máquina para conservar las aprobaciones y el aislamiento de la CLI, y limitar MCP al árbol de creación de quien llama. El cambio se aplica en el siguiente arranque o resume. `facade status` muestra la ruta del archivo.

[Documentación del producto (en inglés)](../../PRODUCT.md) · [Glosario](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Múltiples proyectos. Una sola ventana.**

Organice proyectos, worktrees de funcionalidades y equipos de agentes en una barra de área de trabajo dedicada. Cambie de proyecto con sus archivos y terminales relevantes, mientras los agentes continúan trabajando en segundo plano.

Descargue la versión previa del IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Todas las versiones](https://github.com/y5ez3g/facadecode/releases)

La versión preliminar del IDE usa su propia configuración y extensiones. Sus extensiones proceden de [Open VSX](https://open-vsx.org); unas pocas extensiones propietarias de Microsoft, como Remote Development y C/C++, solo se ejecutan en compilaciones oficiales de Microsoft. La arquitectura y las especificaciones se encuentran en [`docs/ide/`](../../ide/).

## Compilación desde el código fuente

- **Extensión:** Proporcione [`extension/AGENTS.md`](../../../extension/AGENTS.md) a su agente de programación para compilar el paquete.
- **Orchestrator / Shell.** [Instrucciones de compilación](../../../core/README.md).
- **IDE:** Proporcione [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) a su agente de programación para compilar la aplicación.

Para conocer las pautas de contribución y la disciplina de ramas, consulte [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) y [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Comentarios y soporte

- **Errores e ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), o **Ayuda > Notificar problema** en el IDE.
- **Vulnerabilidades de seguridad**: Notifíquelas de forma privada de acuerdo con [`SECURITY.md`](../../../SECURITY.md).

## Licencia

MIT, conforme al proyecto original de VS Code. Consulte [`LICENSE.txt`](../../../LICENSE.txt) para ver el aviso de derechos de autor de Microsoft y los avisos de los colaboradores de Facade Code.

<sub>Facade Code es un producto independiente y no está afiliado, respaldado ni patrocinado por los proveedores de las herramientas de terceros mostradas. Todas las marcas comerciales y logotipos de terceros pertenecen a sus respectivos propietarios.</sub>
