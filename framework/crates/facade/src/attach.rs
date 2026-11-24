//! Shows an agent's terminal in the host's alternate screen and forwards keys and size changes.
//! When the connection closes, it reconnects by the agent's stored reference and redraws before
//! resuming input. Keys still waiting or typed while disconnected are discarded and counted.
//!
//! Every end of an attachment restores the person's terminal exactly once and reports the result to
//! stderr. Ctrl-] waits up to one second for the keys typed before it. Termination signals do not wait.

use std::collections::VecDeque;
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use facade_base::api_v1::daemon::{
    AgentInfo, AgentInspect, AgentRef, AgentTarget, AgentTargetArgs, AttachArgs, AttachResizeArgs,
    AttachShellTopic, AttachTopic, MachineQuery, ProcessState, ScreenChange, ScreenSnapshot,
    attach_resize_line, raw_input_line,
};
use facade_base::api_v1::daemon_client::{
    Cut, DaemonClient, takeover_timeout, transient_transport,
};
use facade_base::api_v1::{ErrorBody, ProcessExit, Size, Topic};
use facade_base::console::{
    ConsoleRead, ConsoleReader, ConsoleSignal, ConsoleSignals, PointerAction, VtModes,
};
use facade_base::paths::ClientSocket;
use facade_base::unix_process::signal_number;
use facade_base::{base64, service, system};
use facade_screen::{ParsedOutput, REDRAW_SCROLLBACK_ROWS, Screen, SelectionView};
use unicode_width::UnicodeWidthChar;

use crate::daemon_client::{ConnectFailure, Reconnect};
use crate::errors::{AgentCommand, agent_failed, agent_label, cause, machine_query_detail};
use crate::{ExitText, Opening, agent_address, single_line};

mod mouse;

use mouse::{LocalMouseInput, MouseInput};

/// Ctrl-], as plain input and in the kitty keyboard encoding. In win32-input-mode it comes as a
/// key-down record of its character, which [`is_detach_record`] recognizes.
const DETACH_KEYS: [&[u8]; 2] = [b"\x1d", b"\x1b[93;5u"];
/// The longest Ctrl-] waits for the keys typed before it to be sent.
const DETACH_SEND_TIMEOUT: Duration = Duration::from_secs(1);
/// The wait between attempts to reconnect an attached terminal.
const RECONNECT_DELAY: Duration = Duration::from_millis(500);
const RECONNECT_TIMED_OUT: &str = "the terminal did not reconnect in time";
/// The most typed bytes that wait while a connected writer is busy.
const MAX_QUEUED_KEY_BYTES: usize = 1024 * 1024;

const SAVE_HOST_TITLE: &[u8] = b"\x1b[22;0t";
const RESTORE_HOST_TITLE: &[u8] = b"\x1b[23;0t";
const CLEAR_TITLE: &[u8] = b"\x1b]2;\x1b\\";
/// Report button presses, drags and wheel events in SGR and disable arrow emulation.
const LOCAL_MOUSE: &[u8] = b"\x1b[?1002h\x1b[?1006h\x1b[?1007l";
const SCROLL_ROWS_PER_TICK: isize = 3;

/// Whether raw mode is on and the person's terminal still has to be restored.
static RAW_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
/// The console modes entered after raw mode, which the restoration puts back.
static VT_MODES: Mutex<Option<VtModes>> = Mutex::new(None);
/// Held while writing to the person's terminal and while restoring it, so that none of the agent's
/// output lands in the middle of the restoration or after it.
static TERMINAL: Mutex<Display> = Mutex::new(Display {
    shared: None,
    host_alternate: false,
    cli_title_shown: false,
    mouse: MouseOwner::Host,
    held: None,
});

/// The person's terminal size, when both dimensions are nonzero.
pub(crate) fn console_size() -> Option<(u16, u16)> {
    let (cols, rows) = crossterm::terminal::size().ok()?;
    (cols > 0 && rows > 0).then_some((cols, rows))
}

/// Shows the agent's terminal until the person detaches or the agent exits or is removed. Whenever
/// the connection closes, `reconnect` reaches the daemon again and the watch resumes at the
/// agent's stored reference.
/// Returns the command's exit code.
pub(crate) fn attach(
    mut client: DaemonClient,
    target: AgentTarget,
    opening: Opening,
    reconnect: &Reconnect,
) -> anyhow::Result<i32> {
    // A foreground start or resume already used its connection for a call.
    if !matches!(opening, Opening::Attached) && supports_dedicated_watch(&client) {
        drop(client);
        client = connect_before_input(reconnect)?;
    }
    let hostname = system::hostname().unwrap_or_else(|_| client.hello_result.machine_id.clone());
    let viewer = format!("Terminal on {hostname}");
    let address = match &target {
        AgentTarget::Selector(agent) => agent.clone(),
        AgentTarget::Reference(reference) => agent_address(reference, None),
    };
    let allow_ended =
        !matches!(opening, Opening::Attached) && matches!(target, AgentTarget::Reference(_));
    let watched = match watch_first(&mut client, &target, &viewer, allow_ended, reconnect) {
        Ok(watched) => watched,
        Err(error) if allow_ended && watch_reason(&error) == Some("ended") => {
            let agent = inspect_agent(&mut client, target);
            let shown = agent.as_ref().map_or_else(
                || single_line(&address),
                |agent| agent_label(Some(&agent.name), &agent.address),
            );
            let end = AttachEnd::AgentExited {
                exit: agent.and_then(|agent| agent.exit),
                status: None,
            };
            let code = end.code();
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(
                stderr,
                "{}\n{}",
                opening_line(&opening, &shown),
                result_line(&end, &shown, &address)
            );
            return Ok(code);
        }
        Err(error) => return Err(opening_error(&address, error)),
    };
    let snapshot = &watched.snapshot;
    let shown = agent_label(snapshot.name.as_deref(), &snapshot.address);
    let input = Arc::new(AgentInput::new(
        snapshot.reference.clone(),
        snapshot.address.clone(),
    ));
    input.lock().agent_name.clone_from(&snapshot.name);
    let screen = ScreenWatch { client, watched };
    // Register before entering raw mode so a termination signal can be handled even during setup.
    let signals = ConsoleSignals::new()?;
    let _ = writeln!(std::io::stderr(), "{}", opening_line(&opening, &shown));
    enter_raw_mode()?;
    follow_signals(signals, input.clone());
    let end = follow_agent(screen, &input, &viewer, reconnect);
    let code = end.as_ref().map_or(1, AttachEnd::code);
    finish_attachment(&input, end);
    input.detach();
    Ok(code)
}

/// Runs `work` on its own thread with the shared input.
fn spawn_with(input: &Arc<AgentInput>, work: fn(&AgentInput)) {
    let input = input.clone();
    std::thread::spawn(move || work(&input));
}

/// Turns on raw mode and byte input and saves the host title. Every end of the attachment restores
/// the terminal from here.
fn enter_raw_mode() -> std::io::Result<()> {
    RAW_MODE_ACTIVE.store(true, SeqCst);
    crossterm::terminal::enable_raw_mode().inspect_err(|_| RAW_MODE_ACTIVE.store(false, SeqCst))?;
    let modes = VtModes::enter().inspect_err(|_| {
        RAW_MODE_ACTIVE.store(false, SeqCst);
        let _ = crossterm::terminal::disable_raw_mode();
    })?;
    *lock_vt_modes() = Some(modes);
    let _terminal = lock_terminal();
    write_terminal(SAVE_HOST_TITLE);
    Ok(())
}

/// Takes the console modes to restore, even if an earlier holder panicked.
fn lock_vt_modes() -> MutexGuard<'static, Option<VtModes>> {
    VT_MODES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why an attachment ended.
pub(crate) enum AttachEnd {
    Detached,
    AgentExited {
        exit: Option<ProcessExit>,
        status: Option<i32>,
    },
    Removed,
    Unreachable(String),
    Signal(String),
}

impl AttachEnd {
    fn code(&self) -> i32 {
        match self {
            AttachEnd::Detached => 0,
            AttachEnd::AgentExited { exit, status, .. } => {
                status.unwrap_or_else(|| exit.as_ref().map_or(1, exit_code))
            }
            AttachEnd::Removed | AttachEnd::Unreachable(_) => 1,
            AttachEnd::Signal(name) => signal_number(name).map_or(1, |number| 128 + number),
        }
    }
}

/// The line shown before the first redraw.
pub(crate) fn opening_line(opening: &Opening, shown: &str) -> String {
    let began = match opening {
        Opening::Started => format!("Started {shown}."),
        Opening::Resumed => format!("Resumed {shown}."),
        Opening::SavedSession { cli } => {
            format!("Started {shown} from a saved {} session.", single_line(cli))
        }
        Opening::Attached => format!("Attached to {shown}."),
    };
    format!("{began} Press Ctrl+] to detach.")
}

