//! The text formats of the CLIs' own files and command lines, as Facade writes and reads them:
//! JSON with comments, shell commands, TOML values, and settings merged with the person's.

use facade_base::system::{SYSTEM, System};
use serde_json::Value;

/// `text` read as JSON the way a CLI reads its own configuration: comments, a leading byte order
/// mark, and a comma before a closing `}` or `]` are allowed. Strings are kept as they are.
pub(crate) fn parse_jsonc(text: &str) -> Result<Value, serde_json::Error> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(&strict_json(text, true))
}

/// JSON with comments, as Qoder reads the project's `.mcp.json`.
pub(crate) fn parse_json_with_comments(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(&strict_json(text, false))
}

/// Each comment becomes one space, so the tokens on either side stay apart.
fn strict_json(text: &str, trailing_commas: bool) -> String {
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
            ('}' | ']', _) if trailing_commas => {
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

/// An argument of a Facade hook. Encoded PowerShell writes both kinds as literals.
pub(crate) enum HookArg<'a> {
    /// A fixed word written as-is in the POSIX and cmd.exe forms.
    Word(&'a str),
    /// A word quoted in the POSIX and cmd.exe forms, such as a session file path.
    Literal(&'a str),
}

/// Writes `<program> hook <event> <args>` with `variables` set, in the form `cli` passes intact
/// to its shell. Unix and Claude Code's Git Bash on Windows take POSIX words. Antigravity's
/// Windows hooks take cmd.exe words verbatim. Antigravity's title command and the other Windows
/// commands use encoded PowerShell, with every argument and variable value written as a literal.
pub(crate) fn facade_hook<'a>(
    cli: &str,
    program: &str,
    event: &str,
    args: &[HookArg<'_>],
    variables: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> String {
    let verbatim_cmd = SYSTEM == System::Windows && cli == "agy" && event != "title";
    let encoded = SYSTEM == System::Windows && cli != "claude" && !verbatim_cmd;
    let literal: fn(&str) -> String = if encoded {
        powershell_word
    } else if verbatim_cmd {
        |word| format!("\"{word}\"")
    } else {
        shell_word
    };
    let mut command: String = variables
        .into_iter()
        .map(|(name, value)| {
            if encoded {
                format!("$env:{name}={}; ", literal(value))
            } else if verbatim_cmd {
                format!("set \"{name}={value}\" && ")
            } else {
                format!("{name}={} ", literal(value))
            }
        })
        .collect();
    if encoded {
        command.push_str("& ");
    } else if verbatim_cmd {
        command.push('@');
    }
    command.push_str(&literal(program));
    for arg in [HookArg::Word("hook"), HookArg::Word(event)]
        .iter()
        .chain(args)
    {
        command.push(' ');
        match arg {
            HookArg::Word(word) if !encoded => command.push_str(word),
            HookArg::Word(word) | HookArg::Literal(word) => command.push_str(&literal(word)),
        }
    }
    if encoded {
        command.push_str("; exit $LASTEXITCODE");
        encoded_powershell(&command)
    } else {
        command
    }
}

/// Reads the literal words of a Facade hook in POSIX or cmd.exe form. Each variable is one
/// `NAME=value` word, followed by the program and its arguments. Returns None for other shell
/// syntax.
pub(crate) fn shell_words(command: &str) -> Option<Vec<String>> {
    if command.starts_with("set \"") || command.starts_with('@') {
        cmd_words(command)
    } else {
        posix_words(command)
    }
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

/// The characters a cmd.exe word may hold without quotes.
fn is_plain_for_cmd(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._:/\\-".contains(c)
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

/// The words of a Facade cmd.exe hook: `set "NAME=value" && ` prefixes, then `@` and the
/// program in quotes, then plain or quoted words.
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
