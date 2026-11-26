//! `facade.json`, Facade's settings file in the Facade home (CONFIGURATION-1). The editor windows
//! and the `facade` commands of the home's execution environment share it. It is JSON with comments
//! and trailing commas, read strictly:
//!
//! - a file that does not exist, or holds nothing but spaces and comments, holds every default;
//! - anything else Facade cannot read as it must stops every launch, each problem said with the
//!   file's path and, where known, its line and column (CONFIGURATION-4.1). Nothing is guessed, and
//!   no default stands in.
//!
//! The whole file is checked as the extension checks it. `yolo`, the names of `names` and the
//! members of `clis` are kept, each on its own; `facade_rules::entries` reads the CLI entries
//! (CONFIGURATION-2). The Framework reads the file and never writes it.

use std::collections::HashSet;
use std::fmt;
use std::io::Write as _;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub use crate::whitespace::is_space;

/// The settings file's name, in the Facade home.
pub const SETTINGS_FILE: &str = "facade.json";

/// The settings file Facade writes where there is none (CONFIGURATION-1.3): YOLO on, the built-in
/// names, every built-in CLI's entry with its fields, and what Facade gives each CLI and why. It
/// holds the defaults, so a home reads the same before and after it is written.
pub const TEMPLATE: &str = include_str!("texts/settings.jsonc");

/// The settings a launch takes from the file.
#[derive(Clone)]
pub struct Settings {
    /// Whether a launch runs with YOLO on (RULES-4.3, CONFIGURATION-1.4): true unless the file says
    /// false.
    pub yolo: bool,
    /// The names an agent started without one is named from (CONFIGURATION-1.4, LIFECYCLE-2.1),
    /// each trimmed: None where the file gives none, for the built-in names.
    pub names: Option<Vec<String>>,
    /// The members of `clis` in the file's order: each CLI entry's name, and its value as the file
    /// holds it (CONFIGURATION-2.1).
    pub clis: Vec<Member>,
    source: Option<Source>,
}

#[derive(Clone)]
struct Source {
    file: String,
    text: String,
}

/// A position in the settings file, with a 1-based line and UTF-16 column.
#[derive(Debug, PartialEq, Eq)]
pub struct SourceLocation<'a> {
    pub file: &'a str,
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for SourceLocation<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}:{}", self.file, self.line, self.column)
    }
}

impl Settings {
    /// Locates a [`Member::at`] or [`Node::at`] from this file's CLI entries.
    /// Returns `None` when there are no parsed CLI entries.
    pub fn source_location(&self, at: usize) -> Option<SourceLocation<'_>> {
        let source = self.source.as_ref()?;
        Some(location_in(&source.text, &source.file, at))
    }
}

impl fmt::Debug for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Settings")
            .field("yolo", &self.yolo)
            .field("names", &self.names)
            .field("clis", &self.clis)
            .finish()
    }
}

impl PartialEq for Settings {
    fn eq(&self, other: &Self) -> bool {
        self.yolo == other.yolo && self.names == other.names && self.clis == other.clis
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            yolo: true,
            names: None,
            clis: Vec::new(),
            source: None,
        }
    }
}

/// Each setting the file may hold, with what its value must be as a problem says it.
const SETTINGS: [(&str, &str); 4] = [
    ("yolo", "yolo must be true or false"),
    ("names", NAMES_ARE_STRINGS),
    ("clis", "clis must be an object of CLIs by name"),
    ("$schema", "$schema must be a string"),
];

const NAMES_ARE_STRINGS: &str = "names must be a list of strings";

/// The path to the settings file of the Facade home, even before the file exists.
pub fn settings_file() -> anyhow::Result<PathBuf> {
    Ok(crate::paths::facade_home()?.join(SETTINGS_FILE))
}

/// The settings the file holds now, or every problem that keeps them from being read, as one text.
/// A missing file is written from [`TEMPLATE`] first.
pub fn read() -> Result<Settings, String> {
    let file = settings_file().map_err(|err| format!("{err:#}"))?;
    create_missing(&file);
    read_file(&file)
}

