//! Model and effort (CONFIGURATION-3.3, CLIS-1.4). A rule's `choices` section says which arguments
//! pass each one to the CLI, written the CLI's way. The start's choice comes first, the entry's
//! second. When the section names no arguments for one, Facade never passes it and the CLI's own
//! configuration applies.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Deserialize;

use crate::args::ArgsGrammar;
use crate::formats::toml_string;

/// Matches where a choice goes: `${value}` as given, `${value_toml}` and `${value_json}` quoted
/// for TOML or JSON.
static VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{value(_toml|_json)?\}").expect("the value pattern is valid"));

/// The `choices` section of a rule. Each list of arguments holds one placeholder for the value.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Choices {
    /// Passes the model, if the CLI accepts one from Facade.
    pub model: Option<Vec<String>>,
    /// Passes the effort, if the CLI accepts one from Facade.
    pub effort: Option<Vec<String>>,
    /// How to tell that the person's own words for the CLI already pick a model or an effort.
    pub spelling: Spelling,
}

/// The CLI's own options for the model and the effort, and the keys it accepts for them in its
/// configuration overrides (as Codex reads `-c model=…`).
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Spelling {
    pub model: Vec<String>,
    pub effort: Vec<String>,
    pub config: Option<Keys>,
}

/// The override keys for the model and the effort.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keys {
    pub model: String,
    pub effort: String,
}

/// One of the two choices, with everything the section says about it.
struct Choice<'a> {
    name: &'static str,
    args: Option<&'a [String]>,
    options: &'a [String],
    key: Option<&'a str>,
}

impl Choices {
    /// Model first, then effort.
    fn both(&self) -> [Choice<'_>; 2] {
        let keys = self.spelling.config.as_ref();
        [
            Choice {
                name: "model",
                args: self.model.as_deref(),
                options: &self.spelling.model,
                key: keys.map(|keys| keys.model.as_str()),
            },
            Choice {
                name: "effort",
                args: self.effort.as_deref(),
                options: &self.spelling.effort,
                key: keys.map(|keys| keys.effort.as_str()),
            },
        ]
    }

    /// Whether the CLI accepts `choice` (`model` or `effort`) from Facade.
    pub fn takes(&self, choice: &str) -> bool {
        self.both()
            .iter()
            .any(|known| known.name == choice && known.args.is_some())
    }

    /// The arguments passing `model` and `effort` to the CLI. A choice that is None, or that the
    /// CLI does not accept, adds nothing.
    pub fn args(&self, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
        let wanted = self.both().into_iter().zip([model, effort]);
        let given = wanted.filter_map(|(choice, value)| Some((choice.args?, value?)));
        given
            .flat_map(|(args, value)| args.iter().map(move |arg| with_value(arg, value)))
            .collect()
    }

    /// Whether the person's own `words` for the CLI, parsed with `grammar`, already pick the model
    /// and the effort (CONFIGURATION-3.3). What they pick belongs to the start, so an entry's
    /// choice is not added on top.
    pub fn chosen_in(&self, grammar: &ArgsGrammar, words: &[String]) -> (bool, bool) {
        let [model, effort] = self
            .both()
            .map(|choice| grammar.holds(words, choice.options, choice.key));
        (model, effort)
    }

    /// Rejects a section whose arguments do not hold exactly one placeholder, or whose spelling
    /// cannot recognise the choice in the person's own words.
    pub(crate) fn check(&self) -> Result<(), String> {
        for choice in self.both() {
            let Some(args) = choice.args else {
                continue;
            };
            let placeholders: usize = args.iter().map(|arg| VALUE.find_iter(arg).count()).sum();
            let stray = args
                .iter()
                .any(|arg| arg.contains('\0') || VALUE.replace_all(arg, "").contains("${"));
            if placeholders != 1 || stray {
                return Err(format!(
                    "choices.{} must name ${{value}}, ${{value_toml}} or ${{value_json}} \
                     exactly once, and nothing else to fill in",
                    choice.name
                ));
            }
            if choice.options.is_empty() && choice.key.is_none() {
                return Err(format!(
                    "choices.spelling must name how the CLI's own arguments choose its {}",
                    choice.name
                ));
            }
        }
        Ok(())
    }
}

