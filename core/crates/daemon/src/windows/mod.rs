//! Logical editor windows, their current instances and connections, and their locations as last
//! read. A workspace window can reopen under the same logical ID with a new binding generation.

mod locations;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use facade_base::daemon::{
    LocationInfo, TERMINAL_WINDOW, TERMINAL_WINDOW_LABEL, TerminalColors, WindowDeliveryFailure,
    WindowDescription, WindowInfo, WindowRef, WindowsChange, WorktreeCreateArgs, location_id,
};
use facade_base::files::{folder_key, real_path};
use facade_base::jsonrpc::{ErrorBody, Reason};
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};

use crate::store::{WindowRow, WindowTable};
use crate::{WindowBinding, blocking_in_place};
use locations::{Catalog, Creations};

/// The most window changes queued for a watcher before it gets every window again.
const MAX_QUEUED_CHANGES: usize = 256;
const FIRST_GENERATION: u64 = 1;

/// A change in window presence reported to the daemon.
pub(crate) enum WindowEvent {
    /// The window's last connection closed: its `departure`-th leaving.
    Left {
        binding: WindowBinding,
        departure: u64,
    },
}

/// A read of a window's locations: says which agent folders are gone.
pub(crate) struct LocationsRead {
    binding: WindowBinding,
    catalog: Catalog,
    /// Locations only folders the window no longer has brought.
    dropped: Vec<String>,
}

impl LocationsRead {
    #[allow(dead_code, reason = "used when the daemon switches to protocol 2")]
    pub(crate) fn binding(&self) -> &WindowBinding {
        &self.binding
    }

    /// Whether an agent working in `cwd` lost its location: no location holds the folder and the
    /// window no longer has the folder of one that did, or a read with no problem no longer finds
    /// the folder.
    pub(crate) fn is_gone(&self, cwd: &str) -> bool {
        if self.catalog.location(cwd).is_some() {
            return false;
        }
        let cwd_key = folder_key(Path::new(cwd));
        (self.catalog.holding(cwd).is_none()
            && self
                .dropped
                .iter()
                .any(|path| Path::new(&cwd_key).starts_with(folder_key(Path::new(path)))))
            || (self.catalog.problems().is_empty() && !Path::new(cwd).exists())
    }
}

/// Where an agent starts: its folder, and the ID of the location that holds the folder.
pub(crate) struct Destination {
    pub(crate) cwd: String,
    pub(crate) location_id: String,
}

/// The editor windows, by ID, and the worktree creations under way in them.
pub(crate) struct Windows {
    shared: Arc<Shared>,
    creations: Creations,
}

/// What [`Windows`] shares with its connection and watch guards.
struct Shared {
    machine_id: String,
    /// Serializes changes to durable bindings. The state lock is released during table writes.
    binding_gate: AsyncMutex<()>,
    /// A leaf lock, taken and released inside each method.
    state: Mutex<Registry>,
    changes: broadcast::Sender<WindowsChange>,
    events: mpsc::UnboundedSender<WindowEvent>,
    table: WindowTable,
}

#[derive(Default)]
struct Registry {
    windows: HashMap<String, Window>,
    last_sequence: u64,
}

struct Window {
    binding: WindowBinding,
    sequence: u64,
    description: WindowDescription,
    connections: usize,
    watchers: HashMap<u64, PersonSink>,
    catalog: Catalog,
    /// When `catalog` was read.
    read_at: Option<String>,
    /// How many times the window has left.
    departures: u64,
}

impl Window {
    fn new(binding: WindowBinding, sequence: u64, description: WindowDescription) -> Window {
        Window {
            binding,
            sequence,
            description,
            connections: 0,
            watchers: HashMap::new(),
            catalog: Catalog::default(),
            read_at: None,
            departures: 0,
        }
    }

    fn info(&self) -> WindowInfo {
        WindowInfo {
            machine_id: self.binding.window.machine_id.clone(),
            window_id: self.binding.window.window_id.clone(),
            label: self.description.label.clone(),
            environment: self.description.environment.clone(),
            connected: self.connections > 0,
            folders: self.description.folders.clone(),
            locations: self.catalog.locations().to_vec(),
            problems: self.catalog.problems().to_vec(),
            observed_at: self.read_at.clone(),
            clis: Vec::new(),
            settings_problem: None,
        }
    }