/// Writes [`TEMPLATE`] to `file` where there is nothing, whole or not at all and readable by this
/// user alone, never over a file that someone else made first. Where it cannot be written, the
/// defaults it holds still apply.
pub fn create_missing(file: &Path) {
    if std::fs::symlink_metadata(file).is_ok() {
        return;
    }
    let Some(folder) = file.parent() else {
        return;
    };
    if crate::files::create_private_folder_all(folder).is_err() {
        return;
    }
    // Each call stages its own file: two at once in one daemon must not take each other's.
    static STAGED: AtomicU64 = AtomicU64::new(0);
    let staged = folder.join(format!(
        ".{SETTINGS_FILE}.{}.{}.tmp",
        std::process::id(),
        STAGED.fetch_add(1, Ordering::Relaxed)
    ));
    let Ok(mut staging) = crate::files::private_options()
        .write(true)
        .create_new(true)
        .open(&staged)
    else {
        return;
    };
    // The final name appears only with the whole file, and never replaces one.
    if staging
        .write_all(TEMPLATE.as_bytes())
        .and_then(|()| staging.sync_all())
        .is_ok()
    {
        let _ = std::fs::hard_link(&staged, file);
    }
    let _ = std::fs::remove_file(&staged);
}

/// The settings `file` holds now, or every problem that keeps them from being read, as one text:
/// every default where it does not exist.
pub fn read_file(file: &Path) -> Result<Settings, String> {
    let shown = shown(file);
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(err) => return Err(format!("{shown} could not be read: {err}")),
    };
    parse(&String::from_utf8_lossy(&bytes), &shown).map_err(|problems| problems.join("; "))
}

/// `file` as a problem names it: under the person's home folder as `~/…`, as the editor shows it,
/// and otherwise whole.
pub fn shown(file: &Path) -> String {
    let home = std::env::var_os("HOME");
    match home.and_then(|home| file.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(inside) if !inside.as_os_str().is_empty() => {
            format!("~{MAIN_SEPARATOR}{}", inside.display())
        }
        _ => file.display().to_string(),
    }
}

/// The settings `text`, the file `shown`, holds: empty, blank or only comments for every default;
/// otherwise one object whose `yolo` is true or false, whose `names` is a list of names that are
/// not blank, whose `clis` is an object, and whose `$schema`, where present, is a string. Anything
/// else is a problem, said with where it is.
pub fn parse(text: &str, shown: &str) -> Result<Settings, Vec<String>> {
    // Editors read a JSON file without its byte order mark.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let place = |at| location_in(text, shown, at);
    let document = Cursor { text, at: 0 }.document();
    let mut problems = Vec::new();
    // Past the first place the text stops being JSON with comments, it reads wrong: that place is
    // said alone. A key twice in one object is said wherever it is, as the editor's reader says it.
    if let Err(at) = document {
        problems.push(format!(
            "{}: this is not valid JSON with comments",
            place(at)
        ));
    }
    problems.extend(duplicate_keys(text).into_iter().map(|(key, at)| {
        format!(
            "{}: {} appears twice in the same object",
            place(at),
            quoted(&key)
        )
    }));
    let root = match document {
        Ok(root) if problems.is_empty() => root,
        _ => return Err(problems),
    };
    let members = match root {
        None => return Ok(Settings::default()),
        Some(Node {
            json: Json::Object(members),
            ..
        }) => members,
        Some(other) => {
            return Err(vec![format!(
                "{shown} must hold one object, such as {{}}; it holds {}",
                other.json.kind()
            )]);
        }
    };
    let mut settings = Settings::default();
    for Member { key, at, value } in members {
        match (key.as_str(), value.json) {
            ("yolo", Json::Bool(yolo)) => settings.yolo = yolo,
            ("names", Json::Array(names)) => {
                settings.names = Some(read_names(names, &place, &mut problems));
            }
            ("clis", Json::Object(clis)) => settings.clis = clis,
            ("$schema", Json::String(_)) => {}
            (key, other) => problems.push(match SETTINGS.iter().find(|(name, _)| *name == key) {
                Some((_, must)) => format!("{}: {must}; received {}", place(at), other.kind()),
                None => format!(
                    "{}: {} is not a Facade setting; the settings are yolo, names and clis",
                    place(at),
                    quoted(key)
                ),
            }),
        }
    }
    if problems.is_empty() {
        if !settings.clis.is_empty() {
            settings.source = Some(Source {
                file: shown.to_owned(),
                text: text.to_owned(),
            });
        }
        Ok(settings)
    } else {
        Err(problems)
    }
}

