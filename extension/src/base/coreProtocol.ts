// Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit.

export const PROTOCOL = 3;
export const OLDEST_PROTOCOL = 3;
export const METHODS = ["hello","call","watch","unwatch","cancel","changed","watch_ended","advertise","forward","connected","connect_failed","closing"] as const;
export const TOPICS = ["agents","screen","machines"] as const;
export const OPS = ["agent.list","agent.inspect","agent.start","agent.start_preflight","agent.resume_list","agent.resume","location.list","cli.list","agent.stop","agent.remove","agent.rename","agent.type","agent.send","agent.resize","agent.screen","daemon.status","workspace.import_legacy","machine.list","machine.add","machine.connect","machine.remove","machine.rename","daemon.log","daemon.upgrade"] as const;
export type Topic = typeof TOPICS[number];
export type Operation = keyof Operations;
export type Operations = V3Operations;
export type Topics = V3Topics;
export type V3Topic = keyof V3Topics;
export type V3Operation = keyof V3Operations;

export type AdvertiseParams = V3AdvertiseParams;

export type AgentArgs = V3AgentArgs;

/** The source of an agent's start, as displayed to the caller. */
export type AgentCreator = { readonly kind: 'agent'; readonly address: string } | { readonly kind: 'command_line' } | { readonly kind: 'vs_code' };

export type AgentInfo = V3AgentInfo;

export type AgentKind = 'managed' | 'guest';

/** The identity and state of the reachable agent selected by an operation or offered as a match. */
export interface AgentLabel {
	readonly reference: AgentRef;
	readonly address: string;
	readonly name: string;
	readonly cli: string;
	readonly state: V3AgentState;
	readonly resumable: boolean;
}

/** A roster row and the exact reference to use for later operations. */
export interface AgentListEntry {
	readonly reference: AgentRef;
	readonly id: string;
	readonly name: string;
	readonly type: AgentKind;
	readonly state: V3AgentState;
	readonly cli: string;
	readonly title?: string;
	readonly folder: string;
	readonly started_at: string;
}

export type AgentListResult = V3AgentListResult;

/** A public roster row. The ID is the agent's copyable address. */
export interface AgentListRow {
	readonly id: string;
	readonly name: string;
	readonly type: AgentKind;
	readonly state: V3AgentState;
	readonly cli: string;
	readonly title?: string;
	readonly folder: string;
	readonly started_at: string;
}

export type AgentMachineState = V3AgentMachineState;

/** An agent's durable identity, independently of names and routes. */
export interface AgentRef {
	readonly machine_id: string;
	readonly agent_id: string;
}

/** The recorded cause of an agent record's removal. */
export type AgentRemoval = 'expired' | 'removed';

export type AgentState = V3AgentState;

export type AgentSyncState = 'synced' | 'pending' | 'unreachable';

export type AgentTarget = { readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef };

export type AgentsChange = V3AgentsChange;

export type AgentsSnapshot = V3AgentsSnapshot;

export interface AttachmentInfo {
	readonly kind: AttachmentKind;
	readonly machine_id: string;
}

export type AttachmentKind = 'shell' | 'vs_code';

/** Parameters for `call`. */
export type CallParams = { readonly op: 'agent.list'; readonly args: MachineQueryArgs } | { readonly op: 'agent.inspect'; readonly args: V3AgentArgs } | { readonly op: 'agent.start'; readonly args: V3StartArgs } | { readonly op: 'agent.start_preflight'; readonly args: V3StartArgs } | { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } | { readonly op: 'agent.resume'; readonly args: V3ResumeArgs } | { readonly op: 'location.list'; readonly args: LocationListArgs } | { readonly op: 'cli.list'; readonly args: CliListArgs } | { readonly op: 'agent.stop'; readonly args: V3AgentArgs } | { readonly op: 'agent.remove'; readonly args: V3AgentArgs } | { readonly op: 'agent.rename'; readonly args: V3RenameArgs } | { readonly op: 'agent.type'; readonly args: V3TypeArgs } | { readonly op: 'agent.send'; readonly args: V3SendArgs } | { readonly op: 'agent.resize'; readonly args: V3ResizeArgs } | { readonly op: 'agent.screen'; readonly args: V3ScreenArgs } | { readonly op: 'daemon.status'; readonly args: StatusArgs } | { readonly op: 'workspace.import_legacy'; readonly args: LegacyWorkspaceArgs } | { readonly op: 'machine.list'; readonly args: NoArgs } | { readonly op: 'machine.add'; readonly args: V3MachineAddArgs } | { readonly op: 'machine.connect'; readonly args: V3MachineConnectArgs } | { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } | { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } | { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } | { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs };

export type Caller = V3Caller;

/** A `changed` notification for one watch. */
export interface ChangedParams {
	readonly watch: number;
	readonly change: V3AgentsChange | ScreenChange | V3MachinesChange;
}

/** A CLI a start can run: an entry of Facade's settings file (CONFIGURATION-2.1). */
export interface CliInfo {
	readonly cli: string;
	readonly display_name: string;
	readonly available: boolean;
	readonly problem?: string;
	readonly not_installed?: boolean;
	readonly overrides: Overrides;
}

/** Lists CLIs using the selected machine's launch environment and working folder. */
export interface CliListArgs {
	readonly machine?: string;
	readonly folder?: string;
	readonly env?: { readonly [key: string]: string };
}

export interface CliListResult {
	readonly clis: CliInfo[];
	readonly settings_problem?: string;
}

/** The kind of client connecting to the daemon. */
export type ClientKind = 'terminal' | 'mcp' | 'ide' | 'machine';

