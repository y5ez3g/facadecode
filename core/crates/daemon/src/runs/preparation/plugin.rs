//! Project plugins remain held by starts and listed runs. One lock serializes their changes;
//! the programs handle is consulted before taking that lock.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use facade_base::programs::Held;

/// Keeps a project's plugin until a start is registered or abandoned. Dropping it releases that
/// start and removes an unused plugin, with the plugin lock held during file changes.
pub(crate) struct PluginHold {
    plugins: Arc<Plugins>,
    project: PathBuf,
    /// The project has the files requested by this launch.
    pub(super) installed: bool,
}

#[derive(Default)]
struct Usage {
    starts: HashMap<PathBuf, usize>,
    runs: HashMap<String, PathBuf>,
    unrecorded: Vec<PathBuf>,
}

pub(super) struct Plugins {
    usage: Mutex<Usage>,
    held: Arc<Held>,
}

impl Drop for PluginHold {
    fn drop(&mut self) {
        let files = self.plugins.files();
        let mut usage = self.plugins.usage.lock().unwrap();
        if let Some(count) = usage.starts.get_mut(&self.project) {
            *count -= 1;
            if *count == 0 {
                usage.starts.remove(&self.project);
            }
        }
        self.plugins.clean(&usage, &self.project, &files);
    }
}

impl Plugins {
    pub(super) fn new(held: Arc<Held>) -> Arc<Self> {
        Arc::new(Self {
            usage: Mutex::default(),
            held,
        })
    }

    fn files(&self) -> Vec<(String, String)> {
        let program = self.held.facade_mcp();
        let facade = self.held.facade_launcher();
        let (program, facade) = (program.to_string_lossy(), facade.to_string_lossy());
        facade_rules::plugin_files(&program, &facade)
    }

    pub(super) fn note_unrecorded(&self, projects: Vec<PathBuf>) {
        self.usage.lock().unwrap().unrecorded.extend(projects);
    }

    pub(super) fn used(&self, id: &str, rule: Option<&str>, cwd: &Path) {
        if rule.is_some_and(facade_rules::uses_folder_plugin) {
            self.usage
                .lock()
                .unwrap()
                .runs
                .insert(id.to_owned(), cwd.to_owned());
        }
    }

    pub(super) fn released(&self, id: &str) {
        // Only a run that used the plugin lets go of it; the test gate stops just before that.
        if !self.usage.lock().unwrap().runs.contains_key(id) {
            return;
        }
        crate::gate_for_test("before-plugin-let-go");
        let files = self.files();
        let mut usage = self.usage.lock().unwrap();
        if let Some(cwd) = usage.runs.remove(id) {
            self.clean(&usage, &cwd, &files);
        }
    }

    pub(super) fn unused(&self, agents: Vec<(String, PathBuf)>) {
        let files = self.files();
        let mut usage = self.usage.lock().unwrap();
        let mut projects: BTreeSet<_> = agents
            .into_iter()
            .filter(|(rule, _)| facade_rules::uses_folder_plugin(rule))
            .map(|(_, cwd)| cwd)
            .collect();
        projects.extend(std::mem::take(&mut usage.unrecorded));
        for cwd in projects {
            self.clean(&usage, &cwd, &files);
        }
    }

    pub(super) fn hold(
        self: &Arc<Self>,
        project: &Path,
        files: &[(String, String)],
    ) -> Result<PluginHold, String> {
        let mut usage = self.usage.lock().unwrap();
        let folder = project.join(facade_rules::PLUGIN_FOLDER);
        let busy =
            usage.starts.contains_key(project) || usage.runs.values().any(|cwd| cwd == project);
        let replace = match inspect(&folder, files) {
            Plugin::Foreign(why) => {
                return Err(format!("{why}; Facade leaves the plugin as it is"));
            }
            Plugin::Matching => Some(false),
            Plugin::Earlier | Plugin::Edited if !busy => Some(true),
            _ => None,
        };
        if let Some(replace) = replace {
            put_files(&folder, files, replace)?;
            crate::pause_for_test("after-plugin-placed");
        }
        *usage.starts.entry(project.to_owned()).or_default() += 1;
        Ok(PluginHold {
            plugins: self.clone(),
            project: project.to_owned(),
            installed: replace.is_some(),
        })
    }

