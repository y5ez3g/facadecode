//! The `clis` table of `facade.json` (CONFIGURATION-2). Its keys name CLIs and its values say how
//! to run them, with the fields `type`, `icon`, `program`, `args`, `env`, `model`, `effort` and
//! `enabled`. The key of a built-in edits that built-in; whatever it leaves out keeps the
//! built-in's default. Any other key adds a CLI, which runs either like the built-in named by its
//! `type` or, with type `custom`, as a bare program in a terminal with nothing from Facade.
//!
//! Entries never borrow from each other: a CLI added with type `codex` ignores the `codex` entry.
//! A mistake therefore disables only the entry it is in. It is reported by setting path, never
//! by the value written there, with its place in the settings file.

use std::collections::BTreeMap;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use facade_base::model::error::{ErrorBody, Reason};
use facade_base::programs::{on_path, program_of, runnable};
use facade_base::settings::{Json, Member, Node, Settings, is_space};
use facade_base::system::{SYSTEM, System, env_var};
use regex::{Captures, Regex};

use crate::{FILES, Rule, rules};

/// The `type` of a bare program: Facade runs it in a terminal and adds nothing to it
/// (CONFIGURATION-2.3).
pub const PROGRAM_TYPE: &str = "custom";

/// Every field an entry may have. Problems with an entry come in this order
/// (CONFIGURATION-2.2, 4.1).
const FIELDS: [&str; 8] = [
    "type", "icon", "program", "args", "env", "model", "effort", "enabled",
];

/// The robot icons an entry can pick by name (CONFIGURATION-2.4).
const ROBOTS: [&str; 16] = [
    "facade-red",
    "facade-orange",
    "facade-amber",
    "facade-lime",
    "facade-green",
    "facade-teal",
    "facade-sky",
    "facade-blue",
    "facade-violet",
    "facade-pink",
    "facade-aurora",
    "facade-sunset",
    "facade-ocean",
    "facade-orchid",
    "facade-pearl",
    "facade-graphite",
];

/// What a bare program shows when its entry picks no icon (CONFIGURATION-2.4).
const BARE_PROGRAM_ICON: &str = "facade-pearl";

/// `${env:NAME}` inside an `env` value: the variable `NAME` as the start passes it in
/// (CONFIGURATION-3.2).
static ENV_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{env:([^}]+)\}").expect("the reference pattern is valid"));

/// Unicode's format characters (category Cf). They take no room on screen, so a name made only of
/// them and spaces looks empty.
const INVISIBLE: [RangeInclusive<char>; 21] = [
    '\u{ad}'..='\u{ad}',
    '\u{600}'..='\u{605}',
    '\u{61c}'..='\u{61c}',
    '\u{6dd}'..='\u{6dd}',
    '\u{70f}'..='\u{70f}',
    '\u{890}'..='\u{891}',
    '\u{8e2}'..='\u{8e2}',
    '\u{180e}'..='\u{180e}',
    '\u{200b}'..='\u{200f}',
    '\u{202a}'..='\u{202e}',
    '\u{2060}'..='\u{2064}',
    '\u{2066}'..='\u{206f}',
    '\u{feff}'..='\u{feff}',
    '\u{fff9}'..='\u{fffb}',
    '\u{110bd}'..='\u{110bd}',
    '\u{110cd}'..='\u{110cd}',
    '\u{13430}'..='\u{1343f}',
    '\u{1bca0}'..='\u{1bca3}',
    '\u{1d173}'..='\u{1d17a}',
    '\u{e0001}'..='\u{e0001}',
    '\u{e0020}'..='\u{e007f}',
];

/// How an entry runs: by the rule of a built-in, or as a bare program.
#[derive(Clone, Copy, Debug)]
pub enum Kind {
    BuiltIn(&'static Rule),
    Program,
}

impl Kind {
    /// The rule behind it; a bare program has none.
    pub fn rule(&self) -> Option<&'static Rule> {
        match *self {
            Kind::BuiltIn(rule) => Some(rule),
            Kind::Program => None,
        }
    }

    /// What `type` says for it: the built-in's ID, or `custom` for a bare program.
    pub fn id(&self) -> &'static str {
        self.rule().map_or(PROGRAM_TYPE, |rule| rule.cli.as_str())
    }
}

/// One key of `clis` after reading (CONFIGURATION-2.2, 4.1). Fields hold only valid values; every
/// mistake found is listed in `problems`.
#[derive(Clone, Debug)]
pub struct Entry {
    /// The key, which is also the CLI's ID everywhere a CLI is named (CONFIGURATION-2.1).
    pub name: String,
    /// The path problems use for it, `clis.codex` or `clis["Codex · work"]`.
    pub setting: String,
    /// True for the entry keyed by a built-in's own ID.
    pub built_in: bool,
    /// How it runs. None if `type` is missing or names nothing known; that is then a problem.
    pub kind: Option<Kind>,
    /// The icon on its card (CONFIGURATION-2.4): its own pick, or else its type's. Terminal
    /// commands of Facade show no icon.
    pub icon: String,
    /// The program as written in `program` or legacy `command`. None means the type's program, looked up on `PATH`.
    pub program: Option<String>,
    program_key: &'static str,
    /// `args`, literally and in order.
    pub args: Vec<String>,
    /// `env` in file order: a value to set, or None to unset.
    pub env: Vec<(String, Option<String>)>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub enabled: bool,
    /// Every mistake in it, with the setting path and its place in the file.
    pub problems: Vec<String>,
    program_location: Option<String>,
    enabled_location: Option<String>,
    env_locations: BTreeMap<String, String>,
}

/// A launch's replayable CLI arguments and the model and effort they select when known.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LaunchOptions {
    pub args: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// All entries of `settings` (CONFIGURATION-2.1). The built-ins come first, in their own order,
/// each read from its key or from defaults when the file lacks it; the added CLIs follow, in file
/// order.
pub fn read(settings: &Settings) -> Vec<Entry> {
    let built_ins: &'static [Rule] = rules().unwrap_or_default();
    let is_built_in = |key: &str| built_ins.iter().any(|rule| rule.cli == key);
    let mut entries = Vec::new();
    for rule in built_ins {
        let written = settings.clis.iter().find(|member| member.key == rule.cli);
        entries.push(Entry::read(settings, &rule.cli, written, built_ins));
    }
    for member in &settings.clis {
        if !is_built_in(&member.key) {
            entries.push(Entry::read(settings, &member.key, Some(member), built_ins));
        }
    }
    entries
}

