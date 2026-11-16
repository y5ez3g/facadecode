//! How each CLI reports a run's session to Facade: Claude Code through a session-start hook in
//! `--settings`, Codex through one in a `-c hooks=` override, Muse Code through one in its
//! `-c hooks=` beside its tools' hooks, Antigravity through the title command of its `--settings`,
//! OpenCode through a plugin of the run's in its CLI configuration, Pi through an extension of the
//! run's, given with `-e`, and the test CLI through its environment. Settings the person passed are
//! merged with Facade's and taken out of the person's words; settings Facade cannot read are left
//! as they are, and the run then reports no session.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::Wiring;
use super::config_files::config_home;
use super::settings::{spans, values, without};
use crate::Rule;
use crate::args::ArgsGrammar;
use crate::formats::{inline_toml, merge_settings, parse_jsonc, shell_word};

/// Where a run's CLI reports the session it selects: the run's session file, which `facade`, this
/// program, writes for the CLI's hooks, and which a plugin or extension of the run's writes itself.
#[derive(Clone, Copy, Debug)]
pub struct SessionReport<'a> {
    /// This program, which the CLI's hooks run.
    pub facade: &'a str,
    /// The run's session file, in the run's folder.
    pub file: &'a Path,
    /// The folder the run's CLI starts in, which settings files the person names may be relative
    /// to.
    pub cwd: &'a Path,
}

impl SessionReport<'_> {
    /// `facade hook <command> <session file>`, each word quoted for the shell.
    fn facade_hook(&self, command: &str) -> String {
        let file = shell_word(&self.file.to_string_lossy());
        format!("{} hook {command} {file}", shell_word(self.facade))
    }

    /// The shell command of a CLI's session-start hook.
    pub(super) fn hook(&self) -> String {
        self.facade_hook("session-start")
    }

    /// The shell command of Antigravity's title command, which writes the session from the title's
    /// input. The person's own title command follows it as one more word, where they have one.
    pub(super) fn title(&self) -> String {
        self.facade_hook("title")
    }

    /// The run's folder, which the session file is in.
    pub(crate) fn folder(&self) -> &Path {
        self.file.parent().unwrap_or(Path::new("/"))
    }
}

/// What having the CLI report its session through a hook, plugin or extension adds, and the
/// person's words that remain.
pub(crate) struct Hooked {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    /// Files in the run's folder: each name and its text.
    pub(crate) files: Vec<(String, String)>,
    pub(crate) rest: Vec<String>,
}

/// The variable that gives the test CLI its session-start hook.
const FAKE_HOOK: &str = "FAKECLI_SESSION_HOOK";
/// OpenCode's CLI configuration for one start, read after its configuration files.
const OPENCODE_CLI_CONFIG: &str = "OPENCODE_CLI_CONFIG_CONTENT";
/// The folder, in the run's folder, of the plugin that reports an OpenCode run's session.
const OPENCODE_PLUGIN: &str = "facade-session";
/// The extension, in the run's folder, that reports a Pi run's session.
const PI_EXTENSION: &str = "facade-session.mjs";

/// Has `rule`'s CLI report its session as `session` says, with what `wiring` gives the tools: its
/// settings added to Claude Code's run settings, and the skill given by Codex's hook where it asks.
/// `words` are the person's, `environment` the CLI's own. None for a CLI that reports none this way,
/// and where the person's own settings that Facade adds to cannot be read.
pub(crate) fn install_hook(
    rule: &Rule,
    words: &[String],
    session: &SessionReport,
    wiring: &Wiring,
    environment: &BTreeMap<String, String>,
) -> Option<Hooked> {
    let adding = |args, env, files| {
        Some(Hooked {
            args,
            env,
            files,
            rest: words.to_vec(),
        })
    };
    match rule.cli.as_str() {
        "claude" => claude_settings(
            &rule.arguments,
            words,
            &session.hook(),
            wiring.settings.as_ref(),
        ),
        "codex" => {
            let hook = match wiring.session_skill {
                true => format!("{} --skill", session.hook()),
                false => session.hook(),
            };
            codex_hooks(&rule.arguments, words, &hook)
        }
        "opencode" => opencode_plugin(words, session, environment),
        "pi" => {
            let file = session.folder().join(PI_EXTENSION);
            let args = vec!["-e".into(), file.to_string_lossy().into_owned()];
            adding(
                args,
                Vec::new(),
                vec![(PI_EXTENSION.into(), pi_extension(session.file))],
            )
        }
        "fake" => adding(
            Vec::new(),
            vec![(FAKE_HOOK.into(), session.hook())],
            Vec::new(),
        ),
        _ => None,
    }
}

