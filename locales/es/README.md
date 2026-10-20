<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Un IDE para ti y tu equipo de IA.**

Basado en VS Code. Ejecuta las CLI nativas de tus agentes, como Claude Code, Codex, Antigravity, Muse Code y Qwen Code.

[Descargar](https://github.com/y5ez3g/facadecode/releases) ·
[Especificaciones](../../facade-code-spec/) ·
[Reportar un error](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · **Español** · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code es un fork de VS Code en el que agentes nativos de todos los proveedores colaboran en tus proyectos y funcionalidades, mientras tú revisas el código y diriges a cualquier agente en la misma ventana.

- 🧑‍💻 **VS Code completo, organizado por proyectos y funcionalidades.** Desarrolla varios proyectos y funcionalidades en una sola ventana. Cada funcionalidad es un git worktree con su propio equipo de agentes.
- 🤖 **Un equipo de CLI nativas de agentes de distintos proveedores.** Los agentes funcionan con las suscripciones que ya tienes. En Facade Code, los agentes se lanzan entre sí, se envían mensajes y se ayudan a desatascarse.
- 👥 **Super Engineer o Super Team.** Dirige tú mismo a varios agentes, o designa un modelo líder que coordine a especialistas en paralelo.

## Instalación

Descarga la última versión desde [Releases](https://github.com/y5ez3g/facadecode/releases): un `.dmg` para macOS (Apple silicon), un instalador para Windows (x64) o un `.deb` para Ubuntu (x64).

**Requisitos previos**: instala las CLI de agentes que quieras usar e inicia sesión en ellas (cualquier combinación de Claude Code, Codex, Antigravity, Muse Code o Qwen Code). Facade Code las ejecuta directamente, con su autenticación y sus suscripciones nativas.

Facade Code se instala junto a VS Code y no comparte nada con él: la configuración, las extensiones y la herramienta de línea de comandos `facade` están totalmente separadas.

## Inicio rápido

1. **Abre un proyecto**:
   ```sh
   facade ~/code/space-shooter
   ```
   O usa **File > Open Folder** (Archivo > Abrir carpeta), o arrastra una carpeta a la barra de espacios de trabajo. La carpeta debe ser un repositorio git (los worktrees necesitan git; ejecuta `git init` primero si empiezas de cero).

2. **Lanza un tech lead**:
   Haz clic en el icono del robot en la barra de título (menú Agent), o ejecuta **Agents: Start Agent...** (iniciar agente) en la paleta de comandos, y elige Claude Code o Codex. Un agente lanzado desde Facade Code viene equipado con las herramientas MCP de Facade.

3. **Dale el prompt de tech lead**:
   ```text
   Eres el tech lead. Usa Facade para construir un shooter espacial neón para navegador
   (escritorio) para una demo, con un PD en GPT Sol 6 (gpt-6-sol, max) vía Codex, que se
   encarga del aspecto y la sensación del juego, y tres ingenieros Muse 1.3
   (muse-spark-1.3, max) trabajando en paralelo. Que sea pequeño, unos treinta minutos
   de construcción: un nivel, tres tipos de enemigos, un jefe de dos fases, power-ups,
   puntuación y combos. Mejor un juego terminado y pulido que uno con más funcionalidades.
   Cada ingeniero integra sus propios cambios y tú los revisas después. Envíame una página HTML
   con un plan breve, un diagrama de carriles y el mockup del PD, y espera mi aprobación
   antes de empezar.
   ```

4. **Mira cómo colabora el equipo**:
   El PD y los ingenieros lanzados aparecen en la barra de espacios de trabajo, bajo su proyecto y su funcionalidad. En cuanto apruebes el plan en HTML, empiezan a construir. Puedes entrar en la terminal de cualquier agente en cualquier momento para ver su salida o hablar con él directamente.

*(Nota: este prompt de ejemplo lanza 5 agentes con el nivel de razonamiento máximo. Ajusta las CLI, los modelos, los niveles de razonamiento y el número de ingenieros según las suscripciones que tengas.)*

## Funcionalidades

### Proyectos y funcionalidades, no sesiones

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

La mayoría de las herramientas de agentes crean un worktree por cada sesión de agente. Facade Code lo hace al revés: cada worktree es una funcionalidad, listada bajo su repositorio, y tú le asignas agentes.

Una funcionalidad suele necesitar más de un agente. El que escribe el código quizá no explique bien su trabajo o no tenga buen ojo para el diseño, así que otros agentes ayudan con la documentación, el diseño y la revisión, todos en el mismo worktree. Los agentes vienen y van; la funcionalidad se queda.

- **Barra de espacios de trabajo**: muestra todos los repositorios y funcionalidades en una sola columna. Haz clic en uno para cambiar toda la ventana (explorador, editores, terminales y control de código fuente), restaurada tal como la dejaste. Los proyectos nunca se mezclan. Consulta [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Ciclo de vida del worktree**: **New Worktree** (nuevo worktree) crea la rama, sincroniza los archivos locales indicados en `.worktreeinclude` y ejecuta la configuración inicial. **Delete Worktree** (eliminar worktree) detalla qué se perdería antes de borrarlo. Consulta [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Subtareas en paralelo**: las tareas independientes pueden ramificarse en worktrees separados.

### Un equipo de todos los proveedores

- **CLI nativas con tus propias suscripciones**: Claude Code, Codex, Muse Code, Antigravity y Qwen Code se ejecutan en sus propias terminales integradas, con las suscripciones que ya tienes.
- **Agentes que lanzan agentes**: un agente puede lanzar otros agentes (con cualquier CLI o modelo de cualquier proveedor) en la funcionalidad actual o en un worktree nuevo, y asignarles tareas. Consulta [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) y [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Mensajería**: los agentes se envían mensajes, reportan resultados a quien los llamó y te avisan cuando una decisión necesita aprobación humana. Consulta [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Se desatascan entre sí**: un agente puede leer la terminal de otro, responder a sus preguntas y enviarle pulsaciones de teclas para ayudar a un ingeniero atascado sin interrumpirte. Consulta [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Puedes intervenir en cualquiera**: cada agente tiene su propia fila de terminal bajo su funcionalidad. Ves lo que está haciendo y puedes escribir directamente en ella en cualquier momento.
- **MCP estándar**: todas las herramientas de orquestación se exponen mediante un servidor MCP estándar.

## Dos formas de trabajar

La atención del desarrollador es el cuello de botella. Los dos modos representan dos niveles de delegación:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Tu papel** | Ingeniero que trabaja directamente en el código | Responsable de ingeniería |
| **Con quién tratas** | Con varios agentes directamente | Con un agente tech lead, 1:1 |
| **Quién coordina a los agentes** | Tú | El tech lead |
| **Ideal para** | Funcionalidades que requieren una guía cercana: trabajo exploratorio, decisiones de diseño que quieres juzgar tú mismo, requisitos cambiantes | Funcionalidades grandes y bien definidas que se dividen con claridad |

Puedes combinar ambos en la misma ventana: supervisar de cerca las funcionalidades delicadas y delegar el trabajo bien acotado a un líder.

- **Super Engineer**: abres worktrees, asignas tareas a agentes en distintos repositorios y revisas el código a medida que cada uno termina.
- **Super Team**: entregas una funcionalidad a un agente como tech lead. Este divide las tareas, define los contratos de interfaz, lanza a los ingenieros y revisa su trabajo.
  - Un modelo potente lidera; modelos más rápidos y económicos, con las suscripciones que ya tienes, implementan en paralelo; y modelos de distintos proveedores revisan el trabajo de los demás.
  - Basta con un prompt para montarlo (consulta [Inicio rápido](#inicio-rápido)); los flujos de equipo que reutilices pueden escribirse como skills.

*(Este README se escribió del mismo modo: un agente analizó, otro redactó y una persona tomó la decisión final.)*

## Por qué

La mayoría de las herramientas de programación con IA caen en dos grupos: IDE al estilo Copilot, en los que una persona tiene que seguir el código línea por línea, e IDE de agentes, en los que la revisión de código y la depuración se delegan a un editor externo. Ninguno reúne a un equipo de agentes nativos de distintos proveedores dentro de tu IDE principal.

Creemos que el futuro es un desarrollador que impulsa varios proyectos y funcionalidades con un equipo de agentes. Cada modelo destaca en tareas distintas, así que el equipo debe abarcar varios proveedores. Y como son los agentes quienes escriben el código que tú revisas, ese equipo tiene que estar en tu IDE.

## Sigue siendo VS Code

Facade Code solo modifica lo que exige la gestión de varios proyectos y de agentes:

- La **barra de espacios de trabajo** ocupa la primera columna; la **barra de actividades** pasa a la esquina superior derecha de la barra de título (se puede restaurar con `workbench.activityBar.location`).
- Copilot y el chat de upstream están desactivados por defecto (una sola opción de configuración los vuelve a activar).
- Todo lo demás es VS Code tal cual: editor, configuración, atajos de teclado, `.vscode/` y archivos `.code-workspace`.
- Las extensiones se instalan desde [Open VSX](https://open-vsx.org). Algunas extensiones propietarias de Microsoft, como Remote Development y C/C++, solo tienen licencia para las compilaciones oficiales de Microsoft y no funcionan en forks.

## Compilar desde el código fuente

Pásale [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) a tu agente y deja que compile.

Para las pautas de contribución y las reglas de ramas, consulta [`CONTRIBUTING.md`](CONTRIBUTING.md) y [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Comentarios

- **Errores e ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) o **Help > Report Issue** (Ayuda > Notificar problema) en el editor.
- **Vulnerabilidades de seguridad**: infórmalas de forma privada según [`SECURITY.md`](SECURITY.md).

## Licencia

MIT, igual que VS Code upstream. Consulta [`LICENSE.txt`](../../LICENSE.txt) para ver el aviso de copyright de Microsoft y los avisos de los colaboradores de Facade Code.
