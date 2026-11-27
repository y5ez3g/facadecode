// Generated from framework/crates/base/src by framework/crates/base/tests/protocol_files.rs: do not edit.

export const DAEMON_API_VERSIONS = [1] as const;
export const KEEPER_API_VERSIONS = [1] as const;
export type DaemonOperation = keyof DaemonOperations;
export type DaemonTopic = keyof DaemonTopics;

export interface AdvertiseParams {
	readonly machines: MachineInfo[];
}

/** The source of an agent's start, as displayed to the caller. */
export type AgentCreator = { readonly kind: 'agent'; readonly address: string } | { readonly kind: 'command_line' } | { readonly kind: 'vs_code' };

export interface AgentInfo {
	readonly reference: AgentRef;
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
	readonly pid?: number;
	readonly process: ProcessState;
	readonly size?: Size;
	readonly created_at: string;
	readonly started_at: string;
	readonly creator_kind?: CreatorKind;
	readonly creator?: AgentRef;
	readonly root: AgentRef;
	readonly yolo: boolean;
	readonly exit?: ProcessExit;
	readonly session?: string;
	readonly state: AgentState;
	readonly state_detail?: StateDetail;
	readonly said?: Said;
	readonly tools_state: ToolsState;
	readonly tools_reason?: ToolsReason;
}

export type AgentKind = 'managed' | 'guest';

export interface AgentLabel {
	readonly reference: AgentRef;
	readonly address: string;
	readonly type: AgentKind;
	readonly name: string;
	readonly cli: string;
	readonly state: AgentState;
	readonly resumable: boolean;
}

export interface AgentListArgs {
	readonly scope?: Scope;
}

export interface AgentListEntry {
	readonly reference: AgentRef;
	readonly address: string;
	readonly name: string;
	readonly type: AgentKind;
	readonly state: AgentState;
	readonly cli: string;
	readonly folder: string;
	readonly started_at: string;
	readonly title?: string;
	readonly session_name?: string;
}

export interface AgentListResult {
	readonly agents: AgentListEntry[];
	readonly machines: MachineQuery[];
}

export interface AgentLookupCandidate {
	readonly agent: AgentInfo;
	readonly has_rule: boolean;
	readonly session_name?: string;
}

export interface AgentMachineState {
	readonly machine_id: string;
	readonly state: AgentSyncState;
	readonly agents?: AgentInfo[];
}

export interface AgentRef {
	readonly machine_id: string;
	readonly agent_id: string;
}

/** The recorded cause of an agent record's removal. */
export type AgentRemoval = 'expired' | 'removed';

/** The agent's current state. */
export type AgentState = 'starting' | 'working' | 'waiting_for_you' | 'just_done' | 'idle' | 'error' | 'ended' | 'unknown' | 'online';

export type AgentSyncState = 'synced' | 'pending' | 'unreachable';

export type AgentTarget = string | { readonly machine_id: string; readonly agent_id: string };

export interface AgentTargetArgs {
	readonly target: AgentTarget;
}

export interface AgentTypeArgs {
	readonly target: AgentTarget;
	readonly input: TerminalInput;
}

export type AgentsChange = { readonly kind: 'updated'; readonly agent: AgentInfo } | { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string; readonly cause: AgentRemoval } | { readonly kind: 'machine_state'; readonly machine: AgentMachineState };

export interface AgentsSnapshot {
	readonly agents: AgentInfo[];
	readonly machines: AgentMachineState[];
}

export type ApiVersions = number[];

export interface AttachArgs {
	readonly target: AgentTarget;
	readonly size?: { readonly cols: number; readonly rows: number };
	readonly viewer?: string;
	readonly keep_scrollback?: boolean;
	readonly include_scrollback?: boolean;
	readonly allow_ended?: boolean;
	readonly report_activity?: boolean;
}

export interface AttachBinding {
	readonly viewer: number;
	readonly boot_id: string;
}

export interface AttachResizeArgs {
	readonly watch: number;
	readonly size: { readonly cols: number; readonly rows: number };
	readonly colors?: TerminalColors;
}

export interface AttachmentInfo {
	readonly kind: AttachmentKind;
	readonly machine_id: string;
}

export type AttachmentKind = 'shell' | 'vs_code';

export interface BatchStopResult {
	readonly items: StopItem[];
	readonly machines?: MachineQuery[];
}

