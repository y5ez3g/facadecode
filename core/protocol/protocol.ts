// Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit.

export const PROTOCOL = 2;
export const OLDEST_PROTOCOL = 2;
export const METHODS = ["hello","call","watch","unwatch","cancel","changed","watch_ended","advertise","forward","connected","connect_failed","closing"] as const;
export const TOPICS = ["agents","screen","messages","windows","machines"] as const;
export const OPS = ["agent.start","agent.resume","agent.adopt","agent.stop","agent.remove","agent.inspect","agent.type","agent.screen","agent.resize","agent.rename","agent.send","hook.session-start","hook.prompt","hook.turn-end","hook.idle","hook.session-end","integration.add","integration.remove","integration.list","window.update","worktree.create","daemon.upgrade","daemon.log","machine.connect","machine.add","machine.list","machine.remove","machine.rename","agent.list","cli.list","location.list","agent.start_preflight"] as const;
export type Topic = typeof TOPICS[number];
export type Operation = keyof Operations;
export type V3Topic = keyof V3Topics;
export type V3Operation = keyof V3Operations;

/** A complete replacement for a directly connected machine's table. Every row has a route, build
 * and boot ID. */
export interface AdvertiseParams {
	readonly machines: MachineInfo[];
}

/** Arguments for an operation on one agent. */
export interface AgentArgs {
	readonly agent: string;
}

/** The source of an agent's start, as displayed to the caller. */
export type AgentCreator = { readonly kind: 'agent'; readonly address: string } | { readonly kind: 'command_line' } | { readonly kind: 'vs_code' };

/** An agent record. */
export interface AgentInfo {
	readonly agent_id: string;
	readonly address?: string;
	readonly label?: string;
	readonly unreachable?: boolean;
	readonly name: string;
	readonly cli: string;
	readonly cwd: string;
	readonly machine_id: string;
	readonly windows: WindowRef[];
	readonly location_id: string;
	readonly location_source_window?: WindowRef;
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
	readonly state: AgentState;
	readonly state_detail?: StateDetail;
	readonly said?: Said;
	readonly tools_state: ToolsState;
	readonly tools_reason?: ToolsReason;
	readonly guest?: boolean;
}

export type AgentKind = 'managed' | 'guest';

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

export interface AgentListResult {
	readonly agents: AgentInfo[];
	readonly machines: MachineQueryResult[];
}

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

/** How complete the agent view is for one remote running machine. */
export interface AgentMachineState {
	readonly machine_id: string;
	readonly state: AgentSyncState;
	readonly agents?: AgentInfo[];
}

/** An agent's durable identity, independently of names and routes. */
export interface AgentRef {
	readonly machine_id: string;
	readonly agent_id: string;
}

/** The recorded cause of an agent record's removal. */
export type AgentRemoval = 'expired' | 'removed';

/** What an agent is doing, from its CLI's own status reports, from its screen where its CLI's rule
 * reads it, and from Facade's own facts. The first state that holds, in this order, is the
 * agent's: `waiting_for_you`, `error`, `just_done`, `working`, `idle`, `starting`, then `unknown`;
 * `ended` once its process ended. */
export type AgentState = 'starting' | 'working' | 'waiting_for_you' | 'just_done' | 'idle' | 'error' | 'ended' | 'unknown';

export type AgentSyncState = 'synced' | 'pending' | 'unreachable';

export type AgentTarget = { readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef };

/** A change to the `agents` topic. Skip unknown change kinds. */
export type AgentsChange = { readonly kind: 'updated'; readonly agent: AgentInfo } | { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string } | { readonly kind: 'machine_state'; readonly machine: AgentMachineState };

/** The agents view and the synchronization state of its remote contributors. */
export interface AgentsSnapshot {
	readonly agents: AgentInfo[];
	readonly machines: AgentMachineState[];
}

/** Arguments for the agents view. The member-machine filter is for internal forwarded watches. */
export interface AgentsWatchArgs {
	readonly member_machine_id?: string;
}

