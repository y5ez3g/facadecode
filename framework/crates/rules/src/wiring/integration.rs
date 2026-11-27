//! What `facade integration add` writes into a CLI's user configuration, so that the sessions the
//! person starts join Facade Code Framework as guests, and what `facade integration remove` takes out: Facade Code Framework's
//! MCP server, the approval of its own tools, and the hooks, plugin or extension that report a
//! session's start, turns and end. Nothing else of the person's configuration changes. Facade Code Framework
//! knows its entries by their shape, of any Facade home, program path or version, so adding again
//! brings them up to date in their place. The server entries are built as a run's are.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::servers::{
    Entry, SERVER, agy_entry, claude_entry, codex_entry, is_server_program, muse_guest_entry,
    opencode_allow, opencode_entry, pi_entry,
};
use crate::formats::{HookArg, encoded_powershell_words, facade_hook, parse_jsonc, shell_words};
use facade_base::programs::program_name;
use facade_base::system::{env_var, home_folder_in};

/// The CLIs Facade Code Framework integrates.
pub const CLIS: [&str; 6] = ["claude", "codex", "opencode", "pi", "muse", "agy"];

/// How every file Facade Code Framework writes whole begins, which tells it from the person's own.
const MARKER: &str = "// Facade Code: written by `facade integration add`; `facade integration \
                      remove` takes it out.";

/// Claude Code's hooks, each as `facade hook` names it and as Claude Code names its event: a
/// session's start, a turn's start and end, a session's end, and `idle` for a turn that ends
/// without a `Stop`: `StopFailure`, a turn that ended in an error, and `Notification` for
/// `idle_prompt`, which Claude Code sends once its input has waited a while after a turn. A turn the
/// person cuts short runs no hook: its prompt hook names the session's file, whose status says it.
const CLAUDE_HOOK_EVENTS: [(&str, &str); 6] = [
    ("session-start", "SessionStart"),
    ("prompt", "UserPromptSubmit"),
    ("turn-end", "Stop"),
    ("idle", "StopFailure"),
    ("idle", "Notification"),
    ("session-end", "SessionEnd"),
];
/// Codex's hooks: a session's start and end, a turn's start and end, and `Interrupt`, a turn the
/// person cut short.
const CODEX_HOOK_EVENTS: [(&str, &str); 5] = [
    ("session-start", "SessionStart"),
    ("prompt", "UserPromptSubmit"),
    ("turn-end", "Stop"),
    ("idle", "Interrupt"),
    ("session-end", "SessionEnd"),
];
/// Muse Code's hooks: Codex's, and `PermissionRequest`, which approves Facade Code Framework's own tools, as Muse
/// Code has no rule for one server's tools.
const MUSE_HOOK_EVENTS: [(&str, &str); 6] = [
    ("session-start", "SessionStart"),
    ("prompt", "UserPromptSubmit"),
    ("turn-end", "Stop"),
    ("idle", "Interrupt"),
    ("session-end", "SessionEnd"),
    ("approve", "PermissionRequest"),
];
/// Antigravity's hooks, a hook set named `facade` in its `hooks.json`. It has no event for a
/// session's end: its `agy` process ending is the end.
const AGY_HOOK_EVENTS: [(&str, &str); 3] = [
    ("session-start", "SessionStart"),
    ("prompt", "PreInvocation"),
    ("turn-end", "Stop"),
];
/// The header of Facade Code Framework's server table in Codex's `config.toml`.
const CODEX_TABLE: &str = "[mcp_servers.facade]";
/// Claude Code's approval of Facade Code Framework's tools.
const CLAUDE_ALLOW: &str = "mcp__facade";
/// The rule in Antigravity's `permissions.allow` that approves every tool of Facade Code Framework's server.
const AGY_ALLOW: &str = "mcp(facade/*)";

/// What Facade Code Framework's entries name: its programs and the Facade home, from which the server finds the
/// daemon's socket.
#[derive(Clone, Copy, Debug)]
pub struct Programs<'a> {
    /// The path of `facade`, which every hook runs.
    pub facade: &'a str,
    /// The path of `facade-mcp`, Facade Code Framework's MCP server.
    pub mcp: &'a str,
    /// A Facade home other than `~/.facade`; None for that one.
    pub home: Option<&'a str>,
}

impl Programs<'_> {
    /// The server of `cli`'s sessions, `--guest <cli>`, as `build` writes it for the CLI.
    fn guest_server<R>(&self, cli: &str, build: impl FnOnce(&Entry) -> R) -> R {
        let args = vec!["--guest".into(), cli.into()];
        let env: Vec<(String, String)> = self
            .home
            .iter()
            .map(|home| ("FACADE_HOME".to_string(), home.to_string()))
            .collect();
        build(&Entry {
            program: self.mcp,
            args,
            env: &env,
        })
    }
}

/// Which of a CLI's files an integration file is, and so what Facade Code Framework writes in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Claude Code's `settings.json`, with Facade Code Framework's hooks and the rule that approves its tools.
    /// `claude mcp add` adds the server.
    ClaudeSettings,
    /// Codex's `config.toml`, with Facade Code Framework's server table, whose tools need no approval.
    CodexConfig,
    /// Codex's `hooks.json`, with Facade Code Framework's hooks.
    CodexHooks,
    /// OpenCode's `opencode.json`, with Facade Code Framework's server and a permission for its tools.
    OpencodeConfig,
    /// The plugin Facade Code Framework writes for OpenCode, alone in its folder: it reports each session as it
    /// starts, works and ends, and prompts it with its messages.
    OpencodePlugin,
    /// The extension Facade Code Framework writes for Pi: it registers the server for each session, reports the
    /// session, and hands it its messages.
    PiExtension,
    /// Muse Code's `settings.json`, with Facade Code Framework's server and hooks; one of the hooks approves
    /// Facade Code Framework's tools.
    MuseSettings,
    /// Antigravity's `mcp_config.json`, with Facade Code Framework's server.
    AgyServers,
    /// Antigravity's `hooks.json`, with Facade Code Framework's hook set.
    AgyHooks,
    /// Antigravity's `settings.json`, with the rule that approves Facade Code Framework's tools.
    AgySettings,
}

impl Kind {
    /// Whether the file has a folder to itself, removed along with it.
    pub fn in_own_folder(self) -> bool {
        matches!(self, Kind::OpencodePlugin)
    }
}

/// One file a CLI's integration is written in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub file: PathBuf,
    pub kind: Kind,
}

/// One entry of Facade Code Framework's in a file: the place the CLI's configuration knows it by, and its value.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub place: String,
    pub content: Value,
}

/// How a file stands with Facade Code Framework's entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    /// It holds them exactly as `facade integration add` would write them today.
    AsWritten,
    /// It holds some, but not as they would be written today: edited, written by another Facade Code Framework,
    /// or in a file its CLI cannot read.
    Changed,
    /// It holds none.
    Missing,
}

/// The variable `name` of `env` as a path, where it is set and not empty.
fn path_variable(env: &BTreeMap<String, String>, name: &str) -> Option<PathBuf> {
    env_var(env, name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The file in which `cli` keeps the state of the session of its process `pid`, which tells of a
/// turn that ended with no hook run, such as one the person interrupted. Only Claude Code has one:
/// `sessions/<pid>.json` in `CLAUDE_CONFIG_DIR`, or in `~/.claude`, by `env`, the environment its
/// hooks run with. The other CLIs run a hook at the end of every turn.
pub fn session_status_file(cli: &str, env: &BTreeMap<String, String>, pid: u32) -> Option<PathBuf> {
    if cli != "claude" {
        return None;
    }
    let folder = path_variable(env, "CLAUDE_CONFIG_DIR")
        .or_else(|| Some(home_folder_in(env)?.join(".claude")))?;
    Some(folder.join("sessions").join(format!("{pid}.json")))
}

/// The program whose own command adds Facade Code Framework's server for `cli`, where Facade Code Framework does not write it
/// itself: `claude`, for Claude Code's `claude mcp add`.
pub fn command_program(cli: &str) -> Option<&'static str> {
    (cli == "claude").then_some("claude")
}

/// The files `cli`'s integration is written in, for the person whose environment is `env`: where
/// the CLI keeps its user configuration, as its own variables say, under the home folder
/// otherwise. An error for a CLI Facade Code Framework does not integrate, or without a home folder to look in.
pub fn targets(cli: &str, env: &BTreeMap<String, String>) -> Result<Vec<Target>, String> {
    let home = || {
        home_folder_in(env).ok_or_else(|| {
            "HOME (USERPROFILE on Windows) is not set, so Facade Code Framework cannot find the CLI's configuration".to_string()
        })
    };
    let named_or_home = |name: &str, in_home: &str| -> Result<PathBuf, String> {
        match path_variable(env, name) {
            Some(folder) => Ok(folder),
            None => Ok(home()?.join(in_home)),
        }
    };
    let files: Vec<(PathBuf, Kind)> = match cli {
        "claude" => {
            vec![(
                named_or_home("CLAUDE_CONFIG_DIR", ".claude")?.join("settings.json"),
                Kind::ClaudeSettings,
            )]
        }
        "codex" => {
            let folder = named_or_home("CODEX_HOME", ".codex")?;
            vec![
                (folder.join("config.toml"), Kind::CodexConfig),
                (folder.join("hooks.json"), Kind::CodexHooks),
            ]
        }
        "opencode" => {
            let folder = named_or_home("XDG_CONFIG_HOME", ".config")?.join("opencode");
            vec![
                (folder.join("opencode.json"), Kind::OpencodeConfig),
                (
                    folder.join("plugins").join("facade").join("index.js"),
                    Kind::OpencodePlugin,
                ),
            ]
        }
        "pi" => vec![(
            home()?
                .join(".pi")
                .join("agent")
                .join("extensions")
                .join("facade.js"),
            Kind::PiExtension,
        )],
        "muse" => {
            // Muse Code takes an absolute XDG_CONFIG_HOME alone.
            let config =
                path_variable(env, "XDG_CONFIG_HOME").filter(|folder| folder.is_absolute());
            let config = match config {
                Some(config) => config,
                None => home()?.join(".config"),
            };
            vec![(
                config.join("muse").join("settings.json"),
                Kind::MuseSettings,
            )]
        }
        "agy" => {
            let folder = home()?.join(".gemini");
            vec![
                (
                    folder.join("config").join("mcp_config.json"),
                    Kind::AgyServers,
                ),
                (folder.join("config").join("hooks.json"), Kind::AgyHooks),
                (
                    folder.join("antigravity-cli").join("settings.json"),
                    Kind::AgySettings,
                ),
            ]
        }
        other => {
            return Err(format!(
                "no CLI {other}; Facade Code Framework integrates {}",
                CLIS.join(", ")
            ));
        }
    };
    Ok(files
        .into_iter()
        .map(|(file, kind)| Target { file, kind })
        .collect())
}

/// A note for the person after `cli` is integrated, where there is something to do.
pub fn note(cli: &str) -> Option<&'static str> {
    (cli == "codex").then_some(
        "Codex asks you to review new hooks once, when it next starts: approve Facade Code Framework's for its \
         sessions to join.",
    )
}

