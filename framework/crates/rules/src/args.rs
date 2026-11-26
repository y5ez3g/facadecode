//! How each CLI reads its arguments, as its rule file's `arguments` describes it: options with
//! their values, configuration overrides, arguments that are no option's, and the end of the
//! options. Facade reads a settings entry's `args` this way (CONFIGURATION-3.1, CLIS-3.1): they may
//! hold no option or configuration key Facade sets or decides itself, and no task, file or folder,
//! which Facade gives the CLI itself. An entry of type `custom` has its arguments passed as they
//! are.

use serde::Deserialize;

/// The `arguments` section of a rule (CLIS-3.1). Each field names options by how the CLI writes
/// them:
///
/// | field | what it lists |
/// |---|---|
/// | `reserved` | the options Facade sets or decides itself, in all their spellings |
/// | `attached` | reserved short options that take a value glued on, `-mgpt-5` |
/// | `config` | override options such as Codex's `-c`, and the keys Facade owns |
/// | `variadic` | options that take values up to the next option, `--add-dir a b` |
/// | `single_dash` | Go-style flags: `-mode` = `--mode`, `-p=true`; no short-option runs |
/// | `clusters` | for CLIs that read `-cp` as `-c -p`: the letters that take a value |
/// | `required` | options that take the next argument even when it starts with `-` |
/// | `equals_value` | whether `--name=value` gives `--name` a value (false for Pi) |
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArgsGrammar {
    pub reserved: Vec<String>,
    #[serde(default)]
    pub attached: Vec<String>,
    #[serde(default)]
    pub config: Option<ConfigGrammar>,
    #[serde(default)]
    pub variadic: Vec<String>,
    #[serde(default)]
    pub single_dash: bool,
    #[serde(default)]
    pub clusters: Option<Vec<String>>,
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default = "equals_gives_a_value")]
    pub equals_value: bool,
}

fn equals_gives_a_value() -> bool {
    true
}

/// Override `options` (`-c`, `--config`) and the keys among them that are Facade's, `reserved`.
/// A reserved key covers the keys above and below it: `mcp_servers={...}` sets
/// `mcp_servers.facade`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigGrammar {
    pub options: Vec<String>,
    pub reserved: Vec<String>,
}

/// An option found among a CLI's arguments: where it is, how many arguments it spans, and its
/// value where it has one.
#[derive(Debug, PartialEq)]
pub struct Found {
    pub index: usize,
    pub span: usize,
    pub value: Option<String>,
}

/// A configuration override found among a CLI's arguments: where it is, how many arguments it
/// spans, its key, and its value where its text holds `=`.
#[derive(Debug, PartialEq)]
pub struct Override {
    pub index: usize,
    pub span: usize,
    pub key: String,
    pub value: Option<String>,
}

/// The value of a CLI choice, as a literal option argument or as a configuration value.
pub enum ChoiceValue {
    Option(String),
    Override(String),
}

/// One piece of a CLI's arguments as its parser reads it: where it starts, how many arguments it
/// takes up, and what it is.
#[derive(Debug, PartialEq)]
struct Piece {
    index: usize,
    span: usize,
    kind: Kind,
}

#[derive(Debug, PartialEq)]
enum Kind {
    /// An option: its name as written (before `=` or a glued value; a whole run of short options
    /// for [`Written::Run`]), how its value is written, and its values.
    Option {
        name: String,
        written: Written,
        values: Vec<String>,
    },
    /// A configuration override, with its `key=value` text where it has one.
    Override { text: Option<String> },
    /// An argument that is no option's.
    Positional,
    /// `--`, the end of the options.
    End,
}

/// How an option's value is written.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Written {
    /// `--name=value`.
    Equals,
    /// Glued to a short option, `-mgpt-5`.
    Attached,
    /// In the arguments that follow.
    Apart,
    /// No value.
    Alone,
    /// Inside a run of short options, `-cp`.
    Run,
}