    fn clean(&self, usage: &Usage, cwd: &Path, files: &[(String, String)]) {
        if usage.starts.contains_key(cwd) || usage.runs.values().any(|at| at == cwd) {
            return;
        }
        let folder = cwd.join(facade_rules::PLUGIN_FOLDER);
        if !folder.exists() {
            return;
        }
        let left = match inspect(&folder, files) {
            Plugin::Matching | Plugin::Earlier => None,
            Plugin::Edited => Some(format!(
                "{} was changed since Facade wrote it; Facade leaves it as it is",
                folder.display()
            )),
            Plugin::Later => Some(format!(
                "{} is a later Facade's plugin, which Facade leaves to it",
                folder.display()
            )),
            Plugin::Foreign(why) => Some(format!("{why}; Facade leaves the plugin as it is")),
        };
        if let Some(message) = left {
            facade_base::log::write("daemon", "info", &message);
            return;
        }
        for name in facade_rules::PLUGIN_MEMBERS {
            if let Err(error) = std::fs::remove_file(folder.join(name))
                && error.kind() != std::io::ErrorKind::NotFound
            {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "could not remove Facade's plugin file {}: {error}",
                        folder.join(name).display()
                    ),
                );
                return;
            }
        }
        prune(&folder);
        for at in folder.ancestors().take(3) {
            if std::fs::remove_dir(at).is_err() {
                break;
            }
        }
    }
}

// An unknown file takes precedence over the manifest. Matching uses one template for the folder.
enum Plugin {
    Matching,
    Earlier,
    Edited,
    Later,
    Foreign(String),
}

fn inspect(folder: &Path, files: &[(String, String)]) -> Plugin {
    let scan = || -> std::io::Result<Result<bool, String>> {
        let mut pending = vec![(folder.to_path_buf(), String::new())];
        let mut matching = true;
        while let Some((at, prefix)) = pending.pop() {
            for item in std::fs::read_dir(at)? {
                let item = item?;
                let name = format!("{prefix}{}", item.file_name().to_string_lossy());
                let is_folder = item.file_type()?.is_dir();
                let known = if is_folder {
                    let prefix = format!("{name}/");
                    facade_rules::PLUGIN_MEMBERS
                        .iter()
                        .any(|member| member.starts_with(&prefix))
                } else {
                    facade_rules::PLUGIN_MEMBERS.contains(&name.as_str())
                };
                if !known {
                    return Ok(Err(format!(
                        "{} holds {name}, which Facade does not write there",
                        folder.display()
                    )));
                }
                if is_folder {
                    pending.push((item.path(), format!("{name}/")));
                } else {
                    let contents = std::fs::read(item.path()).ok();
                    matching &= files.iter().any(|(file, text)| {
                        file == &name && contents.as_deref() == Some(text.as_bytes())
                    });
                }
            }
        }
        Ok(Ok(matching))
    };
    match scan() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Plugin::Matching,
        Err(error) => {
            return Plugin::Foreign(format!("{} could not be read: {error}", folder.display()));
        }
        Ok(Err(why)) => return Plugin::Foreign(why),
        Ok(Ok(true)) => return Plugin::Matching,
        Ok(Ok(false)) => {}
    }
    let manifest = std::fs::read_to_string(folder.join("plugin.json")).ok();
    let version = manifest.as_deref().and_then(facade_rules::plugin_version);
    let own = files
        .iter()
        .find(|(name, _)| name == "plugin.json")
        .and_then(|(_, text)| facade_rules::plugin_version(text));
    match version.zip(own).map(|(found, own)| found.cmp(&own)) {
        Some(std::cmp::Ordering::Less) => Plugin::Earlier,
        Some(std::cmp::Ordering::Greater) => Plugin::Later,
        Some(std::cmp::Ordering::Equal) => Plugin::Edited,
        None => Plugin::Foreign(format!(
            "{} is not a plugin of Facade core's",
            folder.display()
        )),
    }
}

fn prune(folder: &Path) {
    let mut parents: Vec<_> = facade_rules::PLUGIN_MEMBERS
        .iter()
        .flat_map(|name| Path::new(name).ancestors().skip(1))
        .filter(|path| !path.as_os_str().is_empty())
        .collect();
    parents.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    parents.dedup();
    for parent in parents {
        let _ = std::fs::remove_dir(folder.join(parent));
    }
}

