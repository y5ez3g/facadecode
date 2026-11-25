//! What CLIs keep on disk and read at their start, as their own sources write and read it: the test
//! CLI stands in for a CLI with these, and scenarios save native sessions with them.

use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};
use serde_json::{Value, json};

/// The Facade plugin in the folder Oh My Pi's run names with `--plugin-dir`.
const OMP_PLUGIN: &str = "omp-facade";
/// The session-reporting extension Oh My Pi's run names with `--extension`.
const OMP_EXTENSION: &str = "facade-omp.mjs";

/// A CLI the test CLI stands in for, reading what its run was given as that CLI does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Native {
    Devin,
    Cursor,
    Kiro,
    Qoder,
    Omp,
}

/// How a run has its CLI report its session.
pub enum Reporter {
    /// Commands of its session-start hooks, for a shell.
    Shell(Vec<String>),
    /// Programs of its session-start hooks, each with its arguments.
    Programs(Vec<Vec<String>>),
    /// The file the run's extension writes.
    File(PathBuf),
}

impl Native {
    pub fn of(cli: &str) -> Option<Native> {
        Some(match cli {
            "devin" => Native::Devin,
            "agent" => Native::Cursor,
            "kiro-cli" => Native::Kiro,
            "qoder" => Native::Qoder,
            "omp" => Native::Omp,
            _ => return None,
        })
    }