/// An argument Facade refuses in an entry's `args`.
enum Refused {
    /// An option Facade sets or decides itself, as the grammar names it, or `--`.
    Option { index: usize, option: String },
    /// A configuration key Facade sets itself.
    Key { index: usize, key: String },
    /// An argument that is no option's value.
    Positional { index: usize },
}

/// Walks a CLI's arguments one piece at a time, as the CLI's own parser does. An argument taken
/// as a value is never read again; after `--` each argument is its own positional piece.
struct Reader<'a> {
    grammar: &'a ArgsGrammar,
    args: &'a [String],
    at: usize,
    ended: bool,
}

impl Iterator for Reader<'_> {
    type Item = Piece;

    fn next(&mut self) -> Option<Piece> {
        let arg = self.args.get(self.at)?;
        let (span, kind) = if self.ended || arg == "-" || !arg.starts_with('-') {
            (1, Kind::Positional)
        } else if arg == "--" {
            self.ended = true;
            (1, Kind::End)
        } else if let Some(read) = self.grammar.read_override(self.args, self.at) {
            read
        } else {
            self.grammar.read_option(self.args, self.at)
        };
        let piece = Piece {
            index: self.at,
            span,
            kind,
        };
        self.at += span;
        Some(piece)
    }
}

impl ArgsGrammar {
    /// What is wrong with `args`, the entry's `args` at `setting` (CONFIGURATION-3.1, 4.1). Each
    /// problem names the place and the option or key, never a value, which may be a secret.
    pub fn problems(&self, args: &[String], setting: &str) -> Vec<String> {
        self.problems_at(args, setting)
            .into_iter()
            .map(|(_, message)| message)
            .collect()
    }

    /// The problems with the index of their source argument.
    pub(crate) fn problems_at(&self, args: &[String], setting: &str) -> Vec<(usize, String)> {
        let say = |refused: Refused| match refused {
            Refused::Option { index, option } => (
                index,
                format!(
                    "{setting}[{index}] is {option}, which Facade sets or decides itself; remove it"
                ),
            ),
            Refused::Key { index, key } => (
                index,
                format!("{setting}[{index}] sets {key}, which Facade sets itself; remove it"),
            ),
            Refused::Positional { index } => (
                index,
                format!(
                    "{setting}[{index}] is not an option: Facade gives the CLI its task and folder \
                     itself, so args holds only options and their values"
                ),
            ),
        };
        self.refused(args).into_iter().map(say).collect()
    }

    /// The arguments Facade refuses, read as the CLI reads them. After `--` every argument is
    /// refused, since Facade places the end of the options itself, before the task it gives.
    fn refused(&self, args: &[String]) -> Vec<Refused> {
        let reserved_key = |key: &str| {
            !key.is_empty()
                && self.config.as_ref().is_some_and(|config| {
                    config.reserved.iter().any(|own| same_or_nested(own, key))
                })
        };
        self.read(args)
            .filter_map(|Piece { index, kind, .. }| match kind {
                Kind::End => Some(Refused::Option {
                    index,
                    option: "--".into(),
                }),
                Kind::Positional => Some(Refused::Positional { index }),
                Kind::Override { text } => {
                    let key = text.as_deref().map_or("", key_of);
                    reserved_key(key).then(|| Refused::Key {
                        index,
                        key: key.trim().to_string(),
                    })
                }
                Kind::Option { .. } => self
                    .named_in(&args[index], &self.reserved)
                    .map(|option| Refused::Option { index, option }),
            })
            .collect()
    }

    /// Every `option` in `args`, in each spelling the CLI reads it by itself (its value apart,
    /// after `=`, or none), with its value (CLIS-3.1). Text that only looks like the option, as
    /// another option's value or after the end of the options, is not it.
    pub fn found(&self, args: &[String], option: &str) -> Vec<Found> {
        let mut found = Vec::new();
        for Piece { index, span, kind } in self.read(args) {
            let Kind::Option {
                name,
                written,
                values,
            } = kind
            else {
                continue;
            };
            let by_itself = !matches!(written, Written::Attached | Written::Run);
            if by_itself && self.is_option(&name, option) {
                let value = values.into_iter().next();
                found.push(Found { index, span, value });
            }
        }
        found
    }