/** Foreground handshake failed after local authorization. */
export interface ConnectFailedParams {
	readonly error: ErrorBody;
}

/** Connection verified on the foreground stream. */
export interface ConnectedParams {
	readonly machine: MachineHello;
	readonly first_connection: boolean;
}

export type ConnectionKind = 'saved' | 'temporary';

export type ConnectionState = 'connected' | 'unavailable' | 'ssh_interaction_required';

export type CreatorKind = 'agent' | 'command_line' | 'vs_code';

/** Arguments for `daemon.log`. */
export interface DaemonLogArgs {
	readonly lines?: number;
}

/** The result of `daemon.log`. */
export interface DaemonLogResult {
	readonly lines: string[];
}

export type DeliverStartResultArgs = V3DeliverStartResultArgs;

/** How a message was delivered. */
export type DeliveredVia = 'terminal' | 'read' | 'notified';

/** What became of a message. */
export interface Delivery {
	readonly status: DeliveryStatus;
	readonly reason?: DeliveryFailure;
	readonly text_written: TextWritten;
	readonly enter_written?: boolean;
	readonly deadline?: string;
	readonly delivered_via?: DeliveredVia;
	readonly delivered_at?: string;
}

/** Why a message was not delivered. */
export type DeliveryFailure = 'ended' | 'input_draft' | 'input_interaction' | 'input_unknown' | 'timeout' | 'submission_unconfirmed' | 'unsupported';

/** The state of a message's delivery. */
export type DeliveryStatus = 'pending' | 'success' | 'failure';

/** An empty success result: `{}`. */
export type EmptyResult = Record<string, never>;

/** Why an exit has no code or signal. */
export type EndReason = 'terminal_closed';

/** A request error. */
export interface ErrorBody {
	readonly code: number;
	readonly message: string;
	readonly data: ErrorData;
}

/** Error details for clients to inspect. */
export interface ErrorData {
	readonly reason: Reason;
	readonly text_written?: TextWritten;
	readonly enter_written?: boolean;
	readonly keys_sent?: number;
	readonly kept?: Kept;
	readonly entry?: string;
	readonly protocol?: ProtocolMismatch;
	readonly available_clis?: string[];
	readonly message_ref?: MessageRef;
	readonly record_removal?: AgentRemoval;
	readonly machine_id_conflict?: MachineIdConflict;
	readonly ssh_interaction?: SshInteraction;
	readonly unavailable?: Unavailable;
	readonly candidates?: string[];
	readonly agents?: AgentLabel[];
	readonly machines?: V3MachineQueryResult[];
	readonly sessions?: SessionMatch[];
}

export type ExecutionOutcome = 'not_executed' | 'outcome_unknown';

export type ForwardCall = V3ForwardCall;

export type ForwardParams = V3ForwardParams;

export type HelloParams = V3HelloParams;

/** The result of `hello`: daemon details and supported topics and operations. */
export interface HelloResult {
	readonly protocol: number;
	readonly build: string;
	readonly machine_id: string;
	readonly machine?: MachineHello;
	readonly ops: string[];
	readonly pid: number;
	readonly topics: string[];
	readonly agents: number;
	readonly keeper?: KeeperInfo;
}

/** Rows of a draft scrolled out of the CLI's input, as the CLI marks them. */
export interface HiddenRows {
	readonly above: number;
	readonly below: number;
}

/** How an agent's process ended. */
export type HowEnded = 'normal' | 'stopped' | 'crashed';

/** A complete inbox message as the receiving MCP client reads it. */
export interface InboxMessage {
	readonly id: string;
	readonly from: string;
	readonly at: string;
	readonly text: string;
	readonly reply_to?: string;
}

/** An agent's message input as its screen shows it now. */
export interface InputInfo {
	readonly state: InputState;
	readonly evidence: string;
	readonly mechanism?: InputMechanism;
	readonly hidden?: HiddenRows;
}

/** The layout a CLI's rule reads its input from. */
export type InputMechanism = 'frame' | 'prompt' | 'editor' | 'box' | 'prompt_row';

/** How an agent's message input reads on its screen. A reading never means input may be typed. */
export type InputState = 'usable' | 'draft' | 'interaction' | 'unknown';

export type InspectResult = V3InspectResult;

/** The keeper holding the agents' terminals. */
export interface KeeperInfo {
	readonly pid: number;
	readonly build: string;
}

/** What a worktree creation that failed partway made, which stays: its branch, its folder, or both. */
export interface Kept {
	readonly branch?: string;
	readonly path?: string;
}

/** One legacy workspace selector from the specified machine. */
export type LegacyWorkspaceArgs = { readonly machine_id: string; readonly workspace_key?: string; readonly window_id?: string; readonly instance_id?: string } & ({ readonly workspace_key: string; readonly window_id?: never; readonly instance_id?: never } | { readonly workspace_key?: never; readonly window_id: string; readonly instance_id?: never } | { readonly workspace_key?: never; readonly window_id?: never; readonly instance_id: string });

export interface LegacyWorkspaceResult {
	readonly agents: AgentRef[];
	readonly machines: V3MachineQueryResult[];
}

export type LocationInfo = V3LocationInfo;

/** What a location is. */
export type LocationKind = 'folder' | 'main' | 'worktree';

export interface LocationListArgs {
	readonly machine?: string;
	readonly folders?: string[];
}

export type LocationListResult = V3LocationListResult;

export type MachineAddArgs = V3MachineAddArgs;

