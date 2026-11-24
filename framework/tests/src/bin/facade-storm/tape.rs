//! What one fake CLI read, showed in its input and submitted, from its `FAKECLI_TAPE`.

use std::path::Path;

use facade_scenarios::serde_json::{self, Value};

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// One submission: its draft's pieces in order.
#[derive(Clone, Debug)]
pub struct Submission {
    pub us: u64,
    pub pieces: Vec<Piece>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    Typed(String),
    Pasted(String),
}

/// One thing the CLI read, whole, with when its last byte was read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Token {
    /// A printable character outside a paste.
    Char(char),
    /// A control byte outside a paste, such as Enter.
    Control(u8),
    /// A bracketed paste as it was read.
    Paste(Paste),
    /// An escape sequence: CSI, SS3, OSC or a lone Escape.
    Escape(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paste {
    pub text: String,
    pub began_us: u64,
    /// The fake CLI numbers only the pastes it displays as placeholders.
    number: Option<usize>,
}

impl Paste {
    /// How the fake CLI draws this paste in its input.
    pub fn displayed(&self) -> String {
        match self.number {
            Some(number) => {
                let lines_after_first = self.text.matches('\n').count();
                format!("[Pasted text #{number} +{lines_after_first} lines]")
            }
            None => self.text.clone(),
        }
    }
}

pub struct Tape {
    pub submissions: Vec<Submission>,
    /// The draft each frame showed where it changed.
    pub boxes: Vec<(u64, String)>,
    pub tokens: Vec<(u64, Token)>,
    /// When each read returned, and its bytes.
    pub reads: Vec<(u64, Vec<u8>)>,
    /// When its first frame was drawn.
    pub drawn: Option<u64>,
    /// When it asked something in place of its input, and when it stopped.
    pub menus: Vec<(u64, bool)>,
}

/// Whether a paste is one Facade makes.
pub fn is_facades(text: &str) -> bool {
    text.starts_with("📨 Message m") || text.starts_with("🔔 ")
}

impl Tape {
    /// What a CLI without a tape submitted.
    pub fn of(submissions: Vec<Submission>) -> Tape {
        Tape {
            submissions,
            boxes: Vec::new(),
            tokens: Vec::new(),
            reads: Vec::new(),
            menus: Vec::new(),
            drawn: None,
        }
    }

    pub fn read(file: &Path) -> Tape {
        let mut tape = Tape::of(Vec::new());
        let text = std::fs::read_to_string(file).unwrap_or_default();
        for line in text.lines() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let us = entry["us"].as_u64().unwrap_or_default();
            if let Some(read) = entry["in"].as_str() {
                if let Ok(bytes) = facade_base::base64::decode(read) {
                    tape.reads.push((us, bytes));
                }
            } else if entry["drawn"] == true {
                tape.drawn.get_or_insert(us);
            } else if let Some(open) = entry["menu"].as_bool() {
                tape.menus.push((us, open));
            } else if let Some(shown) = entry["box"].as_str() {
                tape.boxes.push((us, shown.to_string()));
            } else if let Some(pieces) = entry["submit"].as_array() {
                tape.submissions.push(Submission {
                    us,
                    pieces: pieces
                        .iter()
                        .filter_map(|piece| {
                            let text = |name: &str| piece[name].as_str().map(str::to_string);
                            text("text")
                                .map(Piece::Typed)
                                .or_else(|| text("paste").map(Piece::Pasted))
                        })
                        .collect(),
                });
            }
        }
        tape.tokens = tokens(&tape.reads);
        tape
    }

    /// [`Tape::held_ms`], and besides, from each of a person's keys until the input shows, in order,
    /// what that key left: its line so far after a character or a Backspace, an empty input after an
    /// Enter, the pasted text or its own placeholder after a paste. If the CLI takes a paste without
    /// drawing it, the following edits cannot account for its missing frame. The person's use then
    /// holds the input until both their keys and the input have been quiet for 2.5 s.
    pub fn held_with_keys_ms(&self, from: u64, to: u64) -> u64 {
        const SLOWEST_DRAW: u64 = 2_500_000;
        // The person's keys as the CLI read them, each with what the input shows once it has them.
        let mut keys = Vec::new();
        let (mut line, mut theirs) = (String::new(), false);
        for (us, token) in &self.tokens {
            match token {
                Token::Char(ch) => {
                    line.push(*ch);
                    theirs = true;
                    keys.push((*us, *us, line.clone(), false));
                }
                Token::Paste(paste) if !is_facades(&paste.text) => {
                    theirs = true;
                    line.push_str(&paste.displayed());
                    keys.push((paste.began_us, *us, line.clone(), true));
                }
                Token::Control(0x7f | 0x08) if theirs => {
                    line.pop();
                    keys.push((*us, *us, line.clone(), false));
                }
                Token::Control(b'\r') if theirs => {
                    line.clear();
                    theirs = false;
                    keys.push((*us, *us, String::new(), false));
                }
                Token::Paste(_) | Token::Control(b'\r') => {
                    line.clear();
                    theirs = false;
                }
                _ => {}
            }
        }
        let mut spans: Vec<(u64, u64)> = Vec::new();
        let mut next_box = 0;
        for (at, (began, us, expected, paste)) in keys.iter().enumerate() {
            // The input's changes after this key, in order, from where the key before left off.
            while next_box < self.boxes.len() && self.boxes[next_box].0 < *us {
                next_box += 1;
            }
            let seen = self.boxes[next_box..]
                .iter()
                .position(|(_, shown)| shown.trim_end() == expected.trim_end());
            let until = match seen {
                Some(found) => {
                    next_box += found;
                    self.boxes[next_box].0
                }
                None if *paste => {
                    // A later paste's draft and Enter belong to that paste. Keep the unshown
                    // interval until the end of this stretch of editing, including the final draw.
                    let mut edits = keys[at + 1..].iter().peekable();
                    let mut drawings = self.boxes[next_box..]
                        .iter()
                        .map(|frame| frame.0)
                        .peekable();
                    let mut until = us + SLOWEST_DRAW;
                    loop {
                        let edit = edits.peek().map(|key| key.0);
                        let Some(next) = edit.into_iter().chain(drawings.peek().copied()).min()
                        else {
                            break;
                        };
                        if next > until {
                            break;
                        }
                        let last = if edit == Some(next) {
                            edits.next().unwrap().1
                        } else {
                            drawings.next().unwrap()
                        };
                        until = until.max(last + SLOWEST_DRAW);
                    }
                    until
                }
                None => {
                    let later = keys.get(at + 1).map_or(0, |key| key.0);
                    let changed = self
                        .boxes
                        .iter()
                        .map(|(us, _)| *us)
                        .filter(|change| *change >= *us && *change <= us + SLOWEST_DRAW)
                        .max()
                        .unwrap_or(*us);
                    (changed.max(*us) + SLOWEST_DRAW).min(later.max(us + SLOWEST_DRAW))
                }
            };
            spans.push((*began, until));
        }
        let mut held = self.held_spans();
        held.extend(spans);
        held.sort_unstable();
        let (mut total, mut end) = (0u64, 0u64);
        for (start, stop) in held {
            let (start, stop) = (start.max(from).max(end), stop.min(to));
            if stop > start {
                total += stop - start;
            }
            end = end.max(stop);
        }
        total / 1000
    }

    /// How long, between two times, its input held something that was not Facade's, or a question
    /// was in its place, in milliseconds: what the person's draft or a menu kept from Facade.
    pub fn held_ms(&self, from: u64, to: u64) -> u64 {
        self.held_spans()
            .into_iter()
            .map(|(start, stop)| stop.min(to).saturating_sub(start.max(from)))
            .sum::<u64>()
            / 1000
    }

    /// When its input held something that was not Facade's, or a question was in its place.
    fn held_spans(&self) -> Vec<(u64, u64)> {
        // The numbers the fake CLI gives Facade's pastes in their placeholders.
        let mut facades = std::collections::BTreeSet::new();
        for (_, token) in &self.tokens {
            if let Token::Paste(paste) = token
                && let Some(number) = paste.number
                && is_facades(&paste.text)
            {
                facades.insert(number);
            }
        }
        let is_held = |shown: &str| {
            !shown.trim().is_empty()
                && !facades
                    .iter()
                    .any(|number| shown.contains(&format!("[Pasted text #{number} ")))
                && !shown.contains("[Pasted Content ")
                && !is_facades(shown)
        };
        let mut changes: Vec<(u64, Option<bool>, Option<bool>)> = self
            .boxes
            .iter()
            .map(|(us, shown)| (*us, Some(is_held(shown)), None))
            .chain(self.menus.iter().map(|(us, open)| (*us, None, Some(*open))))
            .collect();
        changes.sort_by_key(|(us, ..)| *us);
        let (mut draft, mut menu, mut since) = (false, false, 0);
        let mut spans = Vec::new();
        for (us, drafts, asks) in changes {
            if draft || menu {
                spans.push((since, us));
            }
            since = us;
            draft = drafts.unwrap_or(draft);
            menu = asks.unwrap_or(menu);
        }
        if draft || menu {
            spans.push((since, u64::MAX));
        }
        spans
    }

    /// Where each of Facade's messages spent its time in the input, in milliseconds: until the CLI drew
    /// its draft; until Facade's key was read; until the CLI drew the input emptied; and until the next
    /// message's paste was read, which Facade did alone.
    pub fn segments(&self) -> [Vec<f64>; 4] {
        let mut out: [Vec<f64>; 4] = Default::default();
        let ms = |from: u64, to: u64| to.saturating_sub(from) as f64 / 1000.0;
        let pastes: Vec<u64> = self
            .tokens
            .iter()
            .filter(|(_, token)| matches!(token, Token::Paste(paste) if is_facades(&paste.text)))
            .map(|(us, _)| *us)
            .collect();
        for (at, paste) in pastes.iter().enumerate() {
            let next = pastes.get(at + 1).copied();
            let after = |us: u64, empty: bool| {
                self.boxes
                    .iter()
                    .find(|(drawn, shown)| *drawn >= us && shown.is_empty() == empty)
                    .map(|(drawn, _)| *drawn)
            };
            let Some(drawn) = after(*paste, false) else {
                continue;
            };
            let Some(key) = self
                .submissions
                .iter()
                .map(|submission| submission.us)
                .find(|us| us >= paste)
                .filter(|us| next.is_none_or(|next| *us < next))
            else {
                continue;
            };
            out[0].push(ms(*paste, drawn));
            out[1].push(ms(drawn, key));
            if let Some(emptied) = after(key, true) {
                out[2].push(ms(key, emptied));
                // Only where another message waited.
                if let Some(next) = next.filter(|next| *next < emptied + 400_000) {
                    out[3].push(ms(emptied, next));
                }
            }
        }
        out
    }

    /// The draft its last frame showed.
    pub fn last_box(&self) -> &str {
        self.boxes.last().map_or("", |(_, shown)| shown.as_str())
    }
}

