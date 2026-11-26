//! Private files for one run. Choosing a path never creates it, so a resume can prepare its
//! command line before retiring the previous run's files.

use std::collections::HashSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::projection::{self, Projection};

const PLUGIN_NOTE: &str = "plugin-folder";

/// The private file plan carried by a prepared run. Only preparation interprets it.
#[derive(Clone, Default)]
pub(crate) struct RunFiles {
    folder: Option<PathBuf>,
    session: Option<Option<String>>,
    contents: Vec<(String, String)>,
    config_links: Vec<(PathBuf, PathBuf)>,
    projection: Option<Projection>,
}

impl RunFiles {
    pub(super) fn new(runs: &Path, id: &str) -> Self {
        let name = format!("{:016x}", facade_base::random_u64());
        Self {
            folder: Some(runs.join(id).join(name)),
            ..Self::default()
        }
    }

    pub(super) fn path(&self) -> &Path {
        self.folder.as_deref().expect("a rule has a run folder")
    }

    pub(super) fn fill(
        &mut self,
        session: Option<Option<&str>>,
        contents: Vec<(String, String)>,
        config_links: Vec<(PathBuf, PathBuf)>,
    ) {
        self.session = session.map(|value| value.map(str::to_owned));
        self.contents = contents;
        self.config_links = config_links;
    }

    pub(super) fn project(&mut self, projection: Projection) {
        self.projection = Some(projection);
    }

    pub(super) fn note_plugin(&self, project: &Path) -> anyhow::Result<()> {
        private_folder(self.path())?;
        let mut note = facade_base::files::create_private_file(&self.path().join(PLUGIN_NOTE))?;
        writeln!(note, "{}", project.display())?;
        Ok(())
    }

    pub(super) fn create(&self) -> anyhow::Result<()> {
        let Some(at) = &self.folder else {
            return Ok(());
        };
        private_folder(at)?;
        if let Some(session) = &self.session {
            let path = session_file(at);
            let reported = session.as_deref().map(facade_rules::Reported::saved);
            match facade_rules::write_session_file(&path, reported.as_ref()) {
                Ok(()) => {}
                Err(facade_rules::WriteFailure::NotWritten(error)) => {
                    anyhow::bail!("could not write {}: {error}", path.display());
                }
                Err(failure) => facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!("{}: {failure}", path.display()),
                ),
            }
        }
        for (name, text) in &self.contents {
            let path = at.join(name);
            let write = || -> io::Result<()> {
                if let Some(parent) = path.parent().filter(|parent| *parent != at) {
                    private_folder(parent)?;
                }
                let mut file = facade_base::files::private_options()
                    .write(true)
                    .create_new(true)
                    .open(&path)?;
                file.write_all(text.as_bytes())
            };
            write()
                .map_err(|error| anyhow::anyhow!("could not write {}: {error}", path.display()))?;
        }
        for (relative, original) in &self.config_links {
            let alias = at.join(relative);
            let parent = alias
                .parent()
                .expect("a run configuration alias has a parent");
            private_folder(parent)?;
            facade_base::files::link_config_entry(original, &alias).map_err(|error| {
                anyhow::anyhow!(
                    "could not link configuration entry {}: {error}",
                    original.display()
                )
            })?;
        }
        if let Some(projection) = &self.projection {
            projection.create(at)?;
        }
        Ok(())
    }
}

pub(super) fn retire_projection(run: &Path) {
    if let Err(error) = projection::retire(run) {
        facade_base::log::write(
            "daemon",
            "warn",
            &format!(
                "could not retire the workspace file of {}: {error}",
                run.display()
            ),
        );
    }
}

fn private_folder(path: &Path) -> io::Result<()> {
    facade_base::files::create_private_folder_all(path)
}

pub(super) fn session_file(folder: &Path) -> PathBuf {
    folder.join(facade_rules::SESSION_FILE)
}

pub(super) fn find(runs: &Path, id: &str) -> Option<PathBuf> {
    facade_rules::run_folder(runs, id)
}