    fn is_current(&self, binding: &WindowBinding) -> bool {
        self.binding == *binding && self.connections > 0
    }

    /// Whether the window is still away since its `departure`-th leaving.
    fn away_since(&self, departure: u64) -> bool {
        self.connections == 0 && self.departures == departure
    }
}

impl Shared {
    fn window_ref(&self, id: &str) -> WindowRef {
        WindowRef {
            machine_id: self.machine_id.clone(),
            window_id: id.to_string(),
        }
    }

    fn first_binding(&self, id: &str) -> WindowBinding {
        WindowBinding {
            window: self.window_ref(id),
            generation: FIRST_GENERATION,
        }
    }

    fn publish(&self, change: WindowsChange) {
        let _ = self.changes.send(change);
    }

    fn updated(&self, window: &Window) {
        self.publish(WindowsChange::Updated {
            window: Box::new(window.info()),
        });
    }

    /// One connection of this binding closed. The last one makes the window leave.
    fn disconnect(&self, binding: &WindowBinding) {
        let departure = {
            let mut state = self.state.lock().unwrap();
            let Some(window) = state
                .windows
                .get_mut(&binding.window.window_id)
                .filter(|window| window.is_current(binding))
            else {
                return;
            };
            window.connections -= 1;
            if window.connections > 0 {
                return;
            }
            window.watchers.clear();
            window.departures += 1;
            self.updated(window);
            window.departures
        };
        let _ = self.events.send(WindowEvent::Left {
            binding: binding.clone(),
            departure,
        });
    }
}

fn warn(message: &str) {
    facade_base::log::write("daemon", "warn", message);
}

/// One open connection of an editor window. Dropping the last one makes the window leave.
pub(crate) struct WindowConnection {
    shared: Arc<Shared>,
    binding: WindowBinding,
}

impl WindowConnection {
    #[allow(dead_code, reason = "used when hello carries a window binding")]
    pub(crate) fn binding(&self) -> &WindowBinding {
        &self.binding
    }
}

impl Drop for WindowConnection {
    fn drop(&mut self) {
        self.shared.disconnect(&self.binding);
    }
}

/// An open `messages` watch of an editor window's `ide` client.
pub(crate) struct PersonWatch {
    shared: Arc<Shared>,
    binding: WindowBinding,
    viewer: u64,
}

impl Drop for PersonWatch {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(window) = state
            .windows
            .get_mut(&self.binding.window.window_id)
            .filter(|window| window.binding == self.binding)
        {
            window.watchers.remove(&self.viewer);
        }
    }
}

/// The sink is called under the window lock and may only try to enqueue the change.
pub(crate) type PersonSink = Arc<dyn Fn(&serde_json::Value) -> bool + Send + Sync>;

/// A window's binding and viewers chosen before the message is stored.
#[allow(dead_code, reason = "used when the daemon switches to protocol 2")]
pub(crate) struct PersonTarget {
    binding: WindowBinding,
    viewers: Vec<u64>,
}

impl Windows {
    /// No windows yet. Rows go to `table`. Departures go to `events`.
    pub(crate) fn new(
        machine_id: String,
        table: WindowTable,
        events: mpsc::UnboundedSender<WindowEvent>,
    ) -> Windows {
        Windows {
            shared: Arc::new(Shared {
                machine_id,
                binding_gate: AsyncMutex::default(),
                state: Mutex::default(),
                changes: broadcast::channel(MAX_QUEUED_CHANGES).0,
                events,
                table,
            }),
            creations: Creations::default(),
        }
    }

    /// Refuses a description no editor window gives: no ID, the terminal window's ID, or a folder
    /// that is not an absolute path.
    pub(crate) fn check(description: &WindowDescription) -> Result<(), ErrorBody> {
        if description.id.trim().is_empty() || description.id == TERMINAL_WINDOW {
            return Err(ErrorBody::invalid_argument(format!(
                "{:?} is not an editor window's ID",
                description.id
            )));
        }
        match description
            .folders
            .iter()
            .find(|folder| !Path::new(folder).is_absolute())
        {
            Some(folder) => Err(ErrorBody::invalid_argument(format!(
                "the folder {folder} is not an absolute path"
            ))),
            None => Ok(()),
        }
    }
}