/** The saved connection is ready. */
export interface MachineAddResult {
	readonly machine: MachineHello;
	readonly first_connection: boolean;
}

export type MachineConnectArgs = V3MachineConnectArgs;

export type MachineConnectResult = V3MachineConnectResult;

export type MachineConnection = V3MachineConnection;

/** The introduction on each side of a machine hello. */
export interface MachineHello {
	readonly machine_id: string;
	readonly boot_id: string;
	readonly name: string;
	readonly build: string;
	readonly protocol: [number, number];
	readonly ssh_cleans_processes?: boolean;
}

export interface MachineIdConflict {
	readonly machine_id: string;
	readonly paths: [string, string];
}

/** A machine's persistent identity and current display name. */
export interface MachineIdentity {
	readonly machine_id: string;
	readonly name: string;
}

export type MachineInfo = V3MachineInfo;

export type MachineListResult = V3MachineListResult;

/** A frame from either direction of a machine session. A request without an ID is a notification. */
export type MachineMessage = Request | Response;

/** Selects a machine for a query. An omitted selector uses the operation's default. */
export interface MachineQueryArgs {
	readonly machine?: string;
}

export type MachineQueryResult = V3MachineQueryResult;

export type MachineQueryStatus = 'answered' | 'unavailable' | 'timed_out' | 'error';

export interface MachineRemoveArgs {
	readonly machine: string;
}

export interface MachineRemoveResult {
	readonly machine_id: string;
	readonly name?: string;
	readonly ssh_destination: string;
	readonly remote_home?: string;
	readonly reachable: boolean;
	readonly via?: string;
}

export interface MachineRenameArgs {
	readonly machine: string;
	readonly name: string;
}

export interface MachineRenameResult {
	readonly machine_id: string;
	readonly name: string;
	readonly previous_name?: string;
}

export type MachineState = 'online' | 'connecting' | 'sleeping' | 'unreachable' | 'ssh_interaction_required';

export type MachineTransport = V3MachineTransport;

export type MachinesChange = V3MachinesChange;

export type Message = V3Message;

/** A message's identity on the machine that assigned its number. */
export interface MessageRef {
	readonly machine_id: string;
	readonly message_id: string;
}

/** Empty arguments: `{}`. May be omitted for topics that take no arguments. */
export type NoArgs = Record<string, never>;

/** A message without an ID or response, such as `changed`. */
export interface Notification {
	readonly jsonrpc?: string;
	readonly method: string;
	readonly params?: unknown;
}

/** Whether a start can choose a CLI's model and its effort. */
export interface Overrides {
	readonly model: boolean;
	readonly effort: boolean;
}

/** A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as
 * exit code zero. */
export interface ProcessExit {
	readonly code?: number;
	readonly signal?: string;
	readonly reason?: EndReason;
	readonly at: string;
}

/** The reported process state of an agent. */
export type ProcessState = 'running' | 'ended';

/** A start prompt's message ID and what became of it. */
export interface PromptOutcome {
	readonly message_id: string;
	readonly delivery: Delivery;
}

export interface ProtocolMismatch {
	readonly local_build: string;
	readonly local_protocol: [number, number];
	readonly remote_build: string;
	readonly remote_protocol: [number, number];
}

/** The public MCP inbox request. */
export interface ReadMessagesArgs {
	readonly after?: string;
	readonly last?: number;
	readonly wait?: boolean;
	readonly reply_to?: string;
}

export interface ReadMessagesResult {
	readonly messages: InboxMessage[];
	readonly next_cursor?: string;
}

/** Error reasons shared by both protocols. */
export type Reason = 'invalid_argument' | 'not_found' | 'session_not_found' | 'ambiguous_reference' | 'ended' | 'partial_input' | 'unavailable' | 'protocol_incompatible' | 'machine_id_conflict' | 'ssh_interaction_required' | 'capacity_exceeded' | 'internal' | 'refused' | 'configuration_invalid' | 'cancelled' | 'worktree_failed' | 'upgrading' | 'unsupported';

export interface RemoveResult {
	readonly reference: AgentRef;
	readonly address: string;
}

export type RenameArgs = V3RenameArgs;

/** An agent's details. */
export interface RenameResult {
	readonly agent_id: string;
	readonly address: string;
	readonly type: AgentKind;
	readonly label?: string;
	readonly unreachable?: boolean;
	readonly name: string;
	readonly cli: string;
	readonly args: string[];
	readonly model?: string;
	readonly effort?: string;
	readonly title?: string;
	readonly cwd: string;
	readonly machine_id: string;
	readonly pid?: number;
	readonly process: ProcessState;
	readonly cols?: number;
	readonly rows?: number;
	readonly created_at: string;
	readonly started_at: string;
	readonly creator_kind?: CreatorKind;
	readonly creator?: string;
	readonly creator_machine_id?: string;
	readonly root: string;
	readonly root_machine_id?: string;
	readonly yolo: boolean;
	readonly exit?: ProcessExit;
	readonly session?: string;
	readonly state: V3AgentState;
	readonly state_detail?: StateDetail;
	readonly said?: Said;
	readonly tools_state: ToolsState;
	readonly tools_reason?: ToolsReason;
	readonly previous_name?: string;
}

/** A method call. Calls with an ID receive a response; calls without an ID are notifications. */
export interface Request {
	readonly jsonrpc?: string;
	readonly id?: number;
	readonly method: string;
	readonly params?: unknown;
}

export type ResizeArgs = V3ResizeArgs;

/** A response containing either a result or an error. */
export interface Response {
	readonly jsonrpc?: string;
	readonly id: number | null;
	readonly result?: unknown;
	readonly error?: ErrorBody;
}

