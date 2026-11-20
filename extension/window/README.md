<div align="center">

<img src="https://raw.githubusercontent.com/y5ez3g/facadecode/main/extension/media/icon.png" alt="Facade Code" width="96">

# Facade Code Window Component

**Cleans up stale Facade Code terminal tabs.**

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![Facade Code: install](https://img.shields.io/badge/Facade%20Code-install-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![GitHub: y5ez3g/facadecode](https://img.shields.io/badge/GitHub-y5ez3g%2Ffacadecode-335e78?style=flat)](https://github.com/y5ez3g/facadecode)

</div>

> **Facade Code and this component always install together.** Install [Facade Code](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) (also on [Open VSX](https://open-vsx.org/extension/facade/facadecode)) and VS Code installs this component alongside it; installing this component installs Facade Code too. On its own it shows nothing.

## What it does

When a remote VS Code window reconnects or the extension restarts, the Window Component removes leftover terminal
tabs from the previous connection. It runs on the local VS Code client. The VS Code entry point continues to
work without it, with stale tab cleanup unavailable.

## Old engine transition

The old engine still uses the Window Component for its existing window functions. If the old engine asks for
the component, install or enable it locally and reload the window.

## License

MIT. See [`LICENSE.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/LICENSE.txt) and [`ThirdPartyNotices.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/ThirdPartyNotices.txt).

<sub>Facade Code is an independent product and is not affiliated with, endorsed by, or sponsored by the providers of the third-party tools shown. All third-party trademarks and logos belong to their respective owners.</sub>
