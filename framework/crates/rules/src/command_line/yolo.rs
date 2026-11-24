//! YOLO's work options and the startup options for an agent start with YOLO on.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::Value;

use crate::Pattern;
use crate::formats::toml_string;
use facade_base::system::{SYSTEM, System};

/// The folder as `${folder_toml}` writes it: on Windows with `A`-`Z` in lower case, as Codex keys
/// a project there.
fn toml_folder(path: &str) -> String {
    match SYSTEM {
        System::Windows => path.to_ascii_lowercase(),
        System::Unix => path.to_string(),
    }
}

/// Matches the two ways a rule writes the start's folder: `${folder}` and `${folder_toml}`.
static FOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{folder(_toml)?\}").expect("the folder pattern is valid"));

/// The trust question of a CLI that accepts trust for a folder only on its screen. All patterns
/// are tried on single screen lines, trailing spaces removed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustQuestion {
    /// Matches some line of the question, so Facade knows it is on screen.
    pub shown: Pattern,
    /// Matches the trusting answer, with or without the selection on it.
    pub answer: Pattern,
    /// Matches the trusting answer only while it is selected.
    pub selected: Pattern,
    /// Pressed in order, these bring the selection from the first answer to the trusting one.
    pub keys: Vec<String>,
    /// Pressed last, this gives the selected answer.
    pub confirm: String,
}

/// The `yolo` section of a rule. Each part is optional and empty by default.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct YoloRule {
    pub(crate) work: RunOptions,
    pub(crate) startup: RunOptions,
    /// Present only for a CLI that cannot be told to trust the folder any other way.
    pub question: Option<TrustQuestion>,
}