export type ResumeArgs = V3ResumeArgs;

export interface ResumeCandidate {
	readonly target: ResumeTarget;
	readonly cli: string;
	readonly folder: string;
	readonly machine_id: string;
	readonly session: string;
	readonly agent?: AgentRef;
	readonly name?: string;
	readonly stopped?: boolean;
	readonly title?: string;
	readonly at?: string;
}

export interface ResumeListArgs {
	readonly machine?: string;
	readonly folder?: string;
	readonly all?: boolean;
}

export interface ResumeListResult {
	readonly items: ResumeCandidate[];
	readonly machines: V3MachineQueryResult[];
}

export interface ResumeResult {
	readonly agent: V3AgentInfo;
	readonly from_saved_session?: boolean;
}

/** The copyable agent address or the CLI session and its working location. */
export interface ResumeTarget {
	readonly reference: string;
	readonly machine?: string;
	readonly folder?: string;
}

/** What last went into an agent's message input with Enter: what the person submitted in its
 * terminal and its CLI took, text typed with `agent.type` and `enter`, or a message delivered
 * through the terminal. */
export interface Said {
	readonly text: string;
	readonly from: string;
	readonly from_name?: string;
	readonly at: string;
}

export type ScreenArgs = V3ScreenArgs;

/** The screen buffer a CLI shows. */
export type ScreenBuffer = 'normal' | 'alternate';

/** A change to the `screen` topic. `exit` follows all output the CLI wrote before ending; processes
 * still holding its terminal may write afterward. On macOS, the terminal is taken from those
 * processes when the CLI ends. `removed` is the watch's last change. Skip unknown change kinds.
 * 
 * `snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode
 * them to bytes and feed those bytes to the viewer's terminal parser. Set the viewer to
 * `snapshot.cols` by `snapshot.rows` before the initial redraw. Each redraw change carries its own
 * `cols` and `rows`; use that size before applying its `data`. Process changes for each watch in
 * arrival order. Apply `output` as continuation bytes; `redraw` supplies a replacement terminal
 * sequence. Preserve parser state between messages. Do not treat the decoded bytes as plain text;
 * use `agent.screen` for plain text. */
export type ScreenChange = { readonly kind: 'output'; readonly data: string } | { readonly kind: 'redraw'; readonly data: string; readonly cols: number; readonly rows: number } | { readonly kind: 'exit'; readonly exit: ProcessExit } | { readonly kind: 'removed' };

export type ScreenSnapshot = V3ScreenSnapshot;

export type ScreenText = V3ScreenText;

export type ScreenWatchArgs = V3ScreenWatchArgs;

export type SendArgs = V3SendArgs;

export type SendResult = V3SendResult;

/** A response or notification received from a server. */
export type ServerMessage = Notification | Response;

/** A saved session that matched the requested session ID. */
export interface SessionMatch {
	readonly id: string;
	readonly cli: string;
	readonly title?: string;
}

export interface SshInteraction {
	readonly reason: string;
	readonly command: string[];
}

export type StartArgs = V3StartArgs;

export type StartOutcome = V3StartOutcome;

export type StartResult = V3StartResult;

/** More about an agent's state. */
export interface StateDetail {
	readonly kind?: WaitKind;
	readonly text?: string;
	readonly how?: HowEnded;
	readonly reason?: StateReason;
}

/** Why nothing shows what an agent's CLI is doing, or what Facade found wrong with it. */
export type StateReason = 'not_shown' | 'asked' | 'taken_back' | 'unrecognized' | 'not_ready' | 'tools_unavailable';

export interface StatusArgs {
	readonly machine?: string;
}

export interface StatusResult {
	readonly home: string;
	readonly settings_file: string;
	readonly build: string;
	readonly daemon_pid: number;
	readonly keeper_pid?: number;
	readonly agents: number;
	readonly machines: V3MachineQueryResult[];
}

export type StopResult = V3StopResult;

/** The colors an editor window's terminals draw with, each `#rrggbb`. An agent of the window
 * replies to its CLI's OSC 10, 11 and 12 queries with them; a color left out gets no reply. */
export interface TerminalColors {
	readonly foreground?: string;
	readonly background?: string;
	readonly cursor?: string;
}

/** How much of a message reached the recipient's terminal. */
export type TextWritten = 'none' | 'partial' | 'full' | 'unknown';

/** Why an agent's CLI cannot use the Facade tools it was given. */
export type ToolsReason = 'not_given' | 'not_connected' | 'not_started' | 'disconnected' | 'ended';

/** Whether an agent's CLI can use Facade's tools: `facade-mcp`, the MCP server that a CLI started
 * by its rule is given for its run. */
export type ToolsState = 'not_injected' | 'connecting' | 'available' | 'unavailable';

export type TypeArgs = V3TypeArgs;

export interface TypeResult {
	readonly agent?: AgentLabel;
}

export interface Unavailable {
	readonly execution: ExecutionOutcome;
	readonly machine?: MachineIdentity;
	readonly unanswered?: MachineIdentity[];
	readonly matches?: string[];
}

/** Parameters for `unwatch`. */
export interface UnwatchParams {
	readonly watch: number;
}

/** Arguments for `daemon.upgrade`: the program of a newer build that takes over, as the command
 * that asks runs it. */
export interface UpgradeArgs {
	readonly program: string;
	readonly build: string;
	readonly daemon_protocol: [number, number];
	readonly keeper_protocol: [number, number];
}

/** The result of `daemon.upgrade`. */
export interface UpgradeResult {
	readonly from: string;
	readonly agents: number;
}

