# Facade JSON-RPC API v1

本文收录 daemon API v1 和 keeper API v1。第 2 节定义共用报文与版本语义，第 3–6 节列 daemon 方法、权限与行为，第 7 节给 keeper 方法及终端交接，第 8–9 节给发布及验收，第 10 节给核心类型。 [工作清单](daemon-api-redesign.md) · [调用方需求](../../core/islands/facade.md#shell-commands)

## 1. 合同范围

**统一握手，版本独立**。Daemon 和 keeper 都在 `hello` 请求中用 `api_versions:[1]` 提供版本，成功回包用 `api_version:1` 确认。首发两端各自支持的集合都是 `{1}`，分别定义和校验，同包交付。持有 CLI 和终端的 keeper 可以跨 daemon 构建接管继续运行。`jsonrpc:"2.0"` 是两端共用的报文规范。MCP 工具经独立的 relay v1 握手交付。 [MCP relay](../../core/islands/daemon.md#mcp)

**首发切换**。首次正式发布采用第 8 节的冷切规则。正式 API 后续换代遵循第 2 节的最低兼容期。`0.1.6` 等预发行构建中两端的范围握手和旧接管通道在首发时退役。首发按第 8 节整批切换，之后用 `daemon.upgrade` 在使用本合同的构建间热接管。 [原工作清单](daemon-api-redesign.md)

**服务职责**。Daemon 服务用户客户端和其他机器，处理 Agent 地址、权限、远端路由、记录及屏幕订阅。Keeper 在同机独立运行，接受已经解析到本机 CLI 进程的操作，持有操作系统终端并监督 daemon。Agent 的启动和停止，以及 daemon 换构建后的终端恢复，都经过这条本机连接。 [现有 daemon 参考](../../../core/protocol/PROTOCOL.md) · [现有 keeper 参考](../../../core/protocol/KEEPER.md)

**已定的操作语义**。`machine.list` 仅读本机机器表。`agent.list` 默认同步等待无唤醒查询，点名机器可以唤醒。`agent.list` 和 `agent.resume_list` 的本机范围连冷启动也发起零次 SSH。`agent.stop` 接受目标名单或三种显式范围，按范围停止从查询到派发均无唤醒。`machine.connect` 在验证身份后保存对应方向的路由。Daemon 与按需 SSH 各按连续空闲 30 秒回收，前台机器连接、正在使用的 Attach 和在途调用都算活动。共享 PTY 逐维取活跃窗口的最小容量。 [按需 SSH](../../core/islands/daemon.md#network) · [共享尺寸与验收](../../../core/protocol/PROTOCOL.md#viewers-and-queue-limits)

**共同评审的提案**。Daemon 从注册表公布可调用入口和订阅。两端复用 `ErrorBody` 和 `ProcessExit`，集合用 `agents`、计数用 `agent_count`。本机 keeper 用现有 `agent.sync` 交接单个操作系统终端。

## 2. 公共线协议

**连接和报文**。本机使用 `FACADE_HOME` 对应的两个端点。在 macOS 和 Linux 使用 `/tmp/facade-core-<uid>/<service>-<key>.sock`，在 Windows 使用 `\\.\pipe\facade-core-<service>-<key>`。`service` 取 `daemon` 或 `keeper`，`key` 沿用现有 home 路径哈希。同用户访问与进程校验在传输层完成。SSH 机器会话使用同样的 daemon 报文。 [端点和哈希规则](../../../core/protocol/PROTOCOL.md#connect-to-the-daemon)

每行一个带 `jsonrpc:"2.0"` 的 UTF-8 JSON 对象，含换行最多 64 MiB。请求在当前连接的同一方向使用互异的在途整数 `id`，范围为 `0` 至 `u64::MAX`，JavaScript 客户端使用可精确表示的整数。响应原样返回 `id`，并带 `result` 或 `error` 中恰好一项。通知省略 `id`，无需响应。超长请求以 `id:null` 报 `capacity_exceeded` 后关闭连接。`request_id` 是 `agent.start` 和 `agent.send` 跨请求用于重试的业务标识。 [共用请求及应答类型](../../../core/crates/base/src/protocol/jsonrpc.rs) · [行长定义](../../../core/crates/base/src/line.rs)

已认证的 Windows keeper 传输在携带终端的行上允许顶层 `terminal` 成员。它由传输层在通用 JSON-RPC 解码前取出，字段、方向和所有权见第 7 节。Unix 的同一资源由 `SCM_RIGHTS` 随行传递。普通 daemon 和 relay 帧使用共用的 JSON-RPC 对象。

Daemon 沿用每连接最多 16 个普通并发调用、8 MiB 出站队列，以及每视图 1 MiB 增量输出和每 Agent 1 MiB 待输入预算。终端输入、调整尺寸、单帧超出队列预算及掉帧后的完整重绘沿用现有处理。 [现有并发及缓冲规则](../../../core/protocol/PROTOCOL.md#viewers-and-queue-limits)

**握手**。普通 daemon 会话和 keeper 会话都以带 `id` 的 `hello` 开始。`api_versions` 是非空的正整数数组，只列发送端实际启用的版本。发送端去重，接收端将重复元素视为同一个版本，数组顺序不表示偏好。服务端从提供的版本与该端点已启用的版本求交集，选最高值。缺字段、空数组、类型错误或非正整数返回 `-32602 invalid_argument`。格式有效但无交集返回 `-32000 protocol_incompatible`，`error.data.details.supported_api_versions` 必带该端点的支持集合。客户端确认成功回包的 `api_version` 在自己提供的集合中，整个连接使用选中的合同。`build` 是应答服务的软件构建标识。Daemon 本机、SSH 机器和内部已认证的 MCP actor 取 daemon 版本集合，控制连接取 keeper 版本集合。

**同一 daemon socket 的 relay**。未绑定 actor 的外部连接，首个 `hello.params` 带 `relay` 时先分派给现有 relay 入口，校验其自己的 `relay:1`、本机对端和进程身份。成功后转入 MCP 报文流。Daemon 用已认证的 actor 建立内部 `kind:"mcp"` 会话，此会话用 `api_versions` 选择 daemon API。直接从外部 socket 请求 `kind:"mcp"` 返回 `refused`，外部 relay 的 `hello` 用自己的版本字段。 [现有外层分流](../../../core/crates/daemon/src/server/connection.rs#L261) · [内部 actor 会话](../../../core/crates/daemon/src/relays.rs#L333)

**调用**。`call` 传 `{op,args}`，`args` 必须是参数对象，无参数时用 `{}`。操作名用 `resource.verb`，内部机器入口用 `internal.verb_or_operation`，受众和权限见第 3 节。同一资源的公开操作在本机和持有机用同一个类型，内部参数变化通过独立内部入口表达。

### API 演进

1. 两端独立发布 API 版本。对已发布方法或主题改名、删除，改变已有字段的类型、含义、默认值、权限或副作用语义时，只在相应端点的新 API 版本生效。
2. 对已发布报文做加法时，新增字段必须可选，省略时遵循原语义。停止使用的名称保留原含义，供实现和审查检索。
3. v1 接收方校验已知请求参数及判别值。未知请求字段或不受支持的判别值返回 `invalid_argument`，发生在操作副作用之前。
4. 接收方可以忽略未知的可选结果字段、通知字段和未知事件种类。未知的必读状态或错误原因以未知处理，保留报文错误和可用详情供诊断。
5. 在同一个版本内增加操作、主题或兼容的可选字段。Daemon 客户端从 `ops` 和 `topics` 发现额外入口。既有入口若新增依赖服务端实现的可选行为，由握手给出相应能力，调用方确认后才发送该参数。现有 v1 基础行为由本合同定义。
6. 每个端点的 Rust 类型和分派注册表是生成源。生成的 JSON Schema 是机读合同，TypeScript 与参考文档来自相同定义。请求、结果、通知和错误示例须过相应的 schema 测试。 [协议生成测试](../../../core/crates/base/tests/protocol_files.rs) · [现有示例测试](../../../core/crates/base/tests/guide_examples.rs)

7. 正式发布的 API 被替代时，新旧构建必须对被替代版本支持且受换代影响的操作保持双向互通，至少持续到替代版本公开发布满三个月。Daemon 与 keeper 分别记录同时支持的 API 版本和各自替代版本的公开发布日期。退役前确认期限已过，并核验受影响的 Shell、VS Code、SSH 双向调用和 keeper 接管。首次从预发行范围握手切换、CLI 检查点的已发布 0.1.6 互通验收及其发布记录分别适用各自规则。

**错误和事件**。两端的 `error` 都是 `{code,message,data:{reason,details?}}`。`-32700` 表示无法解析 JSON，`-32600` 表示报文结构错误，`-32601` 表示未知方法，`-32602` 表示无效参数或未知 `op`，`-32000` 表示 Facade 业务失败。客户端用稳定的 `data.reason` 分支处理。Daemon 的 `changed` 用 `{watch,change}` 在同一连接上传递各订阅的事件，keeper 的 `changed` 在控制连接上直接携带退出事件。

**标识和集合**。`AgentRef` 是完整的 `{machine_id,agent_id}`，用于 Pin、重连、批量去重和转发。Keeper 只接收本机 `agent_id`。`agents` 表示数组，`agent_count` 表示计数。退出统一使用第 10 节的 `ProcessExit` 类型，系统来源差异见第 7 节。

### Daemon 方法

`AgentTarget` 接收名字、ID 或可复制地址字符串，或一个确切 `AgentRef`。接受调用的 daemon 解析并验证调用身份，持有机核对操作权限。重名时返回结构化候选，MCP actor 的 reach 由创建树和 YOLO 决定。 [寻址与权限](../../../core/protocol/PROTOCOL.md#agent-and-machine-addresses) · [创建树](../../../core/protocol/PROTOCOL.md#yolo-and-creation-trees)

| 方法或通知 | 方向与约定 |
| --- | --- |
| `hello` | 本地客户端及双向机器握手。请求含 `api_versions:[1]`、`build`、`kind`。结果含 `api_version:1`、`build`、`machine_id`、`pid`、`agent_count`、`ops`、`topics` 和可选 `keeper:{pid,build}`。机器请求的 `machine` 带 `{machine_id,boot_id,name}`，结果的 `machine` 带 `{boot_id,name}`，两者都可带 `ssh_cleans_processes`。`connected` 中独立传输的机器身份仍携带完整 `machine_id` 和 `build`，并保留同次已验证握手报告的可选 `ssh_cleans_processes`。 |
| `call` | `{op,args}` → 第 3 节定义的结果或结构化错误。 |
| `watch`、`changed`、`watch_ended`、`unwatch` | `{topic,args}` → `{watch,snapshot}`。随后按序发送 `{watch,change}`，失去远端订阅时送 `{watch,error}`。`unwatch {watch}` → `{}`。连接结束同样释放订阅。 |
| `cancel` | `{id}` → `{}`。`id` 指本连接中的原请求。只撤回粘贴尚未开始的 `agent.send`，原请求以 `cancelled` 结算。其他原请求继续并报告实际结果。关闭连接按原操作的断线规则处理。 |
| `closing` | 接管时 daemon 通知 `{build}`，客户端用同名无 `id` 通知与 `params:{}` 确认，然后重连。 |
| `advertise`、`forward` | 已认证的机器会话。前者交换机器表，后者携带剩余 `route`、已验证的 `caller`、内层 `method/params` 和适用的剩余时间预算。初次通告确认后才使用路径。 |
| `machine.sleeping` | 已认证的机器会话，发送无 `id` 通知及空参数 `{}`。接收端以发送会话的机器身份登记休眠。 |
| `connected`、`connect_failed` | 前台机器流的握手完成或失败通知，分别携带 `{machine,first_connection}` 或 `{error}`。成功时 `machine.ssh_cleans_processes?:boolean` 来自同一已验证对端的握手，未知时省略。Shell 根据已确认的值保留 Add 和 Connect 的 SSH 注销提示。SSH 引导阶段的失败由 CLI 报告。 |

`kind` 为 `terminal`、`ide`、`mcp` 或 `machine`。`mcp` 需要由 daemon 注入的已验证身份，`machine` 必带 `machine` 对象。普通客户端按握手公布的 `ops` 和 `topics` 发业务请求。机器会话通过 `advertise` 和 `forward` 交换请求，其目录公布能转发到该端点的操作和订阅。两类握手的 `agent_count` 均为应答 daemon 本机运行中的 managed Agent 数。显式前台机器连接以 `foreground:true` 给对端登记活动。`closing` 后重连要重新握手。

`forward.params` 为 `{route,caller,method,params,time_left_ms?,from_name?,start_result?}`。`route` 为剩余机器 ID，至少一跳，按顺序转发且拒绝重复 ID。`caller` 为经入口认证的真人 `{kind:"terminal"|"ide",machine_id}` 或 Agent `{kind:"agent",agent:AgentRef,root:AgentRef,yolo}`。`method` 为 `call` 或 `watch`，`params` 是各自参数，转发 Agent 操作用目标机的确切引用。`from_name` 是入口核实的发送者显示名。`start_result:MessageRef` 用于带 prompt 的 Agent 发起启动，入口预留编号，持有机校验编号属于发起机。`agent.start`、`agent.send` 的 `request_id` 仅在业务参数中保留一次。投递进入转发后通过 `time_left_ms` 携带剩余预算，逐跳扣除已耗时间。远端活跃附着成功时，机器应答带第 5 节定义的 `view`。 [现有转发身份与预算](../../../core/crates/base/src/protocol/v3/forwarding.rs) · [投递期限](../../../core/crates/daemon/src/delivery.rs#L386)

```jsonl
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1],"build":"1.0.0+example","kind":"terminal"}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.0+example","machine_id":"11111111-1111-4111-8111-111111111111","pid":4321,"agent_count":1,"ops":["agent.list","agent.stop","agent.inspect","agent.start","agent.resume_list","agent.resume","agent.remove","agent.rename","agent.type","agent.send","agent.screen","attach.resize","cli.list","location.list","machine.list","machine.connect","machine.remove","machine.rename","daemon.status","daemon.log","daemon.upgrade"],"topics":["agents","attach","machines"],"keeper":{"pid":4320,"build":"1.0.0+example"}}}
{"jsonrpc":"2.0","id":2,"method":"hello","params":{"build":"1.0.0+example","kind":"terminal"}}
{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Provide hello.params.api_versions as a non-empty array of positive integers. Use a Facade API v1 build.","data":{"reason":"invalid_argument"}}}
{"jsonrpc":"2.0","id":3,"method":"hello","params":{"api_versions":[2],"build":"example","kind":"terminal"}}
{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"No common daemon API version.","data":{"reason":"protocol_incompatible","details":{"supported_api_versions":[1]}}}}
```

示例中的 `build` 仅代表软件构建，和 API 版本独立。

## 3. 操作目录

**权限**。真人为 `terminal` 或 `ide`，Agent 为带已验证 `Caller::Agent` 的内部 MCP actor。Agent 权限除了本表还要在目标机按创建树、YOLO 和操作能力校验。入口 daemon 派生 `Caller`，机器转发时只使用已认证会话及派生身份。本地客户端提供同名字段也无法改变它。表内「转发」指已认证机器端能作为最终目标执行的公开操作。所有业务操作里，只有 `agent.send` 在粘贴前接受 `cancel`。 [身份与操作入口](../../../core/crates/daemon/src/service.rs) · [Agent 能力](../../../core/crates/daemon/src/records.rs)

表中 `?` 表示可省略。新字段及默认值以本合同为准，其余复用同用途的现有字段定义。第 10 节列核心类型与变更。 [现有生成类型](../../../core/protocol/PROTOCOL.md#types)

| `op` | 请求 → 响应 | 受众及转发 | 合同 |
| --- | --- | --- | --- |
| `agent.list` | `{scope?:Scope}` → `{agents:AgentListEntry[],machines:MachineQuery[]}` | 真人或 Agent，本地入口 | 查活跃 Agent 和 Guest。默认 `reachable`，远端查询用 `internal.agent_records`。 |
| `agent.start` | `StartArgs` → `StartResult` | 真人或 Agent，可转发 | 在目标机校验后创建 worktree 或启动进程。Agent 仍受启动参数和创建树规则限制。 |
| `agent.stop` | `{selection:StopSelection}` → `{items:StopItem[],machines?:MachineQuery[]}` | 真人可选范围或名单，Agent 可按现有权限提交名单。可转发确切引用名单 | 按范围从查询到执行均无唤醒。逐项结算。 |
| `agent.resume_list` | `{scope?:Scope,folder?:string,folder_scope?:"cwd"\|"all"}` → `{items:ResumeCandidate[],machines:MachineQuery[]}` | 真人，可转发点名查询 | 默认 `local`。`folder_scope` 只选择已停止 Agent 的目录范围，默认 `"cwd"`。候选带可以原样传回的 `target`。 |
| `agent.resume` | `{target:ResumeTarget,size:Size,env?:Environment}` → `{agent:AgentInfo,from_saved_session?:boolean}` | 真人，可转发 | 恢复 Agent 或启动独立保存会话。从候选或 Pin 恢复使用确切身份。 |
| `agent.rename` | `{target:AgentTarget,name:string}` → `{agent:AgentInfo,previous_name?:string}` | 真人或 Agent，按目标能力，可转发 | 返回完整更新记录和原名。 |
| `agent.inspect` | `{target:AgentTarget}` → `InspectResult` | 真人或 Agent，按目标能力，可转发 | 返回 Agent、输入状态、会话追踪、附着端和脱敏启动命令。 |
| `agent.screen` | `{target:AgentTarget,lines?:integer}` → `ScreenText` | 真人或 Agent，按目标能力，可转发 | `lines` 默认为 50，范围 1–2000。返回最后屏幕的逻辑文本，可查询已结束记录。 |
| `agent.type` | `{target:AgentTarget,input:TerminalInput}` → `{agent?:AgentLabel}` | 真人或 Agent，按目标能力，可转发 | 文本和按键操作回 Agent 标签。原始终端字节用稳定引用及 Base64，可发送通知。 |
| `agent.send` | `{to:AgentTarget,text:string,reply_to?,request_id?,time_left_ms?,allow_unsupported_receipt?}` → `SendResult` | 真人或 Agent，按目标能力，可转发 | 字符串 `to` 另支持已有的 `#human` 寻址。可转发确切 AgentRef。由来源核实回复引用。投递有 30 秒窗口。 |
| `attach.resize` | `{watch:integer,size:Size,colors?:TerminalColors}` → `{}`，也可无 `id` 发送且无响应 | 真人且拥有本连接的活跃视图。本地入口 | 修改视图的容量，远端用 `internal.attach_resize`。 |
| `agent.remove` | `{target:AgentTarget}` → `{reference:AgentRef,address:string}` | 真人或 Agent，按目标能力，可转发 | 运行中先停止 CLI，再删除记录和收件箱，清理终端状态和屏幕文件。停不下来时返回停止失败，保留记录。 |
| `cli.list` | `{scope?:SingleMachineScope,folder?:string,env?:Environment}` → `{clis:CliInfo[],settings_problem?:string}` | 真人或 Agent，可转发 | 查指定机器的可用 CLI。默认 `local`。 |
| `location.list` | `{scope?:SingleMachineScope,folders?:string[]}` → `{locations:LocationInfo[]}` | 真人或 Agent，可转发 | 查单机工作目录。默认 `local`。 |
| `machine.list` | `{}` → `{machines:MachineInfo[]}` | 真人或 Agent，本地入口 | 读取本机登记表，零 SSH。只有真人会话收到本机保存的 SSH 参数。 |
| `machine.connect` | `{transport:MachineTransportInput,kind:ConnectionKind,expected_machine_id?:string}` → `{transport:MachineTransport,expected_machine_id?:string}` | `terminal`，本地入口 | 授权后把同一连接移交给机器流。`saved` 在通过身份核验并落库后发 `connected`，见第 4 节。 |
| `machine.remove` | `{machine:string,expected_machine_id?:string}` → `{machine_id,reachable,transport?:SshTransport,name?,via?}` | 真人，本地入口 | 删除本机保存路由，关闭相应直连。若有本机保存的 SSH 参数，随 `transport` 返回，供客户端后续使用。 |
| `machine.rename` | `{machine:string,name:string}` → `{machine_id,name,previous_name?}` | 真人，可转发 | 在机器持有端改名。 |
| `daemon.status` | `{scope?:SingleMachineScope}` → `StatusResult` | 真人，可转发 | 查单机状态，默认 `local`。返回本机设置路径、构建、PID、Agent 计数及机器查询信息。 |
| `daemon.log` | `{lines?:integer}` → `{lines:string[]}` | 真人，本地入口 | 日志末尾最多 200 行，省略即 200。 |
| `daemon.upgrade` | `{program,build,daemon_api_versions:[1],keeper_api_versions:[1]}` → `{from,agent_count}` | `terminal`，本地入口 | 分别声明两个端点的真实支持集合。接管已安排后通知 `closing`，见第 8 节。 |

`agent.resume_list` 与 `agent.resume` 分别服务候选选择和实际启动。`daemon.status` 给出 daemon 与设置位置，`agent.inspect` 给出单 Agent 的状态与附着端。编辑器可以用一次 `agent.start` 完成现有的预检和启动，校验在启动副作用之前。 [编辑器实际调用](../../../extension/src/host/orchestrator/agents.ts) · [启动校验](../../../core/crates/daemon/src/operations.rs#L349)

### 启动与恢复往返

`scope` 选执行机器。对本机使用传入的 `env`；跨机调用清掉来源机环境和隐式默认目录，目标机使用其自身环境和默认目录。真人的独立保存会话通过确切 `machine_id`、CLI、会话 ID 和目录恢复。该 `target` 在候选和执行请求中是同一对象，调用者只补 `size` 等运行参数。

```jsonl
{"jsonrpc":"2.0","id":10,"method":"call","params":{"op":"agent.start","args":{"cli":"codex","args":[],"scope":{"kind":"machine","machine":"devbox"},"folder":"/work/app","worktree":"feature/140-example","name":"Nova","size":{"cols":120,"rows":40},"request_id":"start-7"}}}
{"jsonrpc":"2.0","id":10,"result":{"agent":{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","type":"managed","name":"Nova","cli":"codex","args":[],"cwd":"/work/feature-140-example","pid":1234,"process":"running","size":{"cols":120,"rows":40},"created_at":"2026-11-20T17:00:00.000Z","started_at":"2026-11-20T17:00:00.000Z","root":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"yolo":false,"state":"starting","tools_state":"connecting"}}}
{"jsonrpc":"2.0","id":11,"method":"call","params":{"op":"agent.resume_list","args":{"scope":{"kind":"local"},"folder":"/work/app","folder_scope":"all"}}}
{"jsonrpc":"2.0","id":11,"result":{"items":[{"target":{"kind":"session","machine_id":"11111111-1111-4111-8111-111111111111","cli":"codex","session":"7f3e9a1c-e899-4200-a444-555555555555","folder":"/work/app"},"machine_id":"11111111-1111-4111-8111-111111111111","cli":"codex","folder":"/work/app","session":"7f3e9a1c-e899-4200-a444-555555555555","at":"2026-11-20T16:50:00.000Z"}],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
{"jsonrpc":"2.0","id":12,"method":"call","params":{"op":"agent.resume","args":{"target":{"kind":"session","machine_id":"11111111-1111-4111-8111-111111111111","cli":"codex","session":"7f3e9a1c-e899-4200-a444-555555555555","folder":"/work/app"},"size":{"cols":120,"rows":40}}}}
{"jsonrpc":"2.0","id":12,"result":{"agent":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a3"},"address":"a3@laptop","type":"managed","name":"Codex","cli":"codex","args":[],"cwd":"/work/app","pid":1235,"process":"running","size":{"cols":120,"rows":40},"created_at":"2026-11-20T17:00:30.000Z","started_at":"2026-11-20T17:00:30.000Z","root":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a3"},"yolo":false,"state":"starting","tools_state":"connecting"},"from_saved_session":true}}
{"jsonrpc":"2.0","id":14,"method":"call","params":{"op":"agent.send","args":{"to":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"text":"Check the build","request_id":"send-7"}}}
{"jsonrpc":"2.0","id":14,"result":{"id":"m42@devbox","message":{"message_id":"m42","from":"command_line","to":"a2","text":"Check the build","at":"2026-11-20T17:01:00.000Z","delivery":{"status":"success","text_written":"full","enter_written":true,"delivered_via":"terminal","delivered_at":"2026-11-20T17:01:01.000Z"}}}}
{"jsonrpc":"2.0","id":15,"method":"call","params":{"op":"daemon.status","args":{}}}
{"jsonrpc":"2.0","id":15,"result":{"home":"/home/alice/.facade","settings_file":"/home/alice/.facade/facade.json","build":"1.0.0+example","daemon_pid":4321,"keeper_pid":4320,"agent_count":1,"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
```

### 订阅与内部操作

公开和转发订阅使用相同主题名。机器侧 `agents` 只提供自身贡献。授权与类型由同一份注册表执行和生成。

| 主题 | 参数 → 快照及事件 | 受众 |
| --- | --- | --- |
| `agents` | `{}` → `{agents:AgentInfo[],machines:AgentMachineState[]}`，`updated/removed/machine_state` | 真人或 Agent，按可见范围过滤。支持机器侧已有的 `Caller::Terminal` 贡献订阅。 |
| `machines` | `{}` → `MachineInfo[]`，`updated/removed` | 真人或 Agent，本地订阅。与 `machine.list` 采用相同的 SSH 配置可见范围，机器间拓扑用 `advertise`。 |
| `attach` | `AttachArgs` → `ScreenSnapshot`，`output/redraw/activity/exit/removed` | 真人，可转发，目标持有端校验访问。 |

| 仅机器 `op` | 参数 → 结果 | 权限及行为 |
| --- | --- | --- |
| `internal.agent_records` | `{active:boolean}` → `AgentLookupCandidate[]` | 已认证机器会话，按派生 `Caller` 的 reach 投影本机候选。来源 daemon 在处理重名之前用 `has_rule` 做已有操作能力过滤。 |
| `internal.resume_records` | `{}` → `ResumeCandidate[]` | 已认证机器会话，派生真人身份，返回本机已停止且可恢复的 Agent，各目录。 |
| `internal.ensure_route` | `{wake:boolean}` → `{}` | 已认证机器会话，按 `route` 逐跳连接本机保存路径，沿用同一个 `wake`，拒绝环路。 |
| `internal.attach_resize` | `{viewer:integer,boot_id:string,size:Size,colors?:TerminalColors}` → `{}` | 已认证机器会话，属于原 `Caller` 的活跃转发视图才可变更。 |
| `internal.deliver_start_result` | `{recipient:AgentRef,message:Message}` → `{}` | 已认证机器会话，将结果送给已预留回执号的本机 Agent。 |
| `internal.deliver_wait_notice` | `{recipient:AgentRef,waiting:AgentRef,name:string,kind:WaitKind}` → `{}` | 已认证机器会话，接收者及等待对象按现有权限校验。 |

公开握手目录列出本会话可调用的公开入口和订阅，机器握手的 `ops` 和 `topics` 只列本会话作为接收端支持转发的入口。相应调用仍须逐目标校验。`internal.*` 由机器侧目录公布。 [现有分派](../../../core/crates/daemon/src/network_operations.rs) · [逐跳建链](../../../core/crates/daemon/src/network/wake.rs) · [附着视图清理](../../../core/crates/daemon/src/topics.rs)

### 现有入口的调整

| 现有入口 | v1 处理 |
| --- | --- |
| `agent.list` | 保留动作名，增加互斥的 `Scope`，为本次查询同步等待。 |
| `agent.stop` | 保留动作名，单目标作为一项名单提交。目标机复用已有停止执行，最终调用 keeper 的 `agent.stop`。 |
| `agent.start_preflight` | 合入 `agent.start`。编辑器用同一组参数连续调用，启动中继续在 worktree 与进程创建前校验。 |
| `machine.add` | 合入 `machine.connect` 的 `kind:"saved"`。保存与临时连接共用身份验证，保存模式在验证后落库。 |
| `watch screen`、`agent.resize` | 由 `watch attach` 和 `attach.resize` 接替，窗口容量和渲染事件由活跃视图共同决定。 |
| `workspace.import_legacy` | 退出首发 RPC 目录。已有成员用现有扩展一次性导入；本地 Pins 路径及规范化的工作区数据继续读取。 |
| 机器内部查询与通知 | 经 `internal.*` 提供完整注册表、固定类型与机器会话校验。 |

[现有操作目录](../../../core/protocol/PROTOCOL.md#operations) · [编辑器入口](../../../extension/src/host/orchestrator/agents.ts)

## 4. 列表、连接与回程

### 共享查询范围

`Scope` 定义候选机器。命名、显式本机和可见机器范围互斥。`reachable` 的候选包含本机及权限允许的已知机器和已保存连接，机器是否应答用 `machines[].status` 表明。`SingleMachineScope` 是其中的 `local` 与 `machine`，用于单机诊断、发现 CLI、读取位置及选择启动位置。

| 调用 | `local` | `machine` | `reachable` |
| --- | --- | --- | --- |
| `agent.list` | 只取本机贡献，冷启动零 SSH。 | 查唯一目标。复用连接，必要时唤醒目标和跳点。选中本机走本地路径。 | 默认。复用活连接，对待查保存路由并发用 `--no-start`，等待本次查询结束。 |
| `agent.resume_list` | 默认。只取本机已停止的可恢复记录与适用目录的独立保存会话，冷启动零 SSH。 | 查唯一目标，必要时唤醒。指定目标机的 `folder` 才查该处独立保存会话。 | 复用活连接，对待查保存路由并发用 `--no-start`。等待本次查询结束，合并本机和已答机器的可恢复记录。 |
| `agent.stop` 的范围 | 只处理本机，零 SSH。 | 查唯一目标。查询与派发均使用无唤醒路径。 | 同 `agent.list` 的候选，对每个目标沿用无唤醒查询和派发。 |

`agent.resume_list.folder` 为单次查询的绝对工作目录。`scope:local` 或 `reachable` 的本机贡献用该目录，缺省时由 daemon 确定其本地默认目录。`folder_scope:"cwd"` 默认只列该目录的可恢复 Agent，`"all"` 列参与查询机器中各目录的可恢复 Agent。独立保存会话始终只枚举一次已确定的目录，`reachable` 的远端贡献只返回可恢复 Agent。点名机器并省略 `folder` 时，查询其各目录的可恢复 Agent。第 3 节请求 `11` 对应本机各目录 Agent 与调用目录会话。 [现有恢复查询](../../../core/crates/daemon/src/resume.rs) · [IDE 目录选择器](../../../extension/src/ui/pickers/orchestrator.ts#L122)

`agent.list` 对已应答机器合并活跃 managed Agent 与在线 Guest，按 `started_at` 降序，再按 `AgentRef` 排同时间戳。`machines[].status` 给本次查询的 `answered/unavailable/timed_out/error`，与连接观察的 `state` 各自表达。首次通告中出现的在线机器也可加入本批，按完整机器 ID 去重。同一条路由复用已有的同类拨号，采用现有 SSH 和查询阶段限时。 [当前排序与查询](../../../core/crates/daemon/src/network_operations.rs#L136)

默认 `reachable` 的单台登录失败、超时或查询错误放入该台 `machines[]`，仍一次返回本机和所有已答机器的 `agents`。CLI 据未答且非已确认休眠的机器提示 warning，保留退出 0。点名 `machine` 时，选择器冲突或该机器连接、权限或查询失败返回外层 `ErrorBody`，CLI 退出 1。 [现有逐机结算](../../../core/crates/daemon/src/network_operations.rs#L198) · [CLI 列表行为](../../core/islands/facade.md#shell-commands)

```jsonl
{"jsonrpc":"2.0","id":20,"method":"call","params":{"op":"agent.list","args":{"scope":{"kind":"local"}}}}
{"jsonrpc":"2.0","id":20,"result":{"agents":[{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a5"},"address":"a5@laptop","name":"Nova","type":"managed","state":"working","cli":"codex","folder":"/work/app","started_at":"2026-11-20T17:00:00.000Z","title":"Check the build"}],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
{"jsonrpc":"2.0","id":21,"method":"call","params":{"op":"machine.list","args":{}}}
{"jsonrpc":"2.0","id":21,"result":{"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","build":"1.0.0+example","route":[],"connections":[{"machine_id":"22222222-2222-4222-8222-222222222222","initiator_machine_id":"11111111-1111-4111-8111-111111111111","kind":"saved","state":"disconnected","transport":{"kind":"ssh","ssh_destination":"alice@devbox","ssh_args":["alice@devbox"],"remote_home":"/home/alice/.facade"}}]},{"machine_id":"22222222-2222-4222-8222-222222222222","short_id":"22222222","name":"devbox","selector":"devbox","state":"disconnected","last_seen":"2026-11-20T16:59:00.000Z","connections":[]}]}}
{"jsonrpc":"2.0","id":22,"method":"call","params":{"op":"agent.list","args":{"scope":{"kind":"machine","machine":"devbox"}}}}
{"jsonrpc":"2.0","id":22,"result":{"agents":[{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","name":"Nova","type":"managed","state":"working","cli":"codex","folder":"/work/app","started_at":"2026-11-20T17:00:00.000Z","title":"Check the build"}],"machines":[{"machine_id":"22222222-2222-4222-8222-222222222222","short_id":"22222222","name":"devbox","selector":"devbox","state":"online","status":"answered"}]}}
{"jsonrpc":"2.0","id":23,"method":"call","params":{"op":"agent.list","args":{}}}
{"jsonrpc":"2.0","id":23,"result":{"agents":[{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a5"},"address":"a5@laptop","name":"Nova","type":"managed","state":"working","cli":"codex","folder":"/work/app","started_at":"2026-11-20T17:00:00.000Z"}],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"},{"machine_id":"55555555-5555-4555-8555-555555555555","short_id":"55555555","name":"buildvm","selector":"buildvm","state":"ssh_interaction_required","status":"unavailable","ssh_error":"Permission denied (publickey)."}]}}
{"jsonrpc":"2.0","id":24,"method":"call","params":{"op":"agent.list","args":{"scope":{"kind":"machine","machine":"buildvm"}}}}
{"jsonrpc":"2.0","id":24,"error":{"code":-32000,"message":"SSH to buildvm needs an interactive login.","data":{"reason":"ssh_interaction_required","details":{"message":"Permission denied (publickey).","command":["facade","machine","add","alice@buildvm"]}}}}
```

### 握手与连接移交

远端已安装可执行程序时，SSH 引导直接尝试 `machine serve`，无唤醒调用使用 `--no-start`。它用 `hello` 选出的 daemon API 判断可互通性，软件 `build` 用于诊断。两端的软件构建号可以不同。远端未安装时，无唤醒调用报安装要求，明确允许唤醒的流程可走现有安装器。握手失败时用已有错误指引修复。无唤醒探测保留休眠退出码 3，零次安装和唤醒。前台与保存路由的引导共用这条规则。 [现有构建门禁](../../../core/crates/base/src/platform/ssh.rs#L478) · [保存路由的引导](../../../core/crates/daemon/src/network/ssh.rs#L91)

```jsonl
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1],"build":"1.0.0+example","kind":"machine","foreground":true,"machine":{"machine_id":"11111111-1111-4111-8111-111111111111","boot_id":"33333333-3333-4333-8333-333333333333","name":"laptop"}}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.1+example","machine_id":"22222222-2222-4222-8222-222222222222","pid":4322,"agent_count":1,"ops":["agent.start","agent.stop","agent.resume_list","agent.resume","agent.rename","agent.inspect","agent.screen","agent.type","agent.send","agent.remove","cli.list","location.list","machine.rename","daemon.status","internal.agent_records","internal.resume_records","internal.ensure_route","internal.attach_resize","internal.deliver_start_result","internal.deliver_wait_notice"],"topics":["agents","attach"],"machine":{"boot_id":"55555555-5555-4555-8555-555555555555","name":"devbox"}}}
```

`machine.connect` 只在已握手的本地 `terminal` 连接接受。入参和授权应答使用嵌套 `transport`，bridge 只可临时连接。用于保存的 `kind:"saved"` 需要 SSH。执行依次发生。

1. 读取并验证 `transport`。若本机已有同一规范化 SSH 参数及目标 home 的保存记录，从中取得预期机器 ID。调用方提供 `expected_machine_id` 时也必须与该记录相符。冲突在授权前以 `machine_id_mismatch` 拒绝。保存模式在显式和推断的预期 ID 均缺省时，使用同一已验证机器流确认的完整对端 ID 保存或更新配置。
2. 发正常 JSON-RPC 应答 `{transport,expected_machine_id?}` 作为授权。应答已刷出后，同一连接交给机器流，接着转送远端 `hello` 及初始化通告。此连接的后续帧按机器协议处理。
3. 验明对端 `machine_id`，保存模式提交该方向配置，成功后发 `connected {machine,first_connection}`。失败发 `connect_failed {error}` 并关闭该尝试。身份不符或保存失败时保留既有配置。

`machine.connect` 的临时模式和保存模式使用相同的身份验证和传输。一条活动机器流可双向请求。CLI 的回程建立使用第二次独立实际 SSH 验证同一预期机器，验证完成后另行保存。SSH 授权、回程候选地址和撤销规则沿用 CLI 专题。 [本地流移交](../../../core/crates/daemon/src/server/connection.rs#L185) · [保存及登记](../../../core/crates/daemon/src/machine_service.rs#L189) · [CLI 授权与回程](../../core/islands/facade.md#machine)

```jsonl
{"jsonrpc":"2.0","id":30,"method":"call","params":{"op":"machine.connect","args":{"transport":{"kind":"ssh","ssh_destination":"alice@laptop.lan","ssh_args":["alice@laptop.lan"],"remote_home":"/home/alice/.facade"},"kind":"saved","expected_machine_id":"11111111-1111-4111-8111-111111111111"}}}
{"jsonrpc":"2.0","id":30,"result":{"transport":{"kind":"ssh","ssh_destination":"alice@laptop.lan","ssh_args":["alice@laptop.lan"],"remote_home":"/home/alice/.facade"},"expected_machine_id":"11111111-1111-4111-8111-111111111111"}}
{"jsonrpc":"2.0","method":"connected","params":{"machine":{"machine_id":"11111111-1111-4111-8111-111111111111","boot_id":"33333333-3333-4333-8333-333333333333","name":"laptop","build":"1.0.0+example","ssh_cleans_processes":true},"first_connection":true}}
```

下面是另一次已授权连接的身份失败。

```jsonl
{"jsonrpc":"2.0","method":"connect_failed","params":{"error":{"code":-32000,"message":"The SSH target announced a different Facade machine ID. Verify the target and Facade home.","data":{"reason":"machine_id_mismatch","details":{"expected_machine_id":"11111111-1111-4111-8111-111111111111","machine_id":"44444444-4444-4444-8444-444444444444"}}}}}
```

### 机器表、回收与移除

`machine.list` 仅读本机登记和最近观察，冷启动零 SSH。`MachineInfo.state` 中，`disconnected` 表示未探测、主动空闲回收或无介入的已断开，`sleeping` 来自当次运行收到的无唤醒退出码 3 或明确空闲退出通报，`unreachable` 表示最近查询的非交互失败，`ssh_interaction_required` 表示需要登录。断开观察以当前 daemon 生命周期为界，启动后待查询机器显示 `disconnected`。空闲退出前可向已认证对端发送 `{"jsonrpc":"2.0","method":"machine.sleeping","params":{}}`。接收端根据已认证会话确定是哪台机器。EOF 或本机清理闲置连接本身只表明断开。另有 `online` 和 `connecting`。连接项的 `state` 是连接状态，取 `connected/disconnected/ssh_interaction_required`。查询的 `status:"unavailable"` 表示本次未取得贡献。`route:[]` 表示本机，非空数组是经过的机器 ID，省略表示无现行路由。

普通客户端、在运行的 Agent、在途调用、明确的前台机器连接和活跃 Attach 都算活动。`foreground:true` 随机器握手把登记传到对端，流结束时清除。后台同步订阅与保活复用已经打开的 SSH。已知路由在请求时拨号，连续 30 秒无活动的 SSH 和 daemon 分别回收。 [现有会话正向交接](../../../core/crates/daemon/src/server/connection.rs#L185) · [按需 SSH](../../core/islands/daemon.md#network)

`machine.remove` 仅移除本机保存路由并关闭相应直连，零 SSH。未提供 `expected_machine_id` 时按 `machine` 选择目标。提供时要求完整机器 ID，显式 `null` 和无效 ID 在副作用前以 `invalid_argument` 拒绝。有效 ID 在同一次加锁变更中只按该 ID 删除保存记录并取得归一化的 SSH 配置。该 ID 未保存时返回 `not_found`，不再按名称或短 ID 查找。双向移除的两端均使用已核验的完整 ID。结果给被删的本机 `transport`，机器表中的本机保存连接同样带 `transport`。CLI 可用其 `ssh_args` 和 `remote_home` 执行用户明确请求的反向移除。复制保存配置给普通客户端只发生在本机真人会话，机器通告仅传路由所需数据。 [现有连接配置](../../../core/crates/base/src/protocol/v3/machines.rs) · [CLI 移除细节](../../core/islands/facade.md#machine)

```jsonl
{"jsonrpc":"2.0","id":31,"method":"call","params":{"op":"machine.remove","args":{"machine":"devbox","expected_machine_id":"22222222-2222-4222-8222-222222222222"}}}
{"jsonrpc":"2.0","id":31,"result":{"machine_id":"22222222-2222-4222-8222-222222222222","name":"devbox","reachable":false,"transport":{"kind":"ssh","ssh_destination":"alice@devbox","ssh_args":["alice@devbox"],"remote_home":"/home/alice/.facade"}}}
```

## 5. 共享 Attach

`watch {topic:"attach",args:AttachArgs}` 给一个本连接的 `watch` 编号和 `ScreenSnapshot`。活跃视图各自上报容量 `size`。`attach.resize` 以同连接的 `watch` 找视图，带 `id` 的请求以 `{}` 确认已接受容量。实时调整也可省略 `id`，由相同的参数、会话身份与视图归属检查处理，无响应。实际屏幕网格以快照或完整重绘为准。已结束快照可用 `allow_ended` 和精确引用读取，并保留退出状态。此类快照占用零个活跃视图。 [现有快照](../../../core/crates/base/src/protocol/v3/terminal.rs#L108)

远端附着由持有机创建视图并给转发层 `{viewer,boot_id}`，分别表示持有机视图号和该 daemon 实例。它随远端订阅成功应答给来源 daemon，由来源保存到这条活的订阅绑定。公开应答只含 `watch` 和 `snapshot`。转发尺寸用 `internal.attach_resize`，持有机核对该实例、活视图及原始 `Caller`，并在订阅关闭时清理绑定。`watch_ended` 后重新订阅得到新绑定。 [现有视图生命周期](../../../core/crates/daemon/src/topics.rs)

加入、容量变化、`unwatch`、断线或进程结束触发重算。实际网格取活跃视图容量的最小列与最小行。最小网格改变时，先更新 PTY 和解析器网格，再向所有视图发送同一完整重绘，随后继续发增量。大视图加入且最小网格没变时只收到自己的快照。最后一个视图离开保留实际网格。快照和增量输出用标准带填充 Base64 终端字节，接收端先应用附带的 `size` 再应用重绘。`exit` 按现有规则跟在退出前已观察的输出后，`removed` 为最后事件。断线后从新快照重连。 [现有帧与顺序](../../../core/protocol/PROTOCOL.md#screenchange) · [呈现与多端验收](../../core/islands/facade.md#attach)

```jsonl
{"jsonrpc":"2.0","id":40,"method":"watch","params":{"topic":"attach","args":{"target":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"viewer":"editor","size":{"cols":120,"rows":40}}}}
{"jsonrpc":"2.0","id":40,"result":{"watch":7,"snapshot":{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","name":"Nova","size":{"cols":80,"rows":24},"redraw":"G1sySg==","process":"running"}}}
{"jsonrpc":"2.0","id":41,"method":"call","params":{"op":"attach.resize","args":{"watch":7,"size":{"cols":100,"rows":30},"colors":{"background":"#161616"}}}}
{"jsonrpc":"2.0","id":41,"result":{}}
{"jsonrpc":"2.0","method":"call","params":{"op":"attach.resize","args":{"watch":7,"size":{"cols":100,"rows":30}}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":7,"change":{"kind":"output","data":"aGk="}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":7,"change":{"kind":"redraw","size":{"cols":100,"rows":30},"data":"G1sySmhp"}}}
{"jsonrpc":"2.0","id":42,"method":"unwatch","params":{"watch":7}}
{"jsonrpc":"2.0","id":42,"result":{}}
```

示例中较小的第二视图离开后，`100×30` 成为新的实际网格。下列报文展示来源 daemon 在该视图仍活跃时发的内部尺寸更新，两段示例使用各自连接的请求号和订阅号。

```jsonl
{"jsonrpc":"2.0","id":73,"method":"forward","params":{"route":["22222222-2222-4222-8222-222222222222"],"caller":{"kind":"ide","machine_id":"11111111-1111-4111-8111-111111111111"},"method":"call","params":{"op":"internal.attach_resize","args":{"viewer":81,"boot_id":"55555555-5555-4555-8555-555555555555","size":{"cols":100,"rows":30},"colors":{"background":"#161616"}}}}}
{"jsonrpc":"2.0","id":73,"result":{}}
```

## 6. 批量停止与错误

### 停止语义

`selection` 必须选非空名单 `{kind:"targets",targets:AgentTarget[]}` 或范围 `{kind:"all",scope:Scope}`。名单按现有寻址权限解析，按首次出现的确切引用去重。范围以一次查询快照决定待停对象。在查询、建路和派发的每一跳都使用 `wake:false`。派发前断线时后续建链仍受这一策略约束，未送达报 `not_executed`，已送出而结果无法确认报 `outcome_unknown`。每个持有机复用单目标停止，保留 Agent 记录、最终屏幕及可恢复信息。子 Agent 继续运行。MCP 单目标停止提交一项名单并读取这一项的回执，采用原有目标能力、创建树及 YOLO 规则。 [停止执行原语](../../../core/crates/daemon/src/service.rs#L472) · [现有 MCP 停止入口](../../../core/crates/daemon/src/mcp/verified_tools.rs#L142)

结果 `items` 按名单或快照顺序返回。每项含原 `target`，已解析时带 `agent:AgentLabel`，稳定引用与地址在此标签中。只有已确认结束的受控 CLI 得到 `status:"stopped"` 和 `exit`。已结束状态或执行失败得到 `status:"failed"` 和结构化 `error`。显式 Guest 为 `failed` 与 `unsupported`，范围里的 Guest 用 `skipped`，两种都用 `agent.type:"guest"` 识别。整体参数错误或整体鉴权失败用外层错误。范围结果按机器给查询状态，当次确认休眠机器无待停目标。部分失联时已完成项继续返回。

```jsonl
{"jsonrpc":"2.0","id":50,"method":"call","params":{"op":"agent.stop","args":{"selection":{"kind":"targets","targets":["a2@devbox","nobody"]}}}}
{"jsonrpc":"2.0","id":50,"result":{"items":[{"target":"a2@devbox","agent":{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","type":"managed","name":"Nova","cli":"codex","state":"ended","resumable":true},"status":"stopped","exit":{"signal":"SIGHUP","at":"2026-11-20T17:03:00.000Z"}},{"target":"nobody","status":"failed","error":{"code":-32000,"message":"No active agent matches nobody.","data":{"reason":"not_found"}}}]}}
{"jsonrpc":"2.0","id":51,"method":"call","params":{"op":"agent.stop","args":{"selection":{"kind":"all","scope":{"kind":"local"}}}}}
{"jsonrpc":"2.0","id":51,"result":{"items":[{"target":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a9"},"agent":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a9"},"address":"a9@laptop","type":"guest","name":"Cursor","cli":"cursor","state":"online","resumable":false},"status":"skipped"}],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
{"jsonrpc":"2.0","id":52,"method":"call","params":{"op":"agent.stop","args":{"selection":{"kind":"all","scope":{"kind":"machine","machine":"devbox"}}}}}
{"jsonrpc":"2.0","id":52,"result":{"items":[],"machines":[{"machine_id":"22222222-2222-4222-8222-222222222222","short_id":"22222222","name":"devbox","selector":"devbox","state":"sleeping","status":"unavailable"}]}}
{"jsonrpc":"2.0","id":53,"method":"call","params":{"op":"agent.stop","args":{"selection":{"kind":"all","scope":{"kind":"reachable"}}}}}
{"jsonrpc":"2.0","id":53,"result":{"items":[{"target":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a1"},"agent":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a1"},"address":"a1@laptop","type":"managed","name":"Pixel","cli":"codex","state":"ended","resumable":true},"status":"stopped","exit":{"code":0,"at":"2026-11-20T17:03:00.000Z"}}],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"},{"machine_id":"22222222-2222-4222-8222-222222222222","short_id":"22222222","name":"devbox","selector":"devbox","state":"sleeping","status":"unavailable"},{"machine_id":"55555555-5555-4555-8555-555555555555","short_id":"55555555","name":"buildvm","selector":"buildvm","state":"ssh_interaction_required","status":"unavailable","ssh_error":"Permission denied (publickey)."}]}}
```

### 错误及可重试条件

所有可编程错误统一用 `ErrorBody`，即 `{code,message,data:{reason,details?}}`。错误详情里的说明文本叫 `message`。外层错误、`items[].error`、`connect_failed` 和 `watch_ended` 复用同一形状。无详情时省略 `details`。下表列 daemon 发出的 `reason`，`?` 表示详情字段可缺省。

| `reason` | `details` 中适用的字段 | 下一次请求 |
| --- | --- | --- |
| `invalid_argument` | `available_clis?:string[]` | 更正报文或参数后重发。 |
| `not_found` | `record_removal?:"expired"\|"removed"`、`agents?:AgentLabel[]` | 重新查询可操作对象。 |
| `session_not_found` | `sessions?:SessionMatch[]` | 刷新会话列表或选择存在的会话。 |
| `ambiguous_reference` | `candidates?:string[]`、`agents?:AgentLabel[]`、`machines?:MachineQuery[]`、`sessions?:SessionMatch[]` | 选择明确引用后重发。 |
| `ended` | `agents?:AgentLabel[]` | 重新检查 Agent，按用户请求恢复后再操作。 |
| `partial_input` | `{text_written,enter_written?}` 或 `{keys_sent}` | 先看实际屏幕和写入回执，按剩余输入继续。 |
| `unavailable` | `execution?`、`machine?`、`unanswered?:MachineIdentity[]`、`matches?:string[]`、`machines?:MachineQuery[]`、`message_ref?`、`windows?`、`window_delivery?`、`agents?:AgentLabel[]` | 只读可重新查询。副作用按下文的执行状态与重试标识结算。 |
| `protocol_incompatible` | `offered_api_versions?:integer[]`、`supported_api_versions:integer[]`、`agents?:AgentLabel[]` | 切换到相容的构建，或按升级回执结束持有不相容终端的 Agent 后再试。 |
| `machine_id_conflict` | `machine_id:string`、`paths:[string,string]` | 修复冲突机器身份，再重新握手。 |
| `machine_id_mismatch` | `expected_machine_id:string`、`machine_id:string` | 核对 SSH 配置和目标 Facade home。 |
| `ssh_interaction_required` | `message:string`、`command:string[]` | 运行给出的交互修复命令后再连接。 |
| `capacity_exceeded` | — | 缩小报文或等当前队列有空位，按原操作是否已执行处理。行长超限后新建连接。 |
| `internal` | — | 先检查执行现状。只读查询可重试。 |
| `refused` | `entry?:string`、`agents?:AgentLabel[]` | 确认允许执行的调用方、目标或 CLI 配置。 |
| `configuration_invalid` | `entry?:string` | 修复错误中的设置文件或条目，再启动或调用。 |
| `cancelled` | — | 原发送未开始粘贴。若确实要再发送，使用新的请求标识。 |
| `worktree_failed` | `kept?:{branch?:string,path?:string}` | 先处理已经创建并保留的分支或目录。 |
| `upgrading` | — | 调用未开始。重连完成握手后重发，幂等请求沿用原 ID。 |
| `unsupported` | `agents?:AgentLabel[]` | 换到支持该能力的对象或参数。 |

`unavailable` 和 `refused` 的 `details.agents` 只包含已解析且调用方已获准访问的 Agent 标签。因创建树权限被拒时，树外 Agent 的身份和标签仍受保护。

转发失败的 `unavailable.details.execution` 为 `not_executed` 或 `outcome_unknown`。前者表示未送达，可在原权限和唤醒策略下重试。后者表示已送出或无法确认，先查询现状。只有 `agent.start` 和 `agent.send` 可在第 10 节的去重窗口内用同一标识取原结果。批量停止只重试已证实未执行的目标。 [现有错误类型及详情](../../../core/protocol/PROTOCOL.md#errordata) · [发送时限与回执](../../../core/crates/daemon/src/delivery.rs)

```jsonl
{"jsonrpc":"2.0","id":54,"error":{"code":-32000,"message":"SSH to devbox needs an interactive login.","data":{"reason":"ssh_interaction_required","details":{"message":"Host key verification failed.","command":["facade","machine","add","alice@devbox"]}}}}
{"jsonrpc":"2.0","id":55,"error":{"code":-32000,"message":"a2@devbox ended before Enter reached its terminal.","data":{"reason":"partial_input","details":{"text_written":"full","enter_written":false}}}}
{"jsonrpc":"2.0","method":"watch_ended","params":{"watch":7,"error":{"code":-32000,"message":"The route to devbox closed. Open the terminal again.","data":{"reason":"unavailable"}}}}
{"code":-32000,"message":"The link closed after sending stop. Check the agent's current status.","data":{"reason":"unavailable","details":{"execution":"outcome_unknown","machine":{"machine_id":"22222222-2222-4222-8222-222222222222","name":"devbox"}}}}
```

最后一行展示 `items[].error` 的嵌套形状。

## 7. Keeper API

Daemon 经本机 `keeper` 端点连接。Keeper 核对对端的用户、PID 和进程出生标识，且要求身份与 `core/daemon.lock` 一致。Daemon 同样根据 `core/keeper.lock` 校验 keeper 进程。鉴权失败时关闭连接。新获准的 daemon 连接替换旧连接，自行完成新一轮握手。 [服务进程认证](../../../core/crates/base/src/platform/service.rs) · [daemon 连接 keeper](../../../core/crates/daemon/src/runs/keeper_link/client.rs)

### 方法与类型

| 方法或通知 | 方向 | 参数 → 结果 |
| --- | --- | --- |
| `hello` | Daemon → keeper，请求 | `{api_versions:[1]}` → `{api_version:1,build,agents}`。第 2 节的算法使用 keeper 自己的版本集合。每条连接只成功握手一次。`agents` 为所有仍由 keeper 持有的活跃 CLI 快照，无顺序保证。 |
| `call` | Daemon → keeper，请求 | `{op,args}` → 对应操作的结果或共用错误。 |
| `changed` | Keeper → daemon，通知 | `{kind:"exit",agent_id,exit}`。Keeper 处理退出，释放对应记录及终端副本，随后向已握手的 daemon 发送通知。 |

Daemon 发出的 `hello` 和四个 `call` 操作都带请求 `id`。握手前的 `call` 或握手成功后的再次 `hello` 返回 `invalid_argument`。`HeldAgent` 包含 `agent_id:string`、`pid:u32`、`birth:string` 和可选 `stopping:boolean`，省略 `stopping` 表示 `false`。`agent_id` 是本机 `AgentRef.agent_id`。`pid` 和 `birth` 合用识别操作系统进程，`birth` 是由系统提供、只做等值比较的字符串。Keeper v1 固定提供下面四个操作，接收方按第 2 节处理额外字段和未知事件。 [现有 keeper 操作和事件类型](../../../core/crates/base/src/protocol/keeper.rs#L117)

`ProcessExit` 的字段见第 10 节。Daemon 的 Attach 结束状态和 `agent.stop` 回执复用该类型。 [共用进程类型](../../../core/crates/base/src/process.rs)

在 macOS 和 Linux，只有最初启动 CLI 的 keeper 能读取子进程的退出码或信号。新 keeper 经 `agent.sync` 接手后，以观察到的退出时间报告结束，省略 `code` 和 `signal`。Windows keeper 可以从所持进程句柄读取退出码。Daemon 和界面保留未知退出状态。 [Unix 子进程退出](../../../core/crates/keeper/src/cli.rs#L203) · [Windows 退出码](../../../core/crates/keeper/src/windows/cli.rs#L173)

重连以后以 `hello.agents` 和已持久化的运行记录对账。断线期间已经退出的 CLI 从新快照中消失。Daemon 按持有的终端和进程状态记录可确认的退出信息。新连接在恢复期间收到的退出事件由 daemon 现有的 `ExitDelivery` 暂存，对账就绪后依次送给已安装的接收端。 [daemon 恢复与同步](../../../core/crates/daemon/src/runs/keeper_link/mod.rs#L596) · [现有退出事件交付](../../../core/crates/daemon/src/runs/keeper_link/client.rs#L111) · [现有边界测试](../../../core/crates/daemon/src/runs/keeper_link/client.rs#L511)

### 四个操作

| `op` | `args` → `result` | 合同 |
| --- | --- | --- |
| `agent.start` | `{agent_id,command,env,cwd,size:Size}` → `{pid,birth}`，携带终端副本 | `command` 是非空的 `string[]`，首项为可执行程序绝对路径或由 `env.PATH` 查找的程序名。`env` 是完整环境映射，`cwd` 是解析完成的绝对工作目录。Keeper 在新 PTY 或 ConPTY 创建进程并持有一份终端。 |
| `agent.stop` | `{agent_id}` → `{}` | 接受单个本机 CLI 的停止请求。实际结束用 `changed` 通知。Daemon 的批量 `agent.stop` 等待退出、保存记录并汇总。 |
| `agent.sync` | `{agent_id,pid,birth}` → `{}`，请求或应答可携带终端副本 | 恢复时以进程身份匹配记录，把终端交给缺少它的一方。下表定义四种状态。 |
| `daemon.ping` | `{}` → `{}` | Daemon 握手后每秒发送一次。满 15 秒未收到心跳，keeper 结束 daemon。 |

Unix 的 `agent.stop` 向已验明的进程组发送 `SIGHUP`，待 CLI 退出或满 3 秒时用 `SIGKILL` 收尾，以先到者为准。重复请求沿用第一次的截止时间，向进程组发信号前核对组长身份。Windows 中 daemon 先释放自己的 ConPTY 信号管道副本，keeper 释放其副本并终止对应作业对象。Daemon 退出后，仍持有 CLI 的 keeper 从启动器重新启动 daemon，沿用现有的 0.5 秒起至 30 秒重启间隔，稳定运行 60 秒后复位。Daemon 退出且 keeper 已无 CLI 时，keeper 随之退出。 [Unix 请求处理](../../../core/crates/keeper/src/keeper/requests.rs) · [Windows 请求处理](../../../core/crates/keeper/src/windows/requests.rs) · [现有 keeper 生命周期](../../../core/protocol/KEEPER.md#the-daemon)

| `agent.sync` 请求附终端 | Keeper 已持有 | 结果 |
| --- | --- | --- |
| 否 | 是 | 验明 `pid/birth` 后返回 `{}` 及 keeper 的终端副本。 |
| 是 | 否 | 验明进程身份后接管终端，返回 `{}`。若原进程已退出，先返回 `{}`，随后送 `exit` 事件。 |
| 是 | 是 | 验明 `pid/birth` 后关闭这次收到的多余副本，返回 `{}`。 |
| 否 | 否 | 返回 `not_found`。 |

### Keeper 错误

Keeper v1 的错误体沿用第 2 节，其中 `data` 携带 `reason`。

| `data.reason` | 条件 |
| --- | --- |
| `invalid_argument` | 报文解析或方法错误使用第 2 节对应错误码。其余包括握手顺序错误、无效版本数组、业务参数缺失或非法、空命令、目标重复启动、`agent.sync` 进程身份不符或附加多个文件描述符。 |
| `not_found` | `agent.stop` 的目标未持有，或 `agent.sync` 双方都缺终端。 |
| `unavailable` | 创建 CLI、打开工作目录、取得出生标识或建立、复制终端失败。 |
| `protocol_incompatible` | Keeper 版本集合无交集，`details.supported_api_versions` 给出 keeper 支持集合。 |
| `capacity_exceeded` | 报文超过 64 MiB 行长上限。 |

[现有 keeper 错误目录](../../../core/protocol/KEEPER.md#error-reasons) · [共用错误实现](../../../core/crates/base/src/protocol/jsonrpc.rs#L344)

### 终端资源传递

单条报文最多携带一个终端。资源只随 `agent.start` 的成功响应，或 `agent.sync` 的请求及成功响应传递。macOS 和 Linux 在 JSON 行的第一个字节上用 `SCM_RIGHTS` 附一个 PTY master 文件描述符，JSON 内容即下节示例。Windows 把已复制到对端进程的句柄放进 JSON 顶层 `terminal`，必填 `input`、`output` 和 `job`，可选 `signal`，皆为无符号整数。接收方拥有并负责关闭收到的副本。实际传送前校验对端进程身份，未采用的副本关闭。Windows 的 `terminal` 与 `id`、`params` 或 `result` 同级。 [Unix 资源传递](../../../core/crates/base/src/platform/terminal_lines/unix.rs) · [Windows 资源传递](../../../core/crates/base/src/platform/terminal_lines/windows.rs)

### 报文示例

下面是一条 Unix keeper 连接。`id:3` 与 `id:4` 的成功应答各随报文传一个 PTY 文件描述符。最后一次同步传的是退出后已释放的 `a2`，因此返回 `not_found`。

```jsonl
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1]}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.0+example","agents":[{"agent_id":"a1","pid":5113,"birth":"123456789"}]}}
{"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"daemon.ping","args":{}}}
{"jsonrpc":"2.0","id":2,"result":{}}
{"jsonrpc":"2.0","id":3,"method":"call","params":{"op":"agent.start","args":{"agent_id":"a2","command":["/usr/local/bin/codex","--model","gpt-6.2-sol"],"env":{"HOME":"/home/alice","PATH":"/usr/local/bin:/usr/bin","TERM":"xterm-256color"},"cwd":"/work/app","size":{"cols":120,"rows":40}}}}
{"jsonrpc":"2.0","id":3,"result":{"pid":5114,"birth":"123456910"}}
{"jsonrpc":"2.0","id":4,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a1","pid":5113,"birth":"123456789"}}}
{"jsonrpc":"2.0","id":4,"result":{}}
{"jsonrpc":"2.0","id":5,"method":"call","params":{"op":"agent.stop","args":{"agent_id":"a2"}}}
{"jsonrpc":"2.0","id":5,"result":{}}
{"jsonrpc":"2.0","method":"changed","params":{"kind":"exit","agent_id":"a2","exit":{"signal":"SIGHUP","at":"2026-11-20T17:03:00.000Z"}}}
{"jsonrpc":"2.0","id":6,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a2","pid":5114,"birth":"123456910"}}}
{"jsonrpc":"2.0","id":6,"error":{"code":-32000,"message":"Keeper no longer holds a2.","data":{"reason":"not_found"}}}
```

下面是 Windows 上的另一条已握手连接。Daemon 把本机的终端副本交给新 keeper，`terminal` 的值是接收进程中的示例句柄。

```jsonl
{"jsonrpc":"2.0","id":7,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a1","pid":5113,"birth":"134292990000000000"}},"terminal":{"input":796,"output":800,"job":804,"signal":808}}
{"jsonrpc":"2.0","id":7,"result":{}}
```

下面是一条 Unix keeper 接手已有 CLI 后观察到的退出。

```jsonl
{"jsonrpc":"2.0","method":"changed","params":{"kind":"exit","agent_id":"a1","exit":{"at":"2026-11-20T17:04:00.000Z"}}}
```

## 8. 实施与发布

1. **按端点定义版本。** 两端复用 Rust 的 JSON-RPC、版本字段解析、错误和 `ProcessExit` 类型。Daemon 的本机与 SSH 接口统一切到 API v1，daemon 的 keeper 客户端和 keeper 服务同步切到整数版本握手。Keeper 复用现有操作、进程快照和退出事件。分别从实际注册表生成 `core/protocol/PROTOCOL.md` 和 `core/protocol/KEEPER.md`，分别生成 daemon 与 keeper 的 JSON Schema，并从同一 daemon 注册表生成 TypeScript。Keeper 的 Windows 终端句柄信封作为已认证的 keeper 报文样例单独校验。 [keeper 注册表](../../../core/crates/base/src/protocol/keeper.rs) · [协议生成入口](../../../core/crates/base/tests/protocol_files.rs)
2. **联通默认路径。** 先验证 `hello → agent.start → agent.stop → changed` 和 `agent.sync` 的终端传递，再落实第 4–6 节的按需建链、列表、终端订阅和批量停止。平台侧继续使用现有进程和终端传递机制。
3. **验证并首次发布。** 按第 9 节在隔离环境验证本机与 SSH、终端订阅、两个服务各自重连及 v1 构建间接管，一起交付 daemon 和 keeper。

### 首次切换

切换前在仍有旧成员待导入的工作区完成现有 IDE 导入，成员和 Pins 写入当前工作区存储。等预发行构建上的 Agent 结束后退出该构建的 daemon 和 keeper。沿用原 `FACADE_HOME` 和 IDE 工作区存储，同批切换 CLI、扩展、本机软件包和参与互通的 SSH 两端。随后用新构建冷启动，并读取已有 Agent 记录、工作区成员、Pins 与保存的机器路由。首发合同的两个端点都按第 2 节拒绝预发行的范围握手。 [现有工作区持久化与导入](../../../extension/src/host/orchestrator/workspace.ts#L392)

独立的 GitHub-only 0.1.6 dogfood 切换时，所有参与端以及随后新加入的 SSH 机器先用现有 `--package` 或 Windows `-Package` 离线预装同一已验证的 dogfood 发布包，再运行 CLI 和 `facade machine add`。SSH 先尝试已安装程序，通过 API 选版判断互通。`facade upgrade --version` 和获准的自动安装继续取标准 `extension/<version>` 资产。`--no-start` 发起的探测不安装软件也不启动 daemon。手动包安装、已安装程序的 v1 协商、无唤醒探测和标准在线安装分别验收。

### Daemon 构建接管

`daemon.upgrade` 的 `daemon_api_versions` 和 `keeper_api_versions` 分别声明目标构建用于两条连接的实际支持集合，首发都传 `[1]`。正在运行的 daemon 在安装前检查 daemon 集合有交集。若 keeper 仍持有活动 CLI，再检查 keeper 集合包含该 keeper 连接最近已验明的协商版本。失败返回 `protocol_incompatible`，`error.data.details.supported_api_versions` 给被校验端点的已知支持集合，keeper 不相容时 `details.agents` 列出受影响的运行中 Agent。通过后安排接管，返回接管开始时继续托管的 managed `agent_count`。随后发 `closing`，客户端用 `hello` 重连。 [现有独立接管校验](../../../core/crates/daemon/src/lifecycle/takeover.rs#L106)

同一轮已经进入接管处理的并发调用共用首次成功安排的接管结果和构建。已开始拒收工作的 daemon 对后续调用返回 `upgrading`。 [现有接管串行化](../../../core/crates/daemon/src/lifecycle/takeover.rs#L67)

接管时仍持有 CLI 的 keeper 保持运行，保留原进程和终端并启动新的 daemon。新 daemon 用第 7 节的 keeper v1 握手，根据 `hello.agents` 恢复运行记录，并用 `agent.sync` 取得终端。客户端重连后从新的快照恢复 Attach。 [daemon 构建接管](../../../core/crates/daemon/src/lifecycle/takeover.rs) · [keeper 终端恢复](../../../core/crates/daemon/src/runs/keeper_link/mod.rs)

```jsonl
{"jsonrpc":"2.0","id":70,"method":"call","params":{"op":"daemon.upgrade","args":{"program":"/opt/facade/1.0.1/facade","build":"1.0.1+example","daemon_api_versions":[1],"keeper_api_versions":[1]}}}
{"jsonrpc":"2.0","id":70,"result":{"from":"1.0.0+example","agent_count":1}}
{"jsonrpc":"2.0","method":"closing","params":{"build":"1.0.1+example"}}
{"jsonrpc":"2.0","method":"closing","params":{}}
```

### Keeper 替换

Keeper 进程退出时，daemon 保留原来的客户端连接、订阅、网格与终端句柄。客户端继续接收输出并发送输入。Daemon 启动替代 keeper，通过同一个 `agent.sync` 交回所持终端。接手的 keeper 在 Unix 观察到退出时按第 7 节报告未知的退出码或信号。 [现有 keeper 替换行为](../../../core/protocol/PROTOCOL.md#disconnections-and-recovery) · [已有隔离场景](../../../core/tests/tests/keeper.rs#L149)

按产品原则 2–5，先做已观察到的误退出、丢画面和日常列表、停止及直连回程。取消为假设故障预建的路由缓存、分布式批次事务、帧重放和新的背压系统。已有的终端保护、接管与消息回执按现行承诺验收。 [Core 工程约定](../../core/ENGINEERING.md)

## 9. 实现后验收

| 验收路径 | 实际要观察 |
| --- | --- |
| Shell 与协议 | 复用 `core/tests/tests/cli.rs`、`machines.rs`、`attach.rs`、`protocol.rs`、`upgrade.rs` 及 help 快照。裸 `facade machine` 打印帮助，`machine list` 冷启动只读表，`list --local` 和 `stop --local` 冷启动零 SSH。默认列表等待已答远端，`list --machine` 可唤醒点名机器。校验 `--machine` 帮助与 SSH 参数区内误放的 Facade 选项。 |
| 列表的部分结果 | 一台远端不可查询时，默认列表保留本机和其他已答机器的 Agent，回包有对应未答机器行。点名该机失败得到外层错误。既有跨机同名选择仍按规则能力排除不适用的目标。 |
| 机器状态 | 冷启动后显示 `Disconnected`。确认无唤醒探测退出码 3 或收到远端空闲退出通报后显示 `Sleeping`。本机 daemon 重启后显示 `Disconnected`，再次探测后更新。分别验证连接错误与交互认证状态。 |
| 批量停止 | 覆盖四种形式、互斥检查、重复引用及 Guest。`stop --machine` 和 `stop --all` 保持远端休眠。混合在线、休眠和需重登机器时，`stop --all` 先处理已答目标，再报非休眠机器错误并退出 1。 |
| 升级 | 双来源不同版本取较高者，单来源有效时采用其版本。两处 Core 版本文件 404 且本机版本不低于发布标签时使用已是最新回执。下载只使用有效 Core 版本文件或显式 `--version`，后者跳过 `latest`。 |
| 本机可恢复列表 | 在本机不同目录留可恢复 Agent 与保存会话，并在远端留一个可恢复 Agent。冷启动查询 `scope:local` 和 `folder_scope:all`，核对本机各目录 Agent、指定目录独立会话、仅本机的 `machines` 和零次 SSH。用返回的确切 `target` 直接恢复。 |
| SSH 及回程 | 隔离的双机环境先证明前台 `connect`、空闲读屏及在途调用跨过 30 秒仍可用。活动收尾后看两端各自回收及无需后台拨号。确认 B 使用当前 `SSH_CONNECTION` 的源地址实际回拨，验明 A 的 ID 后，两边各用自己的保存路径独立冷拨。缺地址、需要登录、回拨失败或 ID 不符时都保留正向，环路被拒。 |
| SSH 密钥授权 | 验证已有免交互凭据的复用、首次密码登录后专用公钥的安装、重新添加同一机器后更新保存参数，以及空闲回收后的独立重连。确认 Windows 共享管理员回执。正反向验证或保存失败时核对精确回滚。离线移除时确认零次 SSH，验证已标记的本机入站公钥被撤销及权限不足时的提示。 |
| 编辑器和终端 | 复用 extension 的独立多窗口、远程测试入口。按 `120×40` VS Code → `80×24` Shell → 关闭小 Shell → `150×45` Shell → detach VS Code 验证每步网格、同帧、键入 `hi` 在下次 resize 前可见、81 字符换行、光标、断线清理。另查 start 直接返回可显示 Agent、Resume/Pins 和 Remove。 |
| 首次切换 | 用已有结束 Agent、工作区成员、Pins 和保存路由的隔离 home。对仍待导入的工作区走现有导入路径，再启动首发构建。核对原有数据与新 v1 握手，核对两端均拒绝预发行的范围握手。 |
| Daemon v1 接管 | 用两个采用本合同的构建验证接管。记录 daemon、keeper 和 CLI 的身份。新 daemon 接回同一 keeper 和终端，CLI 的 `pid/birth`、Agent 引用、会话与回执继续可用。客户端重连取 Attach 快照。分别核对 daemon 版本声明及运行中 keeper 的版本校验。 |
| Keeper 替换 | 复用现有 keeper 退出场景，验证同一 daemon 连接及 Attach 订阅继续收帧和读写，终端交给新 keeper 后仍是同一进程。在 Unix 核对接手 CLI 的退出状态按未知显示。 |
| API 握手与 relay | 本机、SSH、内部 MCP actor 和 keeper 协商各自的 API。普通 daemon 目录按受众生成，keeper 给持有快照。使用独立会话复用 `tools/list` 和 `tools/call` 场景确认外部 `relay:1` 的分流。外部 `kind:"mcp"` 和与 keeper 锁身份不符的连接被拒。 |
| Keeper 进程和终端 | 复用 `core/tests/tests/keeper.rs` 的隔离场景，分别在 Unix 和 Windows 校验 `agent.start` 的终端资源、`agent.stop` 的即时确认和随后退出事件、`agent.sync` 的四种持有状态、身份错误和退出竞态。断线期间让测试 CLI 退出，再以新握手核对快照和 daemon 恢复的记录。核对 `daemon.ping` 及最终 `ProcessExit`。 |

计划的校验入口为 `core/scripts/test-all.ps1` 或 `test-all.sh`、`cargo test -p facade-base --test protocol_files --test guide_examples`，以及扩展的 `test:integration`、`test:remote`。每轮在临时 `FACADE_HOME`、HOME、临时 SSH 配置和独立 IDE user-data/extensions 目录运行，用 `facade-fakecli`。运行验收在实现后执行。 [Core 场景测试说明](../../../core/README.md#build-and-test) · [扩展测试入口](../../../extension/package.json) · [远程场景](../../../extension/src/test/integration/remote.ts)

### 版本与分流验收矩阵

| 输入或场景 | 应观察到的结果 |
| --- | --- |
| 终端、IDE、SSH 机器、已验证的内部 MCP actor 分别提供 `[1]` | daemon 选择 `1`。三类目录按本地身份、机器受众等条件返回。 |
| Keeper 客户端提供 `[1]` | keeper 独立选择 `1`，返回持有的活跃进程集合。 |
| 接收重复的 `[1,1]`、缺字段、空数组或错误类型 | 重复选择 `1`。缺字段、空数组与错误类型报 `invalid_argument`。预发行范围报文因缺新字段被拒。 |
| 合法版本列表与本端无交集 | `protocol_incompatible` 且 `details.supported_api_versions:[1]`。记录未修改。 |
| dogfood 离线预装、标准在线安装、已安装优先和无唤醒 | 用同一已验证的 dogfood 发布包预装参与机器及新机器。分开核对标准 `extension/<version>` 安装、已装程序的 v1 握手，以及 `--no-start` 零安装、零唤醒。 |
| 同 API 的两个软件构建，通过两个保存方向分别冷拨 | 两个方向均先尝试已有远端程序。使用 `--no-start` 时验证休眠判定，活动端均完成 `hello`。 |
| 外层 `hello.params.relay:1`；外部伪造 `kind:"mcp"` | 第一种走 relay 的既有认证和 MCP 流。第二种报 `refused`。 |
| 接管目标集合兼容 daemon，活 keeper 所用版本与目标集合无交集 | 安装前拒绝接管，`details.agents` 指出受影响对象，当前 keeper 和终端保持供原 daemon 使用。 |
| 正式 API 后续换代 | 按 daemon 与 keeper 分别记账。从相应替代版本公开发布起至少三个月内，受影响的旧操作在新旧构建间双向互通，并核验相应的 Shell、VS Code、SSH 和 keeper 接管链路。 |

## 10. 核心线类型

本节定义 v1 评审中的字段与约束。`?:` 表示属性可省略。属性省略时采用下表默认值，允许 `null` 的类型会显式设定。未修改的嵌套记录及枚举复用当前注册表的同用途字段、必填和缺省值，例如 `StateDetail`、`Said`、`ToolsReason`、`CliInfo`、`LocationInfo`、`InputInfo`、`AttachmentInfo`、`TerminalColors`、`SessionMatch`、`AgentMachineState`、`ScreenBuffer`、`WindowDelivery`。v1 的输入、输出和严格请求校验从同一 Rust 定义生成。 [现有生成类型全集](../../../core/protocol/PROTOCOL.md#types)

### 身份、范围及请求

| 类型 | JSON 形状和约束 |
| --- | --- |
| `AgentRef` | 必填 `{machine_id:string,agent_id:string}`。`machine_id` 为完整机器 UUID，`agent_id` 是持有机分配的本地 ID。 |
| `AgentTarget` | 非空选择字符串或完整 `AgentRef`。字符串支持已有名称、编号和可复制地址。转发时持有机接收精确引用。 |
| `Scope` | `{kind:"local"}`、`{kind:"reachable"}`、`{kind:"machine",machine:string}` 中恰好一种。选定机器可用其可复制选择器，`machine` 只用于第三种。 |
| `SingleMachineScope` | `Scope` 的 `local` 和 `machine` 两种。 |
| `Size` | `{cols:integer,rows:integer}`，列数 2–65,535，行数 1–65,535。 |
| `Environment` | `{[name:string]:string}`。面向人的启动与恢复省略时使用执行机默认环境。Keeper 接收到的是 daemon 已解析的完整环境。 |
| `ResumeTarget` | `{kind:"agent",reference:AgentRef}`、`{kind:"session",machine_id:string,cli:string,session:string,folder:string}` 或 `{kind:"selector",selector:string,scope?:SingleMachineScope,folder?:string}`。会话目录必须是目标机绝对路径，确切会话给完整 ID。选择器型支持公共地址、已有 Agent 名称以及会话 ID 或前缀。 |
| `ResumeCandidate` | `{target:ResumeTarget,machine_id:string,cli:string,folder:string,session:string,agent?:AgentRef,name?:string,stopped?:boolean,title?:string,at?:timestamp}`。返回的 `target` 使用已经确定的 agent 或 session 形状。 |
| `StopSelection` | `{kind:"targets",targets:AgentTarget[]}` 或 `{kind:"all",scope:Scope}`。名单非空。 |
| `StopItem` | `{target:AgentTarget,agent?:AgentLabel,status:"stopped"\|"failed"\|"skipped",exit?:ProcessExit,error?:ErrorBody}`。已解析时有 `agent`，`stopped` 必带 `exit`，`failed` 必带 `error`。 |
| `TerminalInput` | `{kind:"text",text:string,enter?:boolean}`、`{kind:"keys",keys:string[]}`、`{kind:"raw",raw:string}`。`enter` 默认 `false`。空文本加 `enter:true` 只发 Enter。`keys` 是按顺序的按键，沿用现有按键名。`raw` 为标准带填充 Base64 字节，使用确切的 `AgentRef`，实时输入可用通知。各形状字段互斥。 |
| `StartArgs` | `{cli:string,size:Size,args?:string[],scope?:SingleMachineScope,folder?:string,folder_is_default?:boolean,worktree?:string,model?:string,effort?:string,name?:string,prompt?:string,env?:Environment,request_id?:string,call_id?:string}`。`scope` 默认 `local`，`args` 默认 `[]`，`folder_is_default` 默认 `false`。`call_id` 由已认证的 actor 关联真实调用。 |
| `StartResult` | `{agent:AgentInfo,prompt?:Message,result_message_id?:string,result_message_machine_id?:string,repeated?:boolean}`。仅在有消息回执的路径带相应字段。 |
| `InspectResult` | `{agent:AgentInfo,input:InputInfo,session_tracking:boolean,viewers:string[],rule?:string,started_by?:AgentCreator,attachments?:AttachmentInfo[],launch_command?:string}`。命令已脱敏。 |

`agent.send` 的 `to` 为 `AgentTarget`，字符串允许 `#human`。`text` 非空白，最多 8,000 Unicode 码点及 540 行，只接受已有的可打印字符、制表及换行。`reply_to` 可用消息地址字符串或 `MessageRef {machine_id,message_id}`，入口解析并核对。`time_left_ms` 缺省或上限为 29,500 毫秒。`allow_unsupported_receipt` 默认 `false`，仅 terminal 可请求该回执。`SendResult` 为 `{id:string,message:Message,recipient?:AgentLabel,repeated?:boolean,withdrawn?:boolean,expected_reply_to?:MessageRef}`。`id` 是消息地址。`Message` 的编号、消息引用、发送者、接收者、文本、回复、投递及回执字段沿用现行消息格式，使用下文的 `Delivery` 类型。 [现有消息字段](../../../core/protocol/PROTOCOL.md#message) · [发送约束](../../../core/protocol/PROTOCOL.md#sendargs) · [按键语义](../../../core/protocol/PROTOCOL.md#text-and-keys)

`request_id` 是 1–200 个 Unicode 码点，从首次执行起保留一小时，重试不会延长有效期。重试必须使用相同参数与目的地。启动按执行机、已验证的发起机器与调用身份、`request_id` 去重，投递按持有机、发件人及其机器、收件人、`request_id` 去重。入口保留发送目标的解析结果，重试继续使用该目标。窗口内相同标识取已有结果或并入在途执行。过期或换 ID 可能执行一次新操作。 [现有请求 ID 约束](../../../core/crates/daemon/src/operations.rs#L176) · [启动去重](../../../core/crates/daemon/src/store/mod.rs#L426) · [投递去重](../../../core/crates/daemon/src/delivery.rs#L303)

### Agent 记录和屏幕

| 类型 | 字段 | 约定 |
| --- | --- | --- |
| `AgentInfo` | `reference:AgentRef`、`address:string`、`type:"managed"\|"guest"`、`name:string`、`cli:string`、`args:string[]`、`cwd:string` | 完整身份、可复制地址及实际工作目录。 |
| `AgentInfo` | `label?:string`、`unreachable?:boolean`、`model?:string`、`effort?:string`、`title?:string` | 客户端投影和可选启动配置。`unreachable` 缺省为 `false`。 |
| `AgentInfo` | `pid?:u32`、`process:"running"\|"ended"\|"unknown"`、`size?:Size`、`created_at:timestamp`、`started_at:timestamp` | 进程和共享网格。Guest 可省略进程号和尺寸。 |
| `AgentInfo` | `creator_kind?:"agent"\|"command_line"\|"vs_code"`、`creator?:AgentRef`、`root:AgentRef`、`yolo:boolean` | 创建者、创建树和该次启动的权限快照。 |
| `AgentInfo` | `exit?:ProcessExit`、`session?:string`、`state:AgentState`、`state_detail?:StateDetail`、`said?:Said`、`tools_state:ToolsState`、`tools_reason?:ToolsReason` | 进程结算、可恢复会话、运行观测和工具可用性。 |
| `AgentLabel` | `{reference:AgentRef,address:string,type:"managed"\|"guest",name:string,cli:string,state:AgentState,resumable:boolean}` | 定位及结算所需的较小记录。 |
| `AgentListEntry` | `{reference:AgentRef,address:string,name:string,type:"managed"\|"guest",state:AgentState,cli:string,folder:string,started_at:timestamp,title?:string}` | 活跃列表行，`address` 为 CLI ID 列的来源。 |
| `AgentLookupCandidate` | `{agent:AgentInfo,has_rule:boolean}` | 仅用于 `internal.agent_records`。`has_rule` 指持有机确认的 CLI 规则，覆盖拥有规则但未注入工具的进程。名称解析先使用它检查发送、恢复等操作的候选资格。 [现有候选及能力检查](../../../core/crates/daemon/src/records.rs#L191) |
| `AttachArgs` | `{target:AgentTarget,size?:Size,viewer?:string,keep_scrollback?:boolean,include_scrollback?:boolean,allow_ended?:boolean,report_activity?:boolean}` | `include_scrollback` 默认 `true`，其他布尔默认 `false`。提供 `allow_ended` 时必须是稳定引用。 |
| `ScreenSnapshot` | `{reference:AgentRef,address:string,size:Size,redraw:string,name?:string,exit?:ProcessExit,exit_status?:i32,resume_hint?:string,process?:ProcessState,working?:boolean}` | 终端绘制所需实际网格，`redraw` 为带填充 Base64。 |
| `ScreenText` | `{reference:AgentRef,address:string,name?:string,process:ProcessState,observed_at:timestamp,buffer:ScreenBuffer,text:string,line_count:u32,older_lines:boolean,trimmed:boolean}` | 一次读取的逻辑行与其屏幕状态。 |

`AgentState` 为 `starting`、`working`、`waiting_for_you`、`just_done`、`idle`、`error`、`ended`、`unknown` 或 Guest 的 `online`。`ToolsState` 为 `not_injected`、`connecting`、`available` 或 `unavailable`。`timestamp` 为带毫秒的 UTC ISO 8601 字符串。`output` 变更带 Base64 `data`，`redraw` 带 `{size,data}`。`activity/exit/removed` 沿用现有事件字段，`exit` 中的进程退出统一用 `ProcessExit`。 [现有状态定义](../../../core/protocol/PROTOCOL.md#states) · [终端变更](../../../core/protocol/PROTOCOL.md#screenchange)

### 机器记录

| 类型 | 字段 | 约定 |
| --- | --- | --- |
| `MachineIdentity` | `{machine_id:string,name:string}` | 持久身份和当时的显示名。 |
| `MachineInfo` | `machine_id:string`、`short_id:string`、`name:string`、`selector:string`、`state:MachineState`、`connections:MachineConnection[]` | `short_id` 为完整 UUID 的八位首段，只用于展示或现有无歧义选择。持久引用用完整 ID。 |
| `MachineInfo` | `boot_id?:string`、`build?:string`、`last_seen?:timestamp`、`ssh_error?:string`、`route?:string[]` | 该视图已观察到的进程身份、构建、连接数据。`route` 的空数组、非空和省略区分见第 4 节。 |
| `MachineQuery` | `{machine_id:string,short_id:string,name:string,selector:string,state:MachineState,status:QueryStatus,build?:string,last_seen?:timestamp,ssh_error?:string,error?:string}` | `QueryStatus` 为 `answered`、`unavailable`、`timed_out` 或 `error`。 |
| `MachineConnection` | `{machine_id:string,initiator_machine_id:string,kind:ConnectionKind,state:ConnectionState,transport?:SshTransport,ssh_interaction?:SshInteraction}` | `MachineConnection.state` 为 `connected`、`disconnected` 或 `ssh_interaction_required`。`kind` 为 `saved` 或 `temporary`。 |
| `MachineTransportInput` | `{kind:"ssh",ssh_destination:string,ssh_args?:string[],remote_home?:string}` 或 `{kind:"bridge"}` | 授权请求可省略 SSH argv。 |
| `MachineTransport` | `SshTransport` 或 `{kind:"bridge"}` | 授权应答携带归一化配置。 |
| `SshTransport` | `{kind:"ssh",ssh_destination:string,ssh_args:string[],remote_home?:string}` | `ssh_args` 是供调用 OpenSSH 的归一化 argv。 |
| `SshInteraction` | `{message:string,command:string[]}` | 可显示的诊断及修复 argv。 |
| `StatusResult` | `{home:string,settings_file:string,build:string,daemon_pid:u32,keeper_pid?:u32,agent_count:integer,machines:MachineQuery[]}` | 同 `hello` 的 Agent 计数口径。 |

`MachineState` 为 `online`、`connecting`、`disconnected`、`sleeping`、`unreachable` 或 `ssh_interaction_required`。机器初始或重发通告传 `advertise {machines:MachineInfo[]}`，按已认证对端替换其贡献。路由沿用仅传拓扑字段、终点与机器 ID 匹配和环路拒绝的规则。 [现有机器类型](../../../core/crates/base/src/protocol/v3/machines.rs) · [路由校验](../../../core/crates/daemon/src/network/routes.rs)

### 回执和错误

| 类型 | 字段 | 约定 |
| --- | --- | --- |
| `ProcessExit` | `{at:timestamp,code?:i32,signal?:string,reason?:"terminal_closed"}` | `code` 和 `signal` 互斥。未知时省略二者，`at` 是观察时间。 |
| `Delivery` | `status:"pending"\|"success"\|"failure"`、`text_written:"none"\|"partial"\|"full"\|"unknown"` | 当前结算状态和终端文字写入程度。 |
| `Delivery` | `reason?`、`enter_written?:boolean`、`deadline?:timestamp`、`delivered_via?:"terminal"\|"read"\|"notified"`、`delivered_at?:timestamp` | `reason` 为 `ended/input_draft/input_interaction/input_unknown/timeout/submission_unconfirmed/unsupported`之一。截止时间用于等待中消息，交付字段表示已知原因和效果。 |
| `ErrorBody` | `{code:integer,message:string,data:ErrorData}` | 机器分支按 `code` 和 `data.reason`，文本可显示。 |
| `ErrorData` | `{reason:string,details?:object}` | 已知原因和对应详情见第 6、7 节。`details` 里的 `execution` 为 `not_executed` 或 `outcome_unknown`。未知详情可忽略。 |

[现有投递模型](../../../core/protocol/PROTOCOL.md#delivery) · [现有退出类型](../../../core/crates/base/src/process.rs)