/// The entry keyed exactly `name`.
pub fn find<'a>(entries: &'a [Entry], name: &str) -> Option<&'a Entry> {
    entries.iter().find(|entry| entry.name == name)
}

/// Selects a configured CLI and checks its settings in the incoming environment.
/// Program discovery happens separately once the working folder and entry environment are ready.
pub fn select<'a>(
    entries: &'a [Entry],
    name: &str,
    folder: &Path,
    env: &BTreeMap<String, String>,
) -> Result<&'a Entry, ErrorBody> {
    if !name.is_empty()
        && let Some(entry) = find(entries, name)
    {
        let problems = entry.problems_with(env);
        if !problems.is_empty() {
            return Err(entry.error(Reason::InvalidSettings, problems.join("; ")));
        }
        if !entry.enabled {
            let problem = format!(
                "{} is turned off by {}.enabled",
                entry.display_name(),
                entry.setting
            );
            return Err(entry.error(
                Reason::Unavailable,
                located(entry.enabled_location.as_deref(), problem),
            ));
        }
        return Ok(entry);
    }
    let listed: Vec<_> = entries
        .iter()
        .filter(|entry| entry.listed(env))
        .map(|entry| entry.name.as_str())
        .collect();
    let listed = if listed.is_empty() {
        "none".into()
    } else {
        listed.join(", ")
    };
    let folder = folder.display();
    let message = if name.is_empty() {
        format!("Choose a CLI by name. The CLIs configured at {folder} are {listed}.")
    } else {
        format!(
            "No CLI {} is configured at {folder}; the CLIs there are {listed}.",
            quoted(name)
        )
    };
    Err(ErrorBody::new(Reason::NotFound, message))
}

/// Whether two variable names name the same variable: Windows compares them without case.
fn same_variable(one: &str, other: &str) -> bool {
    match SYSTEM {
        System::Windows => one.eq_ignore_ascii_case(other),
        System::Unix => one == other,
    }
}

impl Entry {
    fn error(&self, reason: Reason, problem: String) -> ErrorBody {
        let mut error = ErrorBody::new(reason, problem);
        error.data.entry = Some(self.name.clone());
        error
    }

    /// Where the program was set, or where to set it when the entry has none.
    pub fn program_setting(&self) -> String {
        format!("{}.{}", self.setting, self.program_key)
    }