    /// The configuration overrides in `args`, in order, with their keys and values (CLIS-3.1), as
    /// Codex reads `-c key=value`. None where one has no text, as a `-c` at the end.
    pub fn overrides(&self, args: &[String]) -> Option<Vec<Override>> {
        let mut overrides = Vec::new();
        for Piece { index, span, kind } in self.read(args) {
            if let Kind::Override { text } = kind {
                let text = text?;
                let (key, value) = text
                    .split_once('=')
                    .map_or((text.as_str(), None), |(key, value)| (key, Some(value)));
                overrides.push(Override {
                    index,
                    span,
                    key: key.trim().to_string(),
                    value: value.map(str::to_string),
                });
            }
        }
        Some(overrides)
    }

    /// Whether `args`, before the end of their options, hold one of `options` in a spelling the
    /// CLI reads, or an override of `key`. Pi's `--model=x` is a flag of its own, and a run of short
    /// options holds each letter up to one that takes a value.
    pub fn holds(&self, args: &[String], options: &[String], key: Option<&str>) -> bool {
        let names = |piece: &Piece| match &piece.kind {
            Kind::Option {
                written: Written::Run,
                ..
            } => self.named_in(&args[piece.index], options).is_some(),
            Kind::Option { name, .. } => options.iter().any(|option| self.is_option(name, option)),
            Kind::Override { text } => match (key, text) {
                (Some(key), Some(text)) => key_of(text).trim() == key,
                _ => false,
            },
            Kind::Positional | Kind::End => false,
        };
        self.read(args)
            .take_while(|piece| piece.kind != Kind::End)
            .any(|piece| names(&piece))
    }

    /// The last value given for a choice. A CLI option takes precedence over a configuration
    /// override. An option that appeared without a value still takes precedence.
    pub fn choice_value(
        &self,
        args: &[String],
        options: &[String],
        key: Option<&str>,
    ) -> Option<ChoiceValue> {
        let mut option = None;
        let mut config = None;
        for piece in self.read(args).take_while(|piece| piece.kind != Kind::End) {
            match piece.kind {
                Kind::Option { name, values, .. }
                    if options.iter().any(|option| self.is_option(&name, option)) =>
                {
                    option = Some(values.into_iter().next().map(ChoiceValue::Option));
                }
                Kind::Override { text: Some(text) }
                    if key.is_some_and(|key| key_of(&text).trim() == key) =>
                {
                    config = text
                        .split_once('=')
                        .map(|(_, value)| ChoiceValue::Override(value.to_string()));
                }
                _ => {}
            }
        }
        option.unwrap_or(config)
    }

    /// The index of the `--` that ends the options of `args`, else their length.
    pub fn end_of_options(&self, args: &[String]) -> usize {
        let end = self.read(args).find(|piece| piece.kind == Kind::End);
        end.map_or(args.len(), |piece| piece.index)
    }

    fn read<'a>(&'a self, args: &'a [String]) -> Reader<'a> {
        Reader {
            grammar: self,
            args,
            at: 0,
            ended: false,
        }
    }