/// The names of `names`, each trimmed; each one that is not a string, or is only spaces, is a
/// problem placed by `place`.
fn read_names<'a>(
    names: Vec<Node>,
    place: &impl Fn(usize) -> SourceLocation<'a>,
    problems: &mut Vec<String>,
) -> Vec<String> {
    let mut kept = Vec::new();
    for (index, name) in names.into_iter().enumerate() {
        match name.json {
            Json::String(text) if !text.chars().all(is_space) => {
                kept.push(text.trim_matches(is_space).to_owned());
            }
            Json::String(_) => problems.push(format!(
                "{}: the name at position {} must not be empty or only spaces",
                place(name.at),
                index + 1
            )),
            other => problems.push(format!(
                "{}: {NAMES_ARE_STRINGS}; received {}",
                place(name.at),
                other.kind()
            )),
        }
    }
    kept
}

/// `key` as a problem quotes it: as a JSON string.
fn quoted(key: &str) -> String {
    serde_json::Value::from(key).to_string()
}

/// Locates byte `at` in `text` as an editor does. Lines end with CR LF, LF or CR alone.
/// `at` is where a character begins or where the text ends.
fn location_in<'a>(text: &str, file: &'a str, at: usize) -> SourceLocation<'a> {
    let before = &text[..at.min(text.len())];
    let (mut line, mut line_begins) = (1, 0);
    for (index, char) in before.char_indices() {
        // CR LF is one line break, counted at its LF.
        let ends_line = match char {
            '\n' => true,
            '\r' => !text[index + 1..].starts_with('\n'),
            _ => false,
        };
        if ends_line {
            line += 1;
            line_begins = index + 1;
        }
    }
    SourceLocation {
        file,
        line,
        column: before[line_begins..].encode_utf16().count() + 1,
    }
}

/// Each key a second time in the same object of `text`, with the byte where that key begins.
/// The text is scanned loosely, as the editor's reader scans it, so that this holds whether or not
/// the text is valid: a string that a colon follows is a key of the innermost object open there.
fn duplicate_keys(text: &str) -> Vec<(String, usize)> {
    let bytes = text.as_bytes();
    // The objects and arrays open, innermost last: an object with its keys so far, an array with
    // None.
    let mut open: Vec<Option<HashSet<String>>> = Vec::new();
    // The string just read, and where it begins: a key if a colon comes next.
    let mut string: Option<(String, usize)> = None;
    let mut twice = Vec::new();
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        let next = bytes.get(at + 1).copied();
        match (byte, next) {
            (b' ' | b'\t' | b'\n' | b'\r', _) => {
                at += 1;
                continue;
            }
            (b'/', Some(b'/')) => {
                at += bytes[at..]
                    .iter()
                    .position(|byte| matches!(byte, b'\n' | b'\r'))
                    .unwrap_or(bytes.len() - at);
                continue;
            }
            (b'/', Some(b'*')) => {
                at = bytes[at + 2..]
                    .windows(2)
                    .position(|pair| pair == b"*/")
                    .map_or(bytes.len(), |end| at + 2 + end + 2);
                continue;
            }
            (b'"', _) => {
                let (key, after) = loose_string(bytes, at);
                string = Some((key, at));
                at = after;
                continue;
            }
            (b':', _) => {
                if let (Some((key, begins)), Some(Some(keys))) = (string.take(), open.last_mut())
                    && !keys.insert(key.clone())
                {
                    twice.push((key, begins));
                }
            }
            (b'{', _) => open.push(Some(HashSet::new())),
            (b'[', _) => open.push(None),
            (b'}' | b']', _) => {
                open.pop();
            }
            _ => {}
        }
        string = None;
        at += 1;
    }
    twice
}