/** An agent record. */
export interface V2AgentInfo {
	readonly agent_id: string;
	readonly address?: string;
	readonly label?: string;
	readonly unreachable?: boolean;
	readonly name: string;
	readonly cli: string;
	readonly cwd: string;
	readonly machine_id: string;
	readonly windows: V2WindowRef[];
	readonly location_id: string;
	readonly location_source_window?: V2WindowRef;
	readonly pid?: number;
	readonly process: ProcessState;
	readonly cols?: number;
	readonly rows?: number;
	readonly created_at: string;
	readonly creator?: string;
	readonly creator_machine_id?: string;
	readonly root: string;
	readonly root_machine_id?: string;
	readonly yolo: boolean;
	readonly exit?: ProcessExit;
	readonly session?: string;
	readonly state: V2AgentState;
	readonly state_detail?: StateDetail;
	readonly said?: Said;
	readonly tools_state: ToolsState;
	readonly tools_reason?: ToolsReason;
	readonly guest?: boolean;
}

export interface V2AgentListResult {
	readonly agents: V2AgentInfo[];
	readonly machines: V2MachineQueryResult[];
}

/** What an agent is doing, from its CLI's own status reports, from its screen where its CLI's rule
 * reads it, and from Facade's own facts. The first state that holds, in this order, is the
 * agent's: `waiting_for_you`, `error`, `just_done`, `working`, `idle`, `starting`, then `unknown`;
 * `ended` once its process ended. */
export type V2AgentState = 'starting' | 'working' | 'waiting_for_you' | 'just_done' | 'idle' | 'error' | 'ended' | 'unknown';

export type V2CallParams = { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs } | { readonly op: 'agent.list'; readonly args: MachineQueryArgs };

/** A `changed` notification for one watch. */
export interface V2ChangedParams {
	readonly watch: number;
	readonly change: V2WindowsChange;
}

/** Parameters for `hello`. */
export interface V2HelloParams {
	readonly protocol: [number, number];
	readonly build: string;
	readonly kind: ClientKind;
	readonly agent?: string;
	readonly sessions?: string[];
	readonly window?: V2WindowDescription;
	readonly numbers_given?: V2NumbersGiven;
	readonly machine?: MachineHello;
}

/** The result of `hello`: daemon details and supported topics and operations. */
export interface V2HelloResult {
	readonly protocol: number;
	readonly build: string;
	readonly machine_id: string;
	readonly machine?: MachineHello;
	readonly window?: V2WindowRef;
	readonly pid: number;
	readonly agent?: string;
	readonly agents: number;
	readonly keeper?: KeeperInfo;
	readonly topics: string[];
	readonly ops: string[];
}

/** A place an agent can work: a window's folder, or a checkout of a Git repository one of its
 * folders is in. */
export interface V2LocationInfo {
	readonly location_id: string;
	readonly label: string;
	readonly path: string;
	readonly kind: LocationKind;
}

/** One connection as seen from its machine table row. */
export interface V2MachineConnection {
	readonly machine_id: string;
	readonly initiator_machine_id: string;
	readonly kind: ConnectionKind;
	readonly ssh_destination?: string;
	readonly remote_home?: string;
	readonly state: ConnectionState;
	readonly ssh_interaction?: SshInteraction;
}

/** A row visible from the machine that supplies the table. */
export interface V2MachineInfo {
	readonly machine_id: string;
	readonly boot_id?: string;
	readonly name: string;
	readonly build?: string;
	readonly route?: string[];
	readonly connections: V2MachineConnection[];
}

/** The outcome of asking one machine for its reachable agents. */
export interface V2MachineQueryResult {
	readonly machine_id: string;
	readonly short_id: string;
	readonly name: string;
	readonly build?: string;
	readonly status: MachineQueryStatus;
	readonly answered_at?: string;
}

/** A message: one sender, one recipient, the complete text, and what became of it. */
export interface V2Message {
	readonly message_id: string;
	readonly message_ref?: MessageRef;
	readonly from: string;
	readonly from_machine_id?: string;
	readonly from_name?: string;
	readonly to: string;
	readonly text: string;
	readonly reply_to?: string;
	readonly reply_to_machine_id?: string;
	readonly from_window?: string;
	readonly call_id?: string;
	readonly result?: V2StartOutcome;
	readonly at: string;
	readonly delivery: Delivery;
}

/** The highest numbers an editor gave before. */
export interface V2NumbersGiven {
	readonly agent: number;
	readonly message: number;
}

/** Arguments for `agent.start`, supplied by the client. */
export interface V2StartArgs {
	readonly command: string[];
	readonly name?: string;
	readonly cwd: string;
	readonly machine?: string;
	readonly cwd_is_default?: boolean;
	readonly window?: V2WindowRef;
	readonly initial_windows?: V2WindowRef[];
	readonly location_source_window?: V2WindowRef;
	readonly env?: { readonly [key: string]: string };
	readonly cols: number;
	readonly rows: number;
	readonly prompt?: string;
	readonly call_id?: string;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly request_id?: string;
	readonly worktree?: V2Worktree;
	readonly model?: string;
	readonly effort?: string;
	readonly session?: string;
}

/** What became of a start with a prompt, as its result tells the agent that started it. */
export interface V2StartOutcome {
	readonly agent: V2AgentInfo;
	readonly prompt: PromptOutcome;
}

/** The result of `agent.start`. */
export interface V2StartResult {
	readonly agent: V2AgentInfo;
	readonly prompt?: V2Message;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly repeated?: boolean;
}