    /// An override at `at`, `-c key=value`, `--config=key=value` or `-ckey=value`: its span and
    /// kind. None where the argument is no override option.
    fn read_override(&self, args: &[String], at: usize) -> Option<(usize, Kind)> {
        let arg = args[at].as_str();
        let config = self.config.as_ref()?;
        for option in &config.options {
            if arg == option {
                // The text is the next argument, unless that looks like an option and the
                // override does not take any argument.
                let text = args
                    .get(at + 1)
                    .filter(|next| self.takes_any(option) || !next.starts_with('-'));
                let span = if text.is_some() { 2 } else { 1 };
                return Some((
                    span,
                    Kind::Override {
                        text: text.cloned(),
                    },
                ));
            }
            let Some(rest) = arg.strip_prefix(option.as_str()) else {
                continue;
            };
            if let Some(text) = rest.strip_prefix('=') {
                return Some((
                    1,
                    Kind::Override {
                        text: Some(text.into()),
                    },
                ));
            }
            if is_short(option) && !rest.is_empty() {
                return Some((
                    1,
                    Kind::Override {
                        text: Some(rest.into()),
                    },
                ));
            }
        }
        None
    }

    /// The option at `at`, an argument that starts with `-`: its span with the arguments that are
    /// its value, and its kind.
    fn read_option(&self, args: &[String], at: usize) -> (usize, Kind) {
        let arg = &args[at];
        let chars: Vec<char> = arg.chars().collect();
        let long = arg.starts_with("--")
            || (self.single_dash && chars.len() > 2 && chars[1] != '-' && chars[2] != '-');
        let equals = chars.iter().position(|&c| c == '=');
        let run = !long && self.clusters.is_some() && chars.len() != 2 && equals != Some(2);
        if run {
            return self.read_run(args, at, &chars);
        }
        if self.equals_value
            && let Some(sign) = equals.filter(|&sign| sign > 1)
        {
            let name = chars[..sign].iter().collect();
            let value = chars[sign + 1..].iter().collect();
            return (1, option(name, Written::Equals, vec![value]));
        }
        let glued = (!long)
            .then(|| {
                self.attached
                    .iter()
                    .find(|short| arg.len() > short.len() && arg.starts_with(short.as_str()))
            })
            .flatten();
        if let Some(short) = glued {
            let value = arg[short.len()..].to_string();
            return (1, option(short.clone(), Written::Attached, vec![value]));
        }
        self.read_apart(args, at, arg)
    }

    /// A run of short options at `at`, `-cp`: each letter is an option up to the first that takes
    /// a value, which takes the rest of the run, or else the next argument. The piece names the
    /// option that takes the value, or the whole run if none is known to take one.
    fn read_run(&self, args: &[String], at: usize, chars: &[char]) -> (usize, Kind) {
        let arg = &args[at];
        let takes_value = self.clusters.as_deref().unwrap_or_default();
        let letters = chars.iter().enumerate().skip(1);
        let valued = letters
            .take_while(|(_, letter)| letter.is_ascii_alphanumeric())
            .find(|(_, letter)| takes_value.contains(&format!("-{letter}")));
        let as_run = |(span, kind): (usize, Kind)| match kind {
            Kind::Option { name, values, .. } => (span, option(name, Written::Run, values)),
            kind => (span, kind),
        };
        let Some((place, letter)) = valued else {
            // No letter takes a value: the last may be one Facade does not know that takes one.
            return as_run(self.read_apart(args, at, arg));
        };
        let short = format!("-{letter}");
        let rest: String = chars[place + 1..].iter().collect();
        match (rest.is_empty(), place) {
            (true, _) => as_run(self.read_apart(args, at, &short)),
            (false, 1) => (1, option(short, Written::Attached, vec![rest])),
            (false, _) => (1, option(short, Written::Run, vec![rest])),
        }
    }

    /// `name`, alone in the argument at `at`, with the arguments after it that are its value: the
    /// next one whatever it is for an option that takes any, then those that are no option, one
    /// at most unless the option is variadic.
    fn read_apart(&self, args: &[String], at: usize, name: &str) -> (usize, Kind) {
        let limit = if self.variadic.iter().any(|each| self.is_option(name, each)) {
            usize::MAX
        } else {
            1
        };
        let mut rest = args[at + 1..].iter().peekable();
        let mut values: Vec<String> = Vec::new();
        if self.takes_any(name)
            && let Some(value) = rest.next()
        {
            values.push(value.clone());
        }
        while values.len() < limit
            && let Some(value) = rest.next_if(|value| !value.starts_with('-'))
        {
            values.push(value.clone());
        }
        let written = if values.is_empty() {
            Written::Alone
        } else {
            Written::Apart
        };
        (1 + values.len(), option(name.to_string(), written, values))
    }