    /// Finds the program in `folder` with the entry's effective environment.
    pub fn resolve_program(
        &self,
        folder: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<PathBuf, ErrorBody> {
        if !folder.is_dir() {
            let message = format!("the folder {} is not available", folder.display());
            return Err(ErrorBody::new(Reason::Unavailable, message));
        }
        let path = env_var(env, "PATH");
        let setting = self.program_setting();
        let found = match self.program.as_deref() {
            Some(command)
                if command.contains('/')
                    || command.contains(std::path::MAIN_SEPARATOR)
                    || command == "~" =>
            {
                let file = PathBuf::from(program_of(command, env, &folder.to_string_lossy()));
                if runnable(&file) {
                    Ok(file)
                } else {
                    Err(format!(
                        "{setting} is {}, and {} is not a program that can be run",
                        quoted(command),
                        file.display()
                    ))
                }
            }
            Some(command) => on_path(command, path, folder).ok_or_else(|| {
                format!(
                    "{setting} is {}, which was not found on the PATH of a terminal in {}",
                    quoted(command),
                    folder.display()
                )
            }),
            None => {
                let rule = self.kind.and_then(|kind| kind.rule());
                let program = rule.map_or("", |rule| rule.program.as_str());
                on_path(program, path, folder).ok_or_else(|| {
                    format!(
                        "{program} was not found on the PATH of a terminal in {}, and \
                         {setting} does not name its location",
                        folder.display()
                    )
                })
            }
        };
        found.map_err(|problem| {
            self.error(
                Reason::NotFound,
                located(self.program_location.as_deref(), problem),
            )
        })
    }

    /// What lists show: the product name for a built-in's own entry (`Claude Code`), the key for
    /// every other.
    pub fn display_name(&self) -> &str {
        match (self.built_in, self.kind) {
            (true, Some(Kind::BuiltIn(rule))) => &rule.display_name,
            _ => &self.name,
        }
    }

    /// Whether its type accepts `choice` (`model` or `effort`) from Facade (CLIS-1.4).
    pub fn takes(&self, choice: &str) -> bool {
        let rule = self.kind.and_then(|kind| kind.rule());
        rule.is_some_and(|rule| rule.choices.takes(choice))
    }

    /// Explains all the choices this start cannot use, in MCP or command-line wording.
    pub fn choice_refusal(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        by_model: bool,
    ) -> Option<String> {
        let cli = self.display_name();
        let (choice, what) = match (
            model.is_some() && !self.takes("model"),
            effort.is_some() && !self.takes("effort"),
        ) {
            (false, false) => return None,
            (true, false) => ("model", "a model"),
            (false, true) => ("effort", "an effort"),
            (true, true) if by_model => {
                return Some(format!(
                    "{cli} takes no explicit model or effort; leave `model` and `effort` out to use its defaults."
                ));
            }
            (true, true) => {
                return Some(format!(
                    "{cli} has no supported way to set a model or an effort; omit model and effort to use its own defaults"
                ));
            }
        };
        Some(if by_model {
            format!("{cli} takes no explicit {choice}; leave `{choice}` out to use its default.")
        } else {
            format!(
                "{cli} has no supported way to set {what}; omit {choice} to use its own default"
            )
        })
    }

    /// The arguments that pass its model and effort (CONFIGURATION-3.3). For each one the start's
    /// choice wins, then the entry's; but when the start's own `words` already pick it, the words
    /// carry it and only the start's choice is added.
    pub fn choices(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        words: &[String],
    ) -> Vec<String> {
        let Some(rule) = self.kind.and_then(|kind| kind.rule()) else {
            return Vec::new();
        };
        let (model_in_words, effort_in_words) = rule.choices.chosen_in(&rule.arguments, words);
        let model = if model_in_words {
            model
        } else {
            model.or(self.model.as_deref())
        };
        let effort = if effort_in_words {
            effort
        } else {
            effort.or(self.effort.as_deref())
        };
        rule.choices.args(model, effort)
    }

    /// Builds the arguments to save and replay, in the same order used to start the CLI.
    pub fn launch_options(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        args: &[String],
    ) -> Result<LaunchOptions, ErrorBody> {
        if let Some(message) = self.choice_refusal(model, effort, true) {
            return Err(self.error(Reason::Unsupported, message));
        }
        let mut words = self.choices(model, effort, args);
        words.extend_from_slice(&self.args);
        words.extend_from_slice(args);
        let [model, effort] = match self.kind.and_then(|kind| kind.rule()) {
            Some(rule) => rule.choices.values_in(&rule.arguments, &words),
            None => [None, None],
        };
        Ok(LaunchOptions {
            args: words,
            model,
            effort,
        })
    }

    /// The environment it runs with (CONFIGURATION-3.2): `env`, as the start passes it, changed
    /// by the entry's `env` one variable at a time. A value is set with each `${env:NAME}` read
    /// from the start's `env`, once; a None unsets. On Windows a name is the same variable in any
    /// letter case, and a set one takes the place of each spelling.
    pub fn environment(&self, env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut result = env.clone();
        for (name, value) in &self.env {
            result.retain(|each, _| !same_variable(each, name));
            match value {
                None => {}
                Some(value) => {
                    let lookup =
                        |found: &Captures| env_var(env, &found[1]).unwrap_or_default().to_string();
                    let value = ENV_REFERENCE.replace_all(value, lookup).into_owned();
                    result.insert(name.clone(), value);
                }
            }
        }
        result
    }

    /// Its problems when started with `env` (CONFIGURATION-3.2, 4.1): the ones found in reading,
    /// and then one for every `${env:NAME}` whose variable `env` does not have. A missing variable
    /// is a problem, never an empty value.
    pub fn problems_with(&self, env: &BTreeMap<String, String>) -> Vec<String> {
        let mut problems = self.problems.clone();
        for (name, value) in &self.env {
            let Some(value) = value else { continue };
            for found in ENV_REFERENCE.captures_iter(value) {
                let variable = &found[1];
                if env_var(env, variable).is_some() {
                    continue;
                }
                let problem = format!(
                    "{}.env.{name} reads ${{env:{variable}}}, but {variable} is not in the \
                     environment it starts with; set it there, or write the value",
                    self.setting
                );
                problems.push(located(
                    self.env_locations.get(name).map(String::as_str),
                    problem,
                ));
            }
        }
        problems
    }

    /// Whether it appears among the CLIs a start can pick, when started with `env`
    /// (CONFIGURATION-2.2). `enabled: false` hides it, except when it has problems: those are
    /// shown, not hidden.
    pub fn listed(&self, env: &BTreeMap<String, String>) -> bool {
        self.enabled || !self.problems_with(env).is_empty()
    }

    /// Reads the settings entry named `name` (CONFIGURATION-2.2). The key decides whether
    /// it edits a built-in or adds a CLI.
    fn read(
        settings: &Settings,
        name: &str,
        written: Option<&Member>,
        built_ins: &'static [Rule],
    ) -> Entry {
        let built_in = built_ins.iter().find(|rule| rule.cli == name);
        let mut reader = Reader {
            settings,
            entry_at: written.map(|member| member.at),
            setting: setting_of(name),
            problems: Vec::new(),
        };
        if built_in.is_none() {
            reader.check_name(name, built_ins);
        }
        let mut entry = Entry {
            name: name.to_string(),
            setting: reader.setting.clone(),
            built_in: built_in.is_some(),
            kind: built_in.map(Kind::BuiltIn),
            icon: String::new(),
            program: None,
            program_key: "program",
            args: Vec::new(),
            env: Vec::new(),
            model: None,
            effort: None,
            enabled: true,
            problems: Vec::new(),
            program_location: None,
            enabled_location: None,
            env_locations: BTreeMap::new(),
        };
        if let Some(Member { value, .. }) = written {
            match &value.json {
                Json::Object(fields) => reader.fill(&mut entry, fields, built_in, built_ins),
                other => reader.say(
                    Some(value.at),
                    format!(
                        "{} must be an object of type, icon, program, args, env, model, effort and \
                     enabled; received {}",
                        reader.setting,
                        other.kind()
                    ),
                ),
            }
        }
        if entry.icon.is_empty() {
            entry.icon = default_icon(entry.kind);
        }
        entry.problems = reader.problems;
        entry
    }
}

/// The icon an entry shows when it picks none: its built-in's, or the bare-program robot.
fn default_icon(kind: Option<Kind>) -> String {
    match kind {
        Some(Kind::BuiltIn(rule)) => rule.cli.clone(),
        _ => BARE_PROGRAM_ICON.to_string(),
    }
}

/// Reads one entry's fields, collecting the problems in the order they are found.
struct Reader<'a> {
    settings: &'a Settings,
    entry_at: Option<usize>,
    setting: String,
    problems: Vec<String>,
}