/// One kind of Facade Code Framework's entries in a JSON file.
#[derive(Clone, Copy)]
enum Slot {
    /// Facade Code Framework's server, `facade` in the object at `key`, as `cli` writes it.
    Server {
        key: &'static str,
        cli: &'static str,
    },
    /// A rule in `permissions.allow` that approves Facade Code Framework's tools.
    Allowed(&'static str),
    /// Facade Code Framework's group for each of `cli`'s hook events, under `hooks`.
    Hooks(&'static str),
    /// Antigravity's hook set `facade`.
    HookSet,
    /// OpenCode's `permission["facade_*"]`, after the person's own rules.
    Permission,
}

/// The kinds of Facade Code Framework's entries in a JSON file of `kind`, in the order they are written and read.
/// None for a file that is not JSON.
fn slots(kind: Kind) -> &'static [Slot] {
    match kind {
        Kind::ClaudeSettings => &[Slot::Allowed(CLAUDE_ALLOW), Slot::Hooks("claude")],
        Kind::CodexHooks => &[Slot::Hooks("codex")],
        Kind::MuseSettings => &[
            Slot::Server {
                key: "mcpServers",
                cli: "muse",
            },
            Slot::Hooks("muse"),
        ],
        Kind::OpencodeConfig => &[
            Slot::Server {
                key: "mcp",
                cli: "opencode",
            },
            Slot::Permission,
        ],
        Kind::AgyServers => &[Slot::Server {
            key: "mcpServers",
            cli: "agy",
        }],
        Kind::AgyHooks => &[Slot::HookSet],
        Kind::AgySettings => &[Slot::Allowed(AGY_ALLOW)],
        Kind::CodexConfig | Kind::OpencodePlugin | Kind::PiExtension => &[],
    }
}

/// Whether `server`, a `facade` server of `cli`'s configuration, is Facade Code Framework's: it runs `facade-mcp`,
/// the first word of its command for OpenCode, which gives a command as a list.
fn is_ours(cli: &str, server: &Value) -> bool {
    let program = match cli {
        "opencode" => &server["command"][0],
        _ => &server["command"],
    };
    is_server_program(program.as_str())
}

impl Slot {
    /// Puts Facade Code Framework's entries of this slot in `map`, in their place. An error where the file holds
    /// something of the person's own there, or something its CLI could not read.
    fn put(self, map: &mut Map<String, Value>, programs: &Programs) -> Result<(), String> {
        match self {
            Slot::Server { key, cli } => {
                let servers = object_at(map, key)?;
                if servers
                    .get(SERVER)
                    .is_some_and(|theirs| !is_ours(cli, theirs))
                {
                    return Err("it has a facade server of the person's own".into());
                }
                let server = match cli {
                    "muse" => programs.guest_server(cli, muse_guest_entry),
                    "opencode" => programs.guest_server(cli, opencode_entry),
                    _ => programs.guest_server(cli, agy_entry),
                };
                servers.insert(SERVER.into(), server);
            }
            Slot::Allowed(rule) => {
                let allow = list_at(object_at(map, "permissions")?, "allow", "permissions")?;
                if !allow.iter().any(|given| given == rule) {
                    allow.push(json!(rule));
                }
            }
            Slot::Hooks(cli) => put_hooks(map, cli, programs)?,
            Slot::HookSet => {
                if map
                    .get(SERVER)
                    .is_some_and(|theirs| !is_facade_agy_set(theirs))
                {
                    return Err("it has a facade hook set of the person's own".into());
                }
                let set: Map<String, Value> = AGY_HOOK_EVENTS
                    .iter()
                    .map(|(event, name)| {
                        let command = hook_command(event, "agy", programs);
                        (
                            name.to_string(),
                            json!([{ "type": "command", "command": command }]),
                        )
                    })
                    .collect();
                map.insert(SERVER.into(), Value::Object(set));
            }
            Slot::Permission => {
                let permission = map.entry("permission").or_insert_with(|| json!({}));
                if permission
                    .get("facade_*")
                    .is_some_and(|rule| rule != "allow")
                {
                    return Err("it has a facade_* permission of the person's own".into());
                }
                let allowed = opencode_allow(permission.clone())
                    .ok_or("its permission is neither a rule nor rules")?;
                *permission = Value::Object(allowed);
            }
        }
        Ok(())
    }

    /// Adds to `found` Facade Code Framework's entries of this slot in `object`.
    fn find(self, object: &Value, found: &mut Vec<Part>) {
        let mut add = |place: String, content: &Value| {
            found.push(Part {
                place,
                content: content.clone(),
            });
        };
        match self {
            Slot::Server { key, cli } => {
                if let Some(server) = object[key]
                    .get(SERVER)
                    .filter(|server| is_ours(cli, server))
                {
                    add(format!("{key}.{SERVER}"), server);
                }
            }
            Slot::Allowed(rule) => {
                let allow = object["permissions"]["allow"]
                    .as_array()
                    .into_iter()
                    .flatten();
                allow
                    .filter(|given| *given == rule)
                    .for_each(|given| add("permissions.allow".into(), given));
            }
            Slot::Hooks(cli) => {
                for (_, name) in hook_events(cli) {
                    let groups = object["hooks"][name].as_array().into_iter().flatten();
                    let ours = groups.filter(|group| is_facade_group(group, cli));
                    ours.for_each(|group| add(format!("hooks.{name}"), group));
                }
            }
            Slot::HookSet => {
                if let Some(set) = object.get(SERVER).filter(|set| is_facade_agy_set(set)) {
                    add(SERVER.into(), set);
                }
            }
            Slot::Permission => {
                if let Some(rule) = object["permission"]
                    .get("facade_*")
                    .filter(|rule| *rule == "allow")
                {
                    add("permission.facade_*".into(), rule);
                }
            }
        }
    }