/// `arg` with its placeholder replaced by `value`, quoted as the placeholder asks.
fn with_value(arg: &str, value: &str) -> String {
    let quote = |found: &Captures| match found.get(1).map(|suffix| suffix.as_str()) {
        None => value.to_string(),
        Some("_toml") => toml_string(value),
        Some(_) => serde_json::to_string(value).expect("a string is JSON"),
    };
    VALUE.replace_all(arg, quote).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{Choices, Spelling};
    use crate::find;

    /// Each CLI takes a model and an effort in its own spelling (CLIS-1.4): Codex's effort as a
    /// TOML string, and Muse Code's as a JSON one with its list of efforts cleared for the run.
    /// OpenCode takes neither from Facade.
    #[test]
    fn each_cli_takes_a_model_and_an_effort_in_its_own_spelling() {
        let args = |cli: &str, model: Option<&str>, effort: Option<&str>| {
            find(cli).unwrap().unwrap().choices.args(model, effort)
        };
        assert_eq!(
            args("claude", Some("opus"), Some("max")),
            ["--model", "opus", "--effort", "max"]
        );
        assert_eq!(args("agy", None, Some("high")), ["--effort", "high"]);
        assert_eq!(
            args("codex", Some("gpt-5"), Some("hi\"gh")),
            [
                "--model",
                "gpt-5",
                "-c",
                "model_reasoning_effort=\"hi\\\"gh\""
            ]
        );
        assert_eq!(
            args("muse", None, Some("low")),
            [
                "-c",
                "reasoning_effort=\"low\"",
                "-c",
                "model_reasoning_efforts={}"
            ]
        );
        assert_eq!(
            args("pi", Some("openrouter/m"), Some("off")),
            ["--model", "openrouter/m", "--thinking", "off"]
        );
        assert!(args("opencode", Some("m"), Some("high")).is_empty());
        assert!(args("claude", None, None).is_empty());
    }

    /// A choice names exactly one placeholder and nothing else to fill in, and the spelling says
    /// how the CLI's own arguments make it.
    #[test]
    fn a_choice_names_exactly_one_placeholder() {
        let check = |model: &[&str]| {
            Choices {
                model: Some(model.iter().map(|arg| arg.to_string()).collect()),
                effort: None,
                spelling: Spelling {
                    model: vec!["--model".into()],
                    ..Default::default()
                },
            }
            .check()
        };
        assert!(check(&["--model", "${value}"]).is_ok());
        assert!(check(&["--model"]).unwrap_err().contains("exactly once"));
        assert!(check(&["--model", "${value}", "${value_json}"]).is_err());
        assert!(check(&["--model=${value}", "${session_id}"]).is_err());
        let unspelt = Choices {
            model: Some(vec!["--model".into(), "${value}".into()]),
            ..Default::default()
        };
        assert_eq!(
            unspelt.check().unwrap_err(),
            "choices.spelling must name how the CLI's own arguments choose its model"
        );
    }

    /// A start's own words choose a model or an effort in any spelling their CLI reads, but never
    /// inside another option's value or after the end of the options (CONFIGURATION-3.3).
    #[test]
    fn a_start_s_own_words_choose_a_model_or_an_effort_in_each_cli_s_spelling() {
        let chosen = |cli: &str, words: &[&str]| {
            let rule = find(cli).unwrap().unwrap();
            let words: Vec<String> = words.iter().map(|word| word.to_string()).collect();
            rule.choices.chosen_in(&rule.arguments, &words)
        };
        let cases: [(&str, &[&str], (bool, bool)); 22] = [
            ("codex", &["-m", "gpt-b"], (true, false)),
            ("codex", &["--model=gpt-b"], (true, false)),
            ("codex", &["-mgpt-b"], (true, false)),
            ("codex", &["-xm", "gpt-b"], (true, false)),
            ("codex", &["-c", "model=\"gpt-b\""], (true, false)),
            ("codex", &["-cmodel_reasoning_effort=high"], (false, true)),
            (
                "codex",
                &["--config=model_reasoning_effort=high", "--search"],
                (false, true),
            ),
            ("codex", &["-c", "model_provider=\"qwen\""], (false, false)),
            ("codex", &["-i", "a.png", "b.png", "-m", "x"], (true, false)),
            ("muse", &["--reasoning-effort", "high"], (false, true)),
            (
                "muse",
                &["--effort=high", "-c", "model=\"m\""],
                (true, true),
            ),
            (
                "claude",
                &["--model", "opus", "--effort", "max"],
                (true, true),
            ),
            (
                "claude",
                &["--append-system-prompt", "--model=x"],
                (false, false),
            ),
            (
                "claude",
                &["--verbose", "--", "--model", "x"],
                (false, false),
            ),
            ("agy", &["-model", "m"], (true, false)),
            ("agy", &["--effort=high"], (false, true)),
            ("agy", &["--project", "-model"], (false, false)),
            ("pi", &["--thinking", "off"], (false, true)),
            ("pi", &["--model", "openrouter/m"], (true, false)),
            // Pi reads `--name=value` as a flag it does not know: no choice
            ("pi", &["--thinking=high"], (false, false)),
            ("pi", &["--model=x"], (false, false)),
            ("opencode", &["--model", "m"], (false, false)),
        ];
        for (cli, words, expected) in cases {
            assert_eq!(chosen(cli, words), expected, "{cli} {words:?}");
        }
    }
}