/// The string whose quote is at `begins`, read loosely: it ends at its closing quote, or, left
/// open, at its line's end, and a backslash takes the byte after it along. Gives its value, decoded
/// where it is valid JSON and otherwise as written, and the byte after its end.
fn loose_string(bytes: &[u8], begins: usize) -> (String, usize) {
    let mut at = begins + 1;
    while let Some(&byte) = bytes.get(at)
        && !matches!(byte, b'"' | b'\n' | b'\r')
    {
        at += if byte == b'\\' { 2 } else { 1 };
    }
    let end = at.min(bytes.len());
    let written = &bytes[begins + 1..end];
    let mut quoted = Vec::with_capacity(written.len() + 2);
    quoted.push(b'"');
    quoted.extend_from_slice(written);
    quoted.push(b'"');
    let value = serde_json::from_slice::<String>(&quoted)
        .unwrap_or_else(|_| String::from_utf8_lossy(written).into_owned());
    (value, end + 1)
}

/// A JSON value, as far as the settings read it.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Object(Vec<Member>),
    Array(Vec<Node>),
    String(String),
    Number,
    Bool(bool),
    Null,
}

impl Json {
    /// The value's JSON type, as a problem names it: never its text.
    pub fn kind(&self) -> &'static str {
        match self {
            Json::Object(_) => "object",
            Json::Array(_) => "array",
            Json::String(_) => "string",
            Json::Number => "number",
            Json::Bool(_) => "boolean",
            Json::Null => "null",
        }
    }
}

/// A value and the byte where it begins.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub json: Json,
    pub at: usize,
}

/// An object's member, with the byte where its key begins.
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub key: String,
    pub at: usize,
    pub value: Node,
}