fn put_files(folder: &Path, files: &[(String, String)], replace: bool) -> Result<(), String> {
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("{} could not be made: {error}", folder.display()))?;
    for (name, text) in files {
        let at = folder.join(name);
        if !replace && at.exists() {
            continue;
        }
        let parent = at.parent().unwrap_or(folder);
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{} could not be made: {error}", parent.display()))?;
        std::fs::write(&at, text)
            .map_err(|error| format!("{} could not be written: {error}", at.display()))?;
    }
    for name in facade_rules::PLUGIN_MEMBERS {
        if !files.iter().any(|(given, _)| given == name) {
            let _ = std::fs::remove_file(folder.join(name));
        }
    }
    prune(folder);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::Preparation;
    use super::*;

    fn preparation(test: &str) -> (Preparation, crate::test_folder::TestFolder, PathBuf) {
        let home = crate::test_folder::TestFolder::new(&format!("plugin-{test}"));
        let cwd = home.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let source = home.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("facade"), "facade").unwrap();
        std::fs::write(source.join("facade-mcp"), "mcp").unwrap();
        let held = Arc::new(Held::open(&source.join("facade"), "test").unwrap());
        (
            Preparation::new(
                home.join("runs"),
                held,
                tokio::sync::mpsc::unbounded_channel().0,
            ),
            home,
            cwd,
        )
    }

    /// The plugin is written where it is missing, shared by the starts in a folder, and goes once
    /// the last of them lets go of it, with each folder above it that it leaves empty.
    #[tokio::test]
    async fn the_plugin_is_placed_shared_and_taken_away_with_the_folders_it_leaves_empty() {
        let (preparation, _home, cwd) = preparation("shared");
        let files = preparation.plugins.files();
        let plugin = cwd.join(facade_rules::PLUGIN_FOLDER);
        let first = preparation.plugins.hold(&cwd, &files).unwrap();
        for (name, text) in &files {
            assert_eq!(&std::fs::read_to_string(plugin.join(name)).unwrap(), text);
        }
        let second = preparation.plugins.hold(&cwd, &files).unwrap();
        drop(first);
        assert!(plugin.exists(), "a start still holds it");
        drop(second);
        assert!(
            !cwd.join(".agents").exists(),
            "the plugin goes, and so do the folders it made"
        );
        std::fs::create_dir_all(cwd.join(".agents/skills")).unwrap();
        std::fs::write(cwd.join(".agents/skills/mine.md"), "mine").unwrap();
        drop(preparation.plugins.hold(&cwd, &files).unwrap());
        assert!(
            !cwd.join(".agents/plugins").exists() && cwd.join(".agents/skills/mine.md").exists(),
            "a folder that holds anything else stays"
        );
        // The held programs close before their folder goes.
        drop(preparation);
    }

    /// A plugin that is not Facade core's - the person's own, or the Facade Code extension's - or
    /// that holds a file no Facade core plugin holds is never changed, before or after a run. One
    /// that holds part of what Facade writes, and nothing else, is completed; one changed since
    /// stays after its runs.
    #[tokio::test]
    async fn a_plugin_that_is_not_facade_core_s_is_left_as_it_is() {
        let (preparation, _home, cwd) = preparation("foreign");
        let files = preparation.plugins.files();
        let plugin = cwd.join(facade_rules::PLUGIN_FOLDER);
        std::fs::create_dir_all(&plugin).unwrap();
        let extension = "{ \"name\": \"facade\", \"description\": \"The Facade Code tools: start \
                         agents, send and read messages, and read or type into agent \
                         terminals.\" }";
        for theirs in ["{ \"name\": \"facade\" }", extension] {
            std::fs::write(plugin.join("plugin.json"), theirs).unwrap();
            let refused = preparation.plugins.hold(&cwd, &files).err().unwrap();
            assert!(
                refused.contains(
                    "is not a plugin of Facade core's; Facade leaves the plugin as it is"
                ),
                "{refused}"
            );
            assert_eq!(
                std::fs::read_to_string(plugin.join("plugin.json")).unwrap(),
                theirs,
                "never changed"
            );
        }
        std::fs::remove_file(plugin.join("plugin.json")).unwrap();
        std::fs::write(plugin.join("notes.txt"), "mine").unwrap();
        let refused = preparation.plugins.hold(&cwd, &files).err().unwrap();
        assert!(
            refused.contains("holds notes.txt, which Facade does not write there"),
            "{refused}"
        );
        assert_eq!(
            std::fs::read_dir(&plugin).unwrap().count(),
            1,
            "nothing written"
        );
        std::fs::remove_file(plugin.join("notes.txt")).unwrap();
        // A skill of someone else's beside where Facade's goes is theirs too.
        std::fs::create_dir_all(plugin.join("skills/mine")).unwrap();
        std::fs::write(plugin.join("skills/mine/SKILL.md"), "mine").unwrap();
        let refused = preparation.plugins.hold(&cwd, &files).err().unwrap();
        assert!(
            refused.contains("holds skills/mine, which Facade does not write there"),
            "{refused}"
        );
        assert!(
            !plugin.join(facade_rules::SKILL_FILE).exists(),
            "nothing written"
        );
        std::fs::remove_dir_all(plugin.join("skills")).unwrap();
        let (name, text) = &files[1];
        std::fs::write(plugin.join(name), text).unwrap();
        let held = preparation.plugins.hold(&cwd, &files).unwrap();
        assert_eq!(
            std::fs::read_dir(&plugin).unwrap().count(),
            files.len(),
            "the rest written"
        );
        std::fs::write(plugin.join(name), "changed").unwrap();
        drop(held);
        assert_eq!(
            std::fs::read_to_string(plugin.join(name)).unwrap(),
            "changed",
            "a plugin changed since stays"
        );
        // The held programs close before their folder goes.
        drop(preparation);
    }

    /// Facade core's plugin from an earlier version is brought up to date by a start and goes after
    /// its run, as this version's; one from a later version stands as it is, serves the run, and
    /// stays after it.
    #[tokio::test]
    async fn an_earlier_version_s_plugin_is_brought_up_to_date_and_a_later_one_s_stands() {
        let (preparation, _home, cwd) = preparation("versions");
        let files = preparation.plugins.files();
        let plugin = cwd.join(facade_rules::PLUGIN_FOLDER);
        let marked = |version: &str| {
            format!(
                "{{ \"name\": \"facade\", \"description\": \"Facade core {version}: an earlier \
                 text.\" }}\n"
            )
        };
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("plugin.json"), marked("0.1.0")).unwrap();
        std::fs::write(plugin.join("mcp_config.json"), "{ \"mcpServers\": {} }").unwrap();
        let held = preparation.plugins.hold(&cwd, &files).unwrap();
        for (name, text) in &files {
            assert_eq!(
                &std::fs::read_to_string(plugin.join(name)).unwrap(),
                text,
                "{name} brought up to date"
            );
        }
        drop(held);
        assert!(
            !cwd.join(".agents").exists(),
            "this version's plugin goes after its run"
        );
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("plugin.json"), marked("99.0.0")).unwrap();
        let held = preparation
            .plugins
            .hold(&cwd, &files)
            .expect("a later version's plugin serves the run");
        assert_eq!(
            std::fs::read_to_string(plugin.join("plugin.json")).unwrap(),
            marked("99.0.0"),
            "it stands"
        );
        assert_eq!(
            std::fs::read_dir(&plugin).unwrap().count(),
            1,
            "nothing added to it"
        );
        drop(held);
        assert_eq!(
            std::fs::read_to_string(plugin.join("plugin.json")).unwrap(),
            marked("99.0.0"),
            "and stays after the run"
        );
        // The held programs close before their folder goes.
        drop(preparation);
    }

    /// A running Antigravity agent keeps its plugin through a recorded reference. A start beside
    /// it leaves the plugin as the run has it, an earlier version's too,
    /// and that plugin goes once its last run ends.
    #[tokio::test]
    async fn a_running_antigravity_agent_keeps_its_folder_s_plugin() {
        let (preparation, _home, cwd) = preparation("used");
        let files = preparation.plugins.files();
        preparation.plugin_used("a1", Some("agy"), &cwd);
        drop(preparation.plugins.hold(&cwd, &files).unwrap());
        assert!(
            cwd.join(facade_rules::PLUGIN_FOLDER).exists(),
            "its agent runs"
        );
        // The plugin is an earlier version's, as where a newer Facade took over the run: a start
        // beside the run leaves it.
        let manifest = cwd.join(facade_rules::PLUGIN_FOLDER).join("plugin.json");
        let earlier =
            "{ \"name\": \"facade\", \"description\": \"Facade core 0.1.0: an earlier text.\" }\n";
        std::fs::write(&manifest, earlier).unwrap();
        drop(preparation.plugins.hold(&cwd, &files).unwrap());
        assert_eq!(
            std::fs::read_to_string(&manifest).unwrap(),
            earlier,
            "the run keeps the plugin it started with"
        );
        preparation.plugin_released("a1");
        assert!(
            !cwd.join(".agents").exists(),
            "no run uses it any more, and an earlier version's goes too"
        );
        // The held programs close before their folder goes.
        drop(preparation);
    }
}