    /// Takes out of `map` Facade Code Framework's entries of this slot that `taken` selects, each by its place and
    /// content, and what they alone filled.
    fn take(self, map: &mut Map<String, Value>, taken: &impl Fn(&str, &Value) -> bool) {
        match self {
            Slot::Server { key, .. } => {
                let place = format!("{key}.{SERVER}");
                take_key(map, key, SERVER, |server| taken(&place, server));
            }
            Slot::Allowed(_) => take_items(map, "permissions", "allow", |rule| {
                taken("permissions.allow", rule)
            }),
            Slot::Hooks(cli) => {
                for (_, name) in hook_events(cli) {
                    let place = format!("hooks.{name}");
                    take_items(map, "hooks", name, |group| taken(&place, group));
                }
            }
            Slot::HookSet => {
                if map.get(SERVER).is_some_and(|set| taken(SERVER, set)) {
                    map.shift_remove(SERVER);
                }
            }
            Slot::Permission => {
                take_key(map, "permission", "facade_*", |rule| {
                    taken("permission.facade_*", rule)
                });
            }
        }
    }
}

/// The text of a file of `kind` with Facade Code Framework's entries brought up to date: `current` is its text
/// now, None where it does not exist. Facade Code Framework's entries are replaced where they are, missing ones
/// are added, and a file that needs no change comes back byte for byte. An error says why Facade Code Framework
/// does not write it: its CLI could not read it, rewriting it would drop its comments, or the
/// person has an entry of their own in Facade Code Framework's place.
pub fn write(kind: Kind, current: Option<&str>, programs: &Programs) -> Result<String, String> {
    match kind {
        Kind::CodexConfig => return codex_config(current.unwrap_or_default(), programs),
        Kind::OpencodePlugin | Kind::PiExtension => {
            let theirs =
                current.is_some_and(|text| !text.trim().is_empty() && !written_by_facade(text));
            if theirs {
                return Err("a file of the person's own is there".into());
            }
            return Ok(whole_file(kind, programs));
        }
        _ => {}
    }
    let mut object = json_object(current)?;
    let before = object.to_string();
    let map = object.as_object_mut().expect("an object");
    if kind == Kind::MuseSettings {
        // Muse Code reads no settings without their schema's version.
        if map.is_empty() {
            map.insert("schema_version".into(), json!(1));
        } else if !map.contains_key("schema_version") {
            return Err("it has no schema_version, so Muse Code cannot read it".into());
        }
    }
    for slot in slots(kind) {
        slot.put(map, programs)?;
    }
    // Compared as text, as a reordering is a change too.
    let after = object.to_string();
    match current {
        Some(current) if after == before => Ok(current.to_string()),
        _ => Ok(json_text(&object, current)),
    }
}

/// The entries of Facade Code Framework's in `text`, a file of `kind`, recognized by their shape, always in the
/// same order. An error where the CLI could not read the file.
pub fn parts(kind: Kind, text: &str) -> Result<Vec<Part>, String> {
    let mut found = Vec::new();
    match kind {
        Kind::CodexConfig => {
            let config = toml_table(text)?;
            let table = config
                .get("mcp_servers")
                .and_then(|servers| servers.get(SERVER));
            let ours = table.filter(|table| {
                is_server_program(table.get("command").and_then(toml::Value::as_str))
            });
            if let Some(table) = ours {
                let content = serde_json::to_value(table).map_err(|err| err.to_string())?;
                found.push(Part {
                    place: "mcp_servers.facade".into(),
                    content,
                });
            }
        }
        Kind::OpencodePlugin | Kind::PiExtension => {
            if written_by_facade(text) {
                found.push(Part {
                    place: whole_place(kind).into(),
                    content: json!(text),
                });
            }
        }
        _ => {
            let object = json_object(Some(text))?;
            for slot in slots(kind) {
                slot.find(&object, &mut found);
            }
        }
    }
    Ok(found)
}

/// The entries Facade Code Framework writes today in a file of `kind`.
pub fn wanted(kind: Kind, programs: &Programs) -> Vec<Part> {
    let written =
        write(kind, None, programs).expect("Facade Code Framework's entries alone can be written");
    parts(kind, &written).expect("Facade Code Framework's entries can be read")
}

/// The text of a file of `kind` once Facade Code Framework's entries in `taken` are out of `current`, with the
/// objects and lists that held nothing else. Unchanged where none of them is there; None where the
/// file would be left empty. An error where the CLI could not read it.
pub fn take_out(kind: Kind, current: &str, taken: &[Part]) -> Result<Option<String>, String> {
    let is_taken = |place: &str, content: &Value| {
        taken
            .iter()
            .any(|part| part.place == place && part.content == *content)
    };
    match kind {
        Kind::OpencodePlugin | Kind::PiExtension => {
            Ok((!is_taken(whole_place(kind), &json!(current))).then(|| current.to_string()))
        }
        Kind::CodexConfig => {
            let ours = parts(kind, current)?;
            if !ours.iter().any(|part| is_taken(&part.place, &part.content)) {
                return Ok(Some(current.to_string()));
            }
            let lines: Vec<&str> = current.split_inclusive('\n').collect();
            let (mut start, end) =
                table_lines(&lines).expect("Facade Code Framework's table is there");
            // The blank line Facade Code Framework put before its table goes with it.
            if start > 0 && lines[start - 1].trim().is_empty() {
                start -= 1;
            }
            let left = [lines[..start].concat(), lines[end..].concat()].concat();
            Ok((!left.trim().is_empty()).then_some(left))
        }
        _ => {
            let mut object = json_object(Some(current))?;
            let before = object.to_string();
            let map = object.as_object_mut().expect("an object");
            for slot in slots(kind) {
                slot.take(map, &is_taken);
            }
            let after = object.to_string();
            if after == before {
                Ok(Some(current.to_string()))
            } else if object.as_object().is_some_and(Map::is_empty) {
                Ok(None)
            } else {
                Ok(Some(json_text(&object, Some(current))))
            }
        }
    }
}

/// How `current`, a file of `kind` or None, stands with the entries Facade Code Framework writes for `programs`.
pub fn held(kind: Kind, current: Option<&str>, programs: &Programs) -> Held {
    match current.map(|text| parts(kind, text)) {
        None => Held::Missing,
        Some(Ok(found)) if found.is_empty() => Held::Missing,
        Some(Ok(found)) if found == wanted(kind, programs) => Held::AsWritten,
        Some(_) => Held::Changed,
    }
}

/// The entry `claude mcp add` writes for Facade Code Framework's server in Claude Code's user configuration.
pub fn claude_server(programs: &Programs) -> Value {
    programs.guest_server("claude", claude_entry)
}

/// The arguments that have `claude` add Facade Code Framework's server for the user.
pub fn claude_server_add(programs: &Programs) -> Vec<String> {
    let mut args = vec!["mcp", "add", "--scope", "user", SERVER];
    let home = programs.home.map(|home| format!("FACADE_HOME={home}"));
    if let Some(home) = &home {
        args.extend(["-e", home]);
    }
    args.extend(["--", programs.mcp, "--guest", "claude"]);
    args.into_iter().map(String::from).collect()
}

/// The arguments that have `claude` remove Facade Code Framework's user server.
pub fn claude_server_remove() -> Vec<String> {
    ["mcp", "remove", "--scope", "user", SERVER]
        .map(String::from)
        .to_vec()
}

/// Whether Claude Code's user server `facade` is Facade Code Framework's own: it runs a `facade-mcp`.
pub fn is_facade_server(server: &Value) -> bool {
    is_ours("claude", server)
}

/// Whether `text` is a file Facade Code Framework writes whole: it starts with Facade Code Framework's marker.
pub(super) fn written_by_facade(text: &str) -> bool {
    text.starts_with(MARKER)
}

/// Whether two server entries of Claude Code's say the same, counting an empty `env` as none.
pub fn same_server(one: &Value, other: &Value) -> bool {
    let comparable = |server: &Value| {
        let mut server = server.clone();
        if let Some(fields) = server.as_object_mut()
            && fields
                .get("env")
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty)
        {
            fields.shift_remove("env");
        }
        server
    };
    comparable(one) == comparable(other)
}

/// A JSON file's text read as an object; a missing or blank file is an empty one. An error for
/// text its CLI could not read, or that is no object, and for comments or trailing commas, which
/// rewriting the file would drop.
fn json_object(current: Option<&str>) -> Result<Value, String> {
    let text = match current {
        Some(text) if !text.trim().is_empty() => text,
        _ => return Ok(json!({})),
    };
    match serde_json::from_str::<Value>(text) {
        Ok(object @ Value::Object(_)) => Ok(object),
        Ok(_) => Err("it is not a JSON object".into()),
        Err(err) => match parse_jsonc(text) {
            Ok(_) => {
                Err("it has comments or trailing commas, which rewriting it would lose".into())
            }
            Err(_) => Err(format!("it is not JSON its CLI can read: {err}")),
        },
    }
}

/// The text of a JSON file holding `value`, indented like the first non-blank line after the first
/// in `current`, or by two spaces where that is not indented.
fn json_text(value: &Value, current: Option<&str>) -> String {
    let mut lines = current.into_iter().flat_map(str::lines).skip(1);
    let sample = lines
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let indent = match &sample[..sample.len() - sample.trim_start().len()] {
        "" => "  ",
        indent => indent,
    };
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    serde::Serialize::serialize(value, &mut serializer).expect("JSON serializes");
    format!("{}\n", String::from_utf8_lossy(&bytes))
}

/// The value at `key` of `map`, `fresh` put there where there is none.
fn value_at<'a>(map: &'a mut Map<String, Value>, key: &str, fresh: Value) -> &'a mut Value {
    map.entry(key).or_insert(fresh)
}

/// The object at `key` of `map`, an empty one put there where there is none. An error where `key`
/// holds anything else.
fn object_at<'a>(
    map: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    match value_at(map, key, json!({})) {
        Value::Object(object) => Ok(object),
        _ => Err(format!("its {key} is not an object")),
    }
}

/// The list at `key` of `map`, itself the object at `within`, an empty one put there where there is
/// none. An error where `key` holds anything else.
fn list_at<'a>(
    map: &'a mut Map<String, Value>,
    key: &str,
    within: &str,
) -> Result<&'a mut Vec<Value>, String> {
    match value_at(map, key, json!([])) {
        Value::Array(list) => Ok(list),
        _ => Err(format!("its {within}.{key} is not a list")),
    }
}

/// Drops the object at `key` of `map` where it is left empty.
fn drop_if_empty(map: &mut Map<String, Value>, key: &str) {
    if map
        .get(key)
        .and_then(Value::as_object)
        .is_some_and(Map::is_empty)
    {
        map.shift_remove(key);
    }
}

/// Takes the items `taken` selects out of the list at `outer.inner` of `map`. A list this empties
/// goes, and then `outer` if that leaves it empty.
fn take_items(
    map: &mut Map<String, Value>,
    outer: &str,
    inner: &str,
    taken: impl Fn(&Value) -> bool,
) {
    let Some(object) = map.get_mut(outer).and_then(Value::as_object_mut) else {
        return;
    };
    let Some(items) = object.get_mut(inner).and_then(Value::as_array_mut) else {
        return;
    };
    let before = items.len();
    items.retain(|item| !taken(item));
    if before > 0 && items.is_empty() {
        object.shift_remove(inner);
        drop_if_empty(map, outer);
    }
}