export type CallParams = { readonly op: 'agent.list'; readonly args: AgentListArgs } | { readonly op: 'agent.start'; readonly args: StartArgs } | { readonly op: 'agent.stop'; readonly args: StopArgs } | { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } | { readonly op: 'agent.resume'; readonly args: ResumeArgs } | { readonly op: 'agent.inspect'; readonly args: AgentTargetArgs } | { readonly op: 'agent.screen'; readonly args: ScreenArgs } | { readonly op: 'agent.type'; readonly args: AgentTypeArgs } | { readonly op: 'agent.send'; readonly args: SendArgs } | { readonly op: 'agent.remove'; readonly args: AgentTargetArgs } | { readonly op: 'agent.rename'; readonly args: RenameArgs } | { readonly op: 'attach.resize'; readonly args: AttachResizeArgs } | { readonly op: 'cli.list'; readonly args: CliListArgs } | { readonly op: 'location.list'; readonly args: LocationListArgs } | { readonly op: 'machine.list'; readonly args: NoArgs } | { readonly op: 'machine.connect'; readonly args: MachineConnectArgs } | { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } | { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } | { readonly op: 'daemon.status'; readonly args: StatusArgs } | { readonly op: 'daemon.log'; readonly args: LogArgs } | { readonly op: 'daemon.upgrade'; readonly args: DaemonUpgradeArgs } | { readonly op: 'internal.agent_records'; readonly args: InternalAgentRecordsArgs } | { readonly op: 'internal.resume_records'; readonly args: NoArgs } | { readonly op: 'internal.ensure_route'; readonly args: InternalEnsureRouteArgs } | { readonly op: 'internal.attach_resize'; readonly args: InternalAttachResizeArgs } | { readonly op: 'internal.deliver_start_result'; readonly args: InternalDeliverStartResultArgs } | { readonly op: 'internal.deliver_wait_notice'; readonly args: InternalDeliverWaitNoticeArgs } | { readonly op: 'internal.deliver_notice'; readonly args: InternalDeliverNoticeArgs } | { readonly op: 'internal.command_reply'; readonly args: CommandReplyArgs };

export type Caller = { readonly kind: 'terminal'; readonly machine_id: string } | { readonly kind: 'ide'; readonly machine_id: string } | { readonly kind: 'agent'; readonly agent: { readonly machine_id: string; readonly agent_id: string }; readonly root: { readonly machine_id: string; readonly agent_id: string }; readonly yolo: boolean };

export interface CancelParams {
	readonly id: number;
}

export interface ChangedParams {
	readonly watch: number;
	readonly change: AgentsChange | MachinesChange | ScreenChange;
}

/** A CLI a start can run: an entry of Facade Code Framework's settings file (CONFIGURATION-2.1). */
export interface CliInfo {
	readonly cli: string;
	readonly display_name: string;
	readonly available: boolean;
	readonly problem?: string;
	readonly not_installed?: boolean;
	readonly overrides: Overrides;
}

export interface CliListArgs {
	readonly scope?: SingleMachineScope;
	readonly folder?: string;
	readonly env?: { readonly [key: string]: string };
}

export interface CliListResult {
	readonly clis: CliInfo[];
	readonly settings_problem?: string;
}

export type ClientKind = 'terminal' | 'ide' | 'mcp' | 'machine';

export interface ClosingParams {
	readonly build: string;
}

export interface CommandReply {
	readonly reference: MessageRef;
	readonly text: string;
}

export interface CommandReplyArgs {
	readonly request_id: string;
	readonly original: { readonly machine_id: string; readonly message_id: string };
	readonly reply: CommandReplyInput;
}

export interface CommandReplyInput {
	readonly reference: { readonly machine_id: string; readonly message_id: string };
	readonly text: string;
}

export interface ConnectFailedParams {
	readonly error: ErrorBody;
}

export interface ConnectedMachine {
	readonly machine_id: string;
	readonly boot_id: string;
	readonly name: string;
	readonly build: string;
	readonly ssh_cleans_processes?: boolean;
}

export interface ConnectedParams {
	readonly machine: ConnectedMachine;
	readonly first_connection: boolean;
}

export type ConnectionKind = 'saved' | 'temporary';

export type ConnectionState = 'connected' | 'disconnected' | 'ssh_interaction_required';

export type CreatorKind = 'agent' | 'command_line' | 'vs_code';

