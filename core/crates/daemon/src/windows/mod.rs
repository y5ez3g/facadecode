//! Editor windows (RULES-4.1, ARCHITECTURE-2.2): what each `ide` client says of its window, how
//! many of the window's connections are open, and its locations as last read.
//!
//! Each time a window's last connection closes, it gets a new departure number. The daemon uses
//! the number from [`WindowEvent::Left`] to verify the window is still disconnected for that
//! departure before removing it. The rows in `facade.db` keep descriptions for recovery and
//! takeover by another window of the same workspace.

mod locations;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use facade_base::daemon::{
    LocationInfo, TERMINAL_WINDOW, TERMINAL_WINDOW_LABEL, TerminalColors, WindowDescription,
    WindowInfo, WindowsChange, WorktreeCreateArgs, location_id,
};
use facade_base::files::{folder_key, real_path};
use facade_base::jsonrpc::{ErrorBody, Reason};
use tokio::sync::{broadcast, mpsc};

use crate::blocking_in_place;
use crate::store::WindowTable;
use locations::{Catalog, Creations};

/// The most window changes queued for a watcher before it gets every window again.
const MAX_QUEUED_CHANGES: usize = 256;

/// A change in window presence reported to the daemon.
pub(crate) enum WindowEvent {
    /// The window's last connection closed: its `departure`-th leaving.
    Left { window_id: String, departure: u64 },
}

/// A read of a window's locations: says which agent folders are gone.
pub(crate) struct LocationsRead {
    catalog: Catalog,
    /// Locations only folders the window no longer has brought.
    dropped: Vec<String>,
}

impl LocationsRead {
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
    /// The windows' lock: a leaf, taken and released inside each method.
    windows: Mutex<HashMap<String, Window>>,
    changes: broadcast::Sender<WindowsChange>,
    events: mpsc::UnboundedSender<WindowEvent>,
    table: WindowTable,
}

struct Window {
    description: WindowDescription,
    connections: usize,
    /// Open `messages` watches of the window's `ide` client: while there is one, the window can
    /// tell the person.
    watchers: usize,
    catalog: Catalog,
    /// When `catalog` was read.
    read_at: Option<String>,
    /// How many times the window has left.
    departures: u64,
}

impl Window {
    fn new(description: WindowDescription) -> Window {
        Window {
            description,
            connections: 0,
            watchers: 0,
            catalog: Catalog::default(),
            read_at: None,
            departures: 0,
        }
    }