#[allow(dead_code, reason = "used when the daemon switches to protocol 2")]
impl Windows {
    /// Restores saved logical windows before clients connect.
    pub(crate) fn restore(&self) -> Result<(), ErrorBody> {
        let rows = blocking_in_place(|| self.shared.table.logical_windows())
            .map_err(ErrorBody::internal)?;
        let mut state = self.shared.state.lock().unwrap();
        for row in rows {
            let binding = self.shared.first_binding(&row.window_id);
            state.last_sequence = state.last_sequence.max(row.sequence);
            state.windows.insert(
                row.window_id,
                Window::new(binding, row.sequence, row.description),
            );
        }
        Ok(())
    }

    /// Binds an instance to its logical window and gives the caller its connection guard.
    pub(crate) async fn bind(
        &self,
        description: WindowDescription,
    ) -> Result<(WindowConnection, Vec<String>), ErrorBody> {
        Self::check(&description)?;
        let _binding_gate = self.shared.binding_gate.lock().await;
        let (binding, sequence) = {
            let state = self.shared.state.lock().unwrap();
            let known = state
                .windows
                .values()
                .find(|window| window.description.id == description.id);
            let matched = known.or_else(|| {
                let workspace = description.workspace.as_ref()?;
                state
                    .windows
                    .values()
                    .filter(|window| {
                        window.connections == 0
                            && window.description.workspace.as_ref() == Some(workspace)
                    })
                    .min_by_key(|window| window.sequence)
            });
            match matched {
                Some(window) => {
                    let mut binding = window.binding.clone();
                    if window.description.id != description.id {
                        binding.generation += 1;
                    }
                    (binding, window.sequence)
                }
                None => {
                    let id = loop {
                        let id = format!("win-{:016x}", facade_base::random_u64());
                        if !state.windows.contains_key(&id) {
                            break id;
                        }
                    };
                    (self.shared.first_binding(&id), state.last_sequence + 1)
                }
            }
        };
        let row = WindowRow {
            window_id: binding.window.window_id.clone(),
            sequence,
            description,
        };
        blocking_in_place(|| self.shared.table.save_logical_window(&row))
            .map_err(ErrorBody::internal)?;

        let mut state = self.shared.state.lock().unwrap();
        state.last_sequence = state.last_sequence.max(sequence);
        let folders_before = match state.windows.get_mut(&row.window_id) {
            Some(window) => {
                if window.binding != binding {
                    window.binding = binding.clone();
                    window.watchers.clear();
                }
                window.connections += 1;
                std::mem::replace(&mut window.description, row.description).folders
            }
            None => {
                let mut window = Window::new(binding.clone(), sequence, row.description);
                window.connections = 1;
                state.windows.insert(row.window_id, window);
                Vec::new()
            }
        };
        let connection = WindowConnection {
            shared: self.shared.clone(),
            binding,
        };
        Ok((connection, folders_before))
    }

    /// Saves a current binding's description and returns the previous folders.
    pub(crate) async fn update(
        &self,
        binding: &WindowBinding,
        description: WindowDescription,
    ) -> Result<Vec<String>, ErrorBody> {
        Self::check(&description)?;
        let _binding_gate = self.shared.binding_gate.lock().await;
        let id = &binding.window.window_id;
        let row = {
            let state = self.shared.state.lock().unwrap();
            let window = state
                .windows
                .get(id)
                .filter(|window| window.is_current(binding))
                .ok_or_else(|| stale_connection(binding))?;
            if description.id != window.description.id {
                return Err(ErrorBody::invalid_argument(format!(
                    "this connection cannot describe window instance {:?}",
                    description.id
                )));
            }
            WindowRow {
                window_id: id.clone(),
                sequence: window.sequence,
                description,
            }
        };
        blocking_in_place(|| self.shared.table.save_logical_window(&row))
            .map_err(ErrorBody::internal)?;

        let mut state = self.shared.state.lock().unwrap();
        let window = state
            .windows
            .get_mut(id)
            .expect("the binding gate keeps this window");
        Ok(std::mem::replace(&mut window.description, row.description).folders)
    }

    pub(crate) fn is_current(&self, binding: &WindowBinding) -> bool {
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(&binding.window.window_id)
            .is_some_and(|window| window.is_current(binding))
    }

