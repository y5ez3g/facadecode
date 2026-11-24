//! The little JSON the relay reads and writes. It reads a line's top-level `id`, `method` and
//! `error`, each as the line's own bytes, and skips everything else; it writes the strings of its
//! hello.

use std::fmt::Write;

/// What a line is, by its top-level `id` and `method`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Message<'a> {
    /// It has a `method` and an `id`: it waits for a response. The `id` as written, a string's
    /// quotes included.
    Request { id: &'a [u8] },
    /// It has a `method` and no `id`. The `method` as written, its quotes included.
    Notification { method: &'a [u8] },
    /// It has an `id` and no `method`; `error` where it holds one.
    Response { id: &'a [u8], error: bool },
    /// No JSON object, such as a batch, or an object with neither.
    Other,
}

/// Reads what `line` is.
pub(crate) fn read(line: &[u8]) -> Message<'_> {
    let mut cursor = Cursor { line, at: 0 };
    let Some(fields) = cursor.top_level() else {
        return Message::Other;
    };
    match (fields.id, fields.method) {
        (Some(id), Some(_)) => Message::Request { id },
        (None, Some(method)) => Message::Notification { method },
        (Some(id), None) => Message::Response {
            id,
            error: fields.error,
        },
        (None, None) => Message::Other,
    }
}

/// `text` as a JSON string.
pub(crate) fn string(text: &str) -> String {
    let mut string = String::from('"');
    for c in text.chars() {
        match c {
            '"' => string.push_str("\\\""),
            '\\' => string.push_str("\\\\"),
            // Writing to a String cannot fail.
            '\u{0}'..='\u{1f}' => _ = write!(string, "\\u{:04x}", u32::from(c)),
            c => string.push(c),
        }
    }
    string.push('"');
    string
}

/// The top-level fields the relay looks at.
#[derive(Default)]
struct Fields<'a> {
    id: Option<&'a [u8]>,
    method: Option<&'a [u8]>,
    error: bool,
}

/// A position in a line, moved forward over JSON.
struct Cursor<'a> {
    line: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn byte(&self) -> Option<u8> {
        self.line.get(self.at).copied()
    }

    /// The next byte that is not space.
    fn after_space(&mut self) -> Option<u8> {
        while matches!(self.byte()?, b' ' | b'\t' | b'\r' | b'\n') {
            self.at += 1;
        }
        self.byte()
    }

    /// The fields of the object the line holds; `None` where it holds no object.
    fn top_level(&mut self) -> Option<Fields<'a>> {
        let mut fields = Fields::default();
        if self.after_space()? != b'{' {
            return None;
        }
        self.at += 1;
        if self.after_space()? == b'}' {
            return Some(fields);
        }
        loop {
            if self.after_space()? != b'"' {
                return None;
            }
            let key = self.value()?;
            if self.after_space()? != b':' {
                return None;
            }
            self.at += 1;
            self.after_space()?;
            let value = self.value()?;
            match key {
                b"\"id\"" => fields.id = Some(value),
                b"\"method\"" => fields.method = Some(value),
                b"\"error\"" => fields.error = true,
                _ => {}
            }
            match self.after_space()? {
                b',' => self.at += 1,
                b'}' => return Some(fields),
                _ => return None,
            }
        }
    }

    /// Moves over the value that starts here and gives its bytes.
    fn value(&mut self) -> Option<&'a [u8]> {
        let start = self.at;
        match self.byte()? {
            b'"' => self.skip_string()?,
            b'{' | b'[' => self.skip_nested()?,
            _ => {
                while self
                    .byte()
                    .is_some_and(|byte| !b",:}] \t\r\n".contains(&byte))
                {
                    self.at += 1;
                }
            }
        }
        if self.at == start {
            return None;
        }
        self.line.get(start..self.at)
    }

    /// Moves past the string that starts here, its closing quote included.
    fn skip_string(&mut self) -> Option<()> {
        self.at += 1;
        loop {
            match self.byte()? {
                b'"' => break,
                b'\\' => self.at += 2,
                _ => self.at += 1,
            }
        }
        self.at += 1;
        Some(())
    }

    /// Moves past the object or array that starts here, whatever it holds.
    fn skip_nested(&mut self) -> Option<()> {
        let mut depth = 0_usize;
        loop {
            match self.byte()? {
                b'"' => {
                    self.skip_string()?;
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth = depth.checked_sub(1)?,
                _ => {}
            }
            self.at += 1;
            if depth == 0 {
                return Some(());
            }
        }
    }
}