/** Parameters for `call`. */
export type CallParams = { readonly op: 'agent.start'; readonly args: StartArgs } | { readonly op: 'agent.resume'; readonly args: ResumeArgs } | { readonly op: 'agent.adopt'; readonly args: AgentArgs } | { readonly op: 'agent.stop'; readonly args: AgentArgs } | { readonly op: 'agent.remove'; readonly args: AgentArgs } | { readonly op: 'agent.inspect'; readonly args: AgentArgs } | { readonly op: 'agent.type'; readonly args: TypeArgs } | { readonly op: 'agent.screen'; readonly args: ScreenArgs } | { readonly op: 'agent.resize'; readonly args: ResizeArgs } | { readonly op: 'agent.rename'; readonly args: RenameArgs } | { readonly op: 'agent.send'; readonly args: SendArgs } | { readonly op: 'hook.session-start'; readonly args: HookSession } | { readonly op: 'hook.prompt'; readonly args: HookSession } | { readonly op: 'hook.turn-end'; readonly args: HookSession } | { readonly op: 'hook.idle'; readonly args: HookSession } | { readonly op: 'hook.session-end'; readonly args: HookSession } | { readonly op: 'integration.add'; readonly args: IntegrationArgs } | { readonly op: 'integration.remove'; readonly args: IntegrationArgs } | { readonly op: 'integration.list'; readonly args: IntegrationsArgs } | { readonly op: 'window.update'; readonly args: WindowDescription } | { readonly op: 'worktree.create'; readonly args: WorktreeCreateArgs } | { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs } | { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } | { readonly op: 'machine.connect'; readonly args: MachineConnectArgs } | { readonly op: 'machine.add'; readonly args: MachineAddArgs } | { readonly op: 'machine.list'; readonly args: NoArgs } | { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } | { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } | { readonly op: 'agent.list'; readonly args: MachineQueryArgs } | { readonly op: 'cli.list'; readonly args: MachineQueryArgs } | { readonly op: 'location.list'; readonly args: MachineQueryArgs } | { readonly op: 'agent.start_preflight'; readonly args: StartArgs } | { readonly op: 'window.deliver'; readonly args: DeliverArgs } | { readonly op: 'agent.deliver_start_result'; readonly args: DeliverStartResultArgs };

/** The identity supplied by the daemon that accepted a local call. */
export type Caller = { readonly kind: 'terminal'; readonly machine_id: string } | { readonly kind: 'ide'; readonly window: WindowRef } | { readonly kind: 'agent'; readonly agent: AgentRef; readonly root: AgentRef; readonly yolo: boolean };

/** A `changed` notification for one watch. */
export interface ChangedParams {
	readonly watch: number;
	readonly change: AgentsChange | ScreenChange | MessagesChange | WindowsChange | MachinesChange;
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

/** A single message for the person, offered to its member windows on another machine. */
export interface DeliverArgs {
	readonly message_ref: MessageRef;
	readonly message: Message;
	readonly windows: WindowRef[];
}

/** A start's result message for its creator, with the number the creator's machine reserved. */
export interface DeliverStartResultArgs {
	readonly recipient: AgentRef;
	readonly message: Message;
}

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
	readonly windows?: WindowDeliveryFailure[];
	readonly window_delivery?: WindowDelivery;
	readonly message_ref?: MessageRef;
	readonly record_removal?: AgentRemoval;
	readonly machine_id_conflict?: MachineIdConflict;
	readonly ssh_interaction?: SshInteraction;
	readonly unavailable?: Unavailable;
	readonly candidates?: string[];
	readonly protocol?: ProtocolMismatch;
}

export type ExecutionOutcome = 'not_executed' | 'outcome_unknown';

/** A call on a machine session with facts the originating daemon takes from the local caller. */
export interface ForwardCall {
	readonly call: CallParams;
	readonly by_model: boolean;
	readonly from_name?: string;
	readonly from_window?: string;
	readonly window_colors?: TerminalColors;
}

/** Parameters of `forward`. The outer JSON-RPC ID identifies this hop. */
export interface ForwardParams {
	readonly route: string[];
	readonly caller: Caller;
	readonly time_left_ms?: number;
	readonly request_id?: string;
	readonly method: string;
	readonly params: unknown;
}