/// The result shown after restoring the person's terminal.
pub(crate) fn result_line(end: &AttachEnd, shown: &str, address: &str) -> String {
    match end {
        AttachEnd::Detached => format!("Detached from {shown}. The agent is still running."),
        AttachEnd::AgentExited {
            exit: Some(exit), ..
        } if exit.code.is_some() => {
            format!("{shown} exited with {}.", ExitText(exit))
        }
        AttachEnd::AgentExited {
            exit: Some(exit), ..
        } if exit.signal.is_some() => {
            format!("{shown} exited on signal {}.", ExitText(exit))
        }
        AttachEnd::AgentExited {
            status: Some(status),
            ..
        } => {
            format!("{shown} exited with status {status}.")
        }
        AttachEnd::AgentExited { .. } => {
            format!("{shown} exited. Facade could not confirm its exit status.")
        }
        AttachEnd::Removed => format!("error: {shown} was removed"),
        AttachEnd::Unreachable(why) => format!("error: {}", lost_connection(shown, address, why)),
        AttachEnd::Signal(name) => format!("Attachment ended by {name}."),
    }
}

fn lost_connection(shown: &str, address: &str, why: &str) -> String {
    format!(
        "Lost connection to {shown}: {}\nReattach with 'facade attach {address}', or check 'facade machine list'.",
        single_line(why)
    )
}

/// Presents a refusal of the first watch using only records visible to this caller.
fn opening_error(address: &str, error: anyhow::Error) -> anyhow::Error {
    let unavailable_address = address.contains('@')
        && matches!(
            watch_reason(&error),
            Some("unavailable" | "ssh_interaction_required")
        )
        && error
            .downcast_ref::<ErrorBody>()
            .and_then(|body| body.data.details.as_ref())
            .and_then(|details| details.get("unanswered"))
            .and_then(serde_json::Value::as_array)
            .is_none_or(Vec::is_empty);
    if unavailable_address || error.is::<Cut>() {
        let address = single_line(address);
        return anyhow::anyhow!(lost_connection(
            &address,
            &address,
            &connection_reason(&error)
        ));
    }
    agent_failed(AgentCommand::Attach, address, error)
}

/// Prefers the current query's SSH diagnostic when the daemon has one.
fn connection_reason(error: &anyhow::Error) -> String {
    machine_connection_reason(error).unwrap_or_else(|| cause(error))
}

fn machine_connection_reason(error: &anyhow::Error) -> Option<String> {
    let body = error.downcast_ref::<ErrorBody>()?;
    let details = body.data.details.as_ref()?;
    if body.data.reason == "ssh_interaction_required" {
        return details.get("message")?.as_str().map(str::to_owned);
    }
    if let Some(machines) = details
        .get("machines")
        .and_then(serde_json::Value::as_array)
        && let [machine] = machines.as_slice()
        && let Ok(machine) = serde_json::from_value::<MachineQuery>(machine.clone())
        && machine.error.is_some()
    {
        return Some(machine_query_detail(&machine));
    }
    details
        .get("machine")?
        .is_object()
        .then(|| body.message.clone())
}

/// The final warning when typed input was left waiting or dropped.
pub(crate) fn unsent_line(unsent: usize) -> Option<String> {
    (unsent > 0).then(|| format!("warning: {unsent} bytes you typed were not sent"))
}

/// The notice after the first redraw on the restored connection.
pub(crate) fn reconnected_line(shown: &str, unsent: usize) -> Option<String> {
    (unsent > 0).then(|| format!(
        "Reconnected to {shown}. {unsent} bytes typed while disconnected were not sent; check the screen and retype if needed."
    ))
}

/// Computes the exit code using the local signal table when an older peer omitted its status.
fn exit_code(exit: &ProcessExit) -> i32 {
    match (exit.code, exit.signal.as_deref()) {
        (Some(code), _) => code,
        (None, Some(name)) => signal_number(name).map_or(1, |number| 128 + number),
        (None, None) => 1,
    }
}

/// A watch on the agent's screen and the connection that owns it.
struct ScreenWatch {
    client: DaemonClient,
    watched: WatchedScreen,
}

struct WatchedScreen {
    watch: u64,
    snapshot: ScreenSnapshot,
    capacity: Option<(u16, u16)>,
}

/// An initial watch refused during takeover starts again with the replacement's hello.
fn watch_first(
    client: &mut DaemonClient,
    target: &AgentTarget,
    viewer: &str,
    allow_ended: bool,
    reconnect: &Reconnect,
) -> anyhow::Result<WatchedScreen> {
    let watched = watch_screen(client, target.clone(), viewer, allow_ended);
    if watched
        .as_ref()
        .is_err_and(|error| watch_reason(error) == Some("upgrading"))
    {
        *client = connect_before_input(reconnect)?;
        return watch_screen(client, target.clone(), viewer, allow_ended);
    }
    watched
}

fn connect_before_input(reconnect: &Reconnect) -> Result<DaemonClient, ConnectFailure> {
    reconnect(Instant::now() + takeover_timeout(), &|| false, &mut |_| {
        true
    })
}

fn supports_dedicated_watch(client: &DaemonClient) -> bool {
    client
        .hello_result
        .topics
        .iter()
        .any(|topic| topic == AttachShellTopic::NAME)
}

/// Watches the agent's visible screen.
fn watch_screen(
    client: &mut DaemonClient,
    target: AgentTarget,
    viewer: &str,
    allow_ended: bool,
) -> anyhow::Result<WatchedScreen> {
    // Attach manages reconnection so input stays bound to the socket and watch that drew the view.
    client.disable_auto_reconnect();
    let capacity = console_size();
    let args = AttachArgs {
        target,
        keep_scrollback: true,
        include_scrollback: true,
        viewer: Some(viewer.into()),
        allow_ended,
        report_activity: false,
        size: capacity
            .filter(|&(cols, _)| cols >= 2)
            .map(|(cols, rows)| Size { cols, rows }),
    };
    let (watch, snapshot) = if supports_dedicated_watch(client) {
        client.watch::<AttachShellTopic>(args)?
    } else {
        client.watch::<AttachTopic>(args)?
    };
    Ok(WatchedScreen {
        watch,
        snapshot,
        capacity,
    })
}

/// Shows the agent through one connection after another until the attachment ends.
fn follow_agent(
    mut screen: ScreenWatch,
    input: &Arc<AgentInput>,
    viewer: &str,
    reconnect: &Reconnect,
) -> anyhow::Result<AttachEnd> {
    if let Some(end) = show_snapshot(&mut screen, input)? {
        return Ok(end);
    }
    spawn_with(input, AgentInput::send_queued);
    spawn_with(input, read_keys);
    loop {
        let failure = match show_until_closed(&mut screen, input) {
            Ok(Some(end)) => return Ok(end),
            Ok(None) => None,
            Err(error) => Some(error),
        };
        let closing = screen.client.closing.is_some();
        input.disconnected(closing);
        if let Some(mut terminal) = attached_terminal() {
            terminal.shared = None;
            terminal.held = None;
        }
        service::mark_for_test("attach-disconnected");
        if input.is_detached() {
            return Ok(AttachEnd::Detached);
        }
        if closing {
            // The old daemon gets only the write already in progress before the reply.
            input.wait_for_write();
            screen.client.respond_to_closing();
        }
        screen = match reconnect_screen(input, viewer, reconnect, failure) {
            Ok(again) => again,
            Err(end) => return Ok(end),
        };
        if let Some(end) = show_snapshot(&mut screen, input)? {
            return Ok(end);
        }
        service::mark_for_test("attach-reconnected");
    }
}

/// Draws the current screen before enabling its connection for keys and size changes.
fn show_snapshot(
    screen: &mut ScreenWatch,
    input: &AgentInput,
) -> anyhow::Result<Option<AttachEnd>> {
    // Keep the redraw, displayed identity and notice together so restoration sees one snapshot.
    let Some(mut terminal) = attached_terminal() else {
        return Ok(Some(AttachEnd::Detached));
    };
    let watched = &mut screen.watched;
    let snapshot = &mut watched.snapshot;
    let grid = (snapshot.size.cols, snapshot.size.rows);
    let capacity = console_size();
    terminal.draw_frame(&snapshot.redraw, grid, capacity);
    {
        let mut queue = input.lock();
        queue.agent_name.clone_from(&snapshot.name);
        queue.address.clone_from(&snapshot.address);
        queue.reported_size = watched.capacity;
        queue
            .waiting
            .retain(|item| !matches!(item, Outgoing::Resize));
    }
    let status = snapshot.exit_status;
    if snapshot.process == Some(ProcessState::Ended) || snapshot.exit.is_some() || status.is_some()
    {
        return Ok(Some(AttachEnd::AgentExited {
            exit: snapshot.exit.take(),
            status,
        }));
    }
    input.push_resize(capacity);
    let Some(loss) = input.connected(screen.client.writer.try_clone()?, watched.watch) else {
        return Ok(Some(AttachEnd::Detached));
    };
    if loss.queued > 0 || loss.disconnected > 0 {
        let shown = agent_label(snapshot.name.as_deref(), &snapshot.address);
        let queued = (loss.queued > 0).then(|| {
            format!(
                "warning: {} bytes queued before disconnect were not sent",
                loss.queued
            )
        });
        let notice: Vec<String> = reconnected_line(&shown, loss.disconnected)
            .into_iter()
            .chain(queued)
            .collect();
        show_status(&notice.join("\n"));
    }
    Ok(None)
}