/// Takes out of `env` what had `cli` report its session: the test CLI's hook, and the plugin in
/// OpenCode's CLI configuration, so that a CLI started with this environment never reports to this
/// run's session file.
pub(super) fn unhook(cli: &str, env: &mut BTreeMap<String, String>) {
    match cli {
        "fake" => drop(env.remove(FAKE_HOOK)),
        "opencode" => {
            let config = env
                .get(OPENCODE_CLI_CONFIG)
                .and_then(|text| serde_json::from_str(text).ok());
            let Some(mut config): Option<Value> = config else {
                return;
            };
            let Some(plugins) = config.get_mut("plugins").and_then(Value::as_array_mut) else {
                return;
            };
            let ours = |plugin: &Value| {
                let name = plugin.as_str().and_then(|path| Path::new(path).file_name());
                name.is_some_and(|name| name == OPENCODE_PLUGIN)
            };
            plugins.retain(|plugin| !ours(plugin));
            env.insert(OPENCODE_CLI_CONFIG.into(), config.to_string());
        }
        _ => {}
    }
}

/// Claude Code takes one `--settings` JSON value, whose hooks run beside those of the person's
/// settings files. A `--settings` of the person's own, given as a JSON object, gets Facade's hook
/// added to its `SessionStart` groups, and `extra`, what the tools and YOLO add, merged in.
fn claude_settings(
    grammar: &ArgsGrammar,
    words: &[String],
    hook: &str,
    extra: Option<&Value>,
) -> Option<Hooked> {
    // Read as Claude Code reads them: never another option's value, as the text of
    // `--append-system-prompt --settings=…`.
    let found = grammar.found(words, "--settings");
    let mut settings = match values(&found)?.as_slice() {
        [] => json!({}),
        [value] => serde_json::from_str::<Value>(value)
            .ok()
            .filter(Value::is_object)?,
        _ => return None,
    };
    let hooks = settings
        .as_object_mut()?
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let groups = hooks
        .as_object_mut()?
        .entry("SessionStart")
        .or_insert_with(|| json!([]));
    let ours = json!({ "hooks": [{ "type": "command", "command": hook }] });
    groups.as_array_mut()?.push(ours);
    if let Some(extra) = extra {
        merge_settings(&mut settings, extra);
    }
    Some(Hooked {
        args: vec!["--settings".into(), settings.to_string()],
        env: Vec::new(),
        files: Vec::new(),
        rest: without(words, spans(&found)),
    })
}