    /// Members may be offline. The local terminal is always a valid member.
    pub(crate) fn check_member(&self, window: &WindowRef) -> Result<(), ErrorBody> {
        self.check_machine(window)?;
        let id = &window.window_id;
        if id == TERMINAL_WINDOW || self.shared.state.lock().unwrap().windows.contains_key(id) {
            return Ok(());
        }
        Err(ErrorBody::invalid_argument(format!(
            "window {id} is not known on this machine"
        )))
    }

    /// Reclaims a workspace-less window only while it is still away and has no members.
    pub(crate) async fn discard_empty(
        &self,
        binding: &WindowBinding,
        departure: u64,
        delete: impl FnOnce(&WindowRef) -> anyhow::Result<bool> + Send,
    ) -> Result<(), ErrorBody> {
        let _binding_gate = self.shared.binding_gate.lock().await;
        let id = &binding.window.window_id;
        let eligible = {
            let state = self.shared.state.lock().unwrap();
            state.windows.get(id).is_some_and(|window| {
                window.binding == *binding
                    && window.away_since(departure)
                    && window.description.workspace.is_none()
            })
        };
        if eligible && blocking_in_place(|| delete(&binding.window)).map_err(ErrorBody::internal)? {
            let mut state = self.shared.state.lock().unwrap();
            state.windows.remove(id);
            self.shared.publish(WindowsChange::Removed {
                machine_id: binding.window.machine_id.clone(),
                window_id: id.clone(),
            });
        }
        Ok(())
    }

    /// Registers a messages subscription for the life of the guard.
    pub(crate) fn watch_person(
        &self,
        binding: &WindowBinding,
        viewer: u64,
        sink: PersonSink,
    ) -> Result<PersonWatch, ErrorBody> {
        let mut state = self.shared.state.lock().unwrap();
        let window = state
            .windows
            .get_mut(&binding.window.window_id)
            .filter(|window| window.is_current(binding))
            .ok_or_else(|| stale_connection(binding))?;
        window.watchers.insert(viewer, sink);
        Ok(PersonWatch {
            shared: self.shared.clone(),
            binding: binding.clone(),
            viewer,
        })
    }

    /// Selects the current binding and subscriptions before a message is stored.
    pub(crate) fn person_target(
        &self,
        window: &WindowRef,
    ) -> Result<PersonTarget, WindowDeliveryFailure> {
        if window.machine_id == self.shared.machine_id && window.window_id == TERMINAL_WINDOW {
            return Err(delivery_failure(window, "not_watching"));
        }
        let state = self.shared.state.lock().unwrap();
        let current = state
            .windows
            .get(&window.window_id)
            .filter(|current| current.binding.window == *window && current.connections > 0)
            .ok_or_else(|| delivery_failure(window, "window_disconnected"))?;
        if current.watchers.is_empty() {
            return Err(delivery_failure(window, "not_watching"));
        }
        Ok(PersonTarget {
            binding: current.binding.clone(),
            viewers: current.watchers.keys().copied().collect(),
        })
    }

    /// Offers an encoded change to every selected viewer still registered on the chosen binding.
    pub(crate) fn deliver_to_person(
        &self,
        target: &PersonTarget,
        change: &serde_json::Value,
    ) -> Result<(), WindowDeliveryFailure> {
        let state = self.shared.state.lock().unwrap();
        let window_ref = &target.binding.window;
        let window = state
            .windows
            .get(&window_ref.window_id)
            .filter(|window| window.is_current(&target.binding))
            .ok_or_else(|| delivery_failure(window_ref, "window_disconnected"))?;
        let mut delivered = false;
        for sink in target
            .viewers
            .iter()
            .filter_map(|viewer| window.watchers.get(viewer))
        {
            delivered |= sink(change);
        }
        if delivered {
            Ok(())
        } else {
            Err(delivery_failure(window_ref, "not_watching"))
        }
    }
}

#[allow(dead_code, reason = "used when the daemon switches to protocol 2")]
fn stale_connection(binding: &WindowBinding) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!(
            "this connection no longer belongs to window {}",
            binding.window.window_id
        ),
    )
}

#[allow(dead_code, reason = "used when the daemon switches to protocol 2")]
fn delivery_failure(window: &WindowRef, reason: &str) -> WindowDeliveryFailure {
    WindowDeliveryFailure {
        window: window.clone(),
        reason: reason.to_string(),
    }
}