/// Draws changes. Returns how the attachment ended, or None when the connection closed.
fn show_until_closed(
    screen: &mut ScreenWatch,
    input: &AgentInput,
) -> anyhow::Result<Option<AttachEnd>> {
    let watch = screen.watched.watch;
    // Changes are keyed by watch ID, and both Attach topics decode the same ScreenChange.
    while let Some(change) = screen.client.next_change::<AttachTopic>(watch)? {
        // Detaching shuts the connection down, whatever the read returned.
        if input.is_detached() {
            return Ok(Some(AttachEnd::Detached));
        }
        return Ok(Some(match change {
            ScreenChange::Output { data } => {
                if let Some(mut terminal) = attached_terminal() {
                    terminal.write_output(&data);
                }
                continue;
            }
            ScreenChange::Redraw { data, size } => {
                if let Some(mut terminal) = attached_terminal() {
                    terminal.draw_frame(&data, (size.cols, size.rows), console_size());
                }
                continue;
            }
            ScreenChange::Activity { .. } | ScreenChange::Unknown => continue,
            ScreenChange::Exit {
                exit, exit_status, ..
            } => AttachEnd::AgentExited {
                exit: Some(exit),
                status: exit_status,
            },
            ScreenChange::Removed => AttachEnd::Removed,
        }));
    }
    Ok(None)
}

/// Reaches the daemon again and watches the same agent. The existing retry delay also applies to
/// an unavailable remote route. All attempts share the time allowed for a daemon handover.
fn reconnect_screen(
    input: &AgentInput,
    viewer: &str,
    reconnect: &Reconnect,
    mut last_failure: Option<anyhow::Error>,
) -> Result<ScreenWatch, AttachEnd> {
    let deadline = Instant::now() + takeover_timeout();
    while !input.is_detached() && Instant::now() < deadline {
        let connection = reconnect(deadline, &|| input.is_detached(), &mut |stream| {
            input.opening(stream)
        });
        if input.is_detached() {
            break;
        }
        let mut client = match connection {
            Ok(client) => client,
            Err(ConnectFailure::Cancelled) => break,
            Err(ConnectFailure::Permanent(error)) => {
                return Err(AttachEnd::Unreachable(connection_reason(&error)));
            }
            Err(ConnectFailure::Timeout(error)) => {
                keep_reconnect_failure(&mut last_failure, error);
                input.wait_before_reconnect(deadline);
                continue;
            }
        };
        let watched = watch_before(&mut client, input.target(), viewer, deadline);
        if input.is_detached() {
            break;
        }
        let error = match watched {
            Ok(watched) => return Ok(ScreenWatch { client, watched }),
            Err(error) => error,
        };
        match watch_reason(&error) {
            Some("not_found") => return Err(AttachEnd::Removed),
            Some("ended") => {
                let exit = set_watch_timeout(&client, deadline)
                    .ok()
                    .and_then(|()| inspect_agent(&mut client, input.target()))
                    .and_then(|agent| agent.exit);
                if input.is_detached() {
                    break;
                }
                return Err(AttachEnd::AgentExited { exit, status: None });
            }
            _ if retryable_watch(&error) => {
                keep_reconnect_failure(&mut last_failure, error);
                input.wait_before_reconnect(deadline);
            }
            _ => return Err(AttachEnd::Unreachable(connection_reason(&error))),
        }
    }
    if input.is_detached() {
        return Err(AttachEnd::Detached);
    }
    let why = last_failure
        .as_ref()
        .filter(|error| !error.is::<Cut>())
        .map_or_else(|| RECONNECT_TIMED_OUT.into(), connection_reason);
    Err(AttachEnd::Unreachable(why))
}

/// A local transport failure must not replace the current diagnostic from the remote machine.
fn keep_reconnect_failure(last: &mut Option<anyhow::Error>, failure: anyhow::Error) {
    if !failure.is::<Cut>()
        && (last.as_ref().and_then(machine_connection_reason).is_none()
            || machine_connection_reason(&failure).is_some())
    {
        *last = Some(failure);
    }
}

/// The remaining reconnect time also applies to the screen request on the new connection.
fn watch_before(
    client: &mut DaemonClient,
    target: AgentTarget,
    viewer: &str,
    deadline: Instant,
) -> anyhow::Result<WatchedScreen> {
    set_watch_timeout(client, deadline)?;
    let watched = watch_screen(client, target, viewer, true)?;
    client.writer.set_read_timeout(None)?;
    client.writer.set_write_timeout(None)?;
    Ok(watched)
}

fn set_watch_timeout(client: &DaemonClient, deadline: Instant) -> std::io::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            RECONNECT_TIMED_OUT,
        ));
    }
    client.writer.set_read_timeout(Some(remaining))?;
    client.writer.set_write_timeout(Some(remaining))
}

/// Reads the run's exit record if the watch returned an ended refusal.
fn inspect_agent(client: &mut DaemonClient, target: AgentTarget) -> Option<AgentInfo> {
    client
        .call::<AgentInspect>(AgentTargetArgs { target })
        .ok()
        .map(|inspected| inspected.agent)
}

fn retryable_watch(error: &anyhow::Error) -> bool {
    matches!(
        watch_reason(error),
        Some("unavailable" | "upgrading" | "ssh_interaction_required")
    ) || error.is::<Cut>()
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(transient_transport)
}

/// The daemon's reason for refusing the watch.
fn watch_reason(error: &anyhow::Error) -> Option<&str> {
    error
        .downcast_ref::<ErrorBody>()
        .map(|body| body.data.reason.as_str())
}

/// Queues a resize on each size change; on a termination signal, restores the terminal and exits
/// with 128 plus the signal's number.
fn follow_signals(signals: ConsoleSignals, input: Arc<AgentInput>) {
    std::thread::spawn(move || {
        for signal in signals {
            let (name, number) = match signal {
                ConsoleSignal::Resized => {
                    input.resized();
                    continue;
                }
                ConsoleSignal::Ended { name, number } => (name, number),
            };
            finish_attachment(&input, Ok(AttachEnd::Signal(name.into())));
            // A test holds the exit here, as a loaded machine can, while the agent's output
            // keeps coming.
            service::gate_for_test("attach-restored");
            std::process::exit(128 + number);
        }
    });
}

/// The one reader of the person's keys and, where the console reports them with its keys, its size
/// changes and routes mouse input. Ctrl-] or the end of input ends the attachment once the keys
/// before it are sent.
fn read_keys(input: &AgentInput) {
    let mut buffer = [0u8; 4096];
    let mut mouse = LocalMouseInput::default();
    let mut copy_key = None;
    if let Ok(mut console) = ConsoleReader::new() {
        loop {
            let read = match console.read(&mut buffer) {
                Ok(ConsoleRead::Resized) => {
                    input.resized();
                    continue;
                }
                Ok(ConsoleRead::Wheel {
                    col,
                    row,
                    delta,
                    modifiers,
                }) => {
                    if let Some(mut terminal) = attached_terminal() {
                        terminal.native_wheel(input, col, row, delta, modifiers);
                    }
                    continue;
                }
                Ok(ConsoleRead::Pointer { col, row, action }) => {
                    if let Some(mut terminal) = attached_terminal() {
                        terminal.pointer(col, row, action);
                    }
                    continue;
                }
                Ok(ConsoleRead::Keys(read @ 1..)) => read,
                Ok(ConsoleRead::Keys(0)) | Err(_) => break,
            };
            let keys = &buffer[..read];
            let detach_at = detach_position(keys);
            // Keys before Ctrl-] in the same read still go.
            if let Some(mut terminal) = attached_terminal() {
                mouse.read(
                    &keys[..detach_at.unwrap_or(read)],
                    terminal.mouse == MouseOwner::Local,
                    |event| match event {
                        MouseInput::Keys(keys) => terminal.forward_keys(input, keys, &mut copy_key),
                        MouseInput::Wheel(ticks) => terminal.scroll_history(ticks),
                        MouseInput::Pointer { col, row, action } => {
                            terminal.pointer(col, row, action);
                        }
                    },
                );
            }
            if let Some(at) = detach_at {
                finish_detach_release(&mut console, &keys[at..]);
                break;
            }
        }
    }
    if let Some(mut terminal) = attached_terminal() {
        terminal.forward_keys(input, mouse.remaining_keys(), &mut copy_key);
    }
    input.detach_after_sending();
}