/// Codex reads `-c hooks=...` and `-c hooks.<key>=...` overrides into one layer, and trusts a hook
/// in it only where the layer's `state` holds the SHA-256 of the hook's definition at its group's
/// place. The person's hook overrides are merged into one `hooks` table with Facade's group added
/// last to `SessionStart`, and its trust recorded, so every other hook keeps its own.
fn codex_hooks(grammar: &ArgsGrammar, words: &[String], hook: &str) -> Option<Hooked> {
    let mut hooks = toml::Table::new();
    let mut taken = Vec::new();
    // Read as Codex reads them: `-chooks=` and `--config=hooks=` too, and never another option's
    // value.
    let overrides = grammar.overrides(words)?.into_iter();
    for given in overrides.filter(|given| given.key == "hooks" || given.key.starts_with("hooks.")) {
        let parsed: toml::Table =
            toml::from_str(&format!("value={}", given.value.as_deref()?)).ok()?;
        let value = parsed.get("value")?.clone();
        match given.key.strip_prefix("hooks.") {
            Some(path) => set_path(&mut hooks, path, value)?,
            None => hooks = value.as_table()?.clone(),
        }
        taken.push((given.index, given.span));
    }
    let mut groups = match hooks.remove("SessionStart") {
        Some(toml::Value::Array(groups)) => groups,
        Some(_) => return None,
        None => Vec::new(),
    };
    let mut state = match hooks.remove("state") {
        Some(toml::Value::Table(state)) => state,
        _ => toml::Table::new(),
    };
    // Codex hashes the definition as it reads it, in this form.
    let definition = json!({
        "event_name": "session_start",
        "hooks": [{ "async": false, "command": hook, "timeout": 5, "type": "command" }],
    });
    let digest = Sha256::digest(definition.to_string().as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut trust = toml::Table::new();
    trust.insert("enabled".into(), toml::Value::Boolean(true));
    trust.insert(
        "trusted_hash".into(),
        toml::Value::String(format!("sha256:{hex}")),
    );
    let place = format!(
        "/<session-flags>/config.toml:session_start:{}:0",
        groups.len()
    );
    state.insert(place, toml::Value::Table(trust));
    let mut ours = toml::Table::new();
    ours.insert("type".into(), "command".into());
    ours.insert("command".into(), hook.into());
    ours.insert("timeout".into(), toml::Value::Integer(5));
    let mut group = toml::Table::new();
    group.insert(
        "hooks".into(),
        toml::Value::Array(vec![toml::Value::Table(ours)]),
    );
    groups.push(group.into());
    hooks.insert("SessionStart".into(), groups.into());
    hooks.insert("state".into(), state.into());
    let inline = inline_toml(&hooks.into())?;
    Some(Hooked {
        args: vec!["-c".into(), format!("hooks={inline}")],
        env: Vec::new(),
        files: Vec::new(),
        rest: without(words, taken.iter().copied()),
    })
}

/// Sets `value` at a dotted `path` in `table`, replacing anything on the way that is not a table.
/// None for a path with quotes or an empty key, which Facade does not read.
fn set_path(table: &mut toml::Table, path: &str, value: toml::Value) -> Option<()> {
    let keys: Vec<&str> = path.split('.').map(str::trim).collect();
    if keys
        .iter()
        .any(|key| key.is_empty() || key.contains(['"', '\'']))
    {
        return None;
    }
    let (last, parents) = keys.split_last()?;
    let mut at = table;
    for key in parents {
        let next = at.entry(*key).or_insert_with(|| toml::Table::new().into());
        if !next.is_table() {
            *next = toml::Table::new().into();
        }
        at = next.as_table_mut()?;
    }
    at.insert(last.to_string(), value);
    Some(())
}

/// OpenCode reports its session through a plugin of the run's, which its CLI configuration for the
/// start names. OpenCode replaces a list of its CLI configuration whole, so the plugins the
/// person's own configuration names come along, and the run's goes last: from their
/// `OPENCODE_CLI_CONFIG_CONTENT`, else from their `cli.json`, else from the `tui.json` that came
/// before it. A configuration Facade cannot read stays as it is, and the run reports no session.
fn opencode_plugin(
    words: &[String],
    session: &SessionReport,
    environment: &BTreeMap<String, String>,
) -> Option<Hooked> {
    // OpenCode takes its configuration folder only as an absolute path.
    let folder = config_home(environment)
        .filter(|folder| folder.is_absolute())?
        .join("opencode");
    let cli_file = folder.join("cli.json");
    let config = config_object(&cli_file)?;
    let legacy = match cli_file.exists() {
        true => json!({}),
        false => config_object(&folder.join("tui.json"))?,
    };
    let given = environment
        .get(OPENCODE_CLI_CONFIG)
        .filter(|text| !text.trim().is_empty());
    let mut overlay = match given {
        Some(text) => parse_jsonc(text).ok().filter(Value::is_object)?,
        None => json!({}),
    };
    let mut plugins = match overlay.get("plugins").or(config.get("plugins")) {
        Some(theirs) => theirs.as_array()?.clone(),
        None => legacy_plugins(&legacy)?,
    };
    plugins.push(json!(
        session.folder().join(OPENCODE_PLUGIN).to_string_lossy()
    ));
    overlay
        .as_object_mut()?
        .insert("plugins".into(), Value::Array(plugins));
    let manifest = json!({
        "name": OPENCODE_PLUGIN, "type": "module", "exports": { "./tui": "./tui.mjs" },
    });
    let files = vec![
        (
            format!("{OPENCODE_PLUGIN}/package.json"),
            manifest.to_string(),
        ),
        (
            format!("{OPENCODE_PLUGIN}/tui.mjs"),
            opencode_plugin_text(session.file),
        ),
    ];
    let env = vec![(OPENCODE_CLI_CONFIG.into(), overlay.to_string())];
    Some(Hooked {
        args: Vec::new(),
        env,
        files,
        rest: words.to_vec(),
    })
}

/// A configuration file read as OpenCode reads it, comments and trailing commas allowed: an object,
/// or an empty one for a file that is not there. None for one that cannot be read, or holds no
/// object.
fn config_object(path: &Path) -> Option<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_jsonc(&text).ok().filter(Value::is_object),
        Err(err) if err.kind() == ErrorKind::NotFound => Some(json!({})),
        Err(_) => None,
    }
}