    /// The option of `options` that the argument `arg` names in any spelling the CLI reads: by
    /// itself, `--x=value`, a short option with its value glued on, a long option after one dash,
    /// or a letter of a run of short options.
    fn named_in(&self, arg: &str, options: &[String]) -> Option<String> {
        self.named_whole(arg, options)
            .or_else(|| self.named_glued(arg, options))
            .or_else(|| self.named_in_run(arg, options))
    }

    fn named_whole(&self, arg: &str, options: &[String]) -> Option<String> {
        let names = |option: &&String| match arg.strip_prefix(option.as_str()) {
            _ if self.single_dash => self.is_option(arg, option),
            Some(rest) => rest.is_empty() || rest.starts_with('='),
            None => false,
        };
        options.iter().find(names).cloned()
    }

    fn named_glued(&self, arg: &str, options: &[String]) -> Option<String> {
        if arg.starts_with("--") {
            return None;
        }
        let glued = |short: &&String| {
            options.contains(short) && arg.len() > short.len() && arg.starts_with(short.as_str())
        };
        self.attached.iter().find(glued).cloned()
    }

    /// A letter of `options` in the run `arg`, before the first letter that takes a value.
    fn named_in_run(&self, arg: &str, options: &[String]) -> Option<String> {
        let takes_value = self.clusters.as_ref()?;
        if arg.starts_with("--") {
            return None;
        }
        for letter in arg.chars().skip(1) {
            let short = format!("-{letter}");
            if options.contains(&short) {
                return Some(short);
            }
            if takes_value.contains(&short) || !letter.is_ascii_alphanumeric() {
                break;
            }
        }
        None
    }

    /// Whether `written` names `option`. A CLI that reads one dash and two alike names an option
    /// without its dashes and any `=value`: `-p`, `--p` and `-p=true` are all `p`.
    fn is_option(&self, written: &str, option: &str) -> bool {
        if !self.single_dash {
            return written == option;
        }
        let bare = |name: &'_ str| -> String {
            let name = name
                .strip_prefix("--")
                .or_else(|| name.strip_prefix('-'))
                .unwrap_or(name);
            name.split('=').next().unwrap_or(name).to_string()
        };
        bare(written) == bare(option)
    }

    /// Whether `option` takes the next argument whatever it looks like.
    fn takes_any(&self, option: &str) -> bool {
        self.required
            .iter()
            .any(|each| self.is_option(option, each))
    }
}

fn option(name: String, written: Written, values: Vec<String>) -> Kind {
    Kind::Option {
        name,
        written,
        values,
    }
}

/// The key of an override's `key=value` text.
fn key_of(text: &str) -> &str {
    text.split('=').next().unwrap_or_default()
}

/// Whether `option` is one dash and one character other than a dash.
fn is_short(option: &str) -> bool {
    let mut chars = option.chars();
    chars.next() == Some('-')
        && chars.next().is_some_and(|char| char != '-')
        && chars.next().is_none()
}

/// The parts of a configuration key: `mcp_servers."a.b".command` is `mcp_servers`, `a.b`,
/// `command`.
fn key_parts(key: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut quote = None;
    for char in key.trim().chars() {
        match quote {
            Some(open) if char == open => quote = None,
            Some(_) => part.push(char),
            None if char == '"' || char == '\'' => quote = Some(char),
            None if char == '.' => parts.push(std::mem::take(&mut part).trim().to_string()),
            None => part.push(char),
        }
    }
    parts.push(part.trim().to_string());
    parts
}

