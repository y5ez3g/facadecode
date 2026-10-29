# Cómo contribuir a Facade Code

Gracias por ayudar. Facade Code se desarrolla en abierto en [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Errores e ideas

Abre una [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Ayuda > Notificar problema) abre una nueva con tu versión ya rellenada. Busca primero entre las issues existentes y, si es un error, indica:

- qué hiciste, qué esperabas y qué ocurrió en realidad;
- la versión, que aparece en Help > About (Ayuda > Acerca de), y tu sistema operativo;
- si es un problema con un agente, qué CLI de agente y qué versión.

Las vulnerabilidades de seguridad no se reportan en issues; consulta [`SECURITY.md`](SECURITY.md).

## Código

Cómo funciona este repositorio está en [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): cómo preparar una compilación, los comandos que comprueban un cambio y las reglas siguientes al completo.

- Crea la rama desde `main` como `feature/<number>-<name>`.
- Fusiona, nunca hagas rebase: una funcionalidad llega a `main` con `--no-ff`, después de la revisión.
- Mantén juntos los archivos de Facade Code y, en los archivos de VS Code, añade hooks opcionales en lugar de reescribir su lógica, para que incorporar una versión más reciente de VS Code siga saliendo barato.
- Cada funcionalidad tiene un interruptor; si lo desactivas, queda VS Code tal cual.
- Cada cambio debe incluir pruebas.
- Escribe en inglés los documentos, los comentarios y los mensajes de commit.

Lo que debe hacer cada funcionalidad está en [`docs/ide/`](../../ide/). Para cambiar un comportamiento, empieza por la especificación o abre antes una issue para comentarlo.

## Licencia

Al contribuir, aceptas que tus contribuciones se publiquen bajo la [licencia MIT](../../../LICENSE.txt) del proyecto.