pub(super) fn remove(runs: &Path, id: &str) -> io::Result<()> {
    let folder = runs.join(id);
    if let Ok(children) = std::fs::read_dir(&folder) {
        for child in children
            .flatten()
            .filter(|child| child.file_type().is_ok_and(|kind| kind.is_dir()))
        {
            retire_projection(&child.path());
        }
    }
    if let Err(error) = std::fs::remove_dir_all(folder)
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    Ok(())
}

pub(super) fn discard_unrecorded(
    runs: &Path,
    kept: &HashSet<String>,
) -> anyhow::Result<Vec<PathBuf>> {
    let mut projects = Vec::new();
    let entries = match std::fs::read_dir(runs) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(projects),
        entries => entries?,
    };
    for entry in entries {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if kept.contains(&id) {
            continue;
        }
        facade_base::log::write(
            "daemon",
            "info",
            &format!("deleting the run folders of {id}: it has no agent record"),
        );
        if let Ok(children) = std::fs::read_dir(entry.path()) {
            for child in children.flatten() {
                if let Ok(note) = std::fs::read_to_string(child.path().join(PLUGIN_NOTE)) {
                    let project = PathBuf::from(note.trim_end_matches('\n'));
                    if project.is_absolute() {
                        projects.push(project);
                    }
                }
            }
        }
        remove(runs, &id)?;
    }
    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The run folders of agents without records go, and give back the projects their starts noted
    /// for Facade's plugin; those of agents with records stay.
    #[test]
    fn a_run_without_a_record_gives_back_the_project_its_plugin_is_in() {
        let runs = crate::test_folder::TestFolder::new("runs-noted");
        let (gone, kept, mut plain) = (
            RunFiles::new(&runs, "a1"),
            RunFiles::new(&runs, "a2"),
            RunFiles::new(&runs, "a1"),
        );
        let (probe, kept_project) = (runs.join("probe"), runs.join("kept"));
        gone.note_plugin(&probe).unwrap();
        kept.note_plugin(&kept_project).unwrap();
        plain.fill(None, vec![], vec![]);
        plain.create().unwrap();
        let projects = discard_unrecorded(&runs, &HashSet::from(["a2".to_string()])).unwrap();
        assert_eq!(projects, [probe]);
        assert!(
            !runs.join("a1").exists(),
            "the folders of an agent without a record go"
        );
        assert!(
            kept.path().join(PLUGIN_NOTE).exists(),
            "those of an agent with a record stay"
        );
    }

    #[test]
    fn a_run_s_folder_is_new_and_private_and_only_one_counts() {
        let runs = crate::test_folder::TestFolder::new("runs");
        let (mut first, mut second) = (RunFiles::new(&runs, "a1"), RunFiles::new(&runs, "a1"));
        assert_ne!(
            first.folder, second.folder,
            "every run gets a folder of its own"
        );
        let files = [
            ("mcp.json".into(), "{}".into()),
            ("plugin/index.mjs".into(), "export {}".into()),
        ];
        first.fill(
            Some(Some("86da4482-2bae-4a45-b193-a5664c19826a")),
            files.to_vec(),
            vec![],
        );
        first.create().unwrap();
        assert_eq!(find(&runs, "a1"), Some(first.path().to_owned()));
        assert!(session_file(first.path()).exists());
        for folder in [first.path(), &first.path().join("plugin")] {
            assert!(
                facade_base::files::is_private(folder).unwrap(),
                "{}",
                folder.display()
            );
        }
        for file in [
            session_file(first.path()),
            first.path().join("mcp.json"),
            first.path().join("plugin/index.mjs"),
        ] {
            assert!(
                facade_base::files::is_private(&file).unwrap(),
                "{}",
                file.display()
            );
        }
        second.fill(None, vec![], vec![]);
        second.create().unwrap();
        assert!(
            !session_file(second.path()).exists(),
            "a run whose CLI reports no session has no session file"
        );
        assert_eq!(find(&runs, "a1"), None, "two folders prove no single run");
        remove(&runs, "a1").unwrap();
        remove(&runs, "a1").unwrap();
        assert!(!runs.join("a1").exists());
        std::fs::remove_dir_all(&runs).unwrap();
    }
}