impl Reader<'_> {
    fn location(&self, at: Option<usize>) -> Option<String> {
        self.settings
            .source_location(at.or(self.entry_at)?)
            .map(|place| place.to_string())
    }

    fn say(&mut self, at: Option<usize>, problem: String) {
        self.problems
            .push(located(self.location(at).as_deref(), problem));
    }

    /// Adds the entry's setting path to a field problem at its key or value.
    fn say_at(&mut self, at: Option<usize>, field_and_problem: String) {
        self.say(at, format!("{}.{field_and_problem}", self.setting));
    }

    /// An added CLI's key shows in every list of CLIs (CONFIGURATION-2.1). It must contain
    /// something visible, have no space at either end and no control character, and differ from
    /// every built-in's ID and name, ignoring case: two rows reading `Codex` give no real choice.
    fn check_name(&mut self, name: &str, built_ins: &[Rule]) {
        let invisible = |char: char| is_space(char) || INVISIBLE.iter().any(|r| r.contains(&char));
        let problem = if name.chars().all(invisible) {
            "a CLI's name needs a visible character".to_string()
        } else if name.starts_with(is_space) || name.ends_with(is_space) {
            "a CLI's name cannot start or end with a space".to_string()
        } else if name.chars().any(char::is_control) {
            "a CLI's name cannot hold a control character".to_string()
        } else {
            let lower = name.to_lowercase();
            let names_of =
                |rule: &Rule| [rule.cli.to_lowercase(), rule.display_name.to_lowercase()];
            match built_ins
                .iter()
                .find(|rule| names_of(rule).contains(&lower))
            {
                Some(rule) => format!(
                    "this is {}'s name; choose another name for this CLI",
                    rule.display_name
                ),
                None => return,
            }
        };
        self.say(None, format!("{}: {problem}", self.setting));
    }

    /// Reads every field of an entry written as an object, into `entry`.
    fn fill(
        &mut self,
        entry: &mut Entry,
        fields: &[Member],
        built_in: Option<&'static Rule>,
        built_ins: &'static [Rule],
    ) {
        for unknown in fields
            .iter()
            .filter(|field| field.key != "command" && !FIELDS.contains(&field.key.as_str()))
        {
            let known = FIELDS.join(", ");
            self.say_at(
                Some(unknown.at),
                format!(
                    "{} is not a field of an entry, which takes {known}",
                    unknown.key
                ),
            );
        }
        let field = |key: &str| fields.iter().find(|field| field.key == key);
        let get = |key: &str| field(key).map(|member| &member.value);
        entry.kind = match built_in {
            Some(rule) => {
                self.keep_type(rule, get("type"));
                Some(Kind::BuiltIn(rule))
            }
            None => self.added_type(get("type"), built_ins),
        };
        match (get("program"), get("command")) {
            (Some(_), Some(_)) => self.say_at(
                field("program").map(|member| member.at),
                "program conflicts with command. Keep program.".into(),
            ),
            (Some(value), None) => entry.program = self.text("program", Some(value)),
            (None, Some(value)) => {
                entry.program_key = "command";
                entry.program = self.text("command", Some(value));
            }
            (None, None) if matches!(entry.kind, Some(Kind::Program)) => {
                self.say_at(
                    None,
                    "program is missing; set it to the program to run".into(),
                );
            }
            (None, None) => {}
        }
        entry.program_location = self.location(get(entry.program_key).map(|node| node.at));
        entry.args = self.args(get("args"), entry.kind);
        entry.env = self.env(get("env"));
        if let Some(Node {
            json: Json::Object(variables),
            ..
        }) = get("env")
        {
            entry.env_locations = variables
                .iter()
                .filter_map(|member| {
                    let Json::String(value) = &member.value.json else {
                        return None;
                    };
                    if !ENV_REFERENCE.is_match(value) {
                        return None;
                    }
                    Some((member.key.clone(), self.location(Some(member.value.at))?))
                })
                .collect();
        }
        entry.model = self.choice("model", get("model"), entry.kind);
        entry.effort = self.choice("effort", get("effort"), entry.kind);
        match get("enabled") {
            Some(Node {
                json: Json::Bool(on),
                at,
            }) => {
                entry.enabled = *on;
                if !on {
                    entry.enabled_location = self.location(Some(*at));
                }
            }
            Some(other) => {
                self.say_at(
                    Some(other.at),
                    format!(
                        "enabled must be true or false; received {}",
                        other.json.kind()
                    ),
                );
            }
            None => {}
        }
        if let Some(icon) = self.icon(get("icon")) {
            entry.icon = icon;
        }
    }

    /// A built-in's `type`, if written, may only repeat the built-in's ID.
    fn keep_type(&mut self, rule: &Rule, written: Option<&Node>) {
        let Some(written) = written else { return };
        if matches!(&written.json, Json::String(id) if *id == rule.cli) {
            return;
        }
        let id = &rule.cli;
        self.say_at(
            Some(written.at),
            format!(
                "type cannot change the {id} entry's type: it is {}'s; set it back to \"{id}\" or \
             remove the line",
                rule.display_name
            ),
        );
    }

    /// An added CLI's `type`: `custom` or a built-in's ID. A wrong one is reported with the
    /// allowed types, never with what was written (CONFIGURATION-4.1).
    fn added_type(&mut self, written: Option<&Node>, built_ins: &'static [Rule]) -> Option<Kind> {
        let allowed = FILES.map(|(cli, _)| cli).join(", ") + ", " + PROGRAM_TYPE;
        let Some(written) = written else {
            self.say_at(
                None,
                format!("type is missing; set it to the CLI it runs: {allowed}"),
            );
            return None;
        };
        if let Json::String(id) = &written.json {
            if id == PROGRAM_TYPE {
                return Some(Kind::Program);
            }
            if let Some(rule) = built_ins.iter().find(|rule| rule.cli == *id) {
                return Some(Kind::BuiltIn(rule));
            }
        }
        self.say_at(
            Some(written.at),
            format!(
                "type must be one of {allowed}; received {}",
                written.json.kind()
            ),
        );
        None
    }

    /// A string field: present, not just spaces, and free of NUL.
    fn text(&mut self, key: &str, written: Option<&Node>) -> Option<String> {
        let written = written?;
        let problem = match &written.json {
            Json::String(text) if text.chars().all(is_space) => {
                format!("{key} is empty; set it, or leave it out")
            }
            Json::String(text) if text.contains('\0') => {
                format!("{key} contains a NUL character, which it cannot hold")
            }
            Json::String(text) => return Some(text.clone()),
            other => format!("{key} must be a string; received {}", other.kind()),
        };
        self.say_at(Some(written.at), problem);
        None
    }

    /// `args`: an array of strings without NUL. One bad item discards them all.
    fn args(&mut self, written: Option<&Node>, kind: Option<Kind>) -> Vec<String> {
        let Some(written) = written else {
            return Vec::new();
        };
        let Json::Array(items) = &written.json else {
            self.say_at(
                Some(written.at),
                format!(
                    "args must be an array of strings; received {}",
                    written.json.kind()
                ),
            );
            return Vec::new();
        };
        let found_before = self.problems.len();
        let mut args = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            match &item.json {
                Json::String(arg) if !arg.contains('\0') => args.push(arg.clone()),
                Json::String(_) => self.say_at(Some(item.at), format!(
                    "args[{index}] contains a NUL character, which is not permitted in arguments"
                )),
                other => {
                    self.say_at(Some(item.at), format!(
                        "args[{index}] must be a string; received {}",
                        other.kind()
                    ));
                }
            }
        }
        if self.problems.len() != found_before {
            return Vec::new();
        }
        if let Some(Kind::BuiltIn(rule)) = kind {
            let path = format!("{}.args", self.setting);
            for (index, problem) in rule.arguments.problems_at(&args, &path) {
                self.say(Some(items[index].at), problem);
            }
        }
        args
    }

    /// `env`: variable names mapped to a string or null. One bad variable discards them all.
    fn env(&mut self, written: Option<&Node>) -> Vec<(String, Option<String>)> {
        let Some(written) = written else {
            return Vec::new();
        };
        let Json::Object(variables) = &written.json else {
            self.say_at(
                Some(written.at),
                format!(
                    "env must be an object of variable names to strings or null; received {}",
                    written.json.kind()
                ),
            );
            return Vec::new();
        };
        let found_before = self.problems.len();
        let mut env = Vec::with_capacity(variables.len());
        for variable in variables {
            let name = &variable.key;
            if name.is_empty() || name.contains(['=', '\0']) {
                let shown = shown_name(name);
                self.say_at(
                    Some(variable.at),
                    format!("env contains invalid environment variable name {shown}"),
                );
                continue;
            }
            match &variable.value.json {
                Json::Null => env.push((name.clone(), None)),
                Json::String(value) if !value.contains('\0') => {
                    env.push((name.clone(), Some(value.clone())));
                }
                Json::String(_) => self.say_at(Some(variable.value.at), format!(
                    "env.{name} contains a NUL character, which is not permitted in environment \
                     variables"
                )),
                other => self.say_at(Some(variable.value.at), format!(
                    "env.{name} must be a string or null; received {}",
                    other.kind()
                )),
            }
        }
        if self.problems.len() == found_before {
            env
        } else {
            Vec::new()
        }
    }

    /// `model` or `effort`, kept only when the entry's type accepts it from Facade.
    fn choice(&mut self, key: &str, written: Option<&Node>, kind: Option<Kind>) -> Option<String> {
        let written = written?;
        let value = self.text(key, Some(written))?;
        let refusal = match kind {
            Some(Kind::Program) => {
                format!("{key} is not taken by a program: give its own options in args")
            }
            Some(Kind::BuiltIn(rule)) if !rule.choices.takes(key) => format!(
                "{key} is not taken by {}, which sets it in its own configuration",
                rule.display_name
            ),
            _ => return Some(value),
        };
        self.say_at(Some(written.at), refusal);
        None
    }

    /// `icon`: a built-in's ID or a robot's name. A wrong one is reported with the allowed
    /// icons, never with what was written (CONFIGURATION-2.4, 4.1).
    fn icon(&mut self, written: Option<&Node>) -> Option<String> {
        let allowed: Vec<&str> = FILES.iter().map(|(cli, _)| *cli).chain(ROBOTS).collect();
        let written = written?;
        if let Json::String(icon) = &written.json
            && allowed.contains(&icon.as_str())
        {
            return Some(icon.clone());
        }
        let allowed = allowed.join(", ");
        self.say_at(
            Some(written.at),
            format!(
                "icon must be one of {allowed}; received {}",
                written.json.kind()
            ),
        );
        None
    }
}