export type DaemonHelloParams = HelloParams;

export type DaemonHelloResult = HelloResult;

export interface DaemonUpgradeArgs {
	readonly program: string;
	readonly build: string;
	readonly daemon_api_versions: ApiVersions;
	readonly keeper_api_versions: ApiVersions;
}

export interface DaemonUpgradeResult {
	readonly from: string;
	readonly agent_count: number;
}

/** How a message was delivered. */
export type DeliveredVia = 'terminal' | 'read' | 'notified' | 'returned_to_request';

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

export interface ErrorBody {
	readonly code: number;
	readonly message: string;
	readonly data: ErrorData;
}

export interface ErrorData {
	readonly reason: string;
	readonly details?: { readonly [key: string]: unknown };
}

export type FolderScope = 'cwd' | 'all';

export type ForwardParams = { readonly route: string[]; readonly caller: Caller; readonly time_left_ms?: number; readonly from_name?: string; readonly start_result?: { readonly machine_id: string; readonly message_id: string } } & ({ readonly method: 'call'; readonly params: CallParams } | { readonly method: 'watch'; readonly params: WatchParams });

export interface ForwardWatchResult {
	readonly watch: number;
	readonly snapshot: AgentsSnapshot | MachineInfo[] | ScreenSnapshot;
	readonly view?: AttachBinding;
}

export interface HelloParams {
	readonly api_versions: ApiVersions;
	readonly build: string;
	readonly kind: ClientKind;
	readonly machine?: MachineHelloParams;
	readonly foreground?: boolean;
}

export interface HelloResult {
	readonly api_version: number;
	readonly build: string;
	readonly machine_id: string;
	readonly pid: number;
	readonly agent_count: number;
	readonly ops: string[];
	readonly topics: string[];
	readonly keeper?: KeeperInfo;
	readonly machine?: MachineHelloResult;
}

/** Rows of a draft scrolled out of the CLI's input, as the CLI marks them. */
export interface HiddenRows {
	readonly above: number;
	readonly below: number;
}

/** How an agent's process ended. */
export type HowEnded = 'normal' | 'stopped' | 'crashed';

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

export type InputStep = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'key'; readonly key: string };

export interface InspectResult {
	readonly agent: AgentInfo;
	readonly input: InputInfo;
	readonly session_tracking: boolean;
	readonly viewers: string[];
	readonly rule?: string;
	readonly started_by?: AgentCreator;
	readonly attachments?: AttachmentInfo[];
	readonly launch_command?: string;
	readonly session_name?: string;
}

export interface InternalAgentRecordsArgs {
	readonly active: boolean;
}

export interface InternalAttachResizeArgs {
	readonly viewer: number;
	readonly boot_id: string;
	readonly size: { readonly cols: number; readonly rows: number };
	readonly colors?: TerminalColors;
}

export interface InternalDeliverNoticeArgs {
	readonly recipient: { readonly machine_id: string; readonly agent_id: string };
	readonly notice: Notice;
}

export interface InternalDeliverStartResultArgs {
	readonly recipient: { readonly machine_id: string; readonly agent_id: string };
	readonly message: { readonly message_id: string; readonly message_ref?: { readonly machine_id: string; readonly message_id: string }; readonly from: string; readonly from_machine_id?: string; readonly from_name?: string; readonly to: string; readonly text: string; readonly reply_to?: string; readonly reply_to_machine_id?: string; readonly call_id?: string; readonly result?: { readonly agent: { readonly reference: { readonly machine_id: string; readonly agent_id: string }; readonly address: string; readonly type: AgentKind; readonly label?: string; readonly unreachable?: boolean; readonly name: string; readonly cli: string; readonly args: string[]; readonly model?: string; readonly effort?: string; readonly title?: string; readonly cwd: string; readonly pid?: number; readonly process: ProcessState; readonly size?: { readonly cols: number; readonly rows: number }; readonly created_at: string; readonly started_at: string; readonly creator_kind?: CreatorKind; readonly creator?: { readonly machine_id: string; readonly agent_id: string }; readonly root: { readonly machine_id: string; readonly agent_id: string }; readonly yolo: boolean; readonly exit?: ProcessExit; readonly session?: string; readonly state: AgentState; readonly state_detail?: StateDetail; readonly said?: Said; readonly tools_state: ToolsState; readonly tools_reason?: ToolsReason }; readonly prompt: PromptOutcome }; readonly at: string; readonly delivery: Delivery };
}