/// Removes the queued releases of the ConPTY Ctrl-] chord, including a record split by the read.
fn finish_detach_release(console: &mut ConsoleReader, keys: &[u8]) {
    let Some(mut rest) = keys.strip_prefix(b"\x1b[221;27;29;1;8;1_") else {
        return;
    };
    // The bracket key-up may carry either zero or the character from its key-down event.
    for release in [b"\x1b[221;27;0;0;8;1_".as_slice(), b"\x1b[221;27;29;0;8;1_"] {
        if let Some(tail) = rest.strip_prefix(release) {
            rest = tail;
            break;
        }
        if let Some(missing) = release.strip_prefix(rest)
            && console.discard_key_prefix(missing).unwrap_or(false)
        {
            rest = &[];
            break;
        }
    }
    if let Some(missing) = b"\x1b[17;29;0;0;0;1_".strip_prefix(rest)
        && !missing.is_empty()
    {
        let _ = console.discard_key_prefix(missing);
    }
}

/// Where the first Ctrl-] begins in `keys`, in any of its forms.
fn detach_position(keys: &[u8]) -> Option<usize> {
    let encoded = DETACH_KEYS
        .iter()
        .filter_map(|key| keys.windows(key.len()).position(|window| window == *key));
    let records = (0..keys.len()).filter(|&at| is_detach_record(&keys[at..]));
    encoded.chain(records).min()
}

/// Whether `keys` begins with Ctrl-] going down in win32-input-mode, which the person's console
/// uses once the agent's console host has asked for it: `CSI <vk>;<sc>;29;1;<cs>;<rc>_`, a key-down
/// record of the character 0x1D, whatever the key, scan code and modifier state.
fn is_detach_record(keys: &[u8]) -> bool {
    win32_key_prefix(keys).is_some_and(|(key, _)| key.character == b"29" && key.key_down == b"1")
}

struct Win32Key<'a> {
    virtual_key: &'a [u8],
    scan_code: &'a [u8],
    character: &'a [u8],
    key_down: &'a [u8],
    control_state: &'a [u8],
}

impl Win32Key<'_> {
    fn number(field: &[u8]) -> Option<u16> {
        if field.is_empty() {
            Some(0)
        } else {
            std::str::from_utf8(field).ok()?.parse().ok()
        }
    }

    fn code(&self) -> Option<(u16, u16)> {
        Some((
            Self::number(self.virtual_key)?,
            Self::number(self.scan_code)?,
        ))
    }

    fn is_release(&self) -> bool {
        matches!(self.key_down, b"0" | b"")
    }

    fn is_copy_press(&self) -> bool {
        const CONTROL: u16 = 0x000c;
        const ALT_OR_SHIFT: u16 = 0x0013;
        self.virtual_key == b"67"
            && self.character == b"3"
            && self.key_down == b"1"
            && Self::number(self.control_state)
                .is_some_and(|state| state & CONTROL != 0 && state & ALT_OR_SHIFT == 0)
    }
}