/// `reads` split into what each byte was part of, each with when its last byte came.
fn tokens(reads: &[(u64, Vec<u8>)]) -> Vec<(u64, Token)> {
    let bytes: Vec<u8> = reads.iter().flat_map(|(_, bytes)| bytes.clone()).collect();
    let mut ends = Vec::with_capacity(reads.len());
    let mut total = 0;
    for (us, bytes) in reads {
        total += bytes.len();
        ends.push((total, *us));
    }
    // When the byte before `end` was read.
    let at = |end: usize| {
        let index = ends.partition_point(|&(through, _)| through < end);
        ends.get(index).map_or(0, |&(_, us)| us)
    };
    let mut out = Vec::new();
    let mut i = 0;
    let mut number = 0;
    while i < bytes.len() {
        let rest = &bytes[i..];
        if rest.starts_with(PASTE_START) {
            let from = i + PASTE_START.len();
            let end = find(&bytes[from..], PASTE_END).map(|at| from + at);
            let (text, next) = match end {
                Some(end) => (&bytes[from..end], end + PASTE_END.len()),
                None => (&bytes[from..], bytes.len()),
            };
            let mut text = crate::judge::plain(&String::from_utf8_lossy(text));
            let placeholder = end.is_some() && (text.contains('\n') || text.len() > 400);
            if end.is_none() {
                text.push_str("<no end>");
            }
            if placeholder {
                number += 1;
            }
            out.push((
                at(next),
                Token::Paste(Paste {
                    text,
                    began_us: at(i + 1),
                    number: placeholder.then_some(number),
                }),
            ));
            i = next;
        } else if rest[0] == 0x1b {
            let length = escape_length(rest);
            out.push((at(i + length), Token::Escape(rest[..length].to_vec())));
            i += length;
        } else if rest[0] < 0x20 || rest[0] == 0x7f {
            out.push((at(i + 1), Token::Control(rest[0])));
            i += 1;
        } else {
            let length = match rest[0] {
                0x00..0x80 => 1,
                0x80..0xe0 => 2,
                0xe0..0xf0 => 3,
                _ => 4,
            }
            .min(rest.len());
            let ch = std::str::from_utf8(&rest[..length])
                .ok()
                .and_then(|text| text.chars().next())
                .unwrap_or(char::REPLACEMENT_CHARACTER);
            out.push((at(i + length), Token::Char(ch)));
            i += length;
        }
    }
    out
}