    /// The option that resumes the session named after it.
    pub fn resume_option(self) -> &'static str {
        match self {
            Native::Devin | Native::Cursor | Native::Qoder => "--resume",
            Native::Kiro => "--resume-id",
            Native::Omp => "--session",
        }
    }

    /// The Facade server this run's configuration gives the CLI, as `mcpServers.facade`: from the
    /// plugin, settings file or agent the CLI's arguments name, and from nowhere else.
    pub fn mcp_settings(
        self,
        arguments: &[String],
        home: &Path,
        user: &Path,
        cwd: &Path,
        devin_config_root: Option<&Path>,
    ) -> anyhow::Result<Option<Value>> {
        let given = |option: &str| option_value(arguments, option).map(Path::new);
        let settings = match self {
            Native::Omp => {
                let Some(plugin) = given("--plugin-dir") else {
                    return Ok(None);
                };
                let plugin = in_run_folder(plugin, home)?;
                ensure!(
                    plugin.file_name().is_some_and(|name| name == OMP_PLUGIN),
                    "{} is not Facade's plugin",
                    plugin.display()
                );
                let manifest = json_file(&plugin.join(".claude-plugin/plugin.json"))?;
                ensure!(
                    manifest["name"].is_string() && manifest.get("mcpServers").is_none(),
                    "the manifest names the plugin and leaves its servers to .mcp.json: {manifest}"
                );
                json_file(&plugin.join(".mcp.json"))?
            }
            Native::Cursor => {
                let Some(plugin) = given("--plugin-dir") else {
                    return Ok(None);
                };
                let plugin = in_run_folder(plugin, home)?;
                let manifest = json_file(&plugin.join(".cursor-plugin/plugin.json"))?;
                // Without a path, Cursor reads mcp.json.
                let file = manifest["mcpServers"].as_str().unwrap_or("mcp.json");
                json_file(&plugin.join(file))?
            }
            Native::Devin => {
                let Some(config_root) = devin_config_root else {
                    return Ok(None);
                };
                let file = config_root.join("devin/mcp_config.json");
                json_file(&in_run_folder(&file, home)?)?
            }
            Native::Qoder => {
                let Some(file) = given("--mcp-config") else {
                    return Ok(None);
                };
                json_file(&in_run_folder(file, home)?)?
            }
            Native::Kiro => {
                let Some(agent) = kiro_agent(arguments, user, cwd)? else {
                    return Ok(None);
                };
                let name = agent["name"].as_str().context("the agent's name")?;
                json!({ "mcpServers": { "facade": agent["mcpServers"][name] } })
            }
        };
        Ok(Some(settings))
    }

    /// What reports the run's session, from the same configuration.
    pub fn reporter(
        self,
        arguments: &[String],
        home: &Path,
        user: &Path,
        cwd: &Path,
    ) -> anyhow::Result<Option<Reporter>> {
        let given = |option: &str| option_value(arguments, option).map(Path::new);
        Ok(match self {
            Native::Omp => omp_report_file(arguments, home)?.map(Reporter::File),
            Native::Devin => match given("--config") {
                Some(file) => {
                    let settings = json_file(&in_run_folder(file, home)?)?;
                    Some(Reporter::Shell(
                        grouped_hooks(&settings["hooks"]["SessionStart"])
                            .filter_map(|hook| Some(hook["command"].as_str()?.to_string()))
                            .collect(),
                    ))
                }
                None => None,
            },
            Native::Qoder => match given("--settings") {
                Some(file) => {
                    let settings = json_file(&in_run_folder(file, home)?)?;
                    let mut programs = Vec::new();
                    for hook in grouped_hooks(&settings["hooks"]["SessionStart"]) {
                        let mut words: Vec<String> = serde_json::from_value(hook["args"].clone())
                            .context("the hook's arguments")?;
                        words.insert(0, hook["command"].as_str().context("a command")?.into());
                        programs.push(words);
                    }
                    Some(Reporter::Programs(programs))
                }
                None => None,
            },
            Native::Cursor => match given("--plugin-dir") {
                Some(plugin) => {
                    let plugin = in_run_folder(plugin, home)?;
                    let hooks = json_file(&plugin.join("hooks/hooks.json"))?;
                    Some(Reporter::Shell(
                        hooks["hooks"]["sessionStart"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|hook| Some(hook["command"].as_str()?.to_string()))
                            .collect(),
                    ))
                }
                None => None,
            },
            Native::Kiro => kiro_agent(arguments, user, cwd)?.map(|agent| {
                Reporter::Shell(
                    agent["hooks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|hook| hook["trigger"] == "SessionStart")
                        .filter_map(|hook| Some(hook["action"]["command"].as_str()?.to_string()))
                        .collect(),
                )
            }),
        })
    }

    /// What the CLI gives its session-start hooks on their input, or None where it runs none:
    /// Cursor runs its hook as a conversation is created, not as one is resumed.
    pub fn hook_input(
        self,
        id: &str,
        source: &str,
        cwd: &Path,
        transcript: Option<&Path>,
    ) -> Option<Value> {
        Some(match self {
            Native::Devin | Native::Kiro => json!({
                "hook_event_name": "SessionStart", "session_id": id, "source": source,
            }),
            Native::Qoder => json!({
                "hook_event_name": "SessionStart", "session_id": id, "source": source,
                "transcript_path": transcript?, "cwd": cwd, "model": "Auto",
            }),
            Native::Cursor if source == "resume" => return None,
            Native::Cursor => json!({
                "hook_event_name": "sessionStart", "conversation_id": id, "session_id": id,
                "generation_id": "", "model": "auto", "cursor_version": "2026.10.22",
                "workspace_roots": [cwd], "is_background_agent": false, "composer_mode": "agent",
            }),
            Native::Omp => return None,
        })
    }

    /// The file the CLI saves session `id` in, where it names it as it reports it.
    pub fn names_its_file(self) -> bool {
        matches!(self, Native::Qoder | Native::Omp)
    }

    /// What the CLI adds to that file for a message and its answer, where it is new or not.
    pub fn saved(self, id: &str, text: &str, cwd: &Path, new: bool) -> String {
        let at = "2026-11-23T00:00:00.000Z";
        match self {
            Native::Qoder => {
                qoder_record(id, "user", text, cwd) + &qoder_record(id, "assistant", "ok", cwd)
            }
            _ => {
                let head = match new {
                    true => omp_session_head(id, cwd, "", at),
                    false => String::new(),
                };
                let (user, answer) = (
                    omp_message(1, "user", text, at),
                    omp_message(2, "assistant", "ok", at),
                );
                format!("{head}{user}{answer}")
            }
        }
    }

    /// The placeholder the CLI shows for paste `number` of `text`, where it shows one. Oh My Pi's,
    /// Qoder's and Cursor's sizes are their sources'. Kiro's are the test's own choice, so that both
    /// a paste shown whole and a placeholder are tried.
    pub fn placeholder(self, number: usize, text: &str) -> Option<String> {
        let lines = text.split('\n').count();
        // JavaScript's length: UTF-16 code units.
        let length = text.encode_utf16().count();
        match self {
            Native::Omp if lines > 10 => Some(format!("[Paste #{number}, +{lines} lines]")),
            Native::Omp if length > 1000 => Some(format!("[Paste #{number}, {length} chars]")),
            Native::Qoder if lines > 5 => Some(format!("[Pasted Text: {lines} lines]")),
            Native::Qoder if length > 500 => Some(format!("[Pasted Text: {length} chars]")),
            Native::Cursor if length > 800 => {
                Some(format!("[Pasted text #{number} +{lines} lines]"))
            }
            Native::Kiro if lines > 5 => Some(format!("[paste #{number} +{lines} lines]")),
            Native::Kiro if length > 500 => Some(format!("[paste #{number} {length} chars]")),
            _ => None,
        }
    }

    /// What stands before the first row of the input; its other rows start under its text.
    pub fn prompt(self, yolo: bool) -> &'static str {
        match self {
            Native::Devin => "❭ ",
            Native::Cursor => "→ ",
            Native::Kiro => "› ",
            Native::Qoder if yolo => " * ",
            Native::Qoder => " > ",
            Native::Omp => " ",
        }
    }

    /// Whether the input stands between two rules.
    pub fn has_rules(self) -> bool {
        matches!(self, Native::Devin | Native::Qoder | Native::Omp)
    }

    /// The dim words an empty input shows.
    pub fn empty_words(self) -> &'static str {
        match self {
            Native::Cursor => "Plan, search, build anything",
            Native::Devin => "Ask Devin to build features, fix bugs, or work on your code",
            Native::Kiro => "ask a question or describe a task ↵",
            Native::Qoder => "Type your message or @path/to/file",
            _ => "",
        }
    }
}