/// The first win32-input-mode key record, followed by any other input in the same read.
fn win32_key_prefix(keys: &[u8]) -> Option<(Win32Key<'_>, &[u8])> {
    let record = keys.strip_prefix(b"\x1b[")?;
    let length = record
        .iter()
        .take_while(|&&byte| byte.is_ascii_digit() || byte == b';')
        .count();
    if record.get(length) != Some(&b'_') {
        return None;
    }
    let fields: Vec<&[u8]> = record[..length].split(|&byte| byte == b';').collect();
    let &[
        virtual_key,
        scan_code,
        character,
        key_down,
        control_state,
        _,
    ] = fields.as_slice()
    else {
        return None;
    };
    Some((
        Win32Key {
            virtual_key,
            scan_code,
            character,
            key_down,
            control_state,
        },
        &record[length + 1..],
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyKey {
    Win32((u16, u16)),
    KittyC,
}

enum KittyCEvent {
    Press { control_only: bool },
    Repeat { control_only: bool },
    Release,
}

/// A complete Kitty report for C, followed by the remaining input.
fn kitty_c_key_prefix(keys: &[u8]) -> Option<(KittyCEvent, &[u8])> {
    let record = keys.strip_prefix(b"\x1b[99")?;
    if let Some(remaining) = record.strip_prefix(b"u") {
        return Some((
            KittyCEvent::Press {
                control_only: false,
            },
            remaining,
        ));
    }

    // Windows Terminal can include the alternate uppercase code when Shift is held.
    let shifted = record.strip_prefix(b":67");
    let fields = shifted.unwrap_or(record).strip_prefix(b";")?;
    let modifier_len = fields
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let (modifier, suffix) = fields.split_at(modifier_len);
    if !matches!(modifier.first(), Some(b'1'..=b'9')) {
        return None;
    }
    let control_only = shifted.is_none() && modifier == b"5";
    match suffix {
        [b'u', remaining @ ..] | [b':', b'1', b'u', remaining @ ..] => {
            Some((KittyCEvent::Press { control_only }, remaining))
        }
        [b':', b'2', b'u', remaining @ ..] => {
            Some((KittyCEvent::Repeat { control_only }, remaining))
        }
        [b':', b'3', b'u', remaining @ ..] => Some((KittyCEvent::Release, remaining)),
        _ => None,
    }
}

/// Modifier-only presses and key releases travel to the CLI without ending scrollback browsing.
fn has_typing(mut keys: &[u8]) -> bool {
    while let Some((key, remaining)) = win32_key_prefix(keys) {
        // Shift, Ctrl, Alt, the Windows keys and the lock keys change only keyboard state
        // when the record carries no character.
        let modifier = matches!(
            key.virtual_key,
            b"16"
                | b"17"
                | b"18"
                | b"20"
                | b"91"
                | b"92"
                | b"144"
                | b"145"
                | b"160"
                | b"161"
                | b"162"
                | b"163"
                | b"164"
                | b"165"
        );
        let modifier_press =
            key.key_down == b"1" && modifier && matches!(key.character, b"0" | b"");
        if !key.is_release() && !modifier_press {
            return true;
        }
        keys = remaining;
    }
    !keys.is_empty()
}

/// The person's input on its way to the agent. Readers queue keys and size changes; one writer
/// thread sends them as notifications on the current connection, without holding the queue while
/// it writes, so a blocked write never holds up typing, signals, detaching or counting.
///
/// At most [`MAX_QUEUED_KEY_BYTES`] wait; keys that do not fit are counted. Keys handed to a
/// connection are never sent again, even when the write fails, since they may have arrived.
struct AgentInput {
    /// The identity of the agent from the first snapshot.
    reference: AgentRef,
    queue: Mutex<InputQueue>,
    /// Wakes the writer for new input, a new connection or the end, and wakes whoever waits for a
    /// write to end.
    wake: Condvar,
}

#[derive(Default)]
struct InputQueue {
    /// Display identity from the snapshot most recently drawn.
    agent_name: Option<String>,
    address: String,
    /// The last capacity sent or queued, initially the watch size.
    reported_size: Option<(u16, u16)>,
    waiting: VecDeque<Outgoing>,
    /// The key bytes in `waiting`.
    waiting_key_bytes: usize,
    /// Typed bytes discarded because the connected queue was full.
    overflow_key_bytes: usize,
    reconnect_loss: ReconnectLoss,
    /// The connection to send on; none while disconnected. A failed write ends it only if it is
    /// still the one the write used.
    connection: Option<InputConnection>,
    /// Whether the writer is sending something it took from `waiting`.
    writing: bool,
    /// A connection opening or finishing a takeover write; detaching shuts it down.
    opening: Option<Arc<ClientSocket>>,
    /// Ctrl-], the end of the person's input or the end of the attachment.
    detached: bool,
}

#[derive(Clone)]
struct InputConnection {
    socket: Arc<ClientSocket>,
    watch: u64,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ReconnectLoss {
    /// Bytes still in the connected queue when the connection closed.
    queued: usize,
    /// Bytes typed while disconnected, before the next full redraw.
    disconnected: usize,
}

impl InputQueue {
    /// Drops input that has not been handed to the old connection.
    fn clear_connection(&mut self) -> Option<Arc<ClientSocket>> {
        self.reconnect_loss.queued += std::mem::take(&mut self.waiting_key_bytes);
        self.waiting.clear();
        self.connection.take().map(|connection| connection.socket)
    }
}

/// Input for the agent, in the order the person made it.
enum Outgoing {
    /// Typed keys.
    Keys(Vec<u8>),
    /// A size change; the size is read when it is sent.
    Resize,
}

impl Outgoing {
    /// The notification for this connection, if it accepts the reported size.
    fn line(self, reference: &AgentRef, watch: u64) -> Option<Vec<u8>> {
        match self {
            Outgoing::Keys(keys) => Some(raw_input_line(reference.clone(), &keys)),
            Outgoing::Resize => {
                let (cols, rows) = console_size().filter(|&(cols, _)| cols >= 2)?;
                Some(attach_resize_line(AttachResizeArgs {
                    watch,
                    size: Size { cols, rows },
                    colors: None,
                }))
            }
        }
    }
}

impl AgentInput {
    fn new(reference: AgentRef, address: String) -> Self {
        AgentInput {
            reference,
            queue: Mutex::new(InputQueue {
                address,
                ..InputQueue::default()
            }),
            wake: Condvar::new(),
        }
    }

    fn target(&self) -> AgentTarget {
        AgentTarget::Reference(self.reference.clone())
    }

    fn lock(&self) -> MutexGuard<'_, InputQueue> {
        self.queue.lock().unwrap()
    }

    fn is_detached(&self) -> bool {
        self.lock().detached
    }

    /// Waits until the retry delay elapses or the person detaches.
    fn wait_before_reconnect(&self, deadline: Instant) {
        let delay = deadline
            .saturating_duration_since(Instant::now())
            .min(RECONNECT_DELAY);
        drop(
            self.wake
                .wait_timeout_while(self.lock(), delay, |queue| !queue.detached)
                .unwrap(),
        );
    }

    /// Refreshes the local drawing and reports capacity independently of the shared grid.
    fn resized(&self) {
        let Some(mut terminal) = attached_terminal() else {
            return;
        };
        let capacity = console_size();
        self.push_resize(capacity);
        if let Some(shared) = &mut terminal.shared
            && shared.capacity != capacity
        {
            shared.capacity = capacity;
            terminal.draw(None);
        }
    }

    /// Queues a changed capacity, coalescing repeated console events and waiting resizes.
    fn push_resize(&self, size: Option<(u16, u16)>) {
        let mut queue = self.lock();
        if size.is_none() || queue.reported_size == size {
            return;
        }
        queue.reported_size = size;
        let waits = queue.waiting.iter().any(|o| matches!(o, Outgoing::Resize));
        if !waits {
            queue.waiting.push_back(Outgoing::Resize);
            self.wake.notify_all();
        }
    }

    /// Queues typed keys, or counts them as dropped when disconnected or the queue is full.
    fn push_keys(&self, keys: &[u8]) {
        if keys.is_empty() {
            return;
        }
        let mut queue = self.lock();
        if queue.connection.is_none() {
            queue.reconnect_loss.disconnected += keys.len();
            // The reconnect failure scenario waits for this point before releasing its peer.
            service::mark_for_test("attach-buffered-input");
            return;
        }
        if queue.waiting_key_bytes + keys.len() > MAX_QUEUED_KEY_BYTES {
            queue.overflow_key_bytes += keys.len();
            return;
        }
        queue.waiting_key_bytes += keys.len();
        if let Some(Outgoing::Keys(waiting)) = queue.waiting.back_mut() {
            waiting.extend_from_slice(keys);
        } else {
            queue.waiting.push_back(Outgoing::Keys(keys.to_vec()));
        }
        self.wake.notify_all();
    }

    /// Enables the writer and takes the unsent counts to report after the redraw.
    fn connected(&self, socket: ClientSocket, watch: u64) -> Option<ReconnectLoss> {
        let mut queue = self.lock();
        if queue.detached {
            return None;
        }
        queue.opening = None;
        queue.connection = Some(InputConnection {
            socket: Arc::new(socket),
            watch,
        });
        self.wake.notify_all();
        Some(std::mem::take(&mut queue.reconnect_loss))
    }

    /// Stops handing input to the old connection. A forwarded watch can end while the socket
    /// is open, so only a planned takeover lets its current write finish.
    fn disconnected(&self, closing: bool) {
        let mut queue = self.lock();
        if let Some(connection) = queue.clear_connection() {
            if closing {
                queue.opening = Some(connection);
            } else {
                let _ = connection.shutdown(std::net::Shutdown::Both);
            }
        }
        self.wake.notify_all();
    }

    /// Notes a connection being opened, so that detaching can shut it down. False once the
    /// attachment has ended.
    fn opening(&self, stream: &ClientSocket) -> bool {
        let mut queue = self.lock();
        queue.opening = stream.try_clone().ok().map(Arc::new);
        !queue.detached
    }

    /// Waits until the write in progress, if any, has ended.
    fn wait_for_write(&self) {
        let queue = self.lock();
        drop(self.wake.wait_while(queue, |queue| queue.writing).unwrap());
    }

    /// Ends the attachment after Ctrl-], once the keys typed before it are sent or after
    /// [`DETACH_SEND_TIMEOUT`].
    fn detach_after_sending(&self) {
        let sending =
            |q: &mut InputQueue| q.connection.is_some() && (q.writing || !q.waiting.is_empty());
        let (queue, _) = self
            .wake
            .wait_timeout_while(self.lock(), DETACH_SEND_TIMEOUT, sending)
            .unwrap();
        self.end(queue);
    }

    fn detach(&self) {
        self.end(self.lock());
    }

    /// Ends the attachment: shuts down the current connection and any being opened, which wakes
    /// the screen reader and interrupts a blocked write.
    fn end(&self, mut queue: MutexGuard<'_, InputQueue>) {
        queue.detached = true;
        let current = queue.connection.as_ref().map(|conn| conn.socket.as_ref());
        for stream in current.into_iter().chain(queue.opening.as_deref()) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        self.wake.notify_all();
    }

    /// Typed bytes still waiting or dropped. Bytes handed to a connection do not count.
    fn unsent_bytes(&self) -> usize {
        let queue = self.lock();
        queue.waiting_key_bytes
            + queue.overflow_key_bytes
            + queue.reconnect_loss.queued
            + queue.reconnect_loss.disconnected
    }

    /// The writer thread: sends the waiting input in order until the attachment ends.
    fn send_queued(&self) {
        while let Some((connection, outgoing)) = self.next_to_send() {
            let sent = match outgoing.line(&self.reference, connection.watch) {
                Some(line) => (&*connection.socket).write_all(&line),
                None => Ok(()),
            };
            let mut queue = self.lock();
            queue.writing = false;
            let still_current = queue
                .connection
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.socket, &connection.socket));
            if sent.is_err() && still_current {
                let _ = queue.clear_connection();
                let _ = connection.socket.shutdown(std::net::Shutdown::Both);
            }
            // Ctrl-] or a takeover may wait for this write.
            self.wake.notify_all();
        }
    }

    /// Waits for input and a connection, then takes the next input with the connection to send it
    /// on. None once the attachment has ended.
    fn next_to_send(&self) -> Option<(InputConnection, Outgoing)> {
        let mut queue = self.lock();
        while !queue.detached {
            if let Some(connection) = queue.connection.clone()
                && let Some(outgoing) = queue.waiting.pop_front()
            {
                if let Outgoing::Keys(keys) = &outgoing {
                    queue.waiting_key_bytes -= keys.len();
                }
                queue.writing = true;
                return Some((connection, outgoing));
            }
            queue = self.wake.wait(queue).unwrap();
        }
        None
    }
}

/// Takes the person's terminal for writing, even if an earlier writer panicked.
fn lock_terminal() -> MutexGuard<'static, Display> {
    TERMINAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Takes the person's terminal while it is the attachment's; none once it is restored.
fn attached_terminal() -> Option<MutexGuard<'static, Display>> {
    let terminal = lock_terminal();
    RAW_MODE_ACTIVE.load(SeqCst).then_some(terminal)
}

/// Writes to the person's terminal. The caller holds [`TERMINAL`].
fn write_terminal(bytes: &[u8]) {
    write_terminal_with_suffix(bytes, b"");
}