fn unknown_window(id: &str) -> WindowDescription {
    WindowDescription {
        id: id.to_string(),
        label: id.to_string(),
        environment: "unknown".into(),
        workspace: None,
        folders: Vec::new(),
        branch_prefix: None,
        colors: None,
        env: None,
    }
}

// Protocol 1 still identifies a window by its instance ID.
impl Windows {
    /// Restores the editor windows in `running` with no connections. Uses the saved descriptions,
    /// or each window's ID as its label if its description is missing. Other windows in `agents`
    /// keep their rows outside the list for a later window of their workspace to take over.
    /// Deletes rows for windows with no agents. Blocks on the table.
    pub(crate) fn restore_v1(&self, running: &[String], agents: &[String]) {
        let kept = blocking_in_place(|| self.shared.table.windows()).unwrap_or_else(|err| {
            warn(&format!("{err:#}"));
            Vec::new()
        });
        let mut kept: HashMap<String, WindowDescription> = kept
            .into_iter()
            .map(|description| (description.id.clone(), description))
            .collect();
        {
            let mut state = self.shared.state.lock().unwrap();
            for id in running.iter().filter(|id| id.as_str() != TERMINAL_WINDOW) {
                state.windows.entry(id.clone()).or_insert_with(|| {
                    let description = kept.remove(id).unwrap_or_else(|| unknown_window(id));
                    Window::new(self.shared.first_binding(id), 0, description)
                });
            }
        }
        for id in kept.keys().filter(|id| !agents.contains(id)) {
            if let Err(err) = blocking_in_place(|| self.shared.table.delete_window(id)) {
                warn(&format!("{err:#}"));
            }
        }
    }

    /// Takes `description` as its window's, counting one more connection where `connecting`, and
    /// keeps it in the table. Answers the windows of the same workspace that it takes over: those
    /// listed with no connection left, which are removed here, and those that left and are no
    /// longer listed, whose rows the table kept. Their agents are the caller's to move before
    /// [`Windows::taken_over`]. Blocks on the table.
    pub(crate) fn describe(
        &self,
        description: &WindowDescription,
        connecting: bool,
    ) -> Vec<String> {
        let id = &description.id;
        let rows = match &description.workspace {
            Some(_) => blocking_in_place(|| self.shared.table.windows()).unwrap_or_else(|err| {
                warn(&format!("{err:#}"));
                Vec::new()
            }),
            None => Vec::new(),
        };
        let taken = {
            let mut state = self.shared.state.lock().unwrap();
            let windows = &mut state.windows;
            let mut taken: Vec<String> = Vec::new();
            if let Some(workspace) = &description.workspace {
                taken = windows
                    .iter()
                    .filter(|(other, window)| {
                        *other != id
                            && window.connections == 0
                            && window.description.workspace.as_ref() == Some(workspace)
                    })
                    .map(|(other, _)| other.clone())
                    .collect();
                taken.extend(
                    rows.iter()
                        .filter(|row| {
                            row.id != *id
                                && row.workspace.as_ref() == Some(workspace)
                                && !windows.contains_key(&row.id)
                        })
                        .map(|row| row.id.clone()),
                );
            }
            for other in &taken {
                windows.remove(other);
            }
            let window = windows.entry(id.clone()).or_insert_with(|| {
                Window::new(self.shared.first_binding(id), 0, description.clone())
            });
            window.description = description.clone();
            if connecting {
                window.connections += 1;
            }
            taken
        };
        if let Err(err) = blocking_in_place(|| self.shared.table.save_window(description)) {
            warn(&format!("{err:#}"));
        }
        taken
    }

    /// A guard for one connection of window `id`, which [`Windows::describe`] counted.
    pub(crate) fn connection(&self, id: &str) -> WindowConnection {
        WindowConnection {
            shared: self.shared.clone(),
            binding: self.shared.first_binding(id),
        }
    }

    /// Says window `from` is gone, once its agents moved to the window that took them over.
    pub(crate) fn taken_over(&self, from: &str) {
        self.shared.publish(WindowsChange::Removed {
            machine_id: String::new(),
            window_id: from.to_string(),
        });
    }