/// The plugins of OpenCode's `tui.json`, as its CLI configuration names them: each of `plugin`, a
/// name or a name and its options, and each of `plugin_enabled`, its name, or `-` and its name
/// where it is turned off.
fn legacy_plugins(legacy: &Value) -> Option<Vec<Value>> {
    let named = |item: &Value| match item.as_array().map(Vec::as_slice) {
        Some([name, options]) => json!({ "package": name, "options": options }),
        _ => item.clone(),
    };
    let mut plugins: Vec<Value> = match legacy.get("plugin") {
        Some(Value::Array(items)) => items.iter().map(named).collect(),
        Some(_) => return None,
        None => Vec::new(),
    };
    let enabled = legacy
        .get("plugin_enabled")
        .and_then(Value::as_object)
        .into_iter()
        .flatten();
    plugins.extend(enabled.map(|(name, on)| match on.as_bool() {
        Some(true) => json!(name),
        _ => json!(format!("-{name}")),
    }));
    Some(plugins)
}

/// Pi's extension that reports its session: on each `session_start` - its start, a new session, a
/// resume, a fork - the session's ID and the file Pi saves it in, which it writes once the session
/// has a message. A session it cannot name is no session.
fn pi_extension(file: &Path) -> String {
    format!(
        r#"// Facade Code: reports this run's Pi session to Facade
import fs from 'node:fs';
import path from 'node:path';
const file = {file};
// Replaces the run's session file whole, by a rename.
function write(text) {{
	try {{
		const temporary = path.join(path.dirname(file), `.session.pi.${{process.pid}}`);
		fs.writeFileSync(temporary, text, {{ mode: 0o600 }});
		fs.renameSync(temporary, file);
	}} catch {{}}
}}
export default function (pi) {{
	pi.on('session_start', (_event, ctx) => {{
		const id = ctx.sessionManager.getSessionId();
		const saved = ctx.sessionManager.getSessionFile();
		const named = typeof id === 'string' && /^[0-9a-f]{{8}}(-[0-9a-f]{{4}}){{3}}-[0-9a-f]{{12}}$/.test(id);
		const kept = typeof saved === 'string' && path.isAbsolute(saved) && !/[\r\n]/.test(saved);
		write(named && kept ? `${{id}}\n${{saved}}\n` : '');
	}});
}}
"#,
        file = json!(file.to_string_lossy())
    )
}