fn write_terminal_with_suffix(bytes: &[u8], suffix: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.write_all(suffix);
    let _ = stdout.flush();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MouseOwner {
    Host,
    Local,
    Cli,
}

impl MouseOwner {
    fn for_screen(host_alternate: bool, screen: &Screen) -> Self {
        if screen.reports_mouse() {
            Self::Cli
        } else if host_alternate && !screen.on_alternate_screen() {
            Self::Local
        } else {
            Self::Host
        }
    }

    fn write_frame(self, frame: &[u8]) {
        let suffix = if self == Self::Local {
            LOCAL_MOUSE
        } else {
            b""
        };
        write_terminal_with_suffix(frame, suffix);
    }
}

/// The terminal drawing for the current watch, held under the same lock as its writes.
struct Display {
    shared: Option<SharedScreen>,
    /// Whether Attach has entered the host's alternate screen for this attachment.
    host_alternate: bool,
    /// Whether the attachment has written a CLI title, including an explicit empty title.
    cli_title_shown: bool,
    /// The mouse mode applied to the host, including while reconnecting.
    mouse: MouseOwner,
    held: Option<HeldView>,
}

/// The viewport currently on display, which can outlive the rows it came from.
struct HeldView {
    view: SelectionView,
    /// The top row's index within the Screen's history. None is a capture of the live rows.
    history_top: Option<usize>,
    selection: Option<DragSelection>,
}

impl HeldView {
    fn paint(&self) {
        let selected = self.selection.as_ref().and_then(|selection| {
            (selection.points[0] != selection.points[1]).then_some(selection.points)
        });
        write_terminal(&self.view.redraw(selected));
    }
}

struct DragSelection {
    points: [(u16, u16); 2],
    complete: bool,
}

impl Display {
    /// Seeds a new watch or replaces the visible frame while keeping this watch's history.
    fn draw_frame(&mut self, data: &str, grid: (u16, u16), capacity: Option<(u16, u16)>) {
        let Ok(bytes) = base64::decode(data) else {
            return;
        };
        let shared = self.shared.get_or_insert_with(|| SharedScreen {
            screen: Screen::new(grid.0, grid.1, REDRAW_SCROLLBACK_ROWS),
            capacity,
        });
        shared.capacity = capacity;
        shared.screen.resize(grid.0, grid.1);
        let output = shared.screen.feed(&bytes);
        self.cli_title_shown |= output.title_change.is_some();
        self.draw(Some(&output));
    }

    fn write_output(&mut self, data: &str) {
        let Some(shared) = &mut self.shared else {
            return;
        };
        let Ok(bytes) = base64::decode(data) else {
            return;
        };
        let output = shared.screen.feed(&bytes);
        let had_cli_title = self.cli_title_shown;
        self.cli_title_shown |= output.title_change.is_some();
        let mouse = MouseOwner::for_screen(self.host_alternate, &shared.screen);
        let switches_screen = !self.host_alternate || switches_screen_or_resets(&bytes);
        let grid_fits = fits(shared.grid(), shared.capacity);
        let held = self.held.is_some();
        if !switches_screen && !held && grid_fits && !shared.uses_viewport() {
            let previous = std::mem::replace(&mut self.mouse, mouse);
            if previous != mouse {
                capture_mouse(mouse != MouseOwner::Host);
            }
            if previous == MouseOwner::Local && mouse != MouseOwner::Local {
                write_terminal_with_suffix(&bytes, &shared.mouse_modes());
            } else if mouse == MouseOwner::Local
                && (previous != mouse || changes_mouse_modes(&bytes))
            {
                mouse.write_frame(&bytes);
            } else {
                write_terminal(&bytes);
            }
            return;
        }

        // Output continues to change the terminal's input encoding while the view is held.
        if held || mouse != self.mouse {
            let modes = input_mode_changes(&bytes);
            if !modes.is_empty() {
                write_terminal(&modes);
            }
        }
        if held
            && had_cli_title
            && output.title_change.is_some()
            && shared.screen.title_output().is_empty()
        {
            write_terminal(CLEAR_TITLE);
        }
        let clears_history = held
            && escapes(&bytes)
                .filter_map(csi)
                .any(|(params, end)| params == b"3" && end == b'J');
        if switches_screen || clears_history || mouse != self.mouse {
            self.draw(Some(&output));
        } else if held || !grid_fits {
            write_activity(&output);
            shared.write_title_change(&output);
        } else {
            write_activity(&output);
            self.mouse
                .write_frame(&shared.screen.redraw_in_viewport_update());
        }
    }

    fn forward_keys(
        &mut self,
        input: &AgentInput,
        mut keys: &[u8],
        copy_key: &mut Option<CopyKey>,
    ) {
        while !keys.is_empty() && (copy_key.is_some() || self.completed_selection().is_some()) {
            let (consumed, remaining) = if let Some((key, remaining)) = win32_key_prefix(keys) {
                (self.consume_win32_copy(&key, copy_key), remaining)
            } else if let Some((key, remaining)) = kitty_c_key_prefix(keys) {
                (self.consume_kitty_copy(key, copy_key), remaining)
            } else if let Some(remaining) = keys.strip_prefix(b"\x03")
                && self.copy_selection()
            {
                (true, remaining)
            } else {
                // Ordinary input ends the selection. An owned release can still follow it.
                let end = keys[1..]
                    .iter()
                    .position(|&byte| byte == 0x1b)
                    .map_or(keys.len(), |at| at + 1);
                (false, &keys[end..])
            };
            if !consumed {
                self.forward_ordinary_keys(input, &keys[..keys.len() - remaining.len()]);
            }
            keys = remaining;
        }
        self.forward_ordinary_keys(input, keys);
    }

    fn forward_ordinary_keys(&mut self, input: &AgentInput, keys: &[u8]) {
        if self.held.is_some() && has_typing(keys) {
            self.draw(None);
        }
        input.push_keys(keys);
    }

    fn consume_win32_copy(&self, key: &Win32Key<'_>, copy_key: &mut Option<CopyKey>) -> bool {
        let Some(code) = key.code().map(CopyKey::Win32) else {
            return false;
        };
        if *copy_key == Some(code) {
            if key.is_release() {
                *copy_key = None;
            } else if key.key_down != b"1" {
                return false;
            } else if key.is_copy_press() {
                self.copy_selection();
            }
            return true;
        }
        if key.is_copy_press() && self.copy_selection() {
            *copy_key = Some(code);
            return true;
        }
        false
    }

    fn consume_kitty_copy(&self, event: KittyCEvent, copy_key: &mut Option<CopyKey>) -> bool {
        let owned = *copy_key == Some(CopyKey::KittyC);
        match event {
            KittyCEvent::Press { control_only } => {
                if owned {
                    *copy_key = None;
                }
                if control_only && self.copy_selection() {
                    *copy_key = Some(CopyKey::KittyC);
                    return true;
                }
                false
            }
            KittyCEvent::Repeat { control_only } if owned => {
                if control_only {
                    self.copy_selection();
                }
                true
            }
            KittyCEvent::Release if owned => {
                *copy_key = None;
                true
            }
            _ => false,
        }
    }

    fn completed_selection(&self) -> Option<(&SelectionView, [(u16, u16); 2])> {
        let held = self.held.as_ref()?;
        let selection = held.selection.as_ref()?;
        selection.complete.then_some((&held.view, selection.points))
    }

    fn copy_selection(&self) -> bool {
        let Some((view, [anchor, end])) = self.completed_selection() else {
            return false;
        };
        let text = view.text(anchor, end);
        let payload = base64::encode(text.as_bytes());
        write_terminal(format!("\x1b]52;c;{payload}\x1b\\").as_bytes());
        true
    }

    fn pointer(&mut self, col: u16, row: u16, action: PointerAction) {
        let Some(shared) = &self.shared else {
            return;
        };
        let grid = shared.grid();
        if self.mouse != MouseOwner::Local || !fits(grid, shared.capacity) || col == 0 || row == 0 {
            return;
        }
        match action {
            PointerAction::RightDown => {
                self.copy_selection();
            }
            PointerAction::LeftDown => {
                if col > grid.0 || row > grid.1 {
                    self.clear_selection();
                    return;
                }
                let held = self.held.get_or_insert_with(|| HeldView {
                    view: shared.screen.selection_view(0),
                    history_top: None,
                    selection: None,
                });
                let point = (col, row);
                let previous = held.selection.replace(DragSelection {
                    points: [point; 2],
                    complete: false,
                });
                if previous.is_some() {
                    held.paint();
                }
            }
            PointerAction::LeftDrag | PointerAction::LeftUp => {
                let Some(held) = &mut self.held else {
                    return;
                };
                let Some(selection) = &mut held.selection else {
                    return;
                };
                if selection.complete {
                    return;
                }
                let end = (col.min(grid.0), row.min(grid.1));
                let released = matches!(action, PointerAction::LeftUp);
                if released && end == selection.points[0] {
                    self.clear_selection();
                    return;
                }
                let moved = end != selection.points[1];
                selection.points[1] = end;
                selection.complete = released;
                if moved {
                    held.paint();
                }
            }
        }
    }

    fn clear_selection(&mut self) {
        if let Some(held) = &mut self.held
            && held.selection.take().is_some()
        {
            if held.history_top.is_some() {
                held.paint();
            } else {
                self.draw(None);
            }
        }
    }

    fn native_wheel(&mut self, input: &AgentInput, col: u16, row: u16, delta: i16, modifiers: u8) {
        match self.mouse {
            MouseOwner::Local => self.scroll_history(delta / 120),
            MouseOwner::Cli => {
                if let Some(shared) = &self.shared
                    && let Some(keys) = shared.screen.encode_wheel(col, row, delta, modifiers)
                {
                    input.push_keys(&keys);
                }
            }
            MouseOwner::Host => {}
        }
    }

    fn scroll_history(&mut self, ticks: i16) {
        let Some(shared) = &self.shared else {
            return;
        };
        if self.mouse != MouseOwner::Local || !fits(shared.grid(), shared.capacity) || ticks == 0 {
            return;
        }
        let history = shared.screen.scrollback_range();
        let history_top = self.held.as_ref().and_then(|held| held.history_top);
        let rows = -isize::from(ticks) * SCROLL_ROWS_PER_TICK;
        let top = history_top
            .unwrap_or(history.end)
            .clamp(history.start, history.end)
            .saturating_add_signed(rows)
            .clamp(history.start, history.end);
        if top < history.end {
            if history_top != Some(top) {
                let held = HeldView {
                    view: shared.screen.selection_view(history.end - top),
                    history_top: Some(top),
                    selection: None,
                };
                held.paint();
                self.held = Some(held);
            } else {
                self.clear_selection();
            }
        } else if self.held.is_some() {
            self.draw(None);
        }
    }

    /// Draws the agent's selected screen in the host's alternate screen.
    fn draw(&mut self, output: Option<&ParsedOutput>) {
        self.held = None;
        let Some(shared) = &self.shared else {
            return;
        };
        let waiting_for_view = !self.host_alternate
            && !shared.screen.on_alternate_screen()
            && shared
                .screen
                .view()
                .rows
                .iter()
                .flatten()
                .all(|cell| cell.text.trim().is_empty() && !cell.inverse);
        let grid_fits = fits(shared.grid(), shared.capacity);
        if let Some(output) = output {
            if waiting_for_view || !grid_fits {
                shared.write_title_change(output);
            }
            write_activity(output);
        }
        if !waiting_for_view && !self.host_alternate {
            write_terminal(b"\x1b[?1049h");
            self.host_alternate = true;
        }
        let mouse = MouseOwner::for_screen(self.host_alternate, &shared.screen);
        let previous = std::mem::replace(&mut self.mouse, mouse);
        capture_mouse(mouse != MouseOwner::Host);
        if waiting_for_view {
            return;
        }
        if !grid_fits {
            show_too_small(shared.grid());
            if mouse == MouseOwner::Local {
                mouse.write_frame(b"");
            } else if previous == MouseOwner::Local {
                write_terminal(&shared.mouse_modes());
            }
            return;
        }
        mouse.write_frame(
            &shared
                .screen
                .redraw_for_attach(shared.uses_viewport(), false),
        );
    }
}

/// Forwards the CLI's own window activity when rendering replaces the original bytes.
fn write_activity(output: &ParsedOutput) {
    if !output.native_activity.is_empty() {
        write_terminal(&output.native_activity);
    }
}

/// Native capture serves both local browsing and CLI mouse reporting.
fn capture_mouse(enabled: bool) {
    if let Some(modes) = lock_vt_modes().as_ref() {
        let _ = modes.set_mouse_capture(enabled);
    }
}

/// The daemon's grid, replayed at the confirmed size even when it cannot currently be drawn.
struct SharedScreen {
    screen: Screen,
    capacity: Option<(u16, u16)>,
}

impl SharedScreen {
    fn grid(&self) -> (u16, u16) {
        (self.screen.cols(), self.screen.rows())
    }

    fn uses_viewport(&self) -> bool {
        self.capacity.is_some_and(|size| size != self.grid())
    }

    /// The CLI's mouse modes from the same frame a full draw would write.
    fn mouse_modes(&self) -> Vec<u8> {
        let frame = self.screen.redraw_for_attach(false, false);
        selected_private_modes(&frame, is_mouse_mode)
    }

    /// Forwards a title change while the agent's screen is hidden.
    fn write_title_change(&self, output: &ParsedOutput) {
        if output.title_change.is_some() {
            write_terminal(&self.screen.title_output());
        }
    }
}

fn fits((cols, rows): (u16, u16), capacity: Option<(u16, u16)>) -> bool {
    capacity.is_none_or(|(width, height)| width >= cols && height >= rows)
}

fn show_too_small((cols, rows): (u16, u16)) {
    show_status(&format!(
        "The shared layout is {cols}×{rows}. Enlarge this terminal to see the current screen."
    ));
}

/// Detects output that could switch or reset the host's screen during native passthrough.
/// The daemon forwards whole sequences.
fn switches_screen_or_resets(bytes: &[u8]) -> bool {
    escapes(bytes).any(|sequence| sequence.starts_with(b"c"))
        || changes_private_modes(bytes, |mode| matches!(mode, b"1049" | b"1047" | b"47"))
}

fn changes_mouse_modes(bytes: &[u8]) -> bool {
    changes_private_modes(bytes, is_mouse_mode)
}

fn is_mouse_mode(mode: &[u8]) -> bool {
    matches!(
        mode,
        b"1000" | b"1002" | b"1003" | b"1005" | b"1006" | b"1007"
    )
}

fn escapes(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|&byte| byte == 0x1b).skip(1)
}