    pub(crate) async fn read_locations_v1(
        &self,
        id: &str,
        folders_before: Option<Vec<String>>,
    ) -> Option<LocationsRead> {
        self.read_locations(&self.shared.first_binding(id), folders_before)
            .await
    }

    /// Removes window `id` from the list, unless it connected again since its `departure`-th
    /// leaving, and deletes its row, except where `has_agents`: agents' records are still under
    /// its ID, and the row keeps its `workspace`, so that a later window of it can take them over.
    /// Blocks on the table.
    pub(crate) fn remove(&self, id: &str, departure: u64, has_agents: bool) {
        {
            let mut state = self.shared.state.lock().unwrap();
            let windows = &mut state.windows;
            if !windows
                .get(id)
                .is_some_and(|window| window.away_since(departure))
            {
                return;
            }
            windows.remove(id);
        }
        if !has_agents && let Err(err) = blocking_in_place(|| self.shared.table.delete_window(id)) {
            warn(&format!("{err:#}"));
        }
        self.shared.publish(WindowsChange::Removed {
            machine_id: String::new(),
            window_id: id.to_string(),
        });
    }

    /// Counts a `messages` watch of window `id`'s `ide` client while the guard lives.
    pub(crate) fn watch_person_v1(&self, id: &str, viewer: u64) -> PersonWatch {
        if let Some(window) = self.shared.state.lock().unwrap().windows.get_mut(id) {
            window.watchers.insert(viewer, Arc::new(|_| false));
        }
        PersonWatch {
            shared: self.shared.clone(),
            binding: self.shared.first_binding(id),
            viewer,
        }
    }

    /// Whether window `id`'s `ide` client watches its messages, so that the window can tell the
    /// person.
    pub(crate) fn tells_person(&self, id: &str) -> bool {
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(id)
            .is_some_and(|window| !window.watchers.is_empty())
    }

    pub(crate) fn check_destination_v1(
        &self,
        id: &str,
        cwd: &str,
    ) -> Result<Destination, ErrorBody> {
        let window = (id != TERMINAL_WINDOW).then(|| self.shared.window_ref(id));
        self.check_destination(window.as_ref(), cwd)
    }

    pub(crate) fn label_v1(&self, id: &str) -> String {
        self.label(&self.shared.window_ref(id))
    }

    pub(crate) fn colors_v1(&self, id: &str) -> Option<TerminalColors> {
        self.colors(&self.shared.window_ref(id))
    }
}

impl Windows {
    /// Reads locations for the selected binding, publishing only if it is still in place.
    /// After a new description, locations brought only by dropped folders are reported as gone.
    pub(crate) async fn read_locations(
        &self,
        binding: &WindowBinding,
        folders_before: Option<Vec<String>>,
    ) -> Option<LocationsRead> {
        let id = &binding.window.window_id;
        let (folders, last) = {
            let state = self.shared.state.lock().unwrap();
            let window = state
                .windows
                .get(id)
                .filter(|window| window.binding == *binding)?;
            (window.description.folders.clone(), window.catalog.clone())
        };
        let catalog = locations::read(&folders, &last).await;
        let dropped = match folders_before {
            Some(_) => last.left_by(&folders),
            None => Vec::new(),
        };
        {
            let mut state = self.shared.state.lock().unwrap();
            let window = state.windows.get_mut(id).filter(|window| {
                window.binding == *binding && window.description.folders == folders
            })?;
            window.catalog = catalog.clone();
            window.read_at = Some(facade_base::time::iso_now());
            self.shared.updated(window);
        }
        Some(LocationsRead {
            binding: binding.clone(),
            catalog,
            dropped,
        })
    }

    /// The local terminal's name, an editor window's own name, or its ID.
    pub(crate) fn label(&self, window: &WindowRef) -> String {
        let id = &window.window_id;
        if window.machine_id != self.shared.machine_id {
            return id.clone();
        }
        if id == TERMINAL_WINDOW {
            return TERMINAL_WINDOW_LABEL.to_string();
        }
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(id)
            .map_or_else(|| id.clone(), |window| window.description.label.clone())
    }