/** The messages `hook.prompt` and `hook.turn-end` take for a guest's model, at its next turn. */
export interface HandOver {
	readonly messages: Message[];
}

/** Parameters for `hello`. */
export interface HelloParams {
	readonly protocol: [number, number];
	readonly build: string;
	readonly kind: ClientKind;
	readonly agent?: string;
	readonly sessions?: string[];
	readonly window?: WindowDescription;
	readonly numbers_given?: NumbersGiven;
	readonly machine?: MachineHello;
}

/** The result of `hello`: daemon details and supported topics and operations. */
export interface HelloResult {
	readonly protocol: number;
	readonly build: string;
	readonly machine_id: string;
	readonly machine?: MachineHello;
	readonly window?: WindowRef;
	readonly pid: number;
	readonly agent?: string;
	readonly agents: number;
	readonly keeper?: KeeperInfo;
	readonly topics: string[];
	readonly ops: string[];
}

/** Rows of a draft scrolled out of the CLI's input, as the CLI marks them. */
export interface HiddenRows {
	readonly above: number;
	readonly below: number;
}

/** The session a CLI's hook reports on. */
export interface HookSession {
	readonly cli: string;
	readonly session: string;
	readonly cwd?: string;
	readonly pid?: number;
	readonly parent?: string;
	readonly env?: { readonly [key: string]: string };
	readonly status_file?: string;
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

/** The result of `agent.inspect`. */
export interface InspectResult {
	readonly agent: AgentInfo;
	readonly rule?: string;
	readonly input: InputInfo;
	readonly session_tracking: boolean;
}

/** Arguments for `integration.add` and `integration.remove`. */
export interface IntegrationArgs {
	readonly cli: string;
	readonly env: { readonly [key: string]: string };
}

/** A CLI's integration: Facade's entries in the CLI's user configuration, through which its
 * sessions join as guests. */
export interface IntegrationInfo {
	readonly cli: string;
	readonly added_at?: string;
	readonly parts: IntegrationPart[];
	readonly notes?: string[];
}

/** A file of a CLI's integration, and whether it holds Facade's entries. */
export interface IntegrationPart {
	readonly file: string;
	readonly state: PartState;
}

/** Arguments for `integration.list`. */
export interface IntegrationsArgs {
	readonly env: { readonly [key: string]: string };
}

/** What `integration.list` answers: each CLI Facade can integrate. */
export interface IntegrationsList {
	readonly integrations: IntegrationInfo[];
}

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

/** A place an agent can work: a window's folder, or a checkout of a Git repository one of its
 * folders is in. */
export interface LocationInfo {
	readonly location_id: string;
	readonly label: string;
	readonly path: string;
	readonly kind: LocationKind;
}

/** What a location is. */
export type LocationKind = 'folder' | 'main' | 'worktree';

export interface LocationListArgs {
	readonly machine?: string;
	readonly folders?: string[];
}

export interface LocationListResult {
	readonly locations: WindowLocation[];
}

/** Save the identity verified in the foreground session. */
export interface MachineAddArgs {
	readonly ssh_destination: string;
	readonly remote_home?: string;
	readonly machine_id: string;
}

/** The saved connection is ready. */
export interface MachineAddResult {
	readonly machine: MachineHello;
	readonly first_connection: boolean;
}

/** A foreground machine session to authorize. */
export interface MachineConnectArgs {
	readonly transport: MachineTransport;
	readonly kind: ConnectionKind;
}

/** Returned before switching the local client stream into a machine session. */
export interface MachineConnectResult {
	readonly ssh_destination?: string;
	readonly remote_home?: string;
	readonly expected_machine_id?: string;
}

/** One connection as seen from its machine table row. */
export interface MachineConnection {
	readonly machine_id: string;
	readonly initiator_machine_id: string;
	readonly kind: ConnectionKind;
	readonly ssh_destination?: string;
	readonly remote_home?: string;
	readonly state: ConnectionState;
	readonly ssh_interaction?: SshInteraction;
}

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

/** A row visible from the machine that supplies the table. */
export interface MachineInfo {
	readonly machine_id: string;
	readonly boot_id?: string;
	readonly name: string;
	readonly build?: string;
	readonly route?: string[];
	readonly connections: MachineConnection[];
}

export interface MachineListResult {
	readonly machines: MachineInfo[];
}

/** A frame from either direction of a machine session. A request without an ID is a notification. */
export type MachineMessage = Request | Response;

/** Selects a machine for a query. An omitted selector uses the operation's default. */
export interface MachineQueryArgs {
	readonly machine?: string;
}

/** The outcome of asking one machine for its reachable agents. */
export interface MachineQueryResult {
	readonly machine_id: string;
	readonly short_id: string;
	readonly name: string;
	readonly build?: string;
	readonly status: MachineQueryStatus;
	readonly answered_at?: string;
}

export type MachineQueryStatus = 'answered' | 'unavailable' | 'timed_out' | 'error';

export interface MachineRemoveArgs {
	readonly machine: string;
}

export interface MachineRemoveResult {
	readonly machine_id: string;
	readonly ssh_destination: string;
	readonly remote_home?: string;
	readonly reachable: boolean;
}

export interface MachineRenameArgs {
	readonly machine: string;
	readonly name: string;
}

export interface MachineRenameResult {
	readonly machine_id: string;
	readonly name: string;
}

export type MachineState = 'online' | 'connecting' | 'sleeping' | 'unreachable' | 'ssh_interaction_required';

/** The transport the local client will bridge to this machine session. */
export type MachineTransport = { readonly kind: 'ssh'; readonly ssh_destination: string; readonly remote_home?: string } | { readonly kind: 'bridge' };

/** A change to the machine table visible to a client. */
export type MachinesChange = { readonly kind: 'updated'; readonly machine: MachineInfo } | { readonly kind: 'removed'; readonly machine_id: string };

/** A message: one sender, one recipient, the complete text, and what became of it. */
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
	readonly from_window?: string;
	readonly call_id?: string;
	readonly result?: StartOutcome;
	readonly at: string;
	readonly delivery: Delivery;
}