impl YoloRule {
    pub(crate) fn check(&self) -> Result<(), String> {
        self.work.check("yolo.work")?;
        self.startup.check("yolo.startup")?;
        let empty_key = self.question.as_ref().is_some_and(|question| {
            question.confirm.is_empty() || question.keys.iter().any(String::is_empty)
        });
        if empty_key {
            return Err("yolo.question names an empty key".into());
        }
        Ok(())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct RunOptions {
    /// Arguments with the folder filled in: `${folder}` as a plain path, `${folder_toml}`
    /// quoted for TOML.
    pub args: Vec<String>,
    /// An object merged over the person's run settings, for the CLIs Facade passes run settings
    /// to, such as Claude Code and Antigravity with `--settings`. Its keys win; its lists add to
    /// the person's. The folder is filled into its strings.
    pub settings: Option<Value>,
    pub env: BTreeMap<String, String>,
}

impl RunOptions {
    /// The extra arguments for a start in `folder`.
    pub(crate) fn args(&self, folder: &Path) -> Vec<String> {
        let path = folder.to_string_lossy();
        let resolved = self
            .args
            .iter()
            .any(|arg| arg.contains("${folder_toml}"))
            .then(|| facade_base::files::real_path(folder).ok())
            .flatten();
        let resolved = resolved.as_deref().unwrap_or(folder).to_string_lossy();
        let quoted = toml_string(&toml_folder(&resolved));
        let fill = |arg: &String| with_folder(arg, &path, &quoted);
        self.args.iter().map(fill).collect()
    }

    /// The extra run settings for a start in `folder`, if the rule has any.
    pub(crate) fn settings(&self, folder: &Path) -> Option<Value> {
        let path = folder.to_string_lossy();
        let mut settings = self.settings.clone()?;
        for_each_string(&mut settings, &mut |text| {
            *text = with_folder(text, &path, &path)
        });
        Some(settings)
    }

    /// Rejects a section the rest of this module could not use as written.
    fn check(&self, section: &str) -> Result<(), String> {
        let open_placeholder =
            |arg: &&String| arg.contains('\0') || FOLDER.replace_all(arg, "").contains("${");
        if let Some(arg) = self.args.iter().find(open_placeholder) {
            return Err(format!(
                "{section} argument {arg:?} must be literal text without NUL, with only ${{folder}} \
                 or ${{folder_toml}} to fill in"
            ));
        }
        if matches!(&self.settings, Some(settings) if !settings.is_object()) {
            return Err(format!("{section}.settings must be an object"));
        }
        Ok(())
    }
}

/// `text` with each `${folder}` replaced by `path` and each `${folder_toml}` by `quoted`. A path
/// that itself holds a placeholder is not filled again.
fn with_folder(text: &str, path: &str, quoted: &str) -> String {
    let pick = |found: &Captures| if found.get(1).is_some() { quoted } else { path }.to_string();
    FOLDER.replace_all(text, pick).into_owned()
}

/// Calls `change` on every string anywhere inside `value`.
fn for_each_string(value: &mut Value, change: &mut impl FnMut(&mut String)) {
    match value {
        Value::String(text) => change(text),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| for_each_string(item, change)),
        Value::Object(members) => {
            members
                .values_mut()
                .for_each(|item| for_each_string(item, change));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::formats::merge_settings;

    /// A folder with dots, as every `.worktrees` folder has, both quotes, a backslash, a space and
    /// a control character.
    const FOLDER_TEXT: &str = "/work/app.worktrees/it's \"quoted\" \\ here\u{7f}";

    fn rule(text: Value) -> RunOptions {
        serde_json::from_value(text).unwrap()
    }

    /// The folder fills its placeholders whole, as a TOML string where the argument asks for one:
    /// a TOML parser reads the folder itself back as the key of Codex's `projects` table, whatever
    /// dots and quotes it holds.
    #[test]
    fn the_folder_fills_the_arguments_as_it_is_or_as_a_toml_string() {
        let codex = rule(json!({
            "args": [
                "--bypass", "-c", "projects={ ${folder_toml} = { trust_level = \"trusted\" } }",
                "--at=${folder}",
            ],
        }));
        let args = codex.args(Path::new(FOLDER_TEXT));
        assert_eq!(args[..2], ["--bypass", "-c"]);
        assert_eq!(args[3], format!("--at={FOLDER_TEXT}"));
        let table: toml::Table = toml::from_str(&args[2]).unwrap();
        let projects = table["projects"].as_table().unwrap();
        assert_eq!(
            projects.keys().collect::<Vec<_>>(),
            [FOLDER_TEXT],
            "{}",
            args[2]
        );
        assert_eq!(
            projects[FOLDER_TEXT]["trust_level"].as_str(),
            Some("trusted")
        );
        assert_eq!(
            rule(json!({ "args": ["--folder", "${folder}${folder}"] }))
                .args(Path::new("/a/${folder}")),
            ["--folder", "/a/${folder}/a/${folder}"],
            "filled once"
        );
    }

    /// Settings name the folder in their strings and merge into the person's: objects key by key,
    /// lists joined, values replaced, and a setting of the person's of another kind kept.
    #[test]
    fn settings_name_the_folder_and_merge_into_the_person_s() {
        let agy = rule(json!({ "settings": { "trustedWorkspaces": ["${folder}"] } }));
        assert_eq!(
            agy.settings(Path::new(FOLDER_TEXT)),
            Some(json!({ "trustedWorkspaces": [FOLDER_TEXT] }))
        );
        let mut own = json!({
            "sandbox": { "enabled": true, "excludedCommands": ["git"] }, "skip": false,
            "list": ["a"], "odd": "text", "keep": 1,
        });
        merge_settings(
            &mut own,
            &json!({
                "sandbox": { "enabled": false }, "skip": true, "list": ["a", "b"], "odd": ["x"],
                "new": { "on": true },
            }),
        );
        assert_eq!(
            own,
            json!({
                "sandbox": { "enabled": false, "excludedCommands": ["git"] }, "skip": true,
                "list": ["a", "b"], "odd": "text", "keep": 1, "new": { "on": true },
            })
        );
    }

    /// YOLO arguments fill in nothing but the folder, and the settings are an object.
    #[test]
    fn yolo_fills_in_only_the_folder_and_its_settings_are_an_object() {
        let check = |text: Value| rule(text).check("yolo");
        assert!(
            check(json!({ "args": ["${session_id}"] }))
                .unwrap_err()
                .contains("only ${folder} or ${folder_toml}")
        );
        assert!(check(json!({ "args": ["-c", "${folder_toml}", "${folder}"] })).is_ok());
        assert!(
            check(json!({ "settings": [1] }))
                .unwrap_err()
                .contains("must be an object")
        );
        assert!(check(json!({ "settings": { "a": 1 } })).is_ok());
    }
}