    /// Later window changes.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<WindowsChange> {
        self.shared.changes.subscribe()
    }

    /// The editor windows by ID, with their locations as last read and no CLIs.
    pub(crate) fn infos(&self) -> Vec<WindowInfo> {
        let mut infos: Vec<WindowInfo> = self
            .shared
            .state
            .lock()
            .unwrap()
            .windows
            .values()
            .map(Window::info)
            .collect();
        infos.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        infos
    }

    /// A direct start uses `cwd` as given. A source window must be connected and provide a
    /// location holding `cwd` with its links resolved.
    pub(crate) fn check_destination(
        &self,
        source: Option<&WindowRef>,
        cwd: &str,
    ) -> Result<Destination, ErrorBody> {
        let Some(window) = source else {
            return Ok(Destination {
                cwd: cwd.to_string(),
                location_id: location_id(cwd),
            });
        };
        self.check_machine(window)?;
        let (destination, _, _) = self.check_editor_place(&window.window_id, cwd, false)?;
        Ok(destination)
    }

    fn check_machine(&self, window: &WindowRef) -> Result<(), ErrorBody> {
        if window.machine_id != self.shared.machine_id {
            return Err(ErrorBody::invalid_argument(format!(
                "window {} belongs to another machine",
                window.window_id
            )));
        }
        Ok(())
    }

    /// Takes the location, binding and Git prefix from the same window state.
    fn check_editor_place(
        &self,
        id: &str,
        cwd: &str,
        exact: bool,
    ) -> Result<(Destination, WindowBinding, Option<String>), ErrorBody> {
        let path = real_path(Path::new(cwd)).map_or_else(
            |_| cwd.to_string(),
            |path| path.to_string_lossy().into_owned(),
        );
        let (location_id, binding, branch_prefix) = {
            let state = self.shared.state.lock().unwrap();
            let window = state
                .windows
                .get(id)
                .filter(|window| window.connections > 0)
                .ok_or_else(|| {
                    ErrorBody::new(Reason::Unavailable, format!("window {id} is not there now"))
                })?;
            let location = if exact {
                window.catalog.location(&path)
            } else {
                window.catalog.holding(&path)
            }
            .ok_or_else(|| {
                let nor_inside = if exact { "" } else { ", nor inside one" };
                ErrorBody::invalid_argument(format!(
                    "{cwd} is not a location of window {}{nor_inside}",
                    window.description.label
                ))
            })?;
            (
                location.location_id.clone(),
                window.binding.clone(),
                window.description.branch_prefix.clone(),
            )
        };
        if !Path::new(&path).is_dir() {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                format!("the folder {path} no longer exists"),
            ));
        }
        Ok((
            Destination {
                location_id,
                cwd: path,
            },
            binding,
            branch_prefix,
        ))
    }

    /// The terminal colors the window last described, kept only in memory.
    pub(crate) fn colors(&self, window: &WindowRef) -> Option<TerminalColors> {
        if window.machine_id != self.shared.machine_id {
            return None;
        }
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(&window.window_id)?
            .description
            .colors
            .clone()
    }

    /// The environment window `id` last described, kept only in memory.
    pub(crate) fn env(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(id)?
            .description
            .env
            .clone()
    }

    /// Window `id`'s folders.
    pub(crate) fn folders(&self, id: &str) -> Vec<String> {
        self.shared
            .state
            .lock()
            .unwrap()
            .windows
            .get(id)
            .map(|window| window.description.folders.clone())
            .unwrap_or_default()
    }

    /// Makes a worktree from the target window's checkout, or directly from the terminal's
    /// path. For an editor target, refreshes locations through the same binding.
    pub(crate) async fn create_worktree(
        &self,
        args: WorktreeCreateArgs,
    ) -> Result<(LocationInfo, Option<LocationsRead>), ErrorBody> {
        let (source, binding, prefix) = if args.window_id == TERMINAL_WINDOW {
            (args.cwd, None, None)
        } else {
            let (destination, binding, prefix) =
                self.check_editor_place(&args.window_id, &args.cwd, true)?;
            (destination.cwd, Some(binding), prefix)
        };
        let made = locations::create(
            Path::new(&source),
            &args.worktree,
            prefix.as_deref(),
            &self.creations,
        )
        .await?;
        let Some(binding) = binding else {
            return Ok((made, None));
        };
        let read = self.read_locations(&binding, None).await;
        let listed = read
            .as_ref()
            .and_then(|read| read.catalog.location(&made.path).cloned())
            .unwrap_or(made);
        Ok((listed, read))
    }
}