/** Parameters for `watch`. */
export type V2WatchParams = { readonly topic: 'windows'; readonly args?: NoArgs };

/** The result of `watch`, sent before any changes for that watch. */
export interface V2WatchResult {
	readonly watch: number;
	readonly snapshot: V2WindowInfo[];
}

/** An editor window as it describes itself, in `hello` and again with `window.update` whenever any
 * of it changes. */
export interface V2WindowDescription {
	readonly id: string;
	readonly label: string;
	readonly environment: string;
	readonly workspace?: string;
	readonly folders?: string[];
	readonly branch_prefix?: string;
	readonly colors?: TerminalColors;
	readonly env?: { readonly [key: string]: string };
}

/** A window: an editor window, or the terminal window, `terminal`, which holds the agents started
 * from a terminal. */
export interface V2WindowInfo {
	readonly machine_id: string;
	readonly window_id: string;
	readonly label: string;
	readonly environment: string;
	readonly connected: boolean;
	readonly folders: string[];
	readonly locations: V2LocationInfo[];
	readonly problems?: string[];
	readonly observed_at?: string;
	readonly clis?: CliInfo[];
	readonly settings_problem?: string;
}

/** A logical window on a Facade machine. */
export interface V2WindowRef {
	readonly machine_id: string;
	readonly window_id: string;
}

/** A change to the windows. */
export type V2WindowsChange = { readonly kind: 'updated'; readonly window: V2WindowInfo } | { readonly kind: 'removed'; readonly machine_id: string; readonly window_id: string };

/** A new worktree: its branch and where the branch starts. */
export interface V2Worktree {
	readonly branch: string;
	readonly base_ref: string;
}

export interface V3AdvertiseParams {
	readonly machines: V3MachineInfo[];
}

export type V3AgentArgs = { readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef };

/** An agent's details. */
export interface V3AgentInfo {
	readonly agent_id: string;
	readonly address: string;
	readonly type: AgentKind;
	readonly label?: string;
	readonly unreachable?: boolean;
	readonly name: string;
	readonly cli: string;
	readonly args: string[];
	readonly model?: string;
	readonly effort?: string;
	readonly title?: string;
	readonly cwd: string;
	readonly machine_id: string;
	readonly pid?: number;
	readonly process: ProcessState;
	readonly cols?: number;
	readonly rows?: number;
	readonly created_at: string;
	readonly started_at: string;
	readonly creator_kind?: CreatorKind;
	readonly creator?: string;
	readonly creator_machine_id?: string;
	readonly root: string;
	readonly root_machine_id?: string;
	readonly yolo: boolean;
	readonly exit?: ProcessExit;
	readonly session?: string;
	readonly state: V3AgentState;
	readonly state_detail?: StateDetail;
	readonly said?: Said;
	readonly tools_state: ToolsState;
	readonly tools_reason?: ToolsReason;
}

export interface V3AgentListResult {
	readonly agents: AgentListEntry[];
	readonly machines: V3MachineQueryResult[];
}

export interface V3AgentMachineState {
	readonly machine_id: string;
	readonly state: AgentSyncState;
	readonly agents?: V3AgentInfo[];
}

/** The agent's current state. */
export type V3AgentState = 'starting' | 'working' | 'waiting_for_you' | 'just_done' | 'idle' | 'error' | 'ended' | 'unknown' | 'online';

export type V3AgentsChange = { readonly kind: 'updated'; readonly agent: V3AgentInfo } | { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string; readonly cause: AgentRemoval } | { readonly kind: 'machine_state'; readonly machine: V3AgentMachineState };

export interface V3AgentsSnapshot {
	readonly agents: V3AgentInfo[];
	readonly machines: V3AgentMachineState[];
}

export type V3CallParams = { readonly op: 'agent.list'; readonly args: MachineQueryArgs } | { readonly op: 'agent.inspect'; readonly args: V3AgentArgs } | { readonly op: 'agent.start'; readonly args: V3StartArgs } | { readonly op: 'agent.start_preflight'; readonly args: V3StartArgs } | { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } | { readonly op: 'agent.resume'; readonly args: V3ResumeArgs } | { readonly op: 'location.list'; readonly args: LocationListArgs } | { readonly op: 'cli.list'; readonly args: CliListArgs } | { readonly op: 'agent.stop'; readonly args: V3AgentArgs } | { readonly op: 'agent.remove'; readonly args: V3AgentArgs } | { readonly op: 'agent.rename'; readonly args: V3RenameArgs } | { readonly op: 'agent.type'; readonly args: V3TypeArgs } | { readonly op: 'agent.send'; readonly args: V3SendArgs } | { readonly op: 'agent.resize'; readonly args: V3ResizeArgs } | { readonly op: 'agent.screen'; readonly args: V3ScreenArgs } | { readonly op: 'daemon.status'; readonly args: StatusArgs } | { readonly op: 'workspace.import_legacy'; readonly args: LegacyWorkspaceArgs } | { readonly op: 'machine.list'; readonly args: NoArgs } | { readonly op: 'machine.add'; readonly args: V3MachineAddArgs } | { readonly op: 'machine.connect'; readonly args: V3MachineConnectArgs } | { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } | { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } | { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } | { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs } | { readonly op: 'agent.deliver_start_result'; readonly args: V3DeliverStartResultArgs };

/** An identity verified by the daemon that accepted the original request. */
export type V3Caller = { readonly kind: 'terminal'; readonly machine_id: string } | { readonly kind: 'ide'; readonly machine_id: string } | { readonly kind: 'agent'; readonly agent: AgentRef; readonly root: AgentRef; readonly yolo: boolean };