/// Whether keys `a` and `b` are the same or one lies below the other, so setting either sets the
/// other.
fn same_or_nested(a: &str, b: &str) -> bool {
    key_parts(a)
        .iter()
        .zip(key_parts(b))
        .all(|(left, right)| *left == right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::find;

    /// The arguments `args` that `cli`'s grammar refuses, each as `index:option`, `index:key` or
    /// `index:positional`.
    fn refused(cli: &str, args: &[&str]) -> Vec<String> {
        let grammar = &find(cli).unwrap().unwrap().arguments;
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        grammar
            .refused(&args)
            .into_iter()
            .map(|refused| match refused {
                Refused::Option { index, option } => format!("{index}:{option}"),
                Refused::Key { index, key } => format!("{index}:{key}"),
                Refused::Positional { index } => format!("{index}:positional"),
            })
            .collect()
    }

    /// An option Facade sets or decides is refused in every spelling its CLI takes: alone with its
    /// value, after `=`, a short one with its value attached, an alias (main's configuration tests,
    /// as all below).
    #[test]
    fn an_option_facade_sets_or_decides_is_refused_in_every_spelling_its_cli_takes() {
        let cases: [(&str, &[&str], &[&str]); 13] = [
            ("codex", &["--yolo"], &["0:--yolo"]),
            (
                "codex",
                &["--sandbox", "read-only", "--search"],
                &["0:--sandbox"],
            ),
            ("codex", &["--sandbox=read-only"], &["0:--sandbox"]),
            ("codex", &["-s", "danger-full-access"], &["0:-s"]),
            ("codex", &["-sread-only"], &["0:-s"]),
            (
                "codex",
                &["-m", "gpt-5", "--model=gpt-5", "-mgpt-5"],
                &["0:-m", "2:--model", "3:-m"],
            ),
            (
                "codex",
                &["--not-so-yolo", "--approve-for-me", "-C", "/elsewhere"],
                &["0:--not-so-yolo", "1:--approve-for-me", "2:-C"],
            ),
            (
                "claude",
                &[
                    "--permission-mode",
                    "plan",
                    "--model",
                    "x",
                    "--effort",
                    "max",
                    "-p",
                ],
                &["0:--permission-mode", "2:--model", "4:--effort", "6:-p"],
            ),
            (
                "claude",
                &[
                    "--resume",
                    "abc",
                    "-rabc",
                    "--continue",
                    "--worktree",
                    "w",
                    "-ww",
                ],
                &["0:--resume", "2:-r", "3:--continue", "4:--worktree", "6:-w"],
            ),
            (
                "agy",
                &["--mode", "plan", "--sandbox"],
                &["0:--mode", "2:--sandbox"],
            ),
            (
                "muse",
                &["--disable-sandbox", "--approval-mode", "yolo", "-w"],
                &["0:--disable-sandbox", "1:--approval-mode", "3:-w"],
            ),
            (
                "opencode",
                &["--yolo", "--dangerously-skip-permissions", "-sabc"],
                &["0:--yolo", "1:--dangerously-skip-permissions", "2:-s"],
            ),
            (
                "pi",
                &["--approve", "-na", "--session", "s"],
                &["0:--approve", "1:-na", "2:--session"],
            ),
        ];
        for (cli, args, expected) in cases {
            assert_eq!(refused(cli, args), expected, "{cli} {args:?}");
        }
    }

    /// An option that would leave a run without Facade's tools or session hooks, or decide its
    /// approvals, is refused too.
    #[test]
    fn an_option_that_would_leave_a_run_without_facade_s_tools_or_decide_its_approvals_is_refused()
    {
        assert_eq!(
            refused("claude", &["--bare", "--safe-mode", "--restricted"]),
            ["0:--bare", "1:--safe-mode", "2:--restricted"]
        );
        assert_eq!(
            refused("pi", &["--no-mcp", "--no-tools", "-nt", "--no-extensions"]),
            ["0:--no-mcp", "1:--no-tools", "2:-nt"]
        );
        assert_eq!(
            refused(
                "muse",
                &[
                    "--permission-profile",
                    "strict",
                    "--approval-judge",
                    "off",
                    "--disable-write"
                ]
            ),
            ["0:--permission-profile", "2:--approval-judge"]
        );
    }

    /// A CLI that reads a long option after one dash - Antigravity, a Go program - has it refused
    /// so too; one that reads a run of short options has each of them checked, up to one that takes
    /// the rest as its value.
    #[test]
    fn one_dash_long_options_and_runs_of_short_options_are_read_as_their_cli_reads_them() {
        assert_eq!(
            refused(
                "agy",
                &[
                    "-mode",
                    "plan",
                    "-model=x",
                    "-sandbox",
                    "-print",
                    "-continue",
                    "-c"
                ]
            ),
            [
                "0:--mode",
                "2:--model",
                "3:--sandbox",
                "4:--print",
                "5:--continue",
                "6:-c"
            ]
        );
        assert!(refused("agy", &["-add-dir", "/a"]).is_empty());
        assert_eq!(refused("claude", &["-cp"]), ["0:-c"]);
        assert_eq!(refused("claude", &["-np", "task"]), ["1:positional"]);
        assert_eq!(refused("codex", &["-xs", "read-only"]), ["0:-s"]);
        assert!(refused("codex", &["-pwork", "-pmy-model"]).is_empty());
        assert_eq!(refused("opencode", &["-cs", "abc"]), ["0:-c"]);
        assert_eq!(refused("muse", &["-wc"]), ["0:-w"]);
        let grammar = &find("codex").unwrap().unwrap().arguments;
        let options = ["--model", "-m"].map(String::from);
        let args = [
            "-mgpt-first",
            "-xm",
            "gpt-saved",
            "-c",
            "model=\"gpt-config\"",
        ]
        .map(String::from);
        assert!(matches!(
            grammar.choice_value(&args, &options, Some("model")),
            Some(ChoiceValue::Option(value)) if value == "gpt-saved"
        ));
        let config = ["-c", "model=\"gpt-config\""].map(String::from);
        assert!(matches!(
            grammar.choice_value(&config, &options, Some("model")),
            Some(ChoiceValue::Override(value)) if value == "\"gpt-config\""
        ));
    }

    /// A configuration override is refused where its key is one Facade sets, the parent of one or
    /// below one - in either option and either spelling, its key quoted or not; another key is the
    /// person's.
    #[test]
    fn a_configuration_override_of_a_key_facade_sets_is_refused() {
        assert_eq!(refused("codex", &["-c", "model=\"gpt-5\""]), ["0:model"]);
        assert_eq!(
            refused("codex", &["--config=model_reasoning_effort=high"]),
            ["0:model_reasoning_effort"]
        );
        assert_eq!(
            refused("codex", &["-csandbox_mode=read-only"]),
            ["0:sandbox_mode"]
        );
        assert_eq!(
            refused(
                "codex",
                &["-c", "projects.\"/repo\".trust_level=\"trusted\""]
            ),
            ["0:projects.\"/repo\".trust_level"]
        );
        assert_eq!(
            refused("codex", &["-c", "mcp_servers={}"]),
            ["0:mcp_servers"]
        );
        assert_eq!(
            refused("codex", &["-c", "mcp_servers.\"facade\".command=\"x\""]),
            ["0:mcp_servers.\"facade\".command"]
        );
        let theirs = [
            "-c",
            "model_provider=\"qwen\"",
            "-c",
            "mcp_servers.other.command=\"x\"",
            "--config",
            "model_providers.qwen.base_url=\"https://example.com\"",
        ];
        assert!(refused("codex", &theirs).is_empty());
        assert_eq!(
            refused(
                "muse",
                &[
                    "-c",
                    "mcpServers.facade={}",
                    "-c",
                    "model=\"x\"",
                    "-c",
                    "theme=\"dark\""
                ]
            ),
            ["0:mcpServers.facade", "2:model"]
        );
    }

    /// An argument that is no option's value is a task, a file or a folder to the CLI, refused -
    /// the end of the options, Facade's to place, and every one after it too; an option Facade does
    /// not know takes the next argument as its value, and a list option every one up to the next
    /// option.
    #[test]
    fn an_argument_that_is_no_option_s_value_is_refused() {
        assert_eq!(refused("codex", &["fix the bug"]), ["0:positional"]);
        assert!(refused("codex", &["--search", "resume"]).is_empty());
        assert_eq!(
            refused("codex", &["--profile", "resume", "more"]),
            ["2:positional"]
        );
        assert_eq!(
            refused("codex", &["-", "--", "--search", "x"]),
            ["0:positional", "1:--", "2:positional", "3:positional"]
        );
        assert_eq!(
            refused(
                "claude",
                &["--add-dir", "/a", "/b", "--verbose", "--", "task"]
            ),
            ["4:--", "5:positional"]
        );
        assert!(refused("claude", &["--some-new-flag", "--other", "value"]).is_empty());
        assert!(refused("codex", &["--image", "a.png", "b.png"]).is_empty());
    }

    /// Antigravity, a Go program, reads each option after one dash or two and a value after `=`: a
    /// reserved one is refused in every such spelling, short aliases too, unless another option
    /// takes it as its value.
    #[test]
    fn antigravity_reads_each_option_after_one_dash_or_two() {
        let spellings = [
            "-c=true",
            "-p=true",
            "-i=true",
            "--c",
            "--p",
            "--i",
            "--c=true",
            "--p=true",
            "--i=true",
            "-print=true",
            "--mode=plan",
            "-continue",
            "-sandbox=false",
            "--resume=session",
            "-resume=session",
            "-r=session",
            "--r=session",
        ];
        let expected = [
            "0:-c",
            "0:-p",
            "0:-i",
            "0:-c",
            "0:-p",
            "0:-i",
            "0:-c",
            "0:-p",
            "0:-i",
            "0:--print",
            "0:--mode",
            "0:--continue",
            "0:--sandbox",
            "0:--resume",
            "0:--resume",
            "0:-r",
            "0:-r",
        ];
        for (arg, expected) in spellings.iter().zip(expected) {
            assert_eq!(refused("agy", &[arg]), [expected], "{arg}");
        }
        // Go gives a flag that is no switch the next argument whatever it looks like: then it is
        // that flag's value
        assert!(refused("agy", &["--project", "-c=true"]).is_empty());
        assert!(refused("agy", &["-log-file", "--p"]).is_empty());
        assert!(refused("agy", &["--log-file", "--resume"]).is_empty());
        assert_eq!(refused("agy", &["-add-dir", "-i", "-i"]), ["2:-i"]);
        assert_eq!(
            refused("agy", &["-resume", "--mode", "-r", "--conversation"]),
            ["0:--resume", "2:-r"]
        );
    }

    /// A refused argument is said by its place and option or key, never a value that may be a
    /// secret; an empty string is an argument too: an option's value, else no option's.
    #[test]
    fn a_refused_argument_is_said_by_its_place_never_its_value() {
        let grammar = &find("codex").unwrap().unwrap().arguments;
        let args = ["-c", "model=\"sk-secret\"", "sk-positional"].map(String::from);
        let indexed = grammar.problems_at(&args, "clis.codex.args");
        assert_eq!(
            indexed.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            [0, 2]
        );
        assert_eq!(
            grammar.problems(&args, "clis.codex.args"),
            [
                "clis.codex.args[0] sets model, which Facade sets itself; remove it",
                "clis.codex.args[2] is not an option: Facade gives the CLI its task and folder \
                 itself, so args holds only options and their values"
            ]
        );
        assert!(refused("claude", &["--append-system-prompt", ""]).is_empty());
        assert_eq!(refused("claude", &["", "--verbose"]), ["0:positional"]);
    }
}