export interface InternalDeliverWaitNoticeArgs {
	readonly recipient: { readonly machine_id: string; readonly agent_id: string };
	readonly waiting: { readonly machine_id: string; readonly agent_id: string };
	readonly name: string;
	readonly kind: WaitKind;
}

export interface InternalEnsureRouteArgs {
	readonly wake: boolean;
}

export type JsonRpc = '2.0';

export interface KeeperInfo {
	readonly pid: number;
	readonly build: string;
}

export interface LocationInfo {
	readonly location_id: string;
	readonly label: string;
	readonly path: string;
	readonly kind: LocationKind;
	readonly source_folder?: string;
}

/** What a location is. */
export type LocationKind = 'folder' | 'main' | 'worktree';

export interface LocationListArgs {
	readonly scope?: SingleMachineScope;
	readonly folders?: string[];
}

export interface LocationListResult {
	readonly locations: LocationInfo[];
}

export interface LogArgs {
	readonly lines?: number;
}

export interface LogResult {
	readonly lines: string[];
}

export interface MachineConnectArgs {
	readonly transport: MachineTransportInput;
	readonly kind: ConnectionKind;
	readonly expected_machine_id?: string;
}

export interface MachineConnectResult {
	readonly transport: MachineTransport;
	readonly expected_machine_id?: string;
}

export interface MachineConnection {
	readonly machine_id: string;
	readonly initiator_machine_id: string;
	readonly kind: ConnectionKind;
	readonly state: ConnectionState;
	readonly transport?: SshTransport;
	readonly ssh_interaction?: SshInteraction;
}

export interface MachineHelloParams {
	readonly machine_id: string;
	readonly boot_id: string;
	readonly name: string;
	readonly ssh_cleans_processes?: boolean;
}

export interface MachineHelloResult {
	readonly boot_id: string;
	readonly name: string;
	readonly ssh_cleans_processes?: boolean;
}

export interface MachineInfo {
	readonly machine_id: string;
	readonly short_id: string;
	readonly name: string;
	readonly selector: string;
	readonly state: MachineState;
	readonly boot_id?: string;
	readonly build?: string;
	readonly last_seen?: string;
	readonly ssh_error?: string;
	readonly route?: string[];
	readonly connections: MachineConnection[];
}

export interface MachineListResult {
	readonly machines: MachineInfo[];
}

export interface MachineQuery {
	readonly machine_id: string;
	readonly short_id: string;
	readonly name: string;
	readonly selector: string;
	readonly state: MachineState;
	readonly status: QueryStatus;
	readonly build?: string;
	readonly last_seen?: string;
	readonly ssh_error?: string;
	readonly error?: string;
}

export interface MachineRemoveArgs {
	readonly machine: string;
	readonly expected_machine_id?: string;
}