fn json_file(file: &Path) -> anyhow::Result<Value> {
    let text =
        std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} is not JSON", file.display()))
}

/// The hooks of each group of an event.
fn grouped_hooks(event: &Value) -> impl Iterator<Item = &Value> {
    event
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
        .filter(|hook| hook["type"] == "command")
}

/// The agent of Kiro's session, from the files of the workspace's `.kiro/agents`: the one `--agent`
/// names, or for a session resumed the one it was saved with, whatever `--agent` says.
pub fn kiro_agent(arguments: &[String], user: &Path, cwd: &Path) -> anyhow::Result<Option<Value>> {
    let name = match option_value(arguments, "--resume-id") {
        Some(id) => {
            let session = json_file(&kiro_session(user, id).join("session.json"))?;
            session["agentMode"].as_str().map(str::to_string)
        }
        None => option_value(arguments, "--agent").map(str::to_string),
    };
    let Some(name) = name else { return Ok(None) };
    let mut found = Vec::new();
    for entry in std::fs::read_dir(cwd.join(".kiro/agents"))? {
        let agent = json_file(&entry?.path())?;
        if agent["name"] == name {
            found.push(agent);
        }
    }
    ensure!(found.len() == 1, "{} agents are named {name}", found.len());
    Ok(found.pop())
}

/// The folder of Kiro's session `id` in the home `user`.
pub fn kiro_session(user: &Path, id: &str) -> PathBuf {
    user.join(".kiro/sessions/0123456789abcdef").join(id)
}

/// The native chat folder of Cursor's session `id`.
pub fn cursor_session(user: &Path, id: &str) -> PathBuf {
    user.join(".config/cursor/chats/0123456789abcdef0123456789abcdef")
        .join(id)
}

/// Writes Cursor's startup metadata or the record of a saved conversation.
pub fn save_cursor_session(
    user: &Path,
    id: &str,
    cwd: &Path,
    title: Option<&str>,
    has_conversation: bool,
) {
    let folder = cursor_session(user, id);
    let metadata = folder.join("meta.json");
    let store = folder.join("store.db");
    if metadata.is_file() && (!has_conversation || title.is_none() && store.is_file()) {
        return;
    }
    let mut meta = json!({
        "cwd": cwd, "hasConversation": has_conversation,
        "createdAtMs": 1795392000000u64, "updatedAtMs": 1795392000000u64,
    });
    if let Some(title) = title {
        meta["title"] = json!(title);
    }
    std::fs::create_dir_all(&folder).expect("the chat folder");
    if has_conversation && !store.is_file() {
        std::fs::File::create(store).expect("the chat store");
    }
    std::fs::write(metadata, meta.to_string()).expect("the chat metadata");
}