fn csi(sequence: &[u8]) -> Option<(&[u8], u8)> {
    let body = sequence.strip_prefix(b"[")?;
    let end = body.iter().position(|byte| (0x40..=0x7e).contains(byte))?;
    Some((&body[..end], body[end]))
}

fn private_modes(params: &[u8], final_byte: u8) -> Option<impl Iterator<Item = &[u8]>> {
    let numbers = params.strip_prefix(b"?")?;
    (matches!(final_byte, b'h' | b'l')
        && numbers
            .iter()
            .all(|&byte| byte.is_ascii_digit() || byte == b';'))
    .then(|| numbers.split(|&byte| byte == b';'))
}

fn changes_private_modes(bytes: &[u8], is_selected: impl Fn(&[u8]) -> bool) -> bool {
    escapes(bytes).filter_map(csi).any(|(params, end)| {
        private_modes(params, end).is_some_and(|mut modes| modes.any(&is_selected))
    })
}

fn append_private_modes(
    out: &mut Vec<u8>,
    params: &[u8],
    end: u8,
    is_selected: impl Fn(&[u8]) -> bool,
) {
    if let Some(modes) = private_modes(params, end) {
        for mode in modes.filter(|mode| is_selected(mode)) {
            out.extend_from_slice(b"\x1b[?");
            out.extend_from_slice(mode);
            out.push(end);
        }
    }
}

fn selected_private_modes(bytes: &[u8], is_selected: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let mut modes = Vec::new();
    for (params, end) in escapes(bytes).filter_map(csi) {
        append_private_modes(&mut modes, params, end, &is_selected);
    }
    modes
}

/// Pass input encoding changes through without painting live output over the history view.
fn input_mode_changes(bytes: &[u8]) -> Vec<u8> {
    let mut modes = Vec::new();
    for sequence in escapes(bytes) {
        if let Some(&keypad @ (b'=' | b'>')) = sequence.first() {
            modes.extend([0x1b, keypad]);
        } else if let Some((params, end)) = csi(sequence) {
            append_private_modes(&mut modes, params, end, |mode| {
                matches!(mode, b"1" | b"1004" | b"2004" | b"9001")
            });
            // Kitty keyboard flags can push and pop, so forward each change in order.
            if (end == b'u' && matches!(params.first(), Some(b'>' | b'<' | b'=')))
                || ((end == b'm' && (params == b">4" || params.starts_with(b">4;")))
                    || (end == b'n' && params == b">4"))
            {
                modes.extend_from_slice(b"\x1b[");
                modes.extend_from_slice(params);
                modes.push(end);
            }
        }
    }
    modes
}

/// Writes the notice to stderr. On a console it uses the bottom rows without scrolling.
/// The caller holds [`TERMINAL`].
fn show_status(note: &str) {
    let mut stderr = std::io::stderr().lock();
    if !stderr.is_terminal() {
        let _ = writeln!(stderr, "{note}");
        return;
    }
    let (cols, rows) = console_size().unwrap_or((80, 24));
    let width = usize::from(cols).saturating_sub(1);
    let lines: Vec<_> = note
        .lines()
        .flat_map(|line| wrap_status(line, width))
        .collect();
    let lines = &lines[lines.len().saturating_sub(usize::from(rows))..];
    let mut output = String::from("\x1b7\x1b[999;1H\x1b[0m");
    if lines.len() > 1 {
        use std::fmt::Write as _;
        let _ = write!(output, "\x1b[{}A", lines.len() - 1);
    }
    output.push_str("\x1b[2K");
    output.push_str(&lines.join("\x1b[1B\r\x1b[2K"));
    output.push_str("\x1b8");
    let _ = stderr.write_all(output.as_bytes());
    let _ = stderr.flush();
}

/// Breaks a console notice at spaces where possible while keeping every word.
fn wrap_status(mut note: &str, width: usize) -> Vec<&str> {
    let mut lines = Vec::new();
    while let Some(first) = note.chars().next() {
        let mut used = 0;
        let end = note
            .char_indices()
            .find_map(|(at, ch)| {
                used += ch.width().unwrap_or(0);
                (used > width).then_some(at)
            })
            .unwrap_or(note.len())
            .max(first.len_utf8());
        let end = if end < note.len() && !note[end..].starts_with(' ') {
            note[..end].rfind(' ').filter(|&at| at > 0).unwrap_or(end)
        } else {
            end
        };
        lines.push(&note[..end]);
        note = note[end..].trim_start_matches(' ');
    }
    lines
}

/// Restores plain text, visible cursor, normal keyboard and keypad modes, wrapping, ASCII charset,
/// and full-screen scrolling. Disables paste, mouse, alternate scroll, focus, win32-input-mode and
/// synchronized-update modes; pops kitty flags and resets modifyOtherKeys. Preserves the cursor
/// position.
const RESTORE_TERMINAL_SEQUENCE: &[u8] =
    b"\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?\
      1006l\x1b[?1007l\x1b[?1015l\x1b[?1004l\x1b[?9001l\x1b[<u\x1b[>4m\x1b[?2026l\x1b[?7h\x1b(B\x0f\x1b7\
      \x1b[r\x1b8";