/** A start outcome with the message number already reserved on the recipient's machine. */
export interface V3DeliverStartResultArgs {
	readonly recipient: AgentRef;
	readonly message: V3Message;
}

/** A forwarded call and the facts verified by the originating machine. */
export interface V3ForwardCall {
	readonly call: V3CallParams;
	readonly by_model: boolean;
	readonly from_name?: string;
	readonly recipient?: AgentRef;
}

/** Parameters of `forward`. The outer JSON-RPC ID identifies this hop. */
export interface V3ForwardParams {
	readonly route: string[];
	readonly caller: V3Caller;
	readonly time_left_ms?: number;
	readonly request_id?: string;
	readonly method: string;
	readonly params: unknown;
}

/** Introduces a daemon client or a machine. Actor identity is supplied by the daemon. */
export interface V3HelloParams {
	readonly protocol: [number, number];
	readonly build: string;
	readonly kind: ClientKind;
	readonly machine?: MachineHello;
}

export interface V3InspectResult {
	readonly agent: V3AgentInfo;
	readonly rule?: string;
	readonly input: InputInfo;
	readonly session_tracking: boolean;
	readonly started_by?: AgentCreator;
	readonly viewers: string[];
	readonly attachments?: AttachmentInfo[];
	readonly launch_command?: string;
}

export interface V3LocationInfo {
	readonly location_id: string;
	readonly label: string;
	readonly path: string;
	readonly kind: LocationKind;
	readonly source_folder?: string;
}

export interface V3LocationListResult {
	readonly locations: V3LocationInfo[];
}

export interface V3MachineAddArgs {
	readonly ssh_destination: string;
	readonly ssh_args?: string[];
	readonly remote_home?: string;
	readonly machine_id: string;
}

export interface V3MachineConnectArgs {
	readonly transport: V3MachineTransport;
	readonly kind: ConnectionKind;
}

export interface V3MachineConnectResult {
	readonly ssh_destination?: string;
	readonly ssh_args?: string[];
	readonly remote_home?: string;
	readonly expected_machine_id?: string;
}

export interface V3MachineConnection {
	readonly machine_id: string;
	readonly initiator_machine_id: string;
	readonly kind: ConnectionKind;
	readonly ssh_destination?: string;
	readonly ssh_args?: string[];
	readonly remote_home?: string;
	readonly state: ConnectionState;
	readonly ssh_interaction?: SshInteraction;
}

export interface V3MachineInfo {
	readonly machine_id: string;
	readonly boot_id?: string;
	readonly name: string;
	readonly selector: string;
	readonly state: MachineState;
	readonly last_seen?: string;
	readonly ssh_error?: string;
	readonly build?: string;
	readonly route?: string[];
	readonly connections: V3MachineConnection[];
}

export interface V3MachineListResult {
	readonly machines: V3MachineInfo[];
}

export interface V3MachineQueryResult {
	readonly machine_id: string;
	readonly short_id: string;
	readonly name: string;
	readonly selector: string;
	readonly build?: string;
	readonly state: MachineState;
	readonly status: MachineQueryStatus;
	readonly last_seen?: string;
	readonly ssh_error?: string;
	readonly error?: string;
}

export type V3MachineTransport = { readonly kind: 'ssh'; readonly ssh_destination: string; readonly ssh_args?: string[]; readonly remote_home?: string } | { readonly kind: 'bridge' };

export type V3MachinesChange = { readonly kind: 'updated'; readonly machine: V3MachineInfo } | { readonly kind: 'removed'; readonly machine_id: string };

export interface V3Message {
	readonly message_id: string;
	readonly message_ref?: MessageRef;
	readonly from: string;
	readonly from_machine_id?: string;
	readonly from_name?: string;
	readonly to: string;
	readonly text: string;
	readonly reply_to?: string;
	readonly reply_to_machine_id?: string;
	readonly call_id?: string;
	readonly result?: V3StartOutcome;
	readonly at: string;
	readonly delivery: Delivery;
}

export type V3RenameArgs = { readonly name: string } & ({ readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef });

export type V3ResizeArgs = { readonly cols: number; readonly rows: number; readonly colors?: TerminalColors } & ({ readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef });

/** The copyable agent address or the CLI session and its working location. */
export type V3ResumeArgs = { readonly reference: string; readonly machine?: string; readonly folder?: string; readonly machine_id?: string; readonly env?: { readonly [key: string]: string }; readonly cols: number; readonly rows: number } & ({ readonly machine_id?: never } | { readonly machine?: never });

export interface V3ScreenArgs {
	readonly agent: string;
	readonly lines?: number;
}

export interface V3ScreenSnapshot {
	readonly agent_id: string;
	readonly address: string;
	readonly name?: string;
	readonly machine_id: string;
	readonly cols: number;
	readonly rows: number;
	readonly redraw: string;
	readonly exit?: ProcessExit;
	readonly process?: ProcessState;
}

export interface V3ScreenText {
	readonly agent_id: string;
	readonly address: string;
	readonly name?: string;
	readonly process: ProcessState;
	readonly observed_at: string;
	readonly buffer: ScreenBuffer;
	readonly text: string;
	readonly line_count: number;
	readonly older_lines: boolean;
	readonly trimmed: boolean;
}

export type V3ScreenWatchArgs = { readonly keep_scrollback?: boolean; readonly include_scrollback?: boolean; readonly viewer?: string; readonly allow_ended?: boolean } & ({ readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef });

export interface V3SendArgs {
	readonly to: string;
	readonly text: string;
	readonly reply_to?: string;
	readonly reply_to_machine_id?: string;
	readonly request_id?: string;
	readonly time_left_ms?: number;
	readonly allow_unsupported_receipt?: boolean;
}

/** The receipt of a send, with the address that can be used to wait for a reply. */
export interface V3SendResult {
	readonly id: string;
	readonly message: V3Message;
	readonly recipient?: AgentLabel;
	readonly repeated?: boolean;
	readonly withdrawn?: boolean;
	readonly expected_reply_to?: MessageRef;
}

/** Shared arguments for start and preflight. */
export interface V3StartArgs {
	readonly cli: string;
	readonly args?: string[];
	readonly folder?: string;
	readonly folder_is_default?: boolean;
	readonly machine?: string;
	readonly worktree?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly name?: string;
	readonly prompt?: string;
	readonly env?: { readonly [key: string]: string };
	readonly cols: number;
	readonly rows: number;
	readonly call_id?: string;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly request_id?: string;
}

export interface V3StartOutcome {
	readonly agent: V3AgentInfo;
	readonly prompt: PromptOutcome;
}

export interface V3StartResult {
	readonly agent: V3AgentInfo;
	readonly prompt?: V3Message;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly repeated?: boolean;
}

/** A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as
 * exit code zero. */
export interface V3StopResult {
	readonly reference: AgentRef;
	readonly address: string;
	readonly agent?: AgentLabel;
	readonly code?: number;
	readonly signal?: string;
	readonly reason?: EndReason;
	readonly at: string;
	readonly already_ended?: boolean;
}

export type V3TypeArgs = { readonly raw?: string; readonly text?: string; readonly enter?: boolean; readonly keys?: string[] } & ({ readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef });

/** What a CLI waits for. */
export type WaitKind = 'permission' | 'question' | 'auth' | 'unknown';

/** A forwarded watch ended. A new watch starts with a fresh snapshot. */
export interface WatchEndedParams {
	readonly watch: number;
	readonly error: ErrorBody;
}

/** Parameters for `watch`. */
export type WatchParams = { readonly topic: 'agents'; readonly args?: NoArgs } | { readonly topic: 'screen'; readonly args: V3ScreenWatchArgs } | { readonly topic: 'machines'; readonly args?: NoArgs };

/** The result of `watch`, sent before any changes for that watch. */
export interface WatchResult {
	readonly watch: number;
	readonly snapshot: V3AgentsSnapshot | V3ScreenSnapshot | V3MachineInfo[];
}

/** Argument and result types for each operation. */
export interface V3Operations {
	readonly "agent.list": { readonly args: MachineQueryArgs; readonly result: V3AgentListResult };
	readonly "agent.inspect": { readonly args: V3AgentArgs; readonly result: V3InspectResult };
	readonly "agent.start": { readonly args: V3StartArgs; readonly result: V3StartResult };
	readonly "agent.start_preflight": { readonly args: V3StartArgs; readonly result: EmptyResult };
	readonly "agent.resume_list": { readonly args: ResumeListArgs; readonly result: ResumeListResult };
	readonly "agent.resume": { readonly args: V3ResumeArgs; readonly result: ResumeResult };
	readonly "location.list": { readonly args: LocationListArgs; readonly result: V3LocationListResult };
	readonly "cli.list": { readonly args: CliListArgs; readonly result: CliListResult };
	readonly "agent.stop": { readonly args: V3AgentArgs; readonly result: V3StopResult };
	readonly "agent.remove": { readonly args: V3AgentArgs; readonly result: RemoveResult };
	readonly "agent.rename": { readonly args: V3RenameArgs; readonly result: RenameResult };
	readonly "agent.type": { readonly args: V3TypeArgs; readonly result: TypeResult };
	readonly "agent.send": { readonly args: V3SendArgs; readonly result: V3SendResult };
	readonly "agent.resize": { readonly args: V3ResizeArgs; readonly result: EmptyResult };
	readonly "agent.screen": { readonly args: V3ScreenArgs; readonly result: V3ScreenText };
	readonly "daemon.status": { readonly args: StatusArgs; readonly result: StatusResult };
	readonly "workspace.import_legacy": { readonly args: LegacyWorkspaceArgs; readonly result: LegacyWorkspaceResult };
	readonly "machine.list": { readonly args: NoArgs; readonly result: V3MachineListResult };
	readonly "machine.add": { readonly args: V3MachineAddArgs; readonly result: MachineAddResult };
	readonly "machine.connect": { readonly args: V3MachineConnectArgs; readonly result: V3MachineConnectResult };
	readonly "machine.remove": { readonly args: MachineRemoveArgs; readonly result: MachineRemoveResult };
	readonly "machine.rename": { readonly args: MachineRenameArgs; readonly result: MachineRenameResult };
	readonly "daemon.log": { readonly args: DaemonLogArgs; readonly result: DaemonLogResult };
	readonly "daemon.upgrade": { readonly args: UpgradeArgs; readonly result: UpgradeResult };
}

/** Argument, snapshot, and change types for each topic. Skip unknown change kinds. */
export interface V3Topics {
	readonly agents: { readonly args: NoArgs; readonly snapshot: V3AgentsSnapshot; readonly change: V3AgentsChange };
	readonly screen: { readonly args: V3ScreenWatchArgs; readonly snapshot: V3ScreenSnapshot; readonly change: ScreenChange };
	readonly machines: { readonly args: NoArgs; readonly snapshot: V3MachineInfo[]; readonly change: V3MachinesChange };
}
