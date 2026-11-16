//! The text formats of the CLIs' own files and command lines, as Facade writes and reads them:
//! JSON with comments, POSIX shell words, TOML values, and settings merged with the person's.

use facade_base::system::{SYSTEM, System};
use serde_json::Value;

/// `text` read as JSON the way a CLI reads its own configuration: comments, a leading byte order
/// mark, and a comma before a closing `}` or `]` are allowed. Strings are kept as they are.
pub(crate) fn parse_jsonc(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(&strict_json(text))
}

/// `text` as strict JSON (see [`parse_jsonc`]). Each comment becomes one space, so the tokens on
/// either side stay apart.
fn strict_json(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut strict = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('"', _) => {
                strict.push('"');
                while let Some(c) = chars.next() {
                    strict.push(c);
                    if c == '\\' {
                        strict.extend(chars.next());
                    } else if c == '"' {
                        break;
                    }
                }
            }
            ('/', Some('/')) => {
                while chars.next_if(|c| *c != '\n').is_some() {}
                strict.push(' ');
            }
            ('/', Some('*')) => {
                chars.next();
                let mut star = false;
                for c in chars.by_ref() {
                    if star && c == '/' {
                        break;
                    }
                    star = c == '*';
                }
                strict.push(' ');
            }
            ('}' | ']', _) => {
                let end = strict.trim_end().len();
                if strict[..end].ends_with(',') {
                    strict.truncate(end - 1);
                }
                strict.push(c);
            }
            _ => strict.push(c),
        }
    }
    strict
}

/// `text` as one word of a POSIX shell command.
pub fn shell_word(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// One literal PowerShell argument, including apostrophes and shell metacharacters.
pub(crate) fn powershell_word(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// A PowerShell script carried without quotes through either PowerShell or cmd.exe.
pub(crate) fn encoded_powershell(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        facade_base::base64::encode(&bytes)
    )
}

/// The literal words of Facade's encoded PowerShell hooks, including their optional home.
pub(crate) fn encoded_powershell_words(command: &str) -> Option<Vec<String>> {
    let encoded =
        command.strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")?;
    let bytes = facade_base::base64::decode(encoded).ok()?;
    let (pairs, remainder) = bytes.as_chunks::<2>();
    if !remainder.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs.iter().copied().map(u16::from_le_bytes).collect();
    let script = String::from_utf16(&units).ok()?;
    let mut rest = script.strip_suffix("; exit $LASTEXITCODE")?;
    let mut words = Vec::new();
    if let Some(home) = rest.strip_prefix("$env:FACADE_HOME=") {
        rest = home;
        words.push(format!("FACADE_HOME={}", take_powershell_word(&mut rest)?));
        rest = rest.strip_prefix("; ")?;
    }
    rest = rest.strip_prefix("& ")?;
    loop {
        words.push(take_powershell_word(&mut rest)?);
        if rest.is_empty() {
            return Some(words);
        }
        rest = rest.strip_prefix(' ')?;
    }
}

/// Reads one single-quoted PowerShell literal; doubled apostrophes are literal apostrophes.
fn take_powershell_word(rest: &mut &str) -> Option<String> {
    let quoted = rest.strip_prefix('\'')?;
    let mut chars = quoted.char_indices().peekable();
    let mut word = String::new();
    while let Some((index, ch)) = chars.next() {
        if ch != '\'' {
            word.push(ch);
        } else if chars.peek().is_some_and(|(_, next)| *next == '\'') {
            chars.next();
            word.push('\'');
        } else {
            *rest = &quoted[index + 1..];
            return Some(word);
        }
    }
    None
}

/// The shell a CLI runs Facade's hook commands with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Shell {
    /// A POSIX shell: `/bin/sh` on Unix, and Git Bash, which Claude Code runs its hooks with on
    /// Windows and which takes `'C:\…'` words as they are.
    Posix,
    /// cmd.exe, used by the other Windows CLIs; Codex hooks use encoded PowerShell instead.
    Cmd,
}