/// Takes `key` out of the object at `outer` of `map` where `taken` selects its value, and then
/// `outer` if that leaves it empty.
fn take_key(map: &mut Map<String, Value>, outer: &str, key: &str, taken: impl Fn(&Value) -> bool) {
    let Some(object) = map.get_mut(outer).and_then(Value::as_object_mut) else {
        return;
    };
    if object.get(key).is_some_and(taken) {
        object.shift_remove(key);
        drop_if_empty(map, outer);
    }
}

/// Whether `commands`, a list of hooks or handlers, is a list of Facade Code Framework's hooks for `cli` alone.
fn all_facade_hooks(commands: &Value, cli: &str) -> bool {
    let facade = |hook: &Value| {
        hook["command"]
            .as_str()
            .is_some_and(|command| is_facade_hook(command, cli))
    };
    commands
        .as_array()
        .is_some_and(|list| !list.is_empty() && list.iter().all(facade))
}

/// Whether Antigravity's hook set `set` is Facade Code Framework's: some events, each with a list of Facade Code Framework's
/// hooks alone.
fn is_facade_agy_set(set: &Value) -> bool {
    let events = set.as_object();
    events.is_some_and(|events| {
        !events.is_empty() && events.values().all(|list| all_facade_hooks(list, "agy"))
    })
}

/// Whether a hook group is Facade Code Framework's: its hooks are Facade Code Framework's for `cli` alone.
pub(super) fn is_facade_group(group: &Value, cli: &str) -> bool {
    all_facade_hooks(&group["hooks"], cli)
}

/// Facade Code Framework's hooks for `cli`, each named as `facade hook` names it and as the CLI names its event.
fn hook_events(cli: &str) -> &'static [(&'static str, &'static str)] {
    match cli {
        "claude" => &CLAUDE_HOOK_EVENTS,
        "muse" => &MUSE_HOOK_EVENTS,
        "agy" => &AGY_HOOK_EVENTS,
        _ => &CODEX_HOOK_EVENTS,
    }
}

/// The command of Facade Code Framework's hook for `event`, in the form `facade_hook` gives `cli`. The
/// approval hook names its CLI as a run's does, and no Facade home.
fn hook_command(event: &str, cli: &str, programs: &Programs) -> String {
    let cli_arg = HookArg::Word(cli);
    if event == "approve" {
        return facade_hook(cli, programs.facade, event, &[cli_arg], []);
    }
    facade_hook(
        cli,
        programs.facade,
        event,
        &[HookArg::Word("--cli"), cli_arg],
        programs.home.map(|home| ("FACADE_HOME", home)),
    )
}

/// Whether `command` is one of Facade Code Framework's hooks for `cli`, in its current or earlier form, whatever its
/// Facade home or the path of its `facade`.
fn is_facade_hook(command: &str, cli: &str) -> bool {
    let words = (if matches!(cli, "codex" | "muse") {
        encoded_powershell_words(command)
    } else {
        None
    })
    .or_else(|| shell_words(command))
    .unwrap_or_default();
    let skip = usize::from(
        words
            .first()
            .is_some_and(|word| word.starts_with("FACADE_HOME=")),
    );
    let words: Vec<&str> = words[skip..].iter().map(String::as_str).collect();
    let is_facade = |program: &str| program_name(Path::new(program)) == "facade";
    let reports =
        |event: &str| event != "approve" && hook_events(cli).iter().any(|(ours, _)| *ours == event);
    match words[..] {
        [program, "hook", "approve", named] => cli == "muse" && named == cli && is_facade(program),
        [program, "hook", event, "--cli", named] => {
            named == cli && reports(event) && is_facade(program)
        }
        _ => false,
    }
}

/// Facade Code Framework's hooks for `cli` under `hooks` of `map`: each in the place of Facade Code Framework's first group for
/// its event, its other groups there dropped, or else after the person's own.
fn put_hooks(map: &mut Map<String, Value>, cli: &str, programs: &Programs) -> Result<(), String> {
    let hooks = object_at(map, "hooks")?;
    for (event, name) in hook_events(cli) {
        let mut hook = json!({ "type": "command", "command": hook_command(event, cli, programs) });
        // Muse Code admits an `Interrupt` hook only where it does not hold the CLI up.
        if cli == "muse" && *name == "Interrupt" {
            hook["async"] = json!(true);
        }
        let mut ours = json!({ "hooks": [hook] });
        // Of Claude Code's notifications, only that it waits for input.
        if cli == "claude" && *name == "Notification" {
            ours["matcher"] = json!("idle_prompt");
        }
        let groups = list_at(hooks, name, "hooks")?;
        let mut placed = false;
        let mut kept = Vec::with_capacity(groups.len() + 1);
        for group in groups.drain(..) {
            match is_facade_group(&group, cli) {
                false => kept.push(group),
                true if placed => {}
                true => {
                    placed = true;
                    kept.push(ours.clone());
                }
            }
        }
        if !placed {
            kept.push(ours);
        }
        *groups = kept;
    }
    Ok(())
}

/// The TOML table of `text`, or why Codex could not read it.
fn toml_table(text: &str) -> Result<toml::Table, String> {
    let parsed: Result<toml::Table, _> = text.parse();
    parsed.map_err(|err| format!("it is not TOML Codex can read: {}", err.message()))
}

/// Codex's `config.toml`, `current`, with Facade Code Framework's server table where Facade Code Framework's was, or else at the
/// end after a blank line. Every other byte stays as it is, comments included.
fn codex_config(current: &str, programs: &Programs) -> Result<String, String> {
    let config = toml_table(current)?;
    let theirs = config
        .get("mcp_servers")
        .and_then(|servers| servers.get(SERVER));
    let program = theirs.map(|table| table.get("command").and_then(toml::Value::as_str));
    if program.is_some_and(|program| !is_server_program(program)) {
        return Err("it has a facade server of the person's own".into());
    }
    let keys = programs.guest_server("codex", codex_entry)?;
    let table: String = std::iter::once(CODEX_TABLE.to_string())
        .chain(keys.iter().map(|(key, value)| format!("{key} = {value}")))
        .map(|line| line + "\n")
        .collect();
    let lines: Vec<&str> = current.split_inclusive('\n').collect();
    match table_lines(&lines) {
        Some((start, end)) => Ok([lines[..start].concat(), table, lines[end..].concat()].concat()),
        None if theirs.is_some() => Err(format!(
            "its facade server is not written as a {CODEX_TABLE} table, which Facade Code Framework could edit"
        )),
        None => {
            let ending = match current {
                "" => "",
                text if text.trim().is_empty() => &"\n"[usize::from(text.ends_with('\n'))..],
                text if text.ends_with('\n') => "\n",
                _ => "\n\n",
            };
            Ok(format!("{current}{ending}{table}"))
        }
    }
}

/// Where Facade Code Framework's table is in `lines`: its header, and the end of its keys before the next table,
/// with the blank and comment lines that lead to that left out.
fn table_lines(lines: &[&str]) -> Option<(usize, usize)> {
    let is_header = |line: &&str| line.split('#').next().unwrap_or_default().trim() == CODEX_TABLE;
    let start = lines.iter().position(is_header)?;
    let is_next_table = |line: &str| {
        let line = line.trim_start();
        line.starts_with('[') && !line.starts_with("[mcp_servers.facade.")
    };
    let next = (start + 1..lines.len())
        .find(|&at| is_next_table(lines[at]))
        .unwrap_or(lines.len());
    let is_filler = |line: &str| line.trim().is_empty() || line.trim_start().starts_with('#');
    let last_key = (start + 1..next).rev().find(|&at| !is_filler(lines[at]));
    Some((start, last_key.map_or(start + 1, |at| at + 1)))
}