/// How many bytes the escape sequence at the start of `bytes` takes.
fn escape_length(bytes: &[u8]) -> usize {
    match bytes.get(1) {
        Some(b'[') => {
            let end = bytes[2..]
                .iter()
                .position(|byte| (0x40..=0x7e).contains(byte));
            end.map_or(bytes.len(), |at| at + 3)
        }
        Some(b'O') => 3.min(bytes.len()),
        Some(b']') | Some(b'P') => {
            let mut end = 2;
            while end < bytes.len() {
                match bytes[end] {
                    0x07 => return end + 1,
                    0x1b => return (end + 2).min(bytes.len()),
                    _ => end += 1,
                }
            }
            bytes.len()
        }
        _ => 1,
    }
}

fn find(bytes: &[u8], what: &[u8]) -> Option<usize> {
    bytes.windows(what.len()).position(|part| part == what)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_paste_does_not_show_the_one_the_cli_skipped_drawing() {
        let mut tape = Tape::of(Vec::new());
        tape.tokens = tokens(&[
            (100_000, b"\x1b[200~one".to_vec()),
            (300_000, b"\rtwo\x1b[201~\r".to_vec()),
            (1_800_000, b"\x1b[200~three\rfour\x1b[201~".to_vec()),
            (2_000_000, b"\r".to_vec()),
        ]);
        tape.boxes = vec![
            (1_900_000, "[Pasted text #2 +1 lines]".to_string()),
            (2_100_000, String::new()),
        ];
        assert_eq!(tape.held_with_keys_ms(0, 10_000_000), 4500);
    }

    #[test]
    fn a_chunked_paste_holds_from_its_first_byte_to_its_own_draft_and_clear() {
        let mut tape = Tape::of(Vec::new());
        tape.tokens = tokens(&[
            (100_000, b"\x1b[200~one".to_vec()),
            (300_000, b"\rtwo\x1b[201~".to_vec()),
            (400_000, b"\r".to_vec()),
        ]);
        tape.boxes = vec![
            (350_000, "[Pasted text #1 +1 lines]".to_string()),
            (500_000, String::new()),
        ];
        assert_eq!(tape.held_with_keys_ms(0, 10_000_000), 400);
    }
}