fn located(location: Option<&str>, problem: String) -> String {
    match location {
        Some(place) => format!("{place}: {problem}"),
        None => problem,
    }
}

/// The path of the key `name` in problems: `clis.<name>` when the name is a plain identifier
/// (letters, digits, `_`, `-`, not starting with a digit or `-`), else `clis["<name>"]`.
fn setting_of(name: &str) -> String {
    let identifier = name.char_indices().all(|(at, char)| {
        char.is_ascii_alphabetic()
            || char == '_'
            || (at > 0 && (char.is_ascii_digit() || char == '-'))
    });
    if identifier && !name.is_empty() {
        format!("clis.{name}")
    } else {
        format!("clis[{}]", quoted(name))
    }
}

/// A variable name for a problem, quoted and cut after the first `=` in case a value follows it.
fn shown_name(name: &str) -> String {
    let cut = name
        .split_once('=')
        .map(|(before, _)| format!("{before}=…"));
    quoted(cut.as_deref().unwrap_or(name))
}

/// `text` as a JSON string literal, the way problems quote names.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("a string is JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "~/.facade/facade.json";

    /// The entries of a settings file holding `text`.
    fn entries(text: &str) -> Vec<Entry> {
        read(&facade_base::settings::parse(text, FILE).expect("the file reads as a whole"))
    }

    /// The entry `name` of a settings file whose `clis` is `clis`.
    fn entry(name: &str, clis: &str) -> Entry {
        let entries = entries(&format!("{{\"clis\": {clis}}}"));
        find(&entries, name).expect("the entry is there").clone()
    }

    /// What is wrong with the entry `name`, `value` in a file of it alone.
    fn problems(name: &str, value: &str) -> Vec<String> {
        entry(name, &format!("{{{}: {value}}}", quoted(name))).problems
    }

    fn at(column: usize, problem: &str) -> String {
        format!("{FILE}:1:{column}: {problem}")
    }

    /// Every built-in, by its name, its defaults where the file names it not, in the built-ins'
    /// order; then the added CLIs in the file's order (main's configuration tests, as all below).
    #[test]
    fn every_built_in_in_order_then_the_added_clis_in_the_file_s_order() {
        let read = entries(
            r#"{"clis": {"Codex · work": {"type": "codex"}, "pi": {"enabled": false}, "aider": {"type": "custom", "command": "aider"}}}"#,
        );
        let rows: Vec<(&str, &str, &str, bool, bool)> = read
            .iter()
            .map(|entry| {
                (
                    entry.name.as_str(),
                    entry.setting.as_str(),
                    entry.kind.unwrap().id(),
                    entry.enabled,
                    entry.built_in,
                )
            })
            .collect();
        let built_ins = rules().unwrap().len();
        assert_eq!(
            rows[..6],
            [
                ("claude", "clis.claude", "claude", true, true),
                ("codex", "clis.codex", "codex", true, true),
                ("agy", "clis.agy", "agy", true, true),
                ("muse", "clis.muse", "muse", true, true),
                ("opencode", "clis.opencode", "opencode", true, true),
                ("pi", "clis.pi", "pi", false, true),
            ]
        );
        assert_eq!(
            rows[built_ins..],
            [
                (
                    "Codex · work",
                    "clis[\"Codex · work\"]",
                    "codex",
                    true,
                    false
                ),
                ("aider", "clis.aider", "custom", true, false)
            ]
        );
        let settings: Vec<String> = ["codex", "my-cli", "_x1", "my cli", "2", "a.b", "Ünïcode"]
            .map(setting_of)
            .into();
        assert_eq!(
            settings,
            [
                "clis.codex",
                "clis.my-cli",
                "clis._x1",
                "clis[\"my cli\"]",
                "clis[\"2\"]",
                "clis[\"a.b\"]",
                "clis[\"Ünïcode\"]"
            ]
        );
    }

    /// An entry's fields as written: its command, literal args in order, env with null removing,
    /// model, effort and enabled.
    #[test]
    fn an_entry_s_fields_as_written() {
        let codex = entry(
            "codex",
            r#"{"codex": {"program": "/opt/codex", "args": ["--search", "-c", "model_provider=\"qwen\""], "env": {"CODEX_HOME": "/q", "OPENAI_API_KEY": null}, "model": "qwen3", "effort": "high", "enabled": false}}"#,
        );
        assert_eq!(codex.program.as_deref(), Some("/opt/codex"));
        assert_eq!(codex.args, ["--search", "-c", "model_provider=\"qwen\""]);
        assert_eq!(
            codex.env,
            [
                ("CODEX_HOME".to_string(), Some("/q".to_string())),
                ("OPENAI_API_KEY".to_string(), None)
            ]
        );
        assert_eq!(
            (
                codex.model.as_deref(),
                codex.effort.as_deref(),
                codex.enabled,
                codex.problems.len()
            ),
            (Some("qwen3"), Some("high"), false, 0)
        );
    }

    #[test]
    fn reads_legacy_programs_and_reports_conflicting_keys() {
        let legacy = entry("tool", r#"{"tool":{"type":"custom","command":"my tool"}}"#);
        assert_eq!(legacy.program.as_deref(), Some("my tool"));
        assert_eq!(legacy.program_setting(), "clis.tool.command");
        assert!(legacy.problems.is_empty());

        for (clis, column) in [
            (
                r#"{"tool":{"type":"custom","command":"same","program":"same"}}"#,
                52,
            ),
            (
                r#"{"tool":{"type":"custom","program":null,"command":"old"}}"#,
                35,
            ),
        ] {
            let conflict = entry("tool", clis);
            assert!(conflict.program.is_none());
            assert_eq!(
                conflict.problems,
                [at(
                    column,
                    "clis.tool.program conflicts with command. Keep program."
                )]
            );
        }
    }

    /// An added CLI stands alone: it takes nothing from its type's own entry, which stays as it is.
    #[test]
    fn an_added_cli_stands_alone() {
        let clis = r#"{"codex": {"command": "/opt/codex", "args": ["--search"], "env": {"A": "1"}, "model": "m", "enabled": false}, "qwen codex": {"type": "codex"}}"#;
        let added = entry("qwen codex", clis);
        assert_eq!(
            (
                added.program.as_deref(),
                added.args.len(),
                added.env.len(),
                added.model.as_deref(),
                added.enabled
            ),
            (None, 0, 0, None, true)
        );
        assert_eq!(
            (added.kind.unwrap().id(), added.display_name()),
            ("codex", "qwen codex")
        );
        assert_eq!(entry("codex", clis).display_name(), "Codex");
    }

    /// A name cannot be blank, start or end with a space, hold a control character, or be a
    /// built-in's ID or name in any letter case.
    #[test]
    fn a_name_is_seen_has_no_space_at_either_end_no_control_character_and_is_no_built_in_s() {
        let program = r#"{"type": "custom", "command": "x"}"#;
        let cases = [
            ("", "clis[\"\"]: a CLI's name needs a visible character"),
            (
                "\u{200b}",
                "clis[\"\u{200b}\"]: a CLI's name needs a visible character",
            ),
            (
                " padded",
                "clis[\" padded\"]: a CLI's name cannot start or end with a space",
            ),
            (
                "tab\there",
                "clis[\"tab\\there\"]: a CLI's name cannot hold a control character",
            ),
            (
                "CODEX",
                "clis.CODEX: this is Codex's name; choose another name for this CLI",
            ),
            (
                "claude code",
                "clis[\"claude code\"]: this is Claude Code's name; choose another name \
                 for this CLI",
            ),
            (
                "Muse Code",
                "clis[\"Muse Code\"]: this is Muse Code's name; choose another name for this CLI",
            ),
            (
                "Antigravity",
                "clis.Antigravity: this is Antigravity's name; choose another name for this CLI",
            ),
        ];
        for (name, said) in cases {
            assert_eq!(problems(name, program), [at(11, said)], "{name:?}");
        }
        assert!(problems("agy2", program).is_empty());
    }

    /// An entry's type: a built-in's is its own, which type may repeat but not change; an added one
    /// names a built-in or custom, and custom needs a command. A wrong type is said by the types it
    /// can be, never by what it holds.
    #[test]
    fn an_entry_s_type_is_its_built_in_s_or_one_it_names() {
        let read = entries(
            r#"{"clis": {"codex": {"type": "codex"}, "claude": {"type": "custom"}, "a": {}, "b": {"type": "sk-live-1"}, "c": {"type": 7}, "d": {"type": "custom"}}}"#,
        );
        let said: Vec<(&str, &[String])> = read
            .iter()
            .filter(|entry| !entry.problems.is_empty())
            .map(|entry| (entry.name.as_str(), &entry.problems[..]))
            .collect();
        let types = "claude, codex, agy, muse, opencode, pi, custom";
        assert_eq!(
            said,
            [
                (
                    "claude",
                    &[at(
                        58,
                        r#"clis.claude.type cannot change the claude entry's type: it is Claude Code's; set it back to "claude" or remove the line"#
                    ),][..]
                ),
                (
                    "a",
                    &[at(
                        69,
                        &format!("clis.a.type is missing; set it to the CLI it runs: {types}")
                    )][..]
                ),
                (
                    "b",
                    &[at(
                        92,
                        &format!("clis.b.type must be one of {types}; received string")
                    )][..]
                ),
                (
                    "c",
                    &[at(
                        120,
                        &format!("clis.c.type must be one of {types}; received number")
                    )][..]
                ),
                (
                    "d",
                    &[at(
                        124,
                        "clis.d.program is missing; set it to the program to run"
                    )][..]
                ),
            ]
        );
    }

    /// A value of the wrong kind is said by its setting path and its JSON type, in the order read,
    /// and nothing of it is used or replaced by a default.
    #[test]
    fn a_value_of_the_wrong_kind_is_said_by_its_place_and_kind_in_the_order_read() {
        let pi = entry(
            "pi",
            r#"{"pi": {"type": "pi", "command": "   ", "args": ["ok", 2, "nul\u0000"], "env": {"GOOD": "x", "BAD": 1, "": "y", "TOKEN=sk-live": "z", "NUL": "a\u0000"}, "model": 7, "effort": "", "enabled": "yes", "trust": true}}"#,
        );
        assert_eq!(
            pi.problems,
            [
                at(
                    207,
                    "clis.pi.trust is not a field of an entry, which takes type, icon, program, args, \
                 env, model, effort, enabled"
                ),
                at(43, "clis.pi.command is empty; set it, or leave it out"),
                at(65, "clis.pi.args[1] must be a string; received number"),
                at(
                    68,
                    "clis.pi.args[2] contains a NUL character, which is not permitted in arguments"
                ),
                at(
                    110,
                    "clis.pi.env.BAD must be a string or null; received number"
                ),
                at(
                    113,
                    "clis.pi.env contains invalid environment variable name \"\""
                ),
                at(
                    122,
                    "clis.pi.env contains invalid environment variable name \"TOKEN=…\""
                ),
                at(
                    151,
                    "clis.pi.env.NUL contains a NUL character, which is not permitted in \
                 environment variables"
                ),
                at(172, "clis.pi.model must be a string; received number"),
                at(185, "clis.pi.effort is empty; set it, or leave it out"),
                at(
                    200,
                    "clis.pi.enabled must be true or false; received string"
                ),
            ]
        );
        assert_eq!(
            (
                pi.program,
                pi.args.len(),
                pi.env.len(),
                pi.model,
                pi.effort,
                pi.enabled
            ),
            (None, 0, 0, None, None, true)
        );
        assert!(!pi.problems.concat().contains("sk-live"));
        assert_eq!(
            problems("codex", "[]"),
            [at(
                20,
                "clis.codex must be an object of type, icon, program, args, env, model, effort and \
                 enabled; received array"
            )]
        );
        assert_eq!(
            problems("codex", r#"{"args": "--search", "env": null}"#),
            [
                at(
                    29,
                    "clis.codex.args must be an array of strings; received string"
                ),
                at(
                    48,
                    "clis.codex.env must be an object of variable names to strings or null; \
                 received null"
                )
            ]
        );
        assert_eq!(
            problems("codex", r#"{"env": ["A=1"]}"#),
            [at(
                28,
                "clis.codex.env must be an object of variable names to strings or null; \
                 received array"
            )]
        );
    }

    /// Model and effort are taken by the built-ins that take them; OpenCode sets both in its own
    /// configuration, and a program takes options in args alone.
    #[test]
    fn model_and_effort_are_taken_by_the_built_ins_that_take_them() {
        let clis = r#"{"opencode": {"model": "x"}, "pi": {"model": "p", "effort": "high"}, "tool": {"type": "custom", "command": "tool", "effort": "high"}, "oc": {"type": "opencode", "effort": "low"}}"#;
        let rows: Vec<(Option<String>, Option<String>, Vec<String>)> =
            ["opencode", "pi", "tool", "oc"]
                .iter()
                .map(|name| entry(name, clis))
                .map(|entry| (entry.model, entry.effort, entry.problems))
                .collect();
        assert_eq!(
            rows,
            [
                (
                    None,
                    None,
                    vec![at(
                        33,
                        "clis.opencode.model is not taken by OpenCode, which sets it in its own \
                         configuration"
                    )]
                ),
                (Some("p".into()), Some("high".into()), vec![]),
                (
                    None,
                    None,
                    vec![at(
                        135,
                        "clis.tool.effort is not taken by a program: give its own options in args"
                    )]
                ),
                (
                    None,
                    None,
                    vec![at(
                        181,
                        "clis.oc.effort is not taken by OpenCode, which sets it in its own \
                         configuration"
                    )]
                ),
            ]
        );
    }

    /// An icon is a built-in's own or one of Facade's robots, said by the icons there are and never
    /// by what it holds; without one an entry shows its type's, a program the whitest robot.
    #[test]
    fn an_icon_is_a_built_in_s_or_a_robot() {
        let clis = r#"{"codex": {"icon": "facade-sky"}, "claude": {"icon": "claude"}, "pi": {"icon": "facade-cyan"}, "muse": {"icon": 7}, "mine": {"type": "custom", "command": "mine", "icon": "codex"}, "other": {"type": "codex"}, "tool": {"type": "custom", "command": "tool"}}"#;
        let icons = [
            &["claude", "codex", "agy", "muse", "opencode", "pi"][..],
            &ROBOTS,
        ]
        .concat()
        .join(", ");
        let rows: Vec<(String, Vec<String>)> = [
            "claude", "codex", "agy", "muse", "pi", "mine", "other", "tool",
        ]
        .iter()
        .map(|name| entry(name, clis))
        .map(|entry| (entry.icon, entry.problems))
        .collect();
        assert_eq!(
            rows,
            [
                ("claude".into(), vec![]),
                ("facade-sky".into(), vec![]),
                ("agy".into(), vec![]),
                (
                    "muse".into(),
                    vec![at(
                        122,
                        &format!("clis.muse.icon must be one of {icons}; received number")
                    )]
                ),
                (
                    "pi".into(),
                    vec![at(
                        89,
                        &format!("clis.pi.icon must be one of {icons}; received string")
                    )]
                ),
                ("codex".into(), vec![]),
                ("codex".into(), vec![]),
                ("facade-pearl".into(), vec![]),
            ]
        );
    }

    /// One entry wrong leaves it alone unavailable: every other CLI reads as it would without it.
    /// An added CLI of a built-in's type has its type's rules for its arguments; a program's are
    /// its own, passed unchanged, an empty one too.
    #[test]
    fn one_entry_wrong_leaves_the_others_and_a_program_s_args_are_its_own() {
        let read = entries(
            r#"{"clis": {
  "codex": { "env": {"LABEL": "🐾"}, "args": [42] },
  "mine": {"type": "custom", "command": "mine"}
}}"#,
        );
        let wrong: Vec<&str> = read
            .iter()
            .filter(|entry| !entry.problems.is_empty())
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(wrong, ["codex"]);
        let folder = Path::new("project");
        let env = BTreeMap::new();
        let invalid = select(&read, "codex", folder, &env).unwrap_err();
        assert_eq!(invalid.data.reason, Reason::InvalidSettings);
        assert_eq!(invalid.data.entry.as_deref(), Some("codex"));
        assert_eq!(
            invalid.message,
            format!("{FILE}:2:47: clis.codex.args[0] must be a string; received number")
        );
        assert_eq!(select(&read, "mine", folder, &env).unwrap().name, "mine");
        let clis = r#"{"tool": {"type": "custom", "command": "tool", "args": ["run", "--yolo", "--", "x", ""]}, "mine": {"type": "codex", "args": ["--yolo"]}}"#;
        let (tool, mine) = (entry("tool", clis), entry("mine", clis));
        assert_eq!(
            (tool.args, tool.problems),
            (
                ["run", "--yolo", "--", "x", ""].map(String::from).to_vec(),
                vec![]
            )
        );
        assert_eq!(
            mine.problems,
            [at(
                135,
                "clis.mine.args[0] is --yolo, which Facade sets or decides itself; remove it"
            )]
        );
    }

    /// An entry's `env` is read from the environment it starts with: each `${env:NAME}` once, a
    /// missing one a problem never read as empty, an empty one empty; a null removes its variable;
    /// a value it sets does not supply a reference of its own.
    #[test]
    fn an_entry_s_env_reads_the_environment_it_starts_with() {
        let codex = entry(
            "codex",
            r#"{"codex": {"env": {"API_TOKEN": "${env:WORK_TOKEN}/${env:EMPTY}", "OLD_TOKEN": null, "WORK_TOKEN": "abc", "LOOP": "${env:LOOP}x"}}}"#,
        );
        let start: BTreeMap<String, String> = [
            ("WORK_TOKEN", "t"),
            ("EMPTY", ""),
            ("OLD_TOKEN", "o"),
            ("LOOP", "${env:LOOP}"),
        ]
        .map(|(name, value)| (name.into(), value.into()))
        .into();
        assert!(codex.problems_with(&start).is_empty());
        let started = codex.environment(&start);
        assert_eq!(started.get("API_TOKEN").map(String::as_str), Some("t/"));
        assert_eq!(
            (
                started.get("OLD_TOKEN"),
                started.get("WORK_TOKEN").map(String::as_str)
            ),
            (None, Some("abc"))
        );
        assert_eq!(
            started.get("LOOP").map(String::as_str),
            Some("${env:LOOP}x"),
            "read once"
        );
        // A reference reads the start's own variable, never one an earlier variable of the same
        // `env` set
        let earlier = entry(
            "codex",
            r#"{"codex": {"env": {"A": "entry", "B": "${env:A}"}}}"#,
        );
        let host = BTreeMap::from([("A".to_string(), "host".to_string())]);
        assert_eq!(
            earlier.environment(&host).get("B").map(String::as_str),
            Some("host")
        );
        let bare = BTreeMap::from([("LOOP".to_string(), String::new())]);
        assert_eq!(
            codex.problems_with(&bare),
            [
                at(
                    42,
                    "clis.codex.env.API_TOKEN reads ${env:WORK_TOKEN}, but WORK_TOKEN is not in the \
                 environment it starts with; set it there, or write the value"
                ),
                at(
                    42,
                    "clis.codex.env.API_TOKEN reads ${env:EMPTY}, but EMPTY is not in the environment \
                 it starts with; set it there, or write the value"
                ),
            ]
        );
    }

    /// A start's model and effort win over its entry's, each on its own, and a choice the start's
    /// own words make is theirs; a type that takes none refuses a start's choice.
    #[test]
    fn a_start_s_choice_wins_and_a_type_without_one_refuses_it() {
        let codex = entry(
            "codex",
            r#"{"codex": {"model": "my-model", "effort": "high", "args": ["--search"]}}"#,
        );
        assert_eq!(
            codex.choices(None, Some("low"), &[]),
            [
                "--model",
                "my-model",
                "-c",
                "model_reasoning_effort=\"low\""
            ]
        );
        assert_eq!(codex.choice_refusal(Some("m"), Some("low"), true), None);
        // The start's own words choose: they carry the choice, and the entry's for it is not added
        let words = |words: &[&str]| {
            words
                .iter()
                .map(|word| word.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            codex.choices(None, None, &words(&["-m", "gpt-b"])),
            ["-c", "model_reasoning_effort=\"high\""]
        );
        assert_eq!(
            codex.choices(None, None, &words(&["-c", "model_reasoning_effort=low"])),
            ["--model", "my-model"]
        );
        assert_eq!(
            codex.choices(None, None, &words(&["--search", "--", "-m", "x"])),
            [
                "--model",
                "my-model",
                "-c",
                "model_reasoning_effort=\"high\""
            ]
        );
        assert_eq!(
            entry("opencode", "{}")
                .choice_refusal(None, Some("low"), true)
                .as_deref(),
            Some("OpenCode takes no explicit effort; leave `effort` out to use its default.")
        );
        assert_eq!(
            entry("tool", r#"{"tool": {"type": "custom", "command": "tool"}}"#)
                .choice_refusal(Some("m"), None, false)
                .as_deref(),
            Some("tool has no supported way to set a model; omit model to use its own default")
        );

        let replay = codex.launch_options(None, Some("low"), &[]).unwrap();
        assert_eq!(
            replay,
            LaunchOptions {
                args: words(&[
                    "--model",
                    "my-model",
                    "-c",
                    r#"model_reasoning_effort="low""#,
                    "--search"
                ]),
                model: Some("my-model".into()),
                effort: Some("low".into()),
            }
        );
        let cli = [
            "-xmgpt-b",
            "-c",
            r#"model="gpt-c""#,
            "-cmodel_reasoning_effort=high",
        ];
        let replay = codex
            .launch_options(None, Some("low"), &words(&cli))
            .unwrap();
        let configured = ["-c", r#"model_reasoning_effort="low""#, "--search"];
        assert_eq!(replay.args, words(&[configured.as_slice(), &cli].concat()));
        assert_eq!(replay.model.as_deref(), Some("gpt-b"));
        assert_eq!(replay.effort.as_deref(), Some("high"));
        let saved = serde_json::to_value(&replay).unwrap();
        assert_eq!(
            saved,
            serde_json::json!({ "args": replay.args, "model": "gpt-b", "effort": "high" })
        );
        assert_eq!(
            serde_json::from_value::<LaunchOptions>(saved).unwrap(),
            replay
        );
        assert_eq!(
            entry("opencode", "{}")
                .launch_options(None, Some("low"), &[])
                .unwrap_err()
                .data
                .reason,
            Reason::Unsupported
        );
    }
}