export interface MachineRemoveResult {
	readonly machine_id: string;
	readonly reachable: boolean;
	readonly transport?: SshTransport;
	readonly name?: string;
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

export type MachineSleepingParams = Record<string, never>;

export type MachineState = 'online' | 'connecting' | 'disconnected' | 'sleeping' | 'unreachable' | 'ssh_interaction_required';

export type MachineTransport = { readonly kind: 'bridge' } | SshTransport;

export type MachineTransportInput = { readonly kind: 'ssh'; readonly ssh_destination: string; readonly ssh_args?: string[]; readonly remote_home?: string } | { readonly kind: 'bridge' };

export type MachinesChange = { readonly kind: 'updated'; readonly machine: MachineInfo } | { readonly kind: 'removed'; readonly machine_id: string };

export interface Message {
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
	readonly result?: StartOutcome;
	readonly at: string;
	readonly delivery: Delivery;
}

export interface MessageRef {
	readonly machine_id: string;
	readonly message_id: string;
}

export type NoArgs = Record<string, never>;

export type Notice = { readonly kind: 'agent_error'; readonly agent: { readonly machine_id: string; readonly agent_id: string }; readonly name: string; readonly state_detail?: StateDetail; readonly tools_reason?: ToolsReason } | { readonly kind: 'agent_ended'; readonly agent: { readonly machine_id: string; readonly agent_id: string }; readonly name: string; readonly exit: ProcessExit; readonly how?: HowEnded; readonly resumable: boolean } | { readonly kind: 'send_failed'; readonly target: { readonly machine_id: string; readonly agent_id: string }; readonly message: { readonly machine_id: string; readonly message_id: string }; readonly delivery: Delivery; readonly withdrawn: boolean };

export interface Notification {
	readonly jsonrpc: JsonRpc;
	readonly method: string;
	readonly params: unknown;
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

export type ProcessState = 'running' | 'ended' | 'unknown';

/** A start prompt's message ID and what became of it. */
export interface PromptOutcome {
	readonly message_id: string;
	readonly delivery: Delivery;
}

export interface ProtocolMismatchDetails {
	readonly offered_api_versions?: ApiVersions;
	readonly supported_api_versions: ApiVersions;
	readonly agents?: AgentLabel[];
}

export type QueryStatus = 'answered' | 'unavailable' | 'timed_out' | 'error';

export interface RemoveResult {
	readonly reference: AgentRef;
	readonly address: string;
}

export interface RenameArgs {
	readonly target: AgentTarget;
	readonly name: string;
}

export interface RenameResult {
	readonly agent: AgentInfo;
	readonly previous_name?: string;
}

export type ReplyTo = string | { readonly machine_id: string; readonly message_id: string };

export interface Request {
	readonly jsonrpc: JsonRpc;
	readonly id?: number;
	readonly method: string;
	readonly params: unknown;
}

export type Response = { readonly jsonrpc: JsonRpc; readonly id: number; readonly result: unknown } | { readonly jsonrpc: JsonRpc; readonly id: number | null; readonly error: ErrorBody };

export interface ResumeArgs {
	readonly target: ResumeTarget;
	readonly size: { readonly cols: number; readonly rows: number };
	readonly env?: { readonly [key: string]: string };
}

export interface ResumeCandidate {
	readonly target: ResumeCandidateTarget;
	readonly machine_id: string;
	readonly cli: string;
	readonly folder: string;
	readonly session: string;
	readonly agent?: AgentRef;
	readonly name?: string;
	readonly stopped?: boolean;
	readonly title?: string;
	readonly at?: string;
	readonly session_name?: string;
	readonly session_selector?: string;
}

export type ResumeCandidateTarget = { readonly kind: 'agent'; readonly reference: AgentRef } | { readonly kind: 'session'; readonly machine_id: string; readonly cli: string; readonly session: string; readonly folder: string };

export interface ResumeListArgs {
	readonly scope?: Scope;
	readonly folder?: string;
	readonly folder_scope?: FolderScope;
}

export interface ResumeListResult {
	readonly items: ResumeCandidate[];
	readonly machines: MachineQuery[];
}

export interface ResumeResult {
	readonly agent: AgentInfo;
	readonly from_saved_session?: boolean;
}

export type ResumeTarget = { readonly kind: 'agent'; readonly reference: { readonly machine_id: string; readonly agent_id: string } } | { readonly kind: 'session'; readonly machine_id: string; readonly cli: string; readonly session: string; readonly folder: string } | { readonly kind: 'selector'; readonly selector: string; readonly scope?: SingleMachineScope; readonly folder?: string };

/** The latest submission through an agent's terminal, from a person, an `agent.type` call with
 * `enter`, or a message Facade Code Framework delivered. */
export interface Said {
	readonly text: string;
	readonly from: string;
	readonly from_name?: string;
	readonly at: string;
}

export type Scope = { readonly kind: 'local' } | { readonly kind: 'machine'; readonly machine: string } | { readonly kind: 'reachable' };

export interface ScreenArgs {
	readonly target: AgentTarget;
	readonly lines?: number;
}

/** The screen buffer a CLI shows. */
export type ScreenBuffer = 'normal' | 'alternate';

export type ScreenChange = { readonly kind: 'output'; readonly data: string } | { readonly kind: 'redraw'; readonly size: Size; readonly data: string } | { readonly kind: 'activity'; readonly working: boolean } | { readonly kind: 'exit'; readonly exit: ProcessExit; readonly exit_status?: number; readonly resume_hint?: string } | { readonly kind: 'removed' };

export interface ScreenSnapshot {
	readonly reference: AgentRef;
	readonly address: string;
	readonly size: Size;
	readonly redraw: string;
	readonly name?: string;
	readonly exit?: ProcessExit;
	readonly exit_status?: number;
	readonly resume_hint?: string;
	readonly process?: ProcessState;
	readonly working?: boolean;
}

export interface ScreenText {
	readonly reference: AgentRef;
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

export interface SendArgs {
	readonly to: AgentTarget;
	readonly text: string;
	readonly reply_to?: ReplyTo;
	readonly request_id?: string;
	readonly time_left_ms?: number;
	readonly allow_unsupported_receipt?: boolean;
	readonly wait_for?: SendWait;
}

export interface SendResult {
	readonly id: string;
	readonly message: Message;
	readonly recipient?: AgentLabel;
	readonly repeated?: boolean;
	readonly withdrawn?: boolean;
	readonly expected_reply_to?: MessageRef;
	readonly reply?: CommandReply;
}

export type SendWait = 'inbox' | 'delivery' | 'result';

export type SingleMachineScope = { readonly kind: 'local' } | { readonly kind: 'machine'; readonly machine: string };

export interface Size {
	readonly cols: number;
	readonly rows: number;
}

/** A diagnostic and the command that repairs the saved SSH connection. */
export interface SshInteraction {
	readonly message: string;
	readonly command: string[];
}

/** Normalized SSH arguments, including an empty argv when no options are required. */
export interface SshTransport {
	readonly ssh_destination: string;
	readonly ssh_args: string[];
	readonly remote_home?: string;
	readonly kind: 'ssh';
}

export interface StartArgs {
	readonly cli: string;
	readonly size: { readonly cols: number; readonly rows: number };
	readonly args?: string[];
	readonly scope?: SingleMachineScope;
	readonly folder?: string;
	readonly folder_is_default?: boolean;
	readonly worktree?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly name?: string;
	readonly prompt?: string;
	readonly env?: { readonly [key: string]: string };
	readonly request_id?: string;
	readonly call_id?: string;
}

export interface StartOutcome {
	readonly agent: AgentInfo;
	readonly prompt: PromptOutcome;
}

export interface StartResult {
	readonly agent: AgentInfo;
	readonly prompt?: Message;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly repeated?: boolean;
}

/** More about an agent's state. */
export interface StateDetail {
	readonly kind?: WaitKind;
	readonly text?: string;
	readonly how?: HowEnded;
	readonly reason?: StateReason;
}

/** Why nothing shows what an agent's CLI is doing, or what Facade Code Framework found wrong with it. */
export type StateReason = 'not_shown' | 'asked' | 'taken_back' | 'unrecognized' | 'not_ready' | 'tools_unavailable';

export interface StatusArgs {
	readonly scope?: SingleMachineScope;
}

export interface StatusResult {
	readonly home: string;
	readonly settings_file: string;
	readonly build: string;
	readonly daemon_pid: number;
	readonly keeper_pid?: number;
	readonly agent_count: number;
	readonly machines: MachineQuery[];
}

export interface StopArgs {
	readonly selection: StopSelection;
}

export type StopItem = { readonly target: string | AgentRef; readonly agent?: AgentLabel } & ({ readonly status: 'stopped'; readonly exit: ProcessExit } | { readonly status: 'failed'; readonly error: ErrorBody } | { readonly status: 'skipped' });

export type StopSelection = { readonly kind: 'targets'; readonly targets: AgentTarget[] } | { readonly kind: 'all'; readonly scope: Scope };

export interface TerminalColors {
	readonly foreground?: string;
	readonly background?: string;
	readonly cursor?: string;
}

export type TerminalInput = { readonly kind: 'text'; readonly text: string; readonly enter?: boolean } | { readonly kind: 'keys'; readonly keys: string[] } | { readonly kind: 'raw'; readonly raw: string } | { readonly kind: 'sequence'; readonly steps: InputStep[] };

/** How much of a message reached the recipient's terminal. */
export type TextWritten = 'none' | 'partial' | 'full' | 'unknown';

/** Why an agent's CLI cannot use the Facade Code Framework tools it was given. */
export type ToolsReason = 'not_given' | 'not_connected' | 'not_started' | 'disconnected' | 'ended';

/** Whether an agent's CLI can use Facade Code Framework's tools: `facade-mcp`, the MCP server that a CLI started
 * by its rule is given for its run. */
export type ToolsState = 'not_injected' | 'connecting' | 'available' | 'unavailable';

export interface TypeResult {
	readonly agent?: AgentLabel;
}

export interface UnwatchParams {
	readonly watch: number;
}

/** What a CLI waits for. */
export type WaitKind = 'permission' | 'question' | 'auth' | 'unknown';

export interface WatchEndedParams {
	readonly watch: number;
	readonly error: ErrorBody;
}

export type WatchParams = { readonly topic: 'agents'; readonly args: NoArgs } | { readonly topic: 'machines'; readonly args: NoArgs } | { readonly topic: 'attach'; readonly args: AttachArgs } | { readonly topic: 'attach.shell'; readonly args: AttachArgs };

export interface WatchResult {
	readonly watch: number;
	readonly snapshot: AgentsSnapshot | MachineInfo[] | ScreenSnapshot;
}

/** Argument and result types for each operation. */
export interface DaemonOperations {
	readonly "agent.list": { readonly args: AgentListArgs; readonly result: AgentListResult };
	readonly "agent.start": { readonly args: StartArgs; readonly result: StartResult };
	readonly "agent.stop": { readonly args: StopArgs; readonly result: BatchStopResult };
	readonly "agent.resume_list": { readonly args: ResumeListArgs; readonly result: ResumeListResult };
	readonly "agent.resume": { readonly args: ResumeArgs; readonly result: ResumeResult };
	readonly "agent.inspect": { readonly args: AgentTargetArgs; readonly result: InspectResult };
	readonly "agent.screen": { readonly args: ScreenArgs; readonly result: ScreenText };
	readonly "agent.type": { readonly args: AgentTypeArgs; readonly result: TypeResult };
	readonly "agent.send": { readonly args: SendArgs; readonly result: SendResult };
	readonly "agent.remove": { readonly args: AgentTargetArgs; readonly result: RemoveResult };
	readonly "agent.rename": { readonly args: RenameArgs; readonly result: RenameResult };
	readonly "attach.resize": { readonly args: AttachResizeArgs; readonly result: EmptyResult };
	readonly "cli.list": { readonly args: CliListArgs; readonly result: CliListResult };
	readonly "location.list": { readonly args: LocationListArgs; readonly result: LocationListResult };
	readonly "machine.list": { readonly args: NoArgs; readonly result: MachineListResult };
	readonly "machine.connect": { readonly args: MachineConnectArgs; readonly result: MachineConnectResult };
	readonly "machine.remove": { readonly args: MachineRemoveArgs; readonly result: MachineRemoveResult };
	readonly "machine.rename": { readonly args: MachineRenameArgs; readonly result: MachineRenameResult };
	readonly "daemon.status": { readonly args: StatusArgs; readonly result: StatusResult };
	readonly "daemon.log": { readonly args: LogArgs; readonly result: LogResult };
	readonly "daemon.upgrade": { readonly args: DaemonUpgradeArgs; readonly result: DaemonUpgradeResult };
	readonly "internal.agent_records": { readonly args: InternalAgentRecordsArgs; readonly result: AgentLookupCandidate[] };
	readonly "internal.resume_records": { readonly args: NoArgs; readonly result: ResumeCandidate[] };
	readonly "internal.ensure_route": { readonly args: InternalEnsureRouteArgs; readonly result: EmptyResult };
	readonly "internal.attach_resize": { readonly args: InternalAttachResizeArgs; readonly result: EmptyResult };
	readonly "internal.deliver_start_result": { readonly args: InternalDeliverStartResultArgs; readonly result: EmptyResult };
	readonly "internal.deliver_wait_notice": { readonly args: InternalDeliverWaitNoticeArgs; readonly result: EmptyResult };
	readonly "internal.deliver_notice": { readonly args: InternalDeliverNoticeArgs; readonly result: EmptyResult };
	readonly "internal.command_reply": { readonly args: CommandReplyArgs; readonly result: EmptyResult };
}

/** Argument, snapshot, and change types for each topic. Skip unknown change kinds. */
export interface DaemonTopics {
	readonly "agents": { readonly args: NoArgs; readonly snapshot: AgentsSnapshot; readonly change: AgentsChange };
	readonly "machines": { readonly args: NoArgs; readonly snapshot: MachineInfo[]; readonly change: MachinesChange };
	readonly "attach": { readonly args: AttachArgs; readonly snapshot: ScreenSnapshot; readonly change: ScreenChange };
	readonly "attach.shell": { readonly args: AttachArgs; readonly snapshot: ScreenSnapshot; readonly change: ScreenChange };
}