/// What Facade Code Framework's plugin and extension run: `facade hook <event> --cli <cli>` for a session.
const HOOK_JS: &str = r#"// Runs `facade hook <event> --cli @CLI@` for `session`, working in `cwd` and part of the session `parent` where they are given,
// and answers what it printed, or nothing.
function hook(event, session, { cwd, parent } = {}) {
	return new Promise((resolve) => {
		const options = { env: { ...process.env, ...ENV }, maxBuffer: 16 * 1024 * 1024 };
		const child = execFile(FACADE, ["hook", event, "--cli", "@CLI@"], options, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
		child.stdin?.end(JSON.stringify({ session_id: session, ...(cwd ? { cwd } : {}), ...(parent ? { parent_session_id: parent } : {}) }));
	});
}"#;

/// OpenCode's plugin of Facade Code Framework's, in OpenCode 2's form.
const OPENCODE_PLUGIN: &str = r#"@MARKER@
// Each OpenCode session the person starts joins Facade Code Framework as a guest: this plugin reports its start, its turns and its end, and
// gives it the messages Facade Code Framework has for it at its next turn: those that waited with the prompt that begins it, and those that
// came during a turn as it ends. OpenCode loads it once for each folder it opens, and each copy sees the events of every
// session: the copy of the session's own folder looks after it.
import { execFile } from "node:child_process";

const FACADE = @FACADE@;
const ENV = @ENV@;

@HOOK@

// Each session's folder, as its events name it, for every copy.
const folders = (globalThis.facadeSessionFolders ??= new Map());

export default {
	id: "facade",
	setup(api) {
		const here = api.location.directory;
		const stop = new AbortController();
		// The sessions this copy looks after, which leave Facade Code Framework with it, and its subagents' sessions.
		const sessions = new Set();
		const subagents = new Set();
		// `steer` puts the messages into the turn that runs; `queue` begins a turn with them.
		const prompt = (session, text, delivery) => Promise.resolve(api.session.prompt({ sessionID: session, text, delivery })).catch(() => {});
		// The hook runs in OpenCode's service: the session works in its own folder.
		const report = (event, session, parent) => hook(event, session, { cwd: folders.get(session), parent });
		const end = (session) => {
			sessions.delete(session);
			const ended = report("session-end", session);
			folders.delete(session);
			return ended;
		};
		(async () => {
			for await (const event of api.event.subscribe({ signal: stop.signal })) {
				const session = event.data?.sessionID;
				if (!session) continue;
				if (event.location?.directory && !folders.has(session)) folders.set(session, event.location.directory);
				if (folders.get(session) !== here) continue;
				// A subagent's session is part of the session that started it: its tool calls act for that session's guest, and its
				// turns are that guest's own.
				if (event.type === "session.created" && event.data.parentID) {
					subagents.add(session);
					await report("session-start", session, event.data.parentID);
					continue;
				}
				if (subagents.has(session)) {
					if (event.type === "session.deleted") {
						subagents.delete(session);
						await report("session-end", session);
					}
					continue;
				}
				switch (event.type) {
					case "session.created":
						sessions.add(session);
						await report("session-start", session);
						break;
					case "session.execution.started": {
						sessions.add(session);
						const messages = await report("prompt", session);
						if (messages) await prompt(session, messages, "steer");
						break;
					}
					case "session.execution.succeeded":
					case "session.execution.failed": {
						sessions.add(session);
						const messages = await report("turn-end", session);
						if (messages) await prompt(session, messages, "queue");
						break;
					}
					// The person's interrupt wins: what waits goes with the next prompt.
					case "session.execution.interrupted":
						sessions.add(session);
						await report("idle", session);
						break;
					case "session.deleted":
						await end(session);
						break;
				}
			}
		})().catch(() => {});
		// OpenCode closes a folder that stayed idle: the sessions this copy looked after leave Facade Code Framework with it.
		return () => {
			stop.abort();
			for (const session of [...sessions]) end(session);
		};
	},
};
"#;

/// Pi's extension of Facade Code Framework's.
const PI_EXTENSION: &str = r#"@MARKER@
// Each Pi session the person starts joins Facade Code Framework as a guest: it gets Facade Code Framework's tools, this extension reports its start, its
// turns and its end, and the messages Facade Code Framework has for it come to its model at its next turn: those that waited with the prompt
// that begins it, and those that came during a turn as it ends.
import { execFile } from "node:child_process";

const FACADE = @FACADE@;
const ENV = @ENV@;
const SERVER = @SERVER@;

@HOOK@

export default function (pi) {
	let session = "";
	let instructions = "";
	pi.on("session_start", async (event, ctx) => {
		session = ctx.sessionManager.getSessionId();
		instructions = await hook("session-start", session);
		// A Facade Code Framework run's own session has the run's extension, and Pi does not start with two that register `facade`: Facade Code Framework
		// tells it no instructions, as it knows the run's session. Any other session is a guest's, one nested in a run included.
		if (!instructions && process.env.FACADE_AGENT) {
			session = "";
			return;
		}
		pi.registerMcpServer("facade", { ...SERVER, env: { ...SERVER.env, PI_SESSION_ID: session } });
	});
	// What waited goes into the run, after its prompt.
	pi.on("before_agent_start", async (event) => {
		if (!session) return;
		if (instructions) event.systemPromptOptions.sections.facade = instructions;
		const messages = await hook("prompt", session);
		if (messages) return { message: { customType: "facade", content: messages, display: true } };
	});
	pi.on("agent_settled", async (event) => {
		if (!session) return;
		// The person's interrupt wins: what waits goes with the next prompt.
		if (event.aborted) {
			await hook("idle", session);
			return;
		}
		const messages = await hook("turn-end", session);
		if (messages) pi.sendUserMessage(messages, { deliverAs: "followUp" });
	});
	pi.on("session_shutdown", async () => {
		if (!session) return;
		await hook("session-end", session);
		session = "";
	});
}
"#;

/// A file Facade Code Framework writes whole for `kind`, naming `programs`: OpenCode's plugin or Pi's extension.
fn whole_file(kind: Kind, programs: &Programs) -> String {
    let (template, cli) = match kind {
        Kind::OpencodePlugin => (OPENCODE_PLUGIN, "opencode"),
        _ => (PI_EXTENSION, "pi"),
    };
    let env = match programs.home {
        Some(home) => json!({ "FACADE_HOME": home }),
        None => json!({}),
    };
    let fills = [
        ("@MARKER@", MARKER.to_string()),
        ("@HOOK@", HOOK_JS.replace("@CLI@", cli)),
        ("@FACADE@", json!(programs.facade).to_string()),
        ("@ENV@", env.to_string()),
        (
            "@SERVER@",
            programs.guest_server("pi", pi_entry).to_string(),
        ),
    ];
    fills
        .iter()
        .fold(template.to_string(), |text, (name, fill)| {
            text.replace(name, fill)
        })
}

/// The place of a file Facade Code Framework writes whole, as its parts name it.
fn whole_place(kind: Kind) -> &'static str {
    match kind {
        Kind::OpencodePlugin => "plugin",
        _ => "extension",
    }
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::{encoded_powershell, powershell_word};
    use facade_base::system::{SYSTEM, System};

    const PROGRAMS: Programs = Programs {
        facade: "/opt/facade/facade",
        mcp: "/opt/facade/facade-mcp",
        home: None,
    };
    const MOVED: Programs = Programs {
        facade: "/new/facade",
        mcp: "/new/facade-mcp",
        home: Some("/h"),
    };

    /// `rest` after the program `/opt/facade/facade`, as `cli` runs its hooks on this system.
    fn facade_command(cli: &str, rest: &str) -> String {
        if SYSTEM == System::Windows && matches!(cli, "codex" | "muse") {
            let args = rest
                .split_whitespace()
                .map(powershell_word)
                .collect::<Vec<_>>()
                .join(" ");
            return encoded_powershell(&format!(
                "& '/opt/facade/facade' {args}; exit $LASTEXITCODE"
            ));
        }
        let program = match (facade_base::system::SYSTEM, cli) {
            (facade_base::system::System::Windows, cli) if cli != "claude" => {
                r#"@"/opt/facade/facade""#
            }
            _ => "'/opt/facade/facade'",
        };
        format!("{program} {rest}")
    }

    /// The environment `pairs` make; the home a test names is the CLIs' home on either system.
    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        if let Some(home) = env.get("HOME").cloned() {
            env.insert("USERPROFILE".into(), home);
        }
        env
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// Claude Code reports how its session stands in its configuration folder, by its process; the
    /// other CLIs' hooks report every turn's end, so they have no such file.
    #[test]
    fn claude_code_reports_its_session_s_status_in_its_configuration_folder() {
        let (home, moved) = (
            env(&[("HOME", "/u")]),
            env(&[("HOME", "/u"), ("CLAUDE_CONFIG_DIR", "/c")]),
        );
        assert_eq!(
            session_status_file("claude", &home, 41),
            Some(PathBuf::from("/u/.claude/sessions/41.json"))
        );
        assert_eq!(
            session_status_file("claude", &moved, 41),
            Some(PathBuf::from("/c/sessions/41.json"))
        );
        assert_eq!(
            session_status_file("claude", &env(&[]), 41),
            None,
            "no folder without HOME"
        );
        assert!(
            ["codex", "muse", "opencode", "pi", "agy"]
                .iter()
                .all(|cli| session_status_file(cli, &home, 41).is_none())
        );
    }

    /// Each CLI's files are where its own variables say, under HOME otherwise.
    #[test]
    fn each_cli_s_files_are_where_its_variables_say() {
        // An absolute folder on this system.
        let absolute_g = match facade_base::system::SYSTEM {
            facade_base::system::System::Unix => "/g",
            facade_base::system::System::Windows => "C:/g",
        };
        let home = env(&[("HOME", "/u")]);
        let files = |cli: &str, env: &BTreeMap<String, String>| {
            targets(cli, env)
                .unwrap()
                .into_iter()
                .map(|target| target.file)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            files("claude", &home),
            [PathBuf::from("/u/.claude/settings.json")]
        );
        assert_eq!(
            files(
                "claude",
                &env(&[("HOME", "/u"), ("CLAUDE_CONFIG_DIR", "/c")])
            ),
            [PathBuf::from("/c/settings.json")]
        );
        assert_eq!(
            files("codex", &env(&[("CODEX_HOME", "/x")])),
            [
                PathBuf::from("/x/config.toml"),
                PathBuf::from("/x/hooks.json")
            ]
        );
        assert_eq!(
            files("codex", &home),
            [
                PathBuf::from("/u/.codex/config.toml"),
                PathBuf::from("/u/.codex/hooks.json")
            ]
        );
        assert_eq!(
            files("opencode", &home),
            [
                PathBuf::from("/u/.config/opencode/opencode.json"),
                PathBuf::from("/u/.config/opencode/plugins/facade/index.js")
            ]
        );
        assert_eq!(
            files("opencode", &env(&[("XDG_CONFIG_HOME", "/g")]))[0],
            PathBuf::from("/g/opencode/opencode.json")
        );
        assert_eq!(
            files("pi", &home),
            [PathBuf::from("/u/.pi/agent/extensions/facade.js")]
        );
        assert_eq!(
            files("muse", &home),
            [PathBuf::from("/u/.config/muse/settings.json")]
        );
        assert_eq!(
            files(
                "muse",
                &env(&[("HOME", "/u"), ("XDG_CONFIG_HOME", absolute_g)])
            ),
            [PathBuf::from(absolute_g).join("muse/settings.json")]
        );
        let relative = env(&[("HOME", "/u"), ("XDG_CONFIG_HOME", "g")]);
        assert_eq!(
            files("muse", &relative),
            [PathBuf::from("/u/.config/muse/settings.json")],
            "Muse Code takes an absolute one alone"
        );
        assert_eq!(
            files("agy", &home),
            [
                PathBuf::from("/u/.gemini/config/mcp_config.json"),
                PathBuf::from("/u/.gemini/config/hooks.json"),
                PathBuf::from("/u/.gemini/antigravity-cli/settings.json")
            ]
        );
        assert!(targets("vim", &home).unwrap_err().contains("no CLI vim"));
        assert!(
            targets("claude", &env(&[]))
                .unwrap_err()
                .contains("is not set")
        );
    }

    /// Claude Code's settings gain the approval of Facade Code Framework's tools and its six hooks beside the
    /// person's own, which keep their order and indentation: the idle hook takes only Claude Code's
    /// notification that it waits for input. Adding again changes no byte; another Facade Code Framework's entries
    /// are brought up to date in their place.
    #[test]
    fn claude_s_settings_gain_facade_s_approval_and_hooks_beside_the_person_s() {
        let own = "{\n    \"model\": \"opus\",\n    \"permissions\": {\n        \"allow\": \
                   [\"Bash(ls)\"]\n    },\n    \"hooks\": {\n        \"Stop\": [{ \"hooks\": [{ \
                   \"type\": \"command\", \"command\": \"say done\" }] }]\n    }\n}\n";
        let written = write(Kind::ClaudeSettings, Some(own), &PROGRAMS).unwrap();
        let settings = json(&written);
        assert_eq!(
            settings["permissions"]["allow"],
            json!(["Bash(ls)", "mcp__facade"])
        );
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"], "say done",
            "the person's hook stays first"
        );
        assert_eq!(
            settings["hooks"]["Stop"][1]["hooks"][0]["command"],
            "'/opt/facade/facade' hook turn-end --cli claude"
        );
        for (event, name) in CLAUDE_HOOK_EVENTS {
            assert_eq!(
                settings["hooks"][name].as_array().unwrap().last().unwrap()["hooks"][0]["command"],
                format!("'/opt/facade/facade' hook {event} --cli claude")
            );
        }
        assert_eq!(
            settings["hooks"]["Notification"][0]["matcher"],
            "idle_prompt"
        );
        assert!(
            settings["hooks"]["Stop"][1].get("matcher").is_none(),
            "the other events, whole"
        );
        assert!(
            written.starts_with("{\n    \"model\": \"opus\",\n    \"permissions\""),
            "the person's indentation and order: {written}"
        );
        assert_eq!(
            write(Kind::ClaudeSettings, Some(&written), &PROGRAMS).unwrap(),
            written,
            "adding again changes nothing"
        );
        let compact = json(&written).to_string();
        assert_eq!(
            write(Kind::ClaudeSettings, Some(&compact), &PROGRAMS).unwrap(),
            compact,
            "nor does it reformat the file"
        );
        assert_eq!(
            held(Kind::ClaudeSettings, Some(&written), &PROGRAMS),
            Held::AsWritten
        );
        assert_eq!(
            held(Kind::ClaudeSettings, Some(own), &PROGRAMS),
            Held::Missing
        );
        assert_eq!(held(Kind::ClaudeSettings, None, &PROGRAMS), Held::Missing);
        assert_eq!(
            held(Kind::ClaudeSettings, Some(&written), &MOVED),
            Held::Changed,
            "another program or home"
        );
        // The person adds a hook after Facade Code Framework's; another Facade Code Framework's update keeps each in its place.
        let mut later = json(&written);
        later["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "hooks": [{ "type": "command", "command": "say later" }] }));
        let updated = json(&write(Kind::ClaudeSettings, Some(&later.to_string()), &MOVED).unwrap());
        let stop: Vec<&str> = updated["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["hooks"][0]["command"].as_str().unwrap())
            .collect();
        assert_eq!(
            stop,
            [
                "say done",
                "FACADE_HOME='/h' '/new/facade' hook turn-end --cli claude",
                "say later"
            ]
        );
        assert_eq!(
            updated["permissions"]["allow"],
            json!(["Bash(ls)", "mcp__facade"]),
            "one approval"
        );
        assert!(
            write(
                Kind::ClaudeSettings,
                Some("{\n  // mine\n  \"model\": \"opus\",\n}"),
                &PROGRAMS
            )
            .unwrap_err()
            .contains("comments")
        );
        assert!(
            write(Kind::ClaudeSettings, Some("[]"), &PROGRAMS)
                .unwrap_err()
                .contains("not a JSON object")
        );
        assert!(
            write(Kind::ClaudeSettings, Some("{\"model\""), &PROGRAMS)
                .unwrap_err()
                .contains("not JSON")
        );
        assert!(
            write(Kind::ClaudeSettings, Some("{\"hooks\": []}"), &PROGRAMS)
                .unwrap_err()
                .contains("hooks is not an object")
        );
    }

    /// Taking Facade Code Framework's entries out leaves the person's settings, and what Facade Code Framework's alone filled
    /// goes. An entry of Facade Code Framework's that is not as written stays.
    #[test]
    fn taking_facade_s_entries_out_leaves_the_person_s_and_changed_ones() {
        let own = r#"{"model":"opus","permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#;
        let written = write(Kind::ClaudeSettings, Some(own), &PROGRAMS).unwrap();
        let wanted = wanted(Kind::ClaudeSettings, &PROGRAMS);
        assert_eq!(wanted.len(), 7, "the approval and six hooks: {wanted:?}");
        assert_eq!(
            json(
                &take_out(Kind::ClaudeSettings, &written, &wanted)
                    .unwrap()
                    .unwrap()
            ),
            json(own)
        );
        let alone = write(Kind::ClaudeSettings, None, &PROGRAMS).unwrap();
        assert_eq!(
            take_out(Kind::ClaudeSettings, &alone, &wanted).unwrap(),
            None,
            "a file only Facade Code Framework filled goes"
        );
        assert_eq!(
            take_out(Kind::ClaudeSettings, own, &wanted)
                .unwrap()
                .as_deref(),
            Some(own),
            "no byte changes without Facade Code Framework's"
        );
        let mut changed = json(&written);
        changed["hooks"]["Stop"][1]["hooks"][0]["timeout"] = json!(5);
        let left = json(
            &take_out(Kind::ClaudeSettings, &changed.to_string(), &wanted)
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            left["hooks"]["Stop"].as_array().unwrap().len(),
            2,
            "the changed hook stays: {left}"
        );
        assert!(
            left["hooks"].get("SessionStart").is_none()
                && left["permissions"]["allow"] == json!(["Bash(ls)"]),
            "{left}"
        );
        assert!(
            take_out(Kind::ClaudeSettings, &written, &[])
                .unwrap()
                .as_deref()
                == Some(written.as_str()),
            "nothing taken"
        );
    }

    /// A hook is Facade Code Framework's by its shape: a `facade` program, any home, one of the four events, for
    /// the CLI.
    #[test]
    fn facade_s_hooks_are_known_by_their_shape() {
        for command in [
            "/opt/facade hook prompt --cli claude",
            "'/a b/facade' hook turn-end --cli claude",
            "FACADE_HOME='/h' /x/facade hook session-end --cli claude",
            "'/it'\\''s/facade' hook session-start --cli claude",
        ] {
            assert!(is_facade_hook(command, "claude"), "{command}");
        }
        for command in [
            "/opt/facade hook prompt --cli codex",
            "/opt/notfacade hook prompt --cli claude",
            "/opt/facade hook prompt --cli claude; rm x",
            "/opt/facade hook prompt --cli claude extra",
            "/opt/facade hook other --cli claude",
            "say done",
        ] {
            assert!(!is_facade_hook(command, "claude"), "{command}");
        }
        assert_eq!(
            shell_words(&hook_command(
                "prompt",
                "claude",
                &Programs {
                    facade: "/it's/facade",
                    ..MOVED
                }
            ))
            .unwrap(),
            [
                "FACADE_HOME=/h",
                "/it's/facade",
                "hook",
                "prompt",
                "--cli",
                "claude"
            ]
        );
    }

    /// Codex's config gains Facade Code Framework's server table at its end, approved in advance; the person's
    /// text stays byte for byte, an update keeps the table's place, and a facade server of the
    /// person's own is refused.
    #[test]
    fn codex_s_config_gains_facade_s_table_and_keeps_the_person_s_text() {
        let own = "# mine\nmodel = \"o3\"\n\n[mcp_servers.docs]\ncommand = \"docs\"\n";
        let written = write(Kind::CodexConfig, Some(own), &PROGRAMS).unwrap();
        assert!(
            written.starts_with(&format!("{own}\n[mcp_servers.facade]\n")),
            "{written}"
        );
        let facade = &toml_table(&written).unwrap()["mcp_servers"]["facade"];
        assert_eq!(facade["command"].as_str(), Some("/opt/facade/facade-mcp"));
        assert_eq!(
            facade["args"].as_array().unwrap(),
            &[toml::Value::from("--guest"), toml::Value::from("codex")]
        );
        assert_eq!(
            facade["default_tools_approval_mode"].as_str(),
            Some("approve")
        );
        assert_eq!(
            write(Kind::CodexConfig, Some(&written), &PROGRAMS).unwrap(),
            written,
            "adding again changes nothing"
        );
        assert_eq!(
            held(Kind::CodexConfig, Some(&written), &PROGRAMS),
            Held::AsWritten
        );
        assert_eq!(
            take_out(
                Kind::CodexConfig,
                &written,
                &wanted(Kind::CodexConfig, &PROGRAMS)
            )
            .unwrap()
            .as_deref(),
            Some(own)
        );
        // The person adds a table after Facade Code Framework's, with a comment leading to it; an update keeps
        // both in place.
        let later = format!("{written}\n# their notes\n[mcp_servers.notes]\ncommand = \"notes\"\n");
        let updated = write(Kind::CodexConfig, Some(&later), &MOVED).unwrap();
        assert!(
            updated.contains("env = {\"FACADE_HOME\"=\"/h\"}\n")
                && updated.matches(CODEX_TABLE).count() == 1,
            "{updated}"
        );
        assert!(
            updated.ends_with("\n\n# their notes\n[mcp_servers.notes]\ncommand = \"notes\"\n")
                && updated.starts_with(own),
            "{updated}"
        );
        assert_eq!(
            held(Kind::CodexConfig, Some(&updated), &PROGRAMS),
            Held::Changed
        );
        let left = take_out(
            Kind::CodexConfig,
            &updated,
            &wanted(Kind::CodexConfig, &MOVED),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            left,
            format!("{own}\n# their notes\n[mcp_servers.notes]\ncommand = \"notes\"\n")
        );
        let theirs = "[mcp_servers.facade]\ncommand = \"their-server\"\n";
        assert!(
            write(Kind::CodexConfig, Some(theirs), &PROGRAMS)
                .unwrap_err()
                .contains("of the person's own")
        );
        assert_eq!(
            held(Kind::CodexConfig, Some(theirs), &PROGRAMS),
            Held::Missing,
            "the person's own is not Facade Code Framework's"
        );
        assert!(
            write(
                Kind::CodexConfig,
                Some("mcp_servers.facade.command = \"/x/facade-mcp\"\n"),
                &PROGRAMS
            )
            .unwrap_err()
            .contains("not written as a")
        );
        assert!(
            write(Kind::CodexConfig, Some("model = "), &PROGRAMS)
                .unwrap_err()
                .contains("not TOML")
        );
        assert_eq!(
            take_out(
                Kind::CodexConfig,
                &write(Kind::CodexConfig, None, &PROGRAMS).unwrap(),
                &wanted(Kind::CodexConfig, &PROGRAMS)
            )
            .unwrap(),
            None
        );
    }

    /// Codex's hooks file gains Facade Code Framework's five hooks in Codex's form, `Interrupt` among them, and
    /// loses them again.
    #[test]
    fn codex_s_hooks_gain_facade_s_five() {
        let written = write(Kind::CodexHooks, None, &PROGRAMS).unwrap();
        let hooks = json(&written);
        for (event, name) in CODEX_HOOK_EVENTS {
            assert_eq!(
                hooks["hooks"][name][0]["hooks"][0]["command"],
                facade_command("codex", &format!("hook {event} --cli codex")),
                "{name}"
            );
        }
        assert_eq!(
            held(Kind::CodexHooks, Some(&written), &PROGRAMS),
            Held::AsWritten
        );
        assert_eq!(
            take_out(
                Kind::CodexHooks,
                &written,
                &wanted(Kind::CodexHooks, &PROGRAMS)
            )
            .unwrap(),
            None
        );
    }

    /// OpenCode's config gains Facade Code Framework's server and the permission of its tools after the person's
    /// rules; a server or a rule of the person's own for facade is refused.
    #[test]
    fn opencode_s_config_gains_facade_s_server_and_permission() {
        let own = "{\n  \"permission\": \"ask\",\n  \"mcp\": {\n    \"docs\": { \"type\": \
                   \"local\" }\n  }\n}\n";
        let written = write(Kind::OpencodeConfig, Some(own), &MOVED).unwrap();
        let config = json(&written);
        assert_eq!(
            config["mcp"]["facade"]["command"],
            json!(["/new/facade-mcp", "--guest", "opencode"])
        );
        assert_eq!(
            config["mcp"]["facade"]["environment"],
            json!({ "FACADE_HOME": "/h" })
        );
        assert_eq!(
            config["permission"],
            json!({ "*": "ask", "facade_*": "allow" }),
            "after the person's own rule"
        );
        assert_eq!(
            held(Kind::OpencodeConfig, Some(&written), &MOVED),
            Held::AsWritten
        );
        let left = json(
            &take_out(
                Kind::OpencodeConfig,
                &written,
                &wanted(Kind::OpencodeConfig, &MOVED),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            left,
            json!({ "permission": { "*": "ask" }, "mcp": { "docs": { "type": "local" } } }),
            "a one-string permission keeps its meaning"
        );
        assert!(
            write(
                Kind::OpencodeConfig,
                Some(r#"{"mcp":{"facade":{"command":["theirs"]}}}"#),
                &PROGRAMS
            )
            .unwrap_err()
            .contains("person's own")
        );
        assert!(
            write(
                Kind::OpencodeConfig,
                Some(r#"{"permission":{"facade_*":"deny"}}"#),
                &PROGRAMS
            )
            .unwrap_err()
            .contains("facade_*")
        );
        assert!(
            write(Kind::OpencodeConfig, Some(r#"{"permission":3}"#), &PROGRAMS)
                .unwrap_err()
                .contains("neither")
        );
    }

    /// OpenCode's plugin and Pi's extension are files of Facade Code Framework's own, written whole, naming
    /// Facade Code Framework's programs. Neither steps aside for `FACADE_AGENT` alone: Facade Code Framework's hooks tell a run's
    /// own session from one nested in it. The person's own file of that name is refused and stays.
    #[test]
    fn the_plugin_and_the_extension_are_files_of_facade_s_own() {
        for kind in [Kind::OpencodePlugin, Kind::PiExtension] {
            let written = write(kind, None, &PROGRAMS).unwrap();
            assert!(
                written.starts_with(MARKER)
                    && written.contains("const FACADE = \"/opt/facade/facade\";\nconst ENV = {};"),
                "{written}"
            );
            assert!(
                !written.contains("if (process.env.FACADE_AGENT) return;")
                    && !written.contains('@'),
                "{written}"
            );
            assert_eq!(write(kind, Some(&written), &PROGRAMS).unwrap(), written);
            assert_eq!(held(kind, Some(&written), &PROGRAMS), Held::AsWritten);
            assert_eq!(held(kind, Some(&written), &MOVED), Held::Changed);
            assert!(
                write(kind, Some(&written), &MOVED)
                    .unwrap()
                    .contains("const ENV = {\"FACADE_HOME\":\"/h\"};")
            );
            assert_eq!(
                take_out(kind, &written, &wanted(kind, &PROGRAMS)).unwrap(),
                None
            );
            assert!(
                write(kind, Some("// mine\n"), &PROGRAMS)
                    .unwrap_err()
                    .contains("person's own")
            );
            assert_eq!(
                take_out(kind, "// mine\n", &wanted(kind, &PROGRAMS))
                    .unwrap()
                    .as_deref(),
                Some("// mine\n")
            );
        }
        let plugin = write(Kind::OpencodePlugin, None, &PROGRAMS).unwrap();
        assert!(
            plugin.contains("[\"hook\", event, \"--cli\", \"opencode\"]")
                && plugin.contains("export default {\n\tid: \"facade\","),
            "{plugin}"
        );
        let extension = write(Kind::PiExtension, None, &PROGRAMS).unwrap();
        assert!(
            extension.contains(r#"const SERVER = {"command":"/opt/facade/facade-mcp","args":["--guest","pi"],"env":{},"exposure":"deferred""#),
            "{extension}"
        );
        assert!(
            extension.contains("[\"hook\", event, \"--cli\", \"pi\"]")
                && extension.contains("PI_SESSION_ID: session"),
            "{extension}"
        );
        assert!(Kind::OpencodePlugin.in_own_folder() && !Kind::PiExtension.in_own_folder());
    }

    /// Claude Code's server is added through its own command, with `FACADE_HOME` only where it is
    /// not the default.
    #[test]
    fn claude_s_server_goes_through_its_own_command() {
        assert_eq!(
            claude_server_add(&PROGRAMS),
            [
                "mcp",
                "add",
                "--scope",
                "user",
                "facade",
                "--",
                "/opt/facade/facade-mcp",
                "--guest",
                "claude"
            ]
        );
        assert_eq!(
            claude_server_add(&MOVED)[5..8],
            ["-e", "FACADE_HOME=/h", "--"]
        );
        let added = json(
            r#"{"type":"stdio","command":"/opt/facade/facade-mcp","args":["--guest","claude"]}"#,
        );
        assert!(same_server(&added, &claude_server(&PROGRAMS)) && is_facade_server(&added));
        assert!(!same_server(&added, &claude_server(&MOVED)));
        assert!(!is_facade_server(&json(r#"{"command":"npx"}"#)));
    }

    /// Muse Code's settings gain Facade Code Framework's server, which names a Facade Code Framework run's variables by
    /// reference, and its hooks, the approval of Facade Code Framework's tools among them, beside the person's
    /// own. A new file gets the schema version Muse Code reads settings by; a file without one,
    /// which Muse Code cannot read, is refused, and so is a `facade` server of the person's own.
    #[test]
    fn muse_s_settings_gain_facade_s_server_and_hooks_beside_the_person_s() {
        let alone = json(&write(Kind::MuseSettings, None, &PROGRAMS).unwrap());
        assert_eq!(
            alone.as_object().unwrap().keys().next().map(String::as_str),
            Some("schema_version"),
            "{alone}"
        );
        assert_eq!(alone["schema_version"], 1);
        let server = json!({
            "command": "/opt/facade/facade-mcp", "args": ["--guest", "muse"],
            "env": { "FACADE_AGENT": "${FACADE_AGENT:-}", "FACADE_HOME": "${FACADE_HOME:-}" },
            "mode": "optional",
        });
        assert_eq!(alone["mcpServers"]["facade"], server);
        for (event, name) in MUSE_HOOK_EVENTS {
            let command = if event == "approve" {
                facade_command("muse", "hook approve muse")
            } else {
                facade_command("muse", &format!("hook {event} --cli muse"))
            };
            let mut handler = json!({ "type": "command", "command": command });
            // Muse Code admits an `Interrupt` hook only as one that does not hold it up.
            if name == "Interrupt" {
                handler["async"] = json!(true);
            }
            assert_eq!(
                alone["hooks"][name],
                json!([{ "hooks": [handler] }]),
                "{name}"
            );
        }
        let moved = json(&write(Kind::MuseSettings, None, &MOVED).unwrap());
        assert_eq!(
            moved["mcpServers"]["facade"]["env"]["FACADE_HOME"], "${FACADE_HOME:-/h}",
            "a Facade Code Framework run's home, else this one"
        );
        assert_eq!(
            moved["hooks"]["Stop"][0]["hooks"][0]["command"],
            match SYSTEM {
                System::Unix => "FACADE_HOME='/h' '/new/facade' hook turn-end --cli muse".into(),
                System::Windows => encoded_powershell(
                    "$env:FACADE_HOME='/h'; & '/new/facade' 'hook' 'turn-end' '--cli' 'muse'; exit $LASTEXITCODE",
                ),
            }
        );
        assert_eq!(
            moved["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
            match SYSTEM {
                System::Unix => "'/new/facade' hook approve muse".into(),
                System::Windows => encoded_powershell(
                    "& '/new/facade' 'hook' 'approve' 'muse'; exit $LASTEXITCODE",
                ),
            }
        );

        let theirs = json!({ "hooks": [{ "type": "command", "command": "say done" }] });
        let own = json!({
            "schema_version": 1, "model": "m", "mcpServers": { "docs": { "command": "docs-mcp" } },
            "hooks": { "Stop": [theirs] },
        });
        let written = write(Kind::MuseSettings, Some(&format!("{own:#}\n")), &PROGRAMS).unwrap();
        let settings = json(&written);
        assert_eq!(settings["mcpServers"]["docs"], own["mcpServers"]["docs"]);
        assert_eq!(
            settings["hooks"]["Stop"][0], theirs,
            "the person's hook stays first"
        );
        assert_eq!(
            held(Kind::MuseSettings, Some(&written), &PROGRAMS),
            Held::AsWritten
        );
        assert_eq!(
            held(Kind::MuseSettings, Some(&written), &MOVED),
            Held::Changed
        );
        assert_eq!(
            wanted(Kind::MuseSettings, &PROGRAMS).len(),
            7,
            "the server and six hooks"
        );
        let left = take_out(
            Kind::MuseSettings,
            &written,
            &wanted(Kind::MuseSettings, &PROGRAMS),
        )
        .unwrap()
        .unwrap();
        assert_eq!(json(&left), own);

        let earlier = json!({ "schema_version": 1, "hooks": { "Stop": [{
            "hooks": [{ "type": "command",
                "command": r#"set "FACADE_HOME=/h" && @"/new/facade" hook turn-end --cli muse"# }]
        }] } })
        .to_string();
        let found = parts(Kind::MuseSettings, &earlier).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(
            held(Kind::MuseSettings, Some(&earlier), &MOVED),
            Held::Changed
        );
        let updated = write(Kind::MuseSettings, Some(&earlier), &MOVED).unwrap();
        assert_eq!(json(&updated)["hooks"]["Stop"], moved["hooks"]["Stop"]);
        let removed = take_out(Kind::MuseSettings, &earlier, &found)
            .unwrap()
            .unwrap();
        assert_eq!(json(&removed), json!({ "schema_version": 1 }));

        assert!(
            write(Kind::MuseSettings, Some("{\"model\": \"m\"}"), &PROGRAMS)
                .unwrap_err()
                .contains("schema_version")
        );
        let mine =
            json!({ "schema_version": 1, "mcpServers": { "facade": { "command": "my-facade" } } })
                .to_string();
        assert!(
            write(Kind::MuseSettings, Some(&mine), &PROGRAMS)
                .unwrap_err()
                .contains("facade server of the person's own")
        );
    }

    /// Antigravity's three files: its MCP configuration gains Facade Code Framework's server, its `hooks.json`
    /// Facade Code Framework's hook set, `facade`, and its settings the approval of Facade Code Framework's tools, each beside
    /// the person's own, which `take_out` leaves.
    #[test]
    fn antigravity_s_files_gain_facade_s_server_hooks_and_approval() {
        let servers = json(&write(Kind::AgyServers, None, &MOVED).unwrap());
        let server = json!({
            "command": "/new/facade-mcp", "args": ["--guest", "agy"],
            "env": { "FACADE_HOME": "/h" },
        });
        assert_eq!(servers, json!({ "mcpServers": { "facade": server } }));
        let mine = json!({ "mcpServers": { "facade": { "command": "my-facade" } } }).to_string();
        assert!(
            write(Kind::AgyServers, Some(&mine), &PROGRAMS)
                .unwrap_err()
                .contains("facade server of the person's own")
        );

        let theirs = json!({
            "lint": { "PostToolUse": [{ "matcher": "*", "hooks": [{ "command": "./lint.sh" }] }] },
        });
        let hooks = write(Kind::AgyHooks, Some(&theirs.to_string()), &PROGRAMS).unwrap();
        let set = &json(&hooks)["facade"];
        for (event, name) in AGY_HOOK_EVENTS {
            assert_eq!(
                set[name],
                json!([
                    {
                        "type": "command",
                        "command": facade_command("agy", &format!("hook {event} --cli agy")),
                    },
                ])
            );
        }
        assert_eq!(
            set.as_object().unwrap().len(),
            3,
            "no end hook: Antigravity has none"
        );
        assert_eq!(json(&hooks)["lint"], theirs["lint"]);
        assert_eq!(
            held(Kind::AgyHooks, Some(&hooks), &PROGRAMS),
            Held::AsWritten
        );
        assert_eq!(
            json(
                &take_out(Kind::AgyHooks, &hooks, &wanted(Kind::AgyHooks, &PROGRAMS))
                    .unwrap()
                    .unwrap()
            ),
            theirs
        );
        let named = json!({ "facade": { "Stop": [{ "command": "say done" }] } }).to_string();
        assert!(
            write(Kind::AgyHooks, Some(&named), &PROGRAMS)
                .unwrap_err()
                .contains("facade hook set of the person's own")
        );

        let own = json!({ "permissions": { "allow": ["command(ls)"] }, "model": "m" });
        let settings = write(Kind::AgySettings, Some(&own.to_string()), &PROGRAMS).unwrap();
        assert_eq!(
            json(&settings)["permissions"]["allow"],
            json!(["command(ls)", "mcp(facade/*)"])
        );
        assert_eq!(
            write(Kind::AgySettings, Some(&settings), &PROGRAMS).unwrap(),
            settings,
            "adding again changes nothing"
        );
        assert_eq!(
            json(
                &take_out(
                    Kind::AgySettings,
                    &settings,
                    &wanted(Kind::AgySettings, &PROGRAMS)
                )
                .unwrap()
                .unwrap()
            ),
            own
        );
    }

    /// The approve hook is Facade Code Framework's by its shape too, for Muse Code alone, which is the CLI it is
    /// written for.
    #[test]
    fn the_approve_hook_is_known_by_its_shape_for_muse_code_alone() {
        assert!(is_facade_hook("'/opt/facade' hook approve muse", "muse"));
        assert!(!is_facade_hook("'/opt/facade' hook approve muse", "claude"));
        assert!(!is_facade_hook(
            "'/opt/facade' hook approve --cli muse",
            "muse"
        ));
        assert!(!is_facade_hook(
            "'/opt/facade' hook approve claude",
            "claude"
        ));
        assert!(
            !is_facade_hook("'/opt/facade' hook session-end --cli agy", "agy"),
            "Antigravity has no end hook"
        );
        assert!(is_facade_hook("'/opt/facade' hook prompt --cli agy", "agy"));
    }
}