/// The characters a cmd.exe word may hold without quotes.
fn is_plain_for_cmd(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._:/\\-".contains(c)
}

impl Shell {
    /// The shell `cli` runs its hook commands with on this system.
    pub(crate) fn of(cli: &str) -> Shell {
        match SYSTEM {
            System::Windows if cli != "claude" => Shell::Cmd,
            _ => Shell::Posix,
        }
    }

    /// `path` as the first word of a command, the program it runs. A cmd.exe command starts with
    /// `@`, never with a quote: `cmd /c` without `/s` would take a line's first and last quote
    /// away.
    pub(crate) fn program(self, path: &str) -> String {
        match self {
            Shell::Posix => shell_word(path),
            Shell::Cmd => format!("@\"{path}\""),
        }
    }

    /// `text` as one argument of a command; None where the shell cannot carry it: for cmd.exe, a
    /// text holding `"` or a line break.
    pub(crate) fn word(self, text: &str) -> Option<String> {
        match self {
            Shell::Posix => Some(shell_word(text)),
            Shell::Cmd if text.contains(['"', '\n', '\r']) => None,
            Shell::Cmd if !text.is_empty() && text.chars().all(is_plain_for_cmd) => {
                Some(text.to_string())
            }
            Shell::Cmd => Some(format!("\"{text}\"")),
        }
    }

    /// `command`, run with `variables` set. Facade's values hold no `"`.
    pub(crate) fn with_variables(self, variables: &[(String, String)], command: &str) -> String {
        let set: String = variables
            .iter()
            .map(|(name, value)| match self {
                Shell::Posix => format!("{name}={} ", shell_word(value)),
                Shell::Cmd => format!("set \"{name}={value}\" && "),
            })
            .collect();
        set + command
    }

    /// The program and arguments that run `command` with this shell.
    pub(crate) fn command(self, command: &str) -> Vec<String> {
        let line: &[&str] = match self {
            Shell::Posix => &["/bin/sh", "-c"],
            Shell::Cmd => &["cmd.exe", "/d", "/s", "/c"],
        };
        line.iter()
            .copied()
            .chain([command])
            .map(String::from)
            .collect()
    }

    /// The words of `command`, written by [`Shell::program`], [`Shell::word`] and
    /// [`Shell::with_variables`] for either shell: each variable it sets as a `NAME=value` word,
    /// then the program and its arguments. None where it holds anything else a shell reads. For
    /// recognizing Facade's own commands, on either system.
    pub(crate) fn words(command: &str) -> Option<Vec<String>> {
        if command.starts_with("set \"") || command.starts_with('@') {
            cmd_words(command)
        } else {
            posix_words(command)
        }
    }
}

/// The characters outside quotes that make a command more than plain words to a POSIX shell.
const POSIX_SYNTAX: &str = "\"$`;&|<>()*?[#~{";

/// The words a POSIX shell splits `command` into, where it is plain words, single quotes and
/// backslashes alone.
fn posix_words(command: &str) -> Option<Vec<String>> {
    /// The word being read, a new one where none is.
    fn word<'a>(words: &'a mut Vec<String>, in_word: &mut bool) -> &'a mut String {
        if !std::mem::replace(in_word, true) {
            words.push(String::new());
        }
        words.last_mut().expect("a word")
    }
    let mut words = Vec::new();
    let (mut in_word, mut quoted, mut escaped) = (false, false, false);
    for c in command.chars() {
        if quoted && c == '\'' {
            quoted = false;
        } else if quoted || escaped {
            escaped = false;
            word(&mut words, &mut in_word).push(c);
        } else if c == '\'' || c == '\\' {
            word(&mut words, &mut in_word);
            (quoted, escaped) = (c == '\'', c == '\\');
        } else if c.is_whitespace() {
            in_word = false;
        } else if POSIX_SYNTAX.contains(c) {
            return None;
        } else {
            word(&mut words, &mut in_word).push(c);
        }
    }
    (!quoted && !escaped).then_some(words)
}