/** A message's identity on the machine that assigned its number. */
export interface MessageRef {
	readonly machine_id: string;
	readonly message_id: string;
}

/** A change to the `messages` topic. Skip unknown change kinds. */
export type MessagesChange = { readonly kind: 'updated'; readonly message: Message } | { readonly kind: 'removed'; readonly message_id: string };

/** The inbox at the start of a `messages` watch. */
export interface MessagesSnapshot {
	readonly messages: Message[];
	readonly not_found?: string[];
	readonly next_cursor?: string;
}

/** Arguments for the `messages` topic: which messages of the inbox to read. Without `ids` or `all`,
 * the messages not yet delivered. */
export interface MessagesWatchArgs {
	readonly ids?: string[];
	readonly all?: boolean;
	readonly cursor?: string;
	readonly limit?: number;
	readonly last?: number;
}

/** Empty arguments: `{}`. May be omitted for topics that take no arguments. */
export type NoArgs = Record<string, never>;

/** A message without an ID or response, such as `changed`. */
export interface Notification {
	readonly jsonrpc?: string;
	readonly method: string;
	readonly params?: unknown;
}

/** The highest numbers an editor gave before. */
export interface NumbersGiven {
	readonly agent: number;
	readonly message: number;
}

/** Whether a start can choose a CLI's model and its effort. */
export interface Overrides {
	readonly model: boolean;
	readonly effort: boolean;
}

/** Whether a file of a CLI's integration holds Facade's entries. */
export type PartState = 'as_written' | 'changed' | 'missing';

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

/** Arguments for `agent.rename`. */
export interface RenameArgs {
	readonly agent: string;
	readonly name: string;
}

/** A method call. Calls with an ID receive a response; calls without an ID are notifications. */
export interface Request {
	readonly jsonrpc?: string;
	readonly id?: number;
	readonly method: string;
	readonly params?: unknown;
}

/** Arguments for `agent.resize`. */
export interface ResizeArgs {
	readonly agent: string;
	readonly cols: number;
	readonly rows: number;
}