/// Saves Kiro's session `id` of `cwd`, named `title` and started with `agent`, if it is not there.
pub fn save_kiro_session(user: &Path, id: &str, cwd: &Path, title: &str, agent: Option<&str>) {
    let folder = kiro_session(user, id);
    if folder.is_dir() {
        return;
    }
    let at = "2026-11-23T00:00:00.000Z";
    let mut session = json!({
        "id": id, "workspacePaths": [cwd], "title": title, "createdAt": at, "lastModifiedAt": at,
    });
    if let Some(agent) = agent {
        session["agentMode"] = json!(agent);
    }
    std::fs::create_dir_all(&folder).expect("the session's folder");
    std::fs::write(folder.join("session.json"), session.to_string()).expect("the session");
    std::fs::write(folder.join("messages.jsonl"), "{}\n").expect("its messages");
}

/// A record of a Qoder transcript.
pub fn qoder_record(id: &str, role: &str, text: &str, cwd: &Path) -> String {
    let record = json!({
        "type": role, "sessionId": id, "cwd": cwd, "timestamp": "2026-11-23T00:00:00.000Z",
        "isSidechain": false,
        "message": { "role": role, "content": [{ "type": "text", "text": text }] },
    });
    format!("{record}\n")
}

/// The value after the last `option` in `arguments`.
pub fn option_value<'a>(arguments: &'a [String], option: &str) -> Option<&'a str> {
    let at = arguments.iter().rposition(|word| word == option)?;
    arguments.get(at + 1).map(String::as_str)
}

/// `path`, which a run was given, once it is known to lie in a run folder of the Facade home `home`.
pub fn in_run_folder(path: &Path, home: &Path) -> anyhow::Result<PathBuf> {
    let real = path
        .canonicalize()
        .with_context(|| format!("the run names {}, which is not there", path.display()))?;
    ensure!(
        real.starts_with(home.join("framework/runs").canonicalize()?),
        "{} lies outside the run folders",
        path.display()
    );
    Ok(real)
}

/// The session file Oh My Pi's extension in `arguments` reports to: the constant its first line
/// holds. The test CLI runs no JavaScript; it writes there what the extension writes.
pub fn omp_report_file(arguments: &[String], home: &Path) -> anyhow::Result<Option<PathBuf>> {
    let Some(extension) = option_value(arguments, "--extension") else {
        return Ok(None);
    };
    let extension = in_run_folder(Path::new(extension), home)?;
    ensure!(
        extension
            .file_name()
            .is_some_and(|name| name == OMP_EXTENSION),
        "{} is not Facade's extension",
        extension.display()
    );
    let source = std::fs::read_to_string(&extension)?;
    let file = source
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("const reportFile = ")?.strip_suffix(';'))
        .context("the extension's first line names no report file")?;
    let file: PathBuf = serde_json::from_str(file).context("the extension's report file")?;
    in_run_folder(file.parent().context("the report file's folder")?, home)?;
    Ok(Some(file))
}

/// The head of an Oh My Pi session file: the 256-byte line that holds the session's name, then the
/// header.
pub fn omp_session_head(id: &str, cwd: &Path, name: &str, at: &str) -> String {
    let slot = |pad: &str| {
        let slot = json!({ "type": "title", "v": 1, "title": name, "updatedAt": at, "pad": pad });
        format!("{slot}\n")
    };
    let room = 256 - slot("").len();
    let header = json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": cwd });
    format!("{}{header}\n", slot(&" ".repeat(room)))
}

/// The head of an Oh My Pi session file from before its name had a line of its own.
pub fn omp_legacy_session_head(id: &str, cwd: &Path, name: &str, at: &str) -> String {
    let header = json!({
        "type": "session", "version": 3, "id": id, "title": name, "timestamp": at, "cwd": cwd,
    });
    format!("{header}\n")
}

/// An Oh My Pi session entry of a message by `role`.
pub fn omp_message(entry: u32, role: &str, text: &str, at: &str) -> String {
    let parent = (entry > 1).then(|| format!("{:08x}", entry - 1));
    let message = json!({
        "type": "message", "id": format!("{entry:08x}"), "parentId": parent, "timestamp": at,
        "message": { "role": role, "content": [{ "type": "text", "text": text }] },
    });
    format!("{message}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oh My Pi overwrites the name in place, so its line always takes the same bytes.
    #[test]
    fn an_omp_session_s_name_line_takes_256_bytes_whatever_it_holds() {
        for name in ["", "fix the build", "修复 👩‍💻 构建"] {
            let head = omp_session_head("id", Path::new("/p"), name, "2026-11-23T00:00:00.000Z");
            assert_eq!(head.find('\n'), Some(255), "{head}");
        }
    }
}