    fn info(&self) -> WindowInfo {
        WindowInfo {
            window_id: self.description.id.clone(),
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

    /// Whether the window is still away since its `departure`-th leaving.
    fn away_since(&self, departure: u64) -> bool {
        self.connections == 0 && self.departures == departure
    }
}

impl Shared {
    fn publish(&self, change: WindowsChange) {
        let _ = self.changes.send(change);
    }

    fn updated(&self, window: &Window) {
        self.publish(WindowsChange::Updated {
            window: Box::new(window.info()),
        });
    }

    /// One connection of window `id` closed; the last one makes the window leave.
    fn disconnect(&self, id: &str) {
        let departure = {
            let mut windows = self.windows.lock().unwrap();
            let Some(window) = windows.get_mut(id) else {
                return;
            };
            window.connections -= 1;
            if window.connections > 0 {
                return;
            }
            window.departures += 1;
            self.updated(window);
            window.departures
        };
        let _ = self.events.send(WindowEvent::Left {
            window_id: id.to_string(),
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
    id: String,
}

impl Drop for WindowConnection {
    fn drop(&mut self) {
        self.shared.disconnect(&self.id);
    }
}

/// An open `messages` watch of an editor window's `ide` client.
pub(crate) struct PersonWatch {
    shared: Arc<Shared>,
    id: String,
}

impl Drop for PersonWatch {
    fn drop(&mut self) {
        if let Some(window) = self.shared.windows.lock().unwrap().get_mut(&self.id) {
            window.watchers -= 1;
        }
    }
}

impl Windows {
    /// No windows yet. Rows go to `table`. Departures go to `events`.
    pub(crate) fn new(table: WindowTable, events: mpsc::UnboundedSender<WindowEvent>) -> Windows {
        Windows {
            shared: Arc::new(Shared {
                windows: Mutex::default(),
                changes: broadcast::channel(MAX_QUEUED_CHANGES).0,
                events,
                table,
            }),
            creations: Creations::default(),
        }
    }

    /// Restores the editor windows in `running` with no connections. Uses the saved descriptions,
    /// or each window's ID as its label if its description is missing. Other windows in `agents`
    /// keep their rows outside the list for a later window of their workspace to take over.
    /// Deletes rows for windows with no agents. Blocks on the table.
    pub(crate) fn restore(&self, running: &[String], agents: &[String]) {
        let kept = blocking_in_place(|| self.shared.table.windows()).unwrap_or_else(|err| {
            warn(&format!("{err:#}"));
            Vec::new()
        });
        let mut kept: HashMap<String, WindowDescription> = kept
            .into_iter()
            .map(|description| (description.id.clone(), description))
            .collect();
        {
            let mut windows = self.shared.windows.lock().unwrap();
            for id in running.iter().filter(|id| id.as_str() != TERMINAL_WINDOW) {
                windows.entry(id.clone()).or_insert_with(|| {
                    let description = kept.remove(id).unwrap_or_else(|| WindowDescription {
                        id: id.clone(),
                        label: id.clone(),
                        environment: "unknown".into(),
                        workspace: None,
                        folders: Vec::new(),
                        branch_prefix: None,
                        colors: None,
                        env: None,
                    });
                    Window::new(description)
                });
            }
        }
        for id in kept.keys().filter(|id| !agents.contains(id)) {
            if let Err(err) = blocking_in_place(|| self.shared.table.delete_window(id)) {
                warn(&format!("{err:#}"));
            }
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
            let mut windows = self.shared.windows.lock().unwrap();
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
            let window = windows
                .entry(id.clone())
                .or_insert_with(|| Window::new(description.clone()));
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
            id: id.to_string(),
        }
    }

    /// Says window `from` is gone, once its agents moved to the window that took them over.
    pub(crate) fn taken_over(&self, from: &str) {
        self.shared.publish(WindowsChange::Removed {
            window_id: from.to_string(),
        });
    }

    /// Reads window `id`'s locations again and publishes the window. `folders_before` is given
    /// after a new description: locations that only folders it dropped brought are then gone.
    /// Waits for Git; None where the window is not known.
    pub(crate) async fn read_locations(
        &self,
        id: &str,
        folders_before: Option<Vec<String>>,
    ) -> Option<LocationsRead> {
        let (folders, last) = {
            let windows = self.shared.windows.lock().unwrap();
            let window = windows.get(id)?;
            (window.description.folders.clone(), window.catalog.clone())
        };
        let catalog = locations::read(&folders, &last).await;
        let dropped = match folders_before {
            Some(_) => last.left_by(&folders),
            None => Vec::new(),
        };
        {
            let mut windows = self.shared.windows.lock().unwrap();
            let window = windows.get_mut(id)?;
            window.catalog = catalog.clone();
            window.read_at = Some(facade_base::time::iso_now());
            self.shared.updated(window);
        }
        Some(LocationsRead { catalog, dropped })
    }

    /// Removes window `id` from the list, unless it connected again since its `departure`-th
    /// leaving, and deletes its row, except where `has_agents`: agents' records are still under
    /// its ID, and the row keeps its `workspace`, so that a later window of it can take them over.
    /// Blocks on the table.
    pub(crate) fn remove(&self, id: &str, departure: u64, has_agents: bool) {
        {
            let mut windows = self.shared.windows.lock().unwrap();
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
            window_id: id.to_string(),
        });
    }

    /// Counts a `messages` watch of window `id`'s `ide` client while the guard lives.
    pub(crate) fn watch_person(&self, id: &str) -> PersonWatch {
        if let Some(window) = self.shared.windows.lock().unwrap().get_mut(id) {
            window.watchers += 1;
        }
        PersonWatch {
            shared: self.shared.clone(),
            id: id.to_string(),
        }
    }

    /// Whether window `id`'s `ide` client watches its messages, so that the window can tell the
    /// person.
    pub(crate) fn tells_person(&self, id: &str) -> bool {
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|window| window.watchers > 0)
    }

    /// The name of window `id`: the terminal window's, an editor window's own, or else its ID.
    pub(crate) fn label(&self, id: &str) -> String {
        if id == TERMINAL_WINDOW {
            return TERMINAL_WINDOW_LABEL.to_string();
        }
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)
            .map_or_else(|| id.to_string(), |window| window.description.label.clone())
    }

    /// Later window changes.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<WindowsChange> {
        self.shared.changes.subscribe()
    }

    /// The editor windows by ID, with their locations as last read and no CLIs.
    pub(crate) fn infos(&self) -> Vec<WindowInfo> {
        let mut infos: Vec<WindowInfo> = self
            .shared
            .windows
            .lock()
            .unwrap()
            .values()
            .map(Window::info)
            .collect();
        infos.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        infos
    }

    /// Where an agent of window `id` starts from `cwd`: in the terminal window, `cwd` as given; in
    /// an editor window that is connected, `cwd` with its links resolved, which must be a location
    /// of the window or a folder inside one, and still exist. Its location is the innermost one.
    pub(crate) fn check_destination(&self, id: &str, cwd: &str) -> Result<Destination, ErrorBody> {
        self.check_place(id, cwd, false)
    }

    /// As [`Self::check_destination`], where `cwd` must be a location itself.
    fn check_location(&self, id: &str, cwd: &str) -> Result<Destination, ErrorBody> {
        self.check_place(id, cwd, true)
    }

    fn check_place(&self, id: &str, cwd: &str, exact: bool) -> Result<Destination, ErrorBody> {
        if id == TERMINAL_WINDOW {
            return Ok(Destination {
                cwd: cwd.to_string(),
                location_id: location_id(cwd),
            });
        }
        let path = real_path(Path::new(cwd)).map_or_else(
            |_| cwd.to_string(),
            |path| path.to_string_lossy().into_owned(),
        );
        let windows = self.shared.windows.lock().unwrap();
        let window = windows
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
        if !Path::new(&path).is_dir() {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                format!("the folder {path} no longer exists"),
            ));
        }
        Ok(Destination {
            location_id: location.location_id.clone(),
            cwd: path,
        })
    }

    /// Window `id`'s Git branch prefix.
    pub(crate) fn branch_prefix(&self, id: &str) -> Option<String> {
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)?
            .description
            .branch_prefix
            .clone()
    }

    /// The terminal colors window `id` last described, kept only in memory.
    pub(crate) fn colors(&self, id: &str) -> Option<TerminalColors> {
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)?
            .description
            .colors
            .clone()
    }

    /// The environment window `id` last described, kept only in memory.
    pub(crate) fn env(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)?
            .description
            .env
            .clone()
    }

    /// Window `id`'s folders.
    pub(crate) fn folders(&self, id: &str) -> Vec<String> {
        self.shared
            .windows
            .lock()
            .unwrap()
            .get(id)
            .map(|window| window.description.folders.clone())
            .unwrap_or_default()
    }

    /// Makes a worktree in window `args.window_id` from the checkout at `args.cwd`, one of its
    /// locations. Answers the new location as the window now lists it, and, for an editor window,
    /// the read that listed it. Waits for Git and for other creations into the same folder.
    pub(crate) async fn create_worktree(
        &self,
        args: WorktreeCreateArgs,
    ) -> Result<(LocationInfo, Option<LocationsRead>), ErrorBody> {
        let source = self.check_location(&args.window_id, &args.cwd)?.cwd;
        let prefix = self.branch_prefix(&args.window_id);
        let made = locations::create(
            Path::new(&source),
            &args.worktree,
            prefix.as_deref(),
            &self.creations,
        )
        .await?;
        if args.window_id == TERMINAL_WINDOW {
            return Ok((made, None));
        }
        let read = self.read_locations(&args.window_id, None).await;
        let listed = read
            .as_ref()
            .and_then(|read| read.catalog.location(&made.path).cloned())
            .unwrap_or(made);
        Ok((listed, read))
    }
}