/** A response containing either a result or an error. */
export interface Response {
	readonly jsonrpc?: string;
	readonly id: number | null;
	readonly result?: unknown;
	readonly error?: ErrorBody;
}

/** Arguments for `agent.resume`, supplied by the client. */
export interface ResumeArgs {
	readonly agent: string;
	readonly env?: { readonly [key: string]: string };
	readonly cols: number;
	readonly rows: number;
}

export interface ResumeCandidate {
	readonly target: ResumeTarget;
	readonly cli: string;
	readonly folder: string;
	readonly machine_id: string;
	readonly session: string;
	readonly agent?: AgentRef;
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

/** Arguments for `agent.screen`. */
export interface ScreenArgs {
	readonly agent: string;
	readonly lines?: number;
}

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

/** A full screen snapshot at the start of a watch. */
export interface ScreenSnapshot {
	readonly agent_id: string;
	readonly machine_id: string;
	readonly cols: number;
	readonly rows: number;
	readonly redraw: string;
	readonly exit?: ProcessExit;
	readonly process?: ProcessState;
}

/** The result of `agent.screen`: the last logical lines of an agent's screen and scrollback, as
 * they show. */
export interface ScreenText {
	readonly agent_id: string;
	readonly process: ProcessState;
	readonly observed_at: string;
	readonly buffer: ScreenBuffer;
	readonly text: string;
	readonly line_count: number;
	readonly older_lines: boolean;
	readonly trimmed: boolean;
}

/** Arguments for the `screen` topic. */
export interface ScreenWatchArgs {
	readonly agent: string;
	readonly keep_scrollback?: boolean;
	readonly include_scrollback?: boolean;
}

/** Arguments for `agent.send`. */
export interface SendArgs {
	readonly to: string;
	readonly text: string;
	readonly reply_to?: string;
	readonly reply_to_machine_id?: string;
	readonly request_id?: string;
	readonly time_left_ms?: number;
}

/** The response to `agent.send`: the message as it stands, whether the call repeated an earlier
 * one, and whether its failure withdrew it. */
export interface SendResult {
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
	readonly result?: StartOutcome;
	readonly at: string;
	readonly delivery: Delivery;
	readonly repeated?: boolean;
	readonly withdrawn?: boolean;
	readonly windows?: WindowDelivery;
}

/** A response or notification received from a server. */
export type ServerMessage = Notification | Response;

/** What `hook.session-start` answers. */
export interface SessionStartResult {
	readonly agent_id?: string;
	readonly instructions?: string;
}

export interface SshInteraction {
	readonly reason: string;
	readonly command: string[];
}

/** Arguments for `agent.start`, supplied by the client. */
export interface StartArgs {
	readonly command: string[];
	readonly name?: string;
	readonly cwd: string;
	readonly machine?: string;
	readonly cwd_is_default?: boolean;
	readonly window?: WindowRef;
	readonly initial_windows?: WindowRef[];
	readonly location_source_window?: WindowRef;
	readonly env?: { readonly [key: string]: string };
	readonly cols: number;
	readonly rows: number;
	readonly prompt?: string;
	readonly call_id?: string;
	readonly result_message_id?: string;
	readonly result_message_machine_id?: string;
	readonly request_id?: string;
	readonly worktree?: Worktree;
	readonly model?: string;
	readonly effort?: string;
	readonly session?: string;
}

/** What became of a start with a prompt, as its result tells the agent that started it. */
export interface StartOutcome {
	readonly agent: AgentInfo;
	readonly prompt: PromptOutcome;
}

/** The result of `agent.start`. */
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

/** The result of `agent.stop`: the CLI's recorded exit, and whether it had ended before this stop. */
export interface StopResult {
	readonly code?: number;
	readonly signal?: string;
	readonly reason?: EndReason;
	readonly at: string;
	readonly already_ended?: boolean;
}

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

/** Arguments for `agent.type`: exactly one of `raw`, `text`, or `keys`. */
export interface TypeArgs {
	readonly agent: string;
	readonly raw?: string;
	readonly text?: string;
	readonly enter?: boolean;
	readonly keys?: string[];
}

export interface Unavailable {
	readonly execution: ExecutionOutcome;
	readonly machine?: MachineIdentity;
	readonly window?: WindowRef;
	readonly matches?: string[];
	readonly unanswered?: MachineIdentity[];
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
	readonly process: ProcessState;
	readonly observed_at: string;
	readonly buffer: ScreenBuffer;
	readonly text: string;
	readonly line_count: number;
	readonly older_lines: boolean;
	readonly trimmed: boolean;
}

export type V3ScreenWatchArgs = { readonly keep_scrollback?: boolean; readonly include_scrollback?: boolean; readonly viewer?: string } & ({ readonly agent: string; readonly reference?: never } | { readonly agent?: never; readonly reference: AgentRef });

export interface V3SendArgs {
	readonly to: string;
	readonly text: string;
	readonly reply_to?: string;
	readonly reply_to_machine_id?: string;
	readonly request_id?: string;
	readonly time_left_ms?: number;
}

/** The receipt of a send, with the address that can be used to wait for a reply. */
export interface V3SendResult {
	readonly id: string;
	readonly message: V3Message;
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
export type WatchParams = { readonly topic: 'agents'; readonly args: AgentsWatchArgs } | { readonly topic: 'screen'; readonly args: ScreenWatchArgs } | { readonly topic: 'messages'; readonly args: MessagesWatchArgs } | { readonly topic: 'windows'; readonly args?: NoArgs } | { readonly topic: 'machines'; readonly args?: NoArgs };

/** The result of `watch`, sent before any changes for that watch. */
export interface WatchResult {
	readonly watch: number;
	readonly snapshot: AgentsSnapshot | ScreenSnapshot | MessagesSnapshot | WindowInfo[] | MachineInfo[];
}

/** The member windows' outcomes for one message to the person. */
export interface WindowDelivery {
	readonly delivered: WindowRef[];
	readonly not_delivered: WindowDeliveryFailure[];
	readonly outcome_unknown: WindowRef[];
}

/** Why a member window did not take a notification. */
export interface WindowDeliveryFailure {
	readonly window: WindowRef;
	readonly reason: string;
}

/** An editor window as it describes itself, in `hello` and again with `window.update` whenever any
 * of it changes. */
export interface WindowDescription {
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
export interface WindowInfo {
	readonly machine_id: string;
	readonly window_id: string;
	readonly label: string;
	readonly environment: string;
	readonly connected: boolean;
	readonly folders: string[];
	readonly locations: LocationInfo[];
	readonly problems?: string[];
	readonly observed_at?: string;
	readonly clis?: CliInfo[];
	readonly settings_problem?: string;
}

export interface WindowLocation {
	readonly window: WindowRef;
	readonly location: LocationInfo;
}

/** A logical window on a Facade machine. */
export interface WindowRef {
	readonly machine_id: string;
	readonly window_id: string;
}

/** A change to the windows. */
export type WindowsChange = { readonly kind: 'updated'; readonly window: WindowInfo } | { readonly kind: 'removed'; readonly machine_id: string; readonly window_id: string };

/** A new worktree: its branch and where the branch starts. */
export interface Worktree {
	readonly branch: string;
	readonly base_ref: string;
}

/** Arguments for `worktree.create`. */
export interface WorktreeCreateArgs {
	readonly window_id: string;
	readonly cwd: string;
	readonly branch: string;
	readonly base_ref: string;
}

/** Protocol 2 types used by takeover diagnostics and legacy fixtures. */
export type V2AgentInfo = AgentInfo;
export type V2AgentListResult = AgentListResult;
export type V2HelloParams = HelloParams;
export type V2HelloResult = HelloResult;
export type V2MachineConnection = MachineConnection;
export type V2MachineInfo = MachineInfo;
export type V2StartArgs = StartArgs;
export type V2StartResult = StartResult;
export type V2WatchResult = WatchResult;
export type V2WindowInfo = WindowInfo;
export type V2WindowRef = WindowRef;

/** Argument and result types for each operation. */
export interface Operations {
	readonly "agent.start": { readonly args: StartArgs; readonly result: StartResult };
	readonly "agent.resume": { readonly args: ResumeArgs; readonly result: AgentInfo };
	readonly "agent.adopt": { readonly args: AgentArgs; readonly result: AgentInfo };
	readonly "agent.stop": { readonly args: AgentArgs; readonly result: StopResult };
	readonly "agent.remove": { readonly args: AgentArgs; readonly result: EmptyResult };
	readonly "agent.inspect": { readonly args: AgentArgs; readonly result: InspectResult };
	readonly "agent.type": { readonly args: TypeArgs; readonly result: EmptyResult };
	readonly "agent.screen": { readonly args: ScreenArgs; readonly result: ScreenText };
	readonly "agent.resize": { readonly args: ResizeArgs; readonly result: EmptyResult };
	readonly "agent.rename": { readonly args: RenameArgs; readonly result: AgentInfo };
	readonly "agent.send": { readonly args: SendArgs; readonly result: SendResult };
	readonly "hook.session-start": { readonly args: HookSession; readonly result: SessionStartResult };
	readonly "hook.prompt": { readonly args: HookSession; readonly result: HandOver };
	readonly "hook.turn-end": { readonly args: HookSession; readonly result: HandOver };
	readonly "hook.idle": { readonly args: HookSession; readonly result: EmptyResult };
	readonly "hook.session-end": { readonly args: HookSession; readonly result: EmptyResult };
	readonly "integration.add": { readonly args: IntegrationArgs; readonly result: IntegrationInfo };
	readonly "integration.remove": { readonly args: IntegrationArgs; readonly result: IntegrationInfo };
	readonly "integration.list": { readonly args: IntegrationsArgs; readonly result: IntegrationsList };
	readonly "window.update": { readonly args: WindowDescription; readonly result: EmptyResult };
	readonly "worktree.create": { readonly args: WorktreeCreateArgs; readonly result: LocationInfo };
	readonly "daemon.upgrade": { readonly args: UpgradeArgs; readonly result: UpgradeResult };
	readonly "daemon.log": { readonly args: DaemonLogArgs; readonly result: DaemonLogResult };
	readonly "machine.connect": { readonly args: MachineConnectArgs; readonly result: MachineConnectResult };
	readonly "machine.add": { readonly args: MachineAddArgs; readonly result: MachineAddResult };
	readonly "machine.list": { readonly args: NoArgs; readonly result: MachineListResult };
	readonly "machine.remove": { readonly args: MachineRemoveArgs; readonly result: MachineRemoveResult };
	readonly "machine.rename": { readonly args: MachineRenameArgs; readonly result: MachineRenameResult };
	readonly "agent.list": { readonly args: MachineQueryArgs; readonly result: AgentListResult };
	readonly "cli.list": { readonly args: MachineQueryArgs; readonly result: CliListResult };
	readonly "location.list": { readonly args: MachineQueryArgs; readonly result: LocationListResult };
	readonly "agent.start_preflight": { readonly args: StartArgs; readonly result: EmptyResult };
	readonly "window.deliver": { readonly args: DeliverArgs; readonly result: WindowDelivery };
	readonly "agent.deliver_start_result": { readonly args: DeliverStartResultArgs; readonly result: EmptyResult };
}

/** Argument, snapshot, and change types for each topic. Skip unknown change kinds. */
export interface Topics {
	readonly agents: { readonly args: AgentsWatchArgs; readonly snapshot: AgentsSnapshot; readonly change: AgentsChange };
	readonly screen: { readonly args: ScreenWatchArgs; readonly snapshot: ScreenSnapshot; readonly change: ScreenChange };
	readonly messages: { readonly args: MessagesWatchArgs; readonly snapshot: MessagesSnapshot; readonly change: MessagesChange };
	readonly windows: { readonly args: NoArgs; readonly snapshot: WindowInfo[]; readonly change: WindowsChange };
	readonly machines: { readonly args: NoArgs; readonly snapshot: MachineInfo[]; readonly change: MachinesChange };
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
	readonly "agent.rename": { readonly args: V3RenameArgs; readonly result: V3AgentInfo };
	readonly "agent.type": { readonly args: V3TypeArgs; readonly result: EmptyResult };
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