/// Reads JSON with comments and trailing commas strictly. Its error is the byte where the text
/// stops being that; a string that is not one is placed at its opening quote, as the editor places
/// it.
struct Cursor<'a> {
    text: &'a str,
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.peek_after(0)
    }

    fn peek_after(&self, bytes: usize) -> Option<u8> {
        self.text.as_bytes().get(self.at + bytes).copied()
    }

    /// Whether `byte` is next, which is then read.
    fn eat(&mut self, byte: u8) -> bool {
        let next = self.peek() == Some(byte);
        if next {
            self.at += 1;
        }
        next
    }

    /// The document's one value, or none where it holds only spaces and comments.
    fn document(mut self) -> Result<Option<Node>, usize> {
        self.skip()?;
        if self.peek().is_none() {
            return Ok(None);
        }
        let root = self.value()?;
        self.skip()?;
        match self.peek() {
            None => Ok(Some(root)),
            Some(_) => Err(self.at),
        }
    }

    /// Skips spaces, line breaks and comments. An unfinished comment is an error where it begins.
    fn skip(&mut self) -> Result<(), usize> {
        loop {
            let rest = &self.text[self.at..];
            match (self.peek(), self.peek_after(1)) {
                (Some(b' ' | b'\t' | b'\n' | b'\r'), _) => self.at += 1,
                (Some(b'/'), Some(b'/')) => {
                    self.at += rest.find(['\n', '\r']).unwrap_or(rest.len())
                }
                (Some(b'/'), Some(b'*')) => match rest[2..].find("*/") {
                    Some(end) => self.at += 2 + end + 2,
                    None => return Err(self.at),
                },
                _ => return Ok(()),
            }
        }
    }

    fn value(&mut self) -> Result<Node, usize> {
        let at = self.at;
        let json = match self.peek() {
            Some(b'{') => Json::Object(self.items(b'}', Self::member)?),
            Some(b'[') => Json::Array(self.items(b']', Self::value)?),
            Some(b'"') => Json::String(self.string()?),
            Some(b'-' | b'0'..=b'9') => self.number()?,
            Some(b't') => self.word("true", Json::Bool(true))?,
            Some(b'f') => self.word("false", Json::Bool(false))?,
            Some(b'n') => self.word("null", Json::Null)?,
            _ => return Err(at),
        };
        Ok(Node { json, at })
    }

    /// The items of the object or array whose bracket is next, up to its `close`: each read by
    /// `item` after the spaces before it and followed by a comma, which the last may leave out.
    fn items<T>(
        &mut self,
        close: u8,
        item: impl Fn(&mut Self) -> Result<T, usize>,
    ) -> Result<Vec<T>, usize> {
        self.at += 1;
        let mut items = Vec::new();
        loop {
            self.skip()?;
            if self.eat(close) {
                return Ok(items);
            }
            items.push(item(self)?);
            self.skip()?;
            if !self.eat(b',') && self.peek() != Some(close) {
                return Err(self.at);
            }
        }
    }

    fn member(&mut self) -> Result<Member, usize> {
        let at = self.at;
        if self.peek() != Some(b'"') {
            return Err(at);
        }
        let key = self.string()?;
        self.skip()?;
        if !self.eat(b':') {
            return Err(self.at);
        }
        self.skip()?;
        let value = self.value()?;
        Ok(Member { key, at, value })
    }

    /// A string, from its opening quote. One left open, holding a control character or a line
    /// break, or with an escape JSON does not have, is an error where it begins.
    fn string(&mut self) -> Result<String, usize> {
        let begins = self.at;
        self.at += 1;
        let mut string = String::new();
        loop {
            let rest = &self.text[self.at..];
            let plain = rest
                .find(|char: char| matches!(char, '"' | '\\' | '\0'..='\u{1f}'))
                .unwrap_or(rest.len());
            string.push_str(&rest[..plain]);
            self.at += plain;
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(string);
                }
                Some(b'\\') => string.push(self.escape().ok_or(begins)?),
                _ => return Err(begins),
            }
        }
    }

    /// The character the escape at the backslash next stands for: None where JSON has no such
    /// escape. A `\u` escape that is no character stands for the replacement character.
    fn escape(&mut self) -> Option<char> {
        let (char, length) = match self.peek_after(1)? {
            b'"' => ('"', 2),
            b'\\' => ('\\', 2),
            b'/' => ('/', 2),
            b'b' => ('\u{8}', 2),
            b'f' => ('\u{c}', 2),
            b'n' => ('\n', 2),
            b'r' => ('\r', 2),
            b't' => ('\t', 2),
            b'u' => {
                let hex = self.text.get(self.at + 2..self.at + 6)?;
                let unit = u32::from_str_radix(hex, 16).ok()?;
                (
                    char::from_u32(unit).unwrap_or(char::REPLACEMENT_CHARACTER),
                    6,
                )
            }
            _ => return None,
        };
        self.at += length;
        Some(char)
    }

    /// A number as JSON writes one: an optional minus, an integer with no leading zero, a fraction
    /// and an exponent. One that is not is an error where it begins.
    fn number(&mut self) -> Result<Json, usize> {
        let begins = self.at;
        self.eat(b'-');
        if !self.eat(b'0') && self.digits() == 0 {
            return Err(begins);
        }
        if self.eat(b'.') && self.digits() == 0 {
            return Err(begins);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(begins);
            }
        }
        Ok(Json::Number)
    }

    /// How many digits come next, which are then read.
    fn digits(&mut self) -> usize {
        let from = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - from
    }

    /// `word`, which must stand alone, as `json`.
    fn word(&mut self, word: &str, json: Json) -> Result<Json, usize> {
        let rest = &self.text[self.at..];
        let joined = rest
            .as_bytes()
            .get(word.len())
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
        if !rest.starts_with(word) || joined {
            return Err(self.at);
        }
        self.at += word.len();
        Ok(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    const FILE: &str = "~/.facade/facade.json";

    fn read(text: &str) -> Result<Settings, Vec<String>> {
        parse(text, FILE)
    }

    /// The settings of a file that gives `yolo` alone.
    fn yolo(yolo: bool) -> Settings {
        Settings {
            yolo,
            ..Settings::default()
        }
    }

    /// A file of nothing, or only spaces and comments, or `{}`, holds every default: YOLO on.
    #[test]
    fn a_file_of_nothing_holds_every_default() {
        for text in [
            "",
            "  \n\t",
            "// only a comment\n/* and another */",
            "\u{feff}",
            "{}",
            "\u{feff}{ }",
        ] {
            assert_eq!(read(text), Ok(yolo(true)), "{text:?}");
        }
    }

    /// `yolo` reads as the file says, with comments and trailing commas; `names` gives its names
    /// trimmed, and `clis` its members in the file's order, each entry as it is, for its own
    /// reading; `$schema` is taken as it is.
    #[test]
    fn the_settings_read_as_the_file_says_with_comments_and_trailing_commas() {
        assert_eq!(read(r#"{"yolo": false}"#), Ok(yolo(false)));
        let text = "{\n  // Ask for the CLI's normal approvals on future starts.\n  \"yolo\": \
                    true,\n  /* names */ \"names\": [\"Ada\", \" Bo \",],\n}";
        assert_eq!(
            read(text),
            Ok(Settings {
                names: Some(vec!["Ada".into(), "Bo".into()]),
                ..yolo(true)
            })
        );
        assert_eq!(
            read(r#"{"names": []}"#),
            Ok(Settings {
                names: Some(Vec::new()),
                ..yolo(true)
            }),
            "a list of none is a list"
        );
        // Spaces as JavaScript has them: a byte order mark is one, a next-line character is not
        let names = |text: &str| read(text).map(|settings| settings.names.unwrap());
        assert_eq!(
            names(r#"{"names": ["\u0085", "\u0085Ada", "\ufeffBo"]}"#),
            Ok(vec!["\u{85}".into(), "\u{85}Ada".into(), "Bo".into()])
        );
        assert!(
            names(r#"{"names": ["\ufeff"]}"#).unwrap_err()[0]
                .ends_with("the name at position 1 must not be empty or only spaces")
        );
        let text = concat!(
            "\u{feff}{\"clis\": {\"y\": [\"😀\", 1],\r\n",
            "  \"x\": 42},\r",
            r#"  "yolo": false, "$schema": "https://example.invalid/facade.json"}"#,
        );
        let settings = read(text).unwrap();
        assert!(!settings.yolo && settings.names.is_none());
        let members: Vec<(&str, &str)> = settings
            .clis
            .iter()
            .map(|member| (member.key.as_str(), member.value.json.kind()))
            .collect();
        assert_eq!(
            members,
            [("y", "array"), ("x", "number")],
            "each entry as it is, in the file's order"
        );
        let y = &settings.clis[0];
        let Json::Array(items) = &y.value.json else {
            panic!("y must be an array");
        };
        assert_eq!(
            settings.source_location(items[1].at),
            Some(SourceLocation {
                file: FILE,
                line: 1,
                column: 23,
            })
        );
        let x = settings.source_location(settings.clis[1].at).unwrap();
        assert_eq!(x.to_string(), format!("{FILE}:2:3"));
    }

    /// Each whole-file problem is said with the file's path, and the line and column of where it
    /// is, in the words the editor uses (CONFIGURATION-4.1); every problem of a file is said.
    #[test]
    fn each_whole_file_problem_is_said_with_where_it_is() {
        let said = |text: &str| read(text).unwrap_err();
        assert_eq!(
            said(r#"{"yolo": "false"}"#),
            [format!(
                "{FILE}:1:2: yolo must be true or false; received string"
            )]
        );
        assert_eq!(
            said(r#"{"yolo": null}"#),
            [format!(
                "{FILE}:1:2: yolo must be true or false; received null"
            )]
        );
        assert_eq!(
            said("[]"),
            [format!(
                "{FILE} must hold one object, such as {{}}; it holds array"
            )]
        );
        assert_eq!(
            said("7"),
            [format!(
                "{FILE} must hold one object, such as {{}}; it holds number"
            )]
        );
        assert_eq!(
            said(r#"{"color": 1}"#),
            [format!(
                r#"{FILE}:1:2: "color" is not a Facade setting; the settings are yolo, names and clis"#
            )]
        );
        assert_eq!(
            said(r#"{"names": "Ada"}"#),
            [format!(
                "{FILE}:1:2: names must be a list of strings; received string"
            )]
        );
        assert_eq!(
            said(r#"{"names": ["Ada", 3, " "]}"#),
            [
                format!("{FILE}:1:19: names must be a list of strings; received number"),
                format!("{FILE}:1:22: the name at position 3 must not be empty or only spaces")
            ]
        );
        assert_eq!(
            said(r#"{"clis": []}"#),
            [format!(
                "{FILE}:1:2: clis must be an object of CLIs by name; received array"
            )]
        );
        assert_eq!(
            said(r#"{"$schema": 1}"#),
            [format!(
                "{FILE}:1:2: $schema must be a string; received number"
            )]
        );
        assert_eq!(said(r#"{"yolo": 1, "x": 2}"#).len(), 2, "every problem");
    }

    /// A key twice in the same object is a problem at its second place, at any depth; the same key
    /// in another object is not.
    #[test]
    fn a_key_twice_in_one_object_is_a_problem_at_any_depth() {
        assert_eq!(
            read(r#"{"yolo": false, "yolo": true}"#).unwrap_err(),
            [format!(
                r#"{FILE}:1:17: "yolo" appears twice in the same object"#
            )]
        );
        let nested = r#"{"clis": {"a": {"x": 1}, "b": {"x": 1, "x": 2}}}"#;
        assert_eq!(
            read(nested).unwrap_err(),
            [format!(
                r#"{FILE}:1:40: "x" appears twice in the same object"#
            )]
        );
    }

    /// Text that is not JSON with comments is said where it stops being so: an unfinished comment,
    /// a missing comma, a word JSON does not have, a string left open, an empty member, or more
    /// after the one value. Lines end with CR LF, LF or CR, and columns count UTF-16 code units, as
    /// an editor counts them.
    #[test]
    fn text_that_is_not_json_with_comments_is_said_where_it_stops() {
        let syntax = |text: &str| read(text).unwrap_err();
        let at = |line: usize, column: usize| {
            [format!(
                "{FILE}:{line}:{column}: this is not valid JSON with comments"
            )]
        };
        assert_eq!(syntax("/* unfinished"), at(1, 1));
        assert_eq!(syntax(r#"{"yolo": true "names": []}"#), at(1, 15));
        assert_eq!(syntax(r#"{"yolo": tru}"#), at(1, 10));
        assert_eq!(syntax(r#"{"yolo": "open}"#), at(1, 10));
        assert_eq!(syntax(r#"{"yolo": true,,}"#), at(1, 15));
        assert_eq!(syntax("{} {}"), at(1, 4));
        assert_eq!(syntax(r#"{"yolo": 01}"#), at(1, 11));
        assert_eq!(syntax("{\r\n\"yolo\": true\r\n,,}"), at(3, 2));
        assert_eq!(syntax("{\r\"yolo\": true\n\r,,}"), at(4, 2));
        assert_eq!(
            syntax("{\"names\": [\"😀\" 1]}"),
            at(1, 17),
            "an emoji is two UTF-16 units"
        );
    }

    /// The problems are placed as the editor's reader places them: a string
    /// that is not one, with a control character, a line break or an escape JSON does not have, at
    /// its opening quote; and a key twice in one object is said also after the text stopped being
    /// JSON with comments.
    #[test]
    fn problems_are_placed_as_the_editor_places_them() {
        let at_quote = [format!("{FILE}:1:10: this is not valid JSON with comments")];
        for text in [
            "{\"yolo\": \"a\u{1}b\"}",
            "{\"yolo\": \"a\nb\"}",
            r#"{"yolo": "\q"}"#,
            r#"{"yolo": "\u12"}"#,
        ] {
            assert_eq!(read(text).unwrap_err(), at_quote, "{text:?}");
        }
        assert_eq!(
            read(r#"{"yolo": tru, "yolo": true}"#).unwrap_err(),
            [
                format!("{FILE}:1:10: this is not valid JSON with comments"),
                format!(r#"{FILE}:1:15: "yolo" appears twice in the same object"#)
            ]
        );
        assert_eq!(
            read(r#"{"a\u0062": 1, "ab": 2}"#).unwrap_err(),
            [format!(
                r#"{FILE}:1:16: "ab" appears twice in the same object"#
            )],
            "as decoded"
        );
    }

    /// The file is read from the Facade home: a missing file holds every default, and one that
    /// cannot be read says why.
    #[test]
    fn a_missing_file_holds_every_default_and_an_unreadable_one_says_why() {
        let folder = TestFolder::new("settings");
        let file = folder.join(SETTINGS_FILE);
        let missing = read_file(&file).unwrap();
        assert_eq!(missing, yolo(true));
        assert_eq!(missing.source_location(0), None);
        std::fs::write(&file, r#"{"yolo": false}"#).unwrap();
        assert_eq!(read_file(&file), Ok(yolo(false)));
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let unreadable = read_file(&file).unwrap_err();
        assert!(
            unreadable.starts_with(&format!("{} could not be read: ", shown(&file))),
            "{unreadable}"
        );
    }
}
