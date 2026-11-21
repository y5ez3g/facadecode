# Facade CLI 与 JSON-RPC API v1 工作清单

桌面 `#1.md` 一共有八项。这里按原编号记录目标、已知现状和验收方式。CLI 验收检查点沿用 daemon protocol 3 和 keeper 的范围握手。正式 JSON-RPC API v1 首发再切换两端的版本协商。

## 1. 保留 `facade machine list`

`facade machine` 显示帮助，`facade machine list` 列出本机登记的机器和已知连接状态。读表发起的 SSH 次数为零。

无活连接且当前 daemon 没记到连接失败时显示 `Disconnected`。当前 daemon 经无唤醒探测收到退出码 3，或收到远端明确的空闲退出通报时，记录 `Sleeping`。此观察只保存在本次运行的内存中，重启后待探测的机器显示 `Disconnected`。非交互连接或协议错误显示 `Unreachable`，需要交互认证显示 `Needs SSH login`。

实现时恢复工作树中相应的子命令、帮助快照、诊断提示和文档。验收裸命令与 `--help` 一致，`machine list` 正常读表。 [机器命令帮助](../../../core/tests/golden/help/machine.txt)

## 2. 修机器会话误退出，改成按需 SSH

实测中远端在机器握手成功后 5 秒退出。握手交接放掉普通连接的计数，正在使用的机器会话需要用自己的活动状态阻止空闲退出。显式前台 `machine connect`、正在看屏幕的 `attach` 和在途调用都算正在使用。 [连接交接](../../../core/crates/daemon/src/server/connection.rs#L185) · [daemon 空闲退出](../../../core/crates/daemon/src/lifecycle/mod.rs#L229)

- `machine add` 验证后保存 SSH 目标和机器身份。后续调用按需建立会话，可按命令语义在 SSH 上拉起远端 daemon。
- 已有 SSH 凭据可以免交互重连时直接复用。首次需要密码时，登录成功后安装 Facade 专用公钥，并以 `-o BatchMode=yes -o IdentitiesOnly=yes -i <key>` 做独立验证。同一 `machine_id` 校验与保存成功后，更新该机已保存的 `ssh_args` 和连接配置。 [CLI 定稿](../../core/islands/facade.md#machine) · [现有保存规则](../../../core/crates/daemon/src/machine_service.rs#L288)
- daemon 连续空闲 30 秒退出。Facade 管理的闲置 SSH 连续 30 秒没有用户使用就收掉，保存的路由供下次复用。取消对断线路由约每 10 秒的后台拨号，已开连接继续用保活判断断线。
- `facade list` 同步等待所需的按需连接，继续返回同样的列表格式、排序和结果语义。默认路径对已保存路由含 `Disconnected` 发起 `--no-start` 探测，只跳过本次确认休眠的机器。`list --machine` 可以唤醒点名远端，`list --local` 发起零次 SSH。
- `facade resume --local` 只列本机可恢复的已停止 Agent 和当前目录已保存的 CLI 会话。冷启动同样发起零次 SSH。CLI 检查点以 `agent.resume_list {local:true}` 限定本机。正式 v1 使用 `scope:{kind:"local"}` 并按调用方选择 `folder_scope`。正式 API 省略 `scope` 默认为本机，Shell 默认查询显式传 `reachable`。

验收前台连接与正在读屏的 attach 在无输入时保持可用，最后的活动结束后可回收，下一次查询或点名操作能按规则重新连接。 [生命周期与列表细节](../../core/islands/daemon.md#network)

## 3. 发布 daemon 和 keeper JSON-RPC API v1

- 核对已验收的 CLI 报文和正式 v1 的方法、操作、订阅、参数、结果、事件和错误。报文继续使用 `jsonrpc:"2.0"`。Daemon 与 keeper 各提供 `api_versions:[1]`，响应分别选出 `api_version:1`。外部 MCP relay 使用独立的 `relay:1` 握手。
- 首发前在旧版完成工作区成员导入，等旧 Agent 结束，停止 daemon 和 keeper，同批替换 Shell、VS Code、服务及参与互通的 SSH 两端。核对 Facade home、Agent 记录、回执、成员、Pins 和保存的 SSH 路由。两端首发都拒绝预发行的范围握手。
- 独立 GitHub-only 0.1.6 dogfood 通过现有 `--package` 或 `-Package` 离线预装同一已验证发布包。所有参与端和新加入的 SSH 机器都先安装，再运行 `facade machine add`。SSH 使用已安装程序和 v1 握手确定互通。`upgrade --version` 与获准的自动安装继续使用标准 `extension/<version>` 资产。
- 分开验收离线预装、已安装程序优先、`--no-start` 零安装及零唤醒、标准在线安装，以及不同构建号的 v1 双向冷连。CLI 检查点与已发布 0.1.6 的互通是单独的验收项。
- 用正式 v1 的两个软件构建验证 daemon 热接管。目标分别提供 daemon 和 keeper 支持的 API 版本。仍持有 CLI 的 keeper 必须兼容目标，成功后保持原 keeper、CLI 身份及终端，客户端重新握手和订阅。
- 正式 API 被替代后，从对应替代版本公开发布起至少三个月，新旧构建必须对受影响的旧版支持操作保持双向互通。Daemon 与 keeper 分别记录兼容版本集合和发布日期。退役前检查期限及受影响的 Shell、VS Code、SSH 双向路径和 keeper 接管。
- 对 daemon 和 keeper 分别校验生成的 JSON Schema、参考文档和实例，包括已认证的 Windows keeper 终端信封。逐项对照作为报文与覆盖清单。

[CLI 检查点 → 正式 v1 报文对照](protocol-versions.html) · [正式版本演进](protocol-versions.html#policy-title) · [API 合同](v3-api-plan.md)

## 4. 同一个 Agent 的多端 Attach 实时同步

当前 PTY 采用最后一次 attach 或 resize 的尺寸。小窗口画不下大帧时会停画，下一次可显示的完整重绘才带回已输入的内容。这能解释在另一端看到 `hi` 要等到 resize 的复现。 [旧版尺寸入口对照](protocol-versions.html#api-ops-agent.resize)

- 按活跃 attach 记录各窗口实际的列数和行数。Shell 拖窗使用系统终端尺寸事件，VS Code 使用终端尺寸回调。加入、resize、detach 或断线都重算。
- PTY 使用所有活跃窗口的最小列数和最小行数。网格真变时才调 PTY 并同步重绘，之后继续分发增量。只剩一个窗口时跟随它的容量。
- 验收 VS Code 加小 Shell、关小 Shell、加大 Shell、detach VS Code 的完整顺序。每步共享网格正确，两端收到同一份画面和回显，输入 `hi` 后另一端在下一次 resize 前就能看到。

[尺寸规则与验收](v3-api-plan.md#9-实现后验收)

## 5. 升级先判断有没有新版

目前 `facade upgrade` 先从 GitHub 或官网取安装器。两个来源都没取到脚本时会在这个阶段报错。已经是最新版的回执由成功运行的安装器输出，用户报的 HTTP 404 因此发生在版本比较之前。 [安装器下载](../../../core/crates/base/src/platform/install.rs#L43) · [CLI 结果处理](../../../core/crates/facade/src/upgrade.rs#L11)

复查结果与报错吻合。GitHub 的 `latest/download/install.ps1` 跳到 `extension/0.1.5` 后返回 404，官网的 `/install.ps1` 也返回 404，两个无版本的 Core 版本文件入口目前也返回 404。两个来源的 `0.1.6` 固定版本 Windows 安装器均返回 200。发布脚本把预发行候选版放在固定版本入口，晋升稳定版时才切换 `latest` 和官网的稳定版本文件。 [0.1.6 发布说明](https://github.com/y5ez3g/facadecode/releases/tag/extension%2F0.1.6) · [晋升流程](../../../extension/scripts/release.mjs#L397)

默认升级读取 GitHub 与官网的 `facade-core-version.txt`，取两处合法语义化版本中的较高者。仅一处有效就采用该版本。下载目标须来自文件中的有效 Core 版本且高于本机版本。两处文件都 404 时，GitHub `releases/latest` 的跳转标签只用于判断本机版本是否已经足够新。本机版本不低于该标签时输出 `Facade <current> is already up to date in <bin>.` 并退出 0。Core 版本文件有效且本机已是最新时也采用此回执。版本信息无法确认时报告检查失败，目标资产缺失时指出版本、文件和 HTTP 状态。显式 `--version X.Y.Z` 跳过 `latest` 检查并安装指定版本。

验收双来源版本不一致、仅一处有效、已是最新、预发行版高于稳定通道、指定版本直装、检查失败和新版资产缺失。Rustup 也先读发布元数据并比较版本，相同时跳过下载更新程序。 [Rustup 自更新实现](https://github.com/rust-lang/rustup/blob/1.28.2/src/cli/self_update.rs#L1054-L1103)

## 6. 调整帮助里的 Agents 顺序

`facade --help` 的 Agents 区按 **start → stop → list → resume → rename** 显示。更新帮助文本和对应快照。 [当前帮助](../../../core/tests/golden/help/root.txt#L18)

`list`、`resume`、`stop` 的 `--machine <MACHINE>` 帮助统一用 `on that machine only`，`--local` 用 `on this machine only`。

## 7. 支持从对面主动连接回来

一条活的 SSH 机器会话已经能双向传 Facade 请求。缺的是原会话释放后，VM 仍有可用的回程。普通 `machine add` 只在发起的一端保存路由。

- `facade machine add --bidirectional <SSH_ARGS>...` 一次完成正向登记和回程验证。`-b <bind_address>` 作为 SSH 参数透传。Facade 选项 `--bidirectional`、`--home` 或 `--home=...` 写在 SSH 参数前。在 SSH 参数区且位于 `--` 分隔符前遇到它们时，本地报用法错误并退出 2。
- 需要授权时在已认证的正向连接内交换专用公钥和主机验证所需的公钥。普通授权回执用 `allows <user> on <facade_machine> to log in to <remote_user>@<ssh_host> without a password`。Windows 共享管理员授权回执写明 `to local Administrators on <host> via C:\ProgramData\ssh\administrators_authorized_keys`。对端从 `SSH_CONNECTION` 取源地址回拨 SSH，核验发起机的 `machine_id` 后保存回程。正向或回程验证或保存失败时，只撤销该方向本次新加且按完整公钥精确匹配的授权和主机信任条目。回程失败退出 1 并保留正向登记。 [CLI 定稿](../../core/islands/facade.md#machine) · [Windows OpenSSH 密钥规则](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)
- `facade machine remove <MACHINE>` 发起零次 SSH，删除本机保存的出站路由，并按所返回的 `machine_id` 清理本机授权文件中带 `# facade:<name>:<machine_id>` 标记的入站公钥。Windows 共享管理员授权文件需要更高权限时，保留路由删除结果并提示本机授权尚需清理。
- `facade machine remove --bidirectional <MACHINE>` 用保存的 SSH 路由确认对端身份，清理对端曾保存的回程与该机器对的 Facade 授权，再执行本机删除。两条删除请求都用已核验的完整 `expected_machine_id`。回程已不存在时仍核对并清理授权。对端离线、身份不符或清理失败仍完成本机删除，分别报告并退出 1。
- 笔记本处于只能出站的 NAT 下时，可以用前台 `machine connect` 保持可双向调用的会话。连接结束后，VM 主动发起操作需要一条仍可达的回程。
- 验收两边的 `facade machine list` 都能看到已登记的对端。原会话关闭后，两端各自用 `facade list --machine <对端>` 重新连上并查询。验证连接回路时按机器 ID 去重，转发使用无重复机器的路径。现有路由代码已有环检查。 [路由校验](../../../core/crates/daemon/src/network/routes.rs#L21)

## 8. `facade stop` 支持多 Agent 和全部停止

以下四种方式互斥。按范围执行时，选择范围内可停止的运行中 managed Agent。 [当前单 Agent 用法](../../../core/tests/golden/help/stop.txt)

| 命令 | 范围 |
| --- | --- |
| `facade stop <AGENT>...` | 显式列出的一个或多个 Agent。 |
| `facade stop --local` | 本机。 |
| `facade stop --machine <MACHINE>` | 点名机器，通过 `--no-start` 探测。 |
| `facade stop --all` | 与 `facade list` 默认查询范围一致，对已保存路由含 `Disconnected` 使用 `--no-start`。 |

本次探测确认 `Sleeping` 的目标跳过。两种远端范围都保持休眠中的 daemon 休眠。统一按现有单 Agent 停止语义执行，保留记录、最后屏幕和可恢复会话。`stop --all` 先处理可达目标，再对失联或需重登的非休眠机器报 `error:` 并退出 1。验收四种范围、互斥校验、休眠远端及部分失败。

## 建议顺序

先收尾 #1 和 #6，同时处理已有使用故障 #2、#4、#5。按定稿的命令和 API 契约实施 #7、#8。完成 CLI 互通验收后进入 #3。发布正式 v1 前完成冷切、接管、生成协议和端到端检查。

## CLI 和线协议对应

CLI 行为以 `cli-plan.md` 为准。前一列来自已验收的 CLI 生成目录，后一列来自正式 v1 合同及已评审的冻结接口。

| CLI 用法 | 已验收的 CLI 线协议 | 正式 API v1 |
| --- | --- | --- |
| `facade machine list` | `machine.list {}` | 同名，仅读本机机器表。SSH 传输归入 `connections[].transport`。 |
| `facade list [--local \| --machine M]` | `list {scope?}` | `agent.list {scope?}`，默认 `reachable`。 |
| `facade resume --local` | `agent.resume_list {local:true}` | `agent.resume_list {scope:{kind:"local"},folder?,folder_scope?}`。Shell 默认列表显式传 `reachable`。 |
| `facade stop A B`、`--local`、`--machine M`、`--all` | `stop {selection}` | `agent.stop {selection}`，按目标返回结果。范围路径全程无唤醒。 |
| `facade attach A` | `watch attach` 和 `attach.resize {watch,cols,rows}`，兼容 `screen` 和 `agent.resize` | `watch attach` 用 `target`，`attach.resize {watch,size}` 按本连接查找视图。两边均支持实时无 `id` 尺寸通知。 |
| `facade machine add --bidirectional B` | `machine.connect` 的 `saved` 模式，按能力传 `expected_machine_id` | 同样独立核验正向和回程。授权结果给出归一化 `transport`，`connected` 保留已核实的 SSH 进程清理提示字段。 |
| `facade machine remove B` 或 `--bidirectional B` | `machine.remove` 可按能力传完整 ID，返回旧式 SSH 目的地字段 | 可选完整 `expected_machine_id`，同次变更返回完整规范化 SSH `transport`，两边精确保护的清理规则见第 7 节。 |
| `facade resume REFERENCE`、`facade status [AGENT]` | `agent.resume`、`daemon.status` 和 `agent.inspect` | 同名，通过 `target`、`scope` 和 `size` 表达，状态计数用 `agent_count`。 |

[CLI 定稿](../../core/islands/facade.md#shell-commands) · [逐项报文对照](protocol-versions.html)

## 实施交接

实施负责人按源码核对 `resume --machine` 的远端会话过滤、专用密钥独立验证与同机凭据更新边界、回滚未完成时的残留授权报告、旧版本接管拒绝路径，以及 attach 从首帧维护本地屏幕。
