//! The text formats of the CLIs' own files and command lines, as Facade writes and reads them:
//! JSON with comments, POSIX shell words, TOML values, and settings merged with the person's.

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
