<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**El orquestador multiagente para VS Code.**

Ejecute CLI nativas de agentes, edite código y revise cambios en la misma ventana del IDE. Use sus propias cuentas y planes de suscripción, y permita que los agentes colaboren entre ventanas y máquinas.

[![Sitio web: facadecode.com](https://img.shields.io/badge/Sitio%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: instalar](https://img.shields.io/badge/VS%20Code%20Marketplace-instalar-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: instalar](https://img.shields.io/badge/Open%20VSX-instalar-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: descargar el IDE](https://img.shields.io/badge/Releases-descargar%20el%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: reportar un error](https://img.shields.io/badge/Issues-reportar%20un%20error-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · **Español** · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![Vea la demostración de 2 minutos en facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalación

```sh
code --install-extension facade.facadecode
```

O instale **Facade Code** desde [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) u [Open VSX](https://open-vsx.org/extension/facade/facadecode). Funciona en macOS (Apple silicon), Linux (x64) y Windows (x64).

A continuación, instale las CLI de agentes compatibles que planee usar e inicie sesión en ellas: Claude Code, Codex, Antigravity, Muse Code, OpenCode o Pi. Facade Code inicia cada CLI con su propio inicio de sesión y planes de suscripción.

> **Los agentes se ejecutan sin avisos de aprobación de forma predeterminada.** Con `facade.yolo` activado por defecto, los agentes pueden ejecutar comandos y modificar archivos sin preguntar antes. Desactívelo para restaurar las solicitudes de aprobación habituales de cada CLI. Consulte el [extension README](../../../extension/README.md#install).

## Agent Panel

**Sus agentes y su IDE, en la misma ventana.**

Facade Code ejecuta CLI nativas de agentes (Claude Code, Codex, Antigravity, Muse Code, OpenCode y Pi) en pestañas de terminal del editor junto a sus archivos, usando los comandos, herramientas, cuentas y planes de suscripción propios de cada CLI. Una tarjeta en el panel supervisa el estado de cada agente.

- **Trabaje junto a su código.** Cada agente se ejecuta en su propia pestaña de terminal en el área del editor. Cerrar una pestaña la oculta mientras el agente sigue ejecutándose; al hacer clic en su tarjeta, se vuelve a abrir.
- **Supervise el estado de los agentes.** Las tarjetas muestran qué se envió por última vez a cada agente y si está trabajando, necesita permisos o encontró un error, con detalles que muestran su título, su carpeta y quién lo inició. Los agentes siguen ejecutándose durante las recargas de ventana y los reinicios de la extensión.
- **Carpetas y worktrees.** Ejecute agentes en cualquier carpeta del área de trabajo o cree un worktree de Git sobre la marcha para mantener separados los cambios de código. Ancle una conversación para restaurarla al volver a abrir el área de trabajo o reanude sesiones anteriores desde el historial.

## Agent Use

**Deje que los agentes operen a otros agentes, igual que usted.**

Mediante MCP y un protocolo de terminal, los agentes pueden iniciar, detener, buscar y enviar mensajes a otros agentes, leer sus pantallas de terminal, escribir texto y pulsar teclas.

- **Iniciar y detener agentes.** Un agente puede iniciar otros agentes con cualquiera de las seis CLI, en cualquier carpeta o nuevo worktree de sus ventanas de Facade en este equipo, y asignarles su primera tarea. Una solicitud reintentada con el mismo ID de solicitud nunca inicia un segundo agente.
- **Enviar mensajes.** Los agentes intercambian mensajes entre sí y también pueden enviarle mensajes a usted. Facade pega el mensaje completo de una sola vez y lo envía. Si hay texto sin enviar o una pregunta interactiva bloqueando la entrada, el envío espera hasta que la entrada esté despejada.
- **Control de terminal.** Un agente puede leer la pantalla de otro agente, escribir comandos y pulsar teclas para responder preguntas o desbloquear a un compañero. Cuando un agente secundario espera 20 segundos un permiso, una respuesta o un inicio de sesión, el agente que lo inició recibe una notificación.

## Agent Mesh

**Conecte agentes entre ventanas, máquinas y ubicaciones.**

Facade Code conecta los agentes de todas sus ventanas de Facade en este equipo en una sola red. Abra una ventana de [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) para ampliar esa colaboración a otra máquina.

- **Entre ventanas.** Con `facade.yolo` activado, un agente llega a todos los agentes de sus ventanas de Facade en este equipo, tanto locales como de Remote - SSH. Con él desactivado, un agente solo se comunica con su propio grupo: el agente que usted inició y los creados a partir de él.
- **Extienda a través de SSH.** En una ventana de [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), los agentes se ejecutan directamente en la máquina remota con las herramientas, archivos y cuentas de allí. Los agentes locales pueden iniciar y enviar mensajes directamente a agentes en ventanas de Remote - SSH.
- **Coordine desde el móvil.** Conecte la aplicación móvil de Claude a una sesión de Claude Code en su ordenador mediante [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Esa sesión puede coordinar a otros agentes mediante Facade e informar del progreso a su teléfono.

<sub>Remote Control requiere una versión compatible de Claude Code, un plan de suscripción válido e inicio de sesión con alcance completo. Consulte los [requisitos de configuración](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Múltiples proyectos. Una sola ventana.**

Organice proyectos, worktrees de funcionalidades y equipos de agentes en una barra de área de trabajo dedicada. Cambie de proyecto con sus archivos y terminales relevantes, mientras los agentes continúan trabajando en segundo plano.

Descargue la versión previa del IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Todas las versiones](https://github.com/y5ez3g/facadecode/releases)

El IDE es una bifurcación (fork) de VS Code que se instala junto a su editor actual y no comparte nada con él: la configuración, las extensiones y el comando `facade` son totalmente independientes. Sus extensiones proceden de [Open VSX](https://open-vsx.org); unas pocas extensiones propietarias de Microsoft, como Remote Development y C/C++, solo se ejecutan en compilaciones oficiales de Microsoft. La arquitectura y las especificaciones se encuentran en [`docs/ide/`](../../ide/).

## Compilación desde el código fuente

- **Extensión:** Proporcione [`extension/AGENTS.md`](../../../extension/AGENTS.md) a su agente de programación para compilar el paquete.
- **IDE:** Proporcione [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) a su agente de programación para compilar la aplicación.

Para conocer las pautas de contribución y la disciplina de ramas, consulte [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) y [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Comentarios y soporte

- **Errores e ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), o **Ayuda > Notificar problema** en el IDE.
- **Vulnerabilidades de seguridad**: Notifíquelas de forma privada de acuerdo con [`SECURITY.md`](../../../SECURITY.md).

## Licencia

MIT, conforme al proyecto original de VS Code. Consulte [`LICENSE.txt`](../../../LICENSE.txt) para ver el aviso de derechos de autor de Microsoft y los avisos de los colaboradores de Facade Code.

<sub>Facade Code es un producto independiente y no está afiliado, respaldado ni patrocinado por los proveedores de las herramientas de terceros mostradas. Todas las marcas comerciales y logotipos de terceros pertenecen a sus respectivos propietarios.</sub>