/// Restores the person's terminal and writes the result and any unsent warning to stderr.
/// Only the first call does anything, so a signal cannot restore a half-restored terminal again.
/// The sequences go out while the console still reads them; then its modes go back, those entered
/// after raw mode first.
fn finish_attachment(input: &AgentInput, end: anyhow::Result<AttachEnd>) {
    let mut terminal = lock_terminal();
    if !RAW_MODE_ACTIVE.swap(false, SeqCst) {
        return;
    }
    let alternate = std::mem::take(&mut terminal.host_alternate);
    let cli_title_shown = std::mem::take(&mut terminal.cli_title_shown);
    write_terminal(&restoration(alternate, cli_title_shown));
    terminal.shared = None;
    terminal.mouse = MouseOwner::Host;
    terminal.held = None;
    drop(lock_vt_modes().take());
    let _ = crossterm::terminal::disable_raw_mode();

    let line = match end {
        Ok(end) => {
            let queue = input.lock();
            let shown = agent_label(queue.agent_name.as_deref(), &queue.address);
            result_line(&end, &shown, &queue.address)
        }
        Err(error) => format!("error: attachment failed: {error:#}"),
    };
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
    if let Some(warning) = unsent_line(input.unsent_bytes()) {
        let _ = writeln!(stderr, "{warning}");
    }
}

/// Restores the terminal's display modes and title and returns from the alternate screen when active.
fn restoration(alternate: bool, cli_title_shown: bool) -> Vec<u8> {
    // CAN ends any escape sequence the agent's output left open.
    let mut restoration = b"\x18".to_vec();
    if alternate {
        restoration.extend_from_slice(b"\x1b[?6l\x1b[?1049l");
    }
    restoration.extend_from_slice(RESTORE_TERMINAL_SEQUENCE);
    if cli_title_shown {
        // Terminals without a title stack can fall back to the host's default label.
        restoration.extend_from_slice(CLEAR_TITLE);
    }
    restoration.extend_from_slice(RESTORE_HOST_TITLE);
    restoration
}

#[cfg(test)]
mod tests {
    use facade_base::sockets::{self, ServerSocket};
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::*;

    const MACHINE_ID: &str = "11111111-2222-4333-8444-555555555555";
    const WATCH_ID: u64 = 7;

    /// The daemon's end of a connection, read on a runtime of its own.
    struct Daemon {
        end: BufReader<ServerSocket>,
        runtime: tokio::runtime::Runtime,
    }

    /// Reads one `agent.type` notification and decodes its keys; fails after 5 seconds.
    fn typed(daemon: &mut Daemon) -> Vec<u8> {
        let mut line = String::new();
        let read = daemon.end.read_line(&mut line);
        let read = daemon
            .runtime
            .block_on(async { tokio::time::timeout(Duration::from_secs(5), read).await });
        read.unwrap().unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["jsonrpc"], "2.0");
        assert_eq!(request["method"], "call");
        assert_eq!(request["params"]["op"], "agent.type");
        assert!(request.get("id").is_none(), "{request}");
        let args = &request["params"]["args"];
        assert_eq!(
            args["target"],
            json!({ "machine_id": MACHINE_ID, "agent_id": "a1" })
        );
        assert_eq!(args["input"]["kind"], "raw");
        base64::decode(args["input"]["raw"].as_str().unwrap()).unwrap()
    }

    /// An input queue with the target fixed by its first snapshot.
    fn input() -> Arc<AgentInput> {
        let reference = AgentRef {
            machine_id: MACHINE_ID.into(),
            agent_id: "a1".into(),
        };
        Arc::new(AgentInput::new(reference, "a1@devbox".into()))
    }

    /// A connection for the input and the daemon's end of it.
    fn connection() -> (ClientSocket, Daemon) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (writer, end) = {
            let _entered = runtime.enter();
            sockets::pair().unwrap()
        };
        let end = BufReader::new(end);
        (writer, Daemon { end, runtime })
    }

    #[test]
    fn queued_keys_and_keys_typed_while_disconnected_are_counted_and_never_replayed() {
        // Leave the writer idle so all the connected keys are still waiting at disconnect.
        let input = input();
        let (old_writer, _old_daemon) = connection();
        assert_eq!(
            input.connected(old_writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
        input.push_keys(&vec![b'x'; MAX_QUEUED_KEY_BYTES]);
        input.push_keys(b"too many");
        input.disconnected(false);
        let offline = "离线".as_bytes();
        input.push_keys(offline);
        assert_eq!(
            input.unsent_bytes(),
            MAX_QUEUED_KEY_BYTES + offline.len() + 8,
            "the final warning would include every unreported byte"
        );
        let (writer, mut daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss {
                queued: MAX_QUEUED_KEY_BYTES,
                disconnected: 6,
            }),
            "the notices distinguish queued bytes from bytes typed while disconnected"
        );
        spawn_with(&input, AgentInput::send_queued);
        input.push_keys(b"online");
        assert_eq!(typed(&mut daemon), b"online");
        assert_eq!(
            input.unsent_bytes(),
            8,
            "only the connected overflow remains for the final warning"
        );
        input.detach();
    }

    #[test]
    fn keys_handed_to_a_lost_connection_are_never_sent_again() {
        let input = input();
        spawn_with(&input, AgentInput::send_queued);
        let (writer, daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
        drop(daemon);
        // The write fails, so whether these keys arrived is unknown: they are neither kept nor
        // counted as unsent.
        input.push_keys(b"maybe delivered");
        let disconnected = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            input.lock().connection.is_none()
        });
        assert!(disconnected, "the failed write ends the connection");
        assert_eq!(input.unsent_bytes(), 0);
        input.push_keys(b"offline");
        let (writer, mut daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss {
                queued: 0,
                disconnected: 7,
            })
        );
        input.push_keys(b"online");
        assert_eq!(typed(&mut daemon), b"online");
        assert_eq!(input.unsent_bytes(), 0);
        input.detach();
    }

    #[test]
    fn a_blocked_write_never_holds_up_typing_counting_or_detaching() {
        let input = input();
        spawn_with(&input, AgentInput::send_queued);
        // The daemon reads nothing, so the writer soon blocks in a write.
        let (writer, daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
        let chunk = vec![b'k'; 64 * 1024];
        let maximum_unsent = 40 * chunk.len();
        let (done, finished) = std::sync::mpsc::channel();
        let work = std::thread::spawn(move || {
            for _ in 0..8 {
                input.push_keys(&chunk);
            }
            std::thread::sleep(Duration::from_millis(300));
            for _ in 0..32 {
                input.push_keys(&chunk);
            }
            let unsent = input.unsent_bytes();
            input.detach();
            done.send(unsent).unwrap();
        });
        let result = finished.recv_timeout(Duration::from_secs(5));
        // Release a blocked write before reporting a failure.
        drop(daemon);
        let unsent = result
            .expect("typing, counting, and detaching did not finish while the write was blocked");
        work.join().unwrap();
        assert!(unsent > 0 && unsent <= maximum_unsent, "{unsent}");
    }

    #[test]
    fn restores_the_host_title_with_or_without_an_alternate_screen() {
        for alternate in [false, true] {
            for cli_title_shown in [false, true] {
                let mut host = Screen::new(80, 24, 0);
                host.feed(b"\x1b]2;host\x1b\\");
                host.feed(SAVE_HOST_TITLE);
                if alternate {
                    host.feed(b"\x1b[?1049h");
                }
                if cli_title_shown {
                    host.feed(b"\x1b]2;agent\x1b\\");
                }

                let bytes = restoration(alternate, cli_title_shown);
                let before_pop = bytes.strip_suffix(RESTORE_HOST_TITLE).unwrap();
                assert_eq!(before_pop.ends_with(CLEAR_TITLE), cli_title_shown);
                let output = host.feed(&bytes);
                assert_eq!(output.title_change.as_deref(), Some("host"));
                assert!(!host.on_alternate_screen());
            }
        }
    }

    #[test]
    fn detects_screen_switches_and_reset() {
        let cases: [(&[u8], bool); 9] = [
            (b"\x1b[?1049h", true),
            (b"\x1b[?1049l", true),
            (b"text\x1b[?25;1049h more", true),
            (b"\x1b[?1049;25l", true),
            (b"\x1b[?47hx\x1b[?47l", true),
            (b"\x1b[?1047l", true),
            (b"\x1b[?25h\x1bc", true),
            (b"\x1b[?10490h", false),
            (b"text\x1b[?25h", false),
        ];
        for (bytes, expected) in cases {
            assert_eq!(
                switches_screen_or_resets(bytes),
                expected,
                "{}",
                String::from_utf8_lossy(bytes)
            );
        }
    }
}