/// The words of a cmd.exe line in the form [`Shell::Cmd`] writes: `set "NAME=value" && ` prefixes,
/// then `@` and the program in quotes, then plain or quoted words.
fn cmd_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut rest = command;
    while let Some(after) = rest.strip_prefix("set \"") {
        let (variable, after) = after.split_once("\" && ")?;
        words.push(variable.to_string());
        rest = after;
    }
    let mut chars = rest.strip_prefix('@')?.chars().peekable();
    loop {
        while chars.next_if(|c| *c == ' ').is_some() {}
        let Some(first) = chars.next() else {
            return Some(words);
        };
        let mut word = String::new();
        if first == '"' {
            loop {
                match chars.next()? {
                    '"' => break,
                    c => word.push(c),
                }
            }
            if chars.peek().is_some_and(|c| *c != ' ') {
                return None;
            }
        } else {
            word.push(first);
            while let Some(c) = chars.next_if(|c| *c != ' ') {
                word.push(c);
            }
            if !word.chars().all(is_plain_for_cmd) {
                return None;
            }
        }
        words.push(word);
    }
}

/// `text` as a TOML basic string, which a key may be too, whatever quotes or control characters it
/// holds.
pub(crate) fn toml_string(text: &str) -> String {
    let mut quoted = String::from('"');
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{8}' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\u{c}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            c if c.is_control() => quoted.push_str(&format!("\\u{:04X}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// `value` as one inline TOML value. None for a date or time, which Facade does not carry over.
pub(crate) fn inline_toml(value: &toml::Value) -> Option<String> {
    let text = match value {
        toml::Value::String(text) => toml_string(text),
        toml::Value::Integer(number) => number.to_string(),
        toml::Value::Float(number) if number.is_nan() => "nan".into(),
        toml::Value::Float(number) => format!("{number:?}"),
        toml::Value::Boolean(flag) => flag.to_string(),
        toml::Value::Datetime(_) => return None,
        toml::Value::Array(items) => {
            let items: Vec<String> = items.iter().map(inline_toml).collect::<Option<_>>()?;
            format!("[{}]", items.join(","))
        }
        toml::Value::Table(table) => {
            let entries: Vec<String> = table
                .iter()
                .map(|(key, item)| Some(format!("{}={}", toml_string(key), inline_toml(item)?)))
                .collect::<Option<_>>()?;
            format!("{{{}}}", entries.join(","))
        }
    };
    Some(text)
}

/// Merges `ours`, the settings Facade adds to a run, into `theirs`, the person's: an object key by
/// key, a list with the items it lacks, and any other value of ours in place of theirs. A setting
/// of theirs that is not an object or list where ours is stays as it is.
pub(crate) fn merge_settings(theirs: &mut Value, ours: &Value) {
    match (theirs, ours) {
        (Value::Object(theirs), Value::Object(ours)) => {
            for (key, value) in ours {
                match theirs.get_mut(key) {
                    Some(their) => merge_settings(their, value),
                    None => {
                        theirs.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(theirs), Value::Array(ours)) => {
            for item in ours {
                if !theirs.contains(item) {
                    theirs.push(item.clone());
                }
            }
        }
        (_, Value::Object(_) | Value::Array(_)) => {}
        (theirs, ours) => *theirs = ours.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn comments_and_trailing_commas_are_read_as_their_cli_reads_them() {
        let text = "\u{feff}{\n\t// a line comment, with \"quotes\"\n\t\"a\": \"http://x/*y*/\", \
                    /* a block\n comment */ \"b\": [1, 2,],\n\t\"c\": {\"d\": \"\\\"//\",},\n}\n";
        assert_eq!(
            parse_jsonc(text).unwrap(),
            json!({ "a": "http://x/*y*/", "b": [1, 2], "c": { "d": "\"//" } })
        );
        assert!(parse_jsonc("{\"a\": 1,, }").is_err(), "only one comma goes");
        assert!(parse_jsonc("{\"a\": /* never closed").is_err());
        assert_eq!(parse_jsonc("[1 /* , */ , // ]\n ]").unwrap(), json!([1]));
    }
}