/// OpenCode's plugin that reports its session: the session its terminal shows, read from its route
/// five times a second, as OpenCode tells no plugin when it changes. OpenCode saves a session as it
/// makes it.
fn opencode_plugin_text(file: &Path) -> String {
    format!(
        r#"// Facade Code: reports this run's OpenCode session to Facade
import fs from 'node:fs';
import path from 'node:path';
const file = {file};
// Replaces the run's session file whole, by a rename.
function write(text) {{
	try {{
		const temporary = path.join(path.dirname(file), `.session.opencode.${{process.pid}}`);
		fs.writeFileSync(temporary, text, {{ mode: 0o600 }});
		fs.renameSync(temporary, file);
		return true;
	}} catch {{
		return false;
	}}
}}
export default {{
	id: 'facade.session',
	setup(ctx) {{
		let last;
		const report = () => {{
			try {{
				const route = ctx.ui.router.current();
				// A plugin's own page shows no session, and leaves the session as it was.
				if (route.type === 'plugin') return;
				const id = route.type === 'session' && /^ses_[A-Za-z0-9]{{1,64}}$/.test(route.sessionID) ? route.sessionID : '';
				if (id !== last && write(id ? `${{id}}\n` : '')) last = id;
			}} catch {{}}
		}};
		report();
		const timer = setInterval(report, 200);
		timer.unref?.();
		return () => clearInterval(timer);
	}},
}};
"#,
        file = json!(file.to_string_lossy())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pi's extension writes the session Pi starts and the file Pi saves it in, and no session
    /// where it cannot name both.
    #[test]
    fn pi_s_extension_writes_each_session_pi_starts() {
        let folder = crate::test_folder::TestFolder::new("rules-piextension");
        let (session, extension) = (folder.join("session"), folder.join("facade-session.mjs"));
        std::fs::write(&extension, pi_extension(&session)).unwrap();
        let script = format!(
            r#"import fs from 'node:fs';
			const extension = (await import({module})).default;
			let start;
			extension({{ on: (event, handler) => {{ if (event === 'session_start') start = handler; }} }});
			const read = () => fs.readFileSync({file}, 'utf8');
			const started = (id, file) => start({{}}, {{ sessionManager: {{ getSessionId: () => id, getSessionFile: () => file }} }});
			started('0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '/pi/sessions/one.jsonl');
			if (read() !== '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n/pi/sessions/one.jsonl\n') throw new Error(read());
			started('0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', undefined);
			if (read() !== '') throw new Error('a session Pi does not save is none: ' + read());
			started('not an id', '/pi/sessions/two.jsonl');
			if (read() !== '') throw new Error(read());
			if (fs.readdirSync({folder}).length !== 2) throw new Error('a temporary file is left');"#,
            module = json!(format!("file://{}", extension.display())),
            file = json!(session),
            folder = json!(folder.as_ref() as &Path),
        );
        if crate::test_folder::run_with_node(&script) {
            assert_eq!(std::fs::read_to_string(&session).unwrap(), "", "no session");
        }
    }

    /// OpenCode's plugin writes the session its terminal shows, a page of a plugin's leaving it as
    /// it was, and no session away from one.
    #[test]
    fn opencode_s_plugin_writes_the_session_its_terminal_shows() {
        let folder = crate::test_folder::TestFolder::new("rules-opencodeplugin");
        let (session, plugin) = (folder.join("session"), folder.join("tui.mjs"));
        std::fs::write(&plugin, opencode_plugin_text(&session)).unwrap();
        let script = format!(
            r#"import fs from 'node:fs';
			let report;
			globalThis.setInterval = callback => {{ report = callback; return {{ unref() {{}} }}; }};
			const plugin = (await import({module})).default;
			let route = {{ type: 'home' }};
			plugin.setup({{ ui: {{ router: {{ current: () => route }} }} }});
			const read = () => fs.readFileSync({file}, 'utf8');
			if (read() !== '') throw new Error('home shows no session: ' + read());
			route = {{ type: 'session', sessionID: 'ses_2b9cfe1a7dffRm6kVzQe7xXn3d' }}; report();
			if (read() !== 'ses_2b9cfe1a7dffRm6kVzQe7xXn3d\n') throw new Error(read());
			route = {{ type: 'plugin', name: 'storybook' }}; report();
			if (read() !== 'ses_2b9cfe1a7dffRm6kVzQe7xXn3d\n') throw new Error('a plugin page keeps the session: ' + read());
			route = {{ type: 'home' }}; report();
			if (read() !== '') throw new Error(read());"#,
            module = json!(format!("file://{}", plugin.display())),
            file = json!(session),
        );
        crate::test_folder::run_with_node(&script);
    }
}
