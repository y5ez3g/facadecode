//! Whether the input box shows a pasted message as its own draft: the message's text, wrapped and
//! indented as the CLI's rows draw it, or the placeholder the CLI draws for a paste of its size. A
//! message's submission key goes only over its own draft.

use std::ops::Range;
use std::time::Duration;

use facade_base::model::terminal::{HiddenRows, InputState};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use super::{BoxReading, canonical_text, caret_in_paste};
use crate::{BackspaceUnit, PasteCount, PastePlaceholder, PasteRule};

impl PasteRule {
    /// The number of Backspaces to issue before reading the box again. The number of
    /// graphemes is a lower bound when the editor's unit is unknown.
    pub fn backspace_count(&self, text: &str) -> usize {
        let unit = self.backspace_unit.unwrap_or(BackspaceUnit::Grapheme);
        match unit {
            BackspaceUnit::CodePoint => text.chars().count(),
            _ if self.backspace_single_code_points.is_none() => {
                text.graphemes(unit == BackspaceUnit::Grapheme).count()
            }
            _ => self.grapheme_backspaces(text, unit).count(),
        }
    }

    /// An editor with an unknown unit can need another batch after its next complete drawing.
    pub fn rechecks_cleanup(&self) -> bool {
        self.backspace_unit.is_none()
    }

    /// Checks which literal remainder the complete box actually shows after confirmed keys.
    /// Without an editor rule, look for the grapheme or scalar remainder of the original or
    /// its canonical spellings. More keys still use the lower bound.
    pub fn remaining_cleanup(
        &self,
        text: &str,
        written: usize,
        shows: impl Fn(&str) -> bool,
    ) -> Option<usize> {
        let after_code_points = |text: &str| {
            match_remainder(text, written, code_point_backspaces(text), &shows)
                .map(|(remaining, _)| self.backspace_count(remaining))
        };
        let after_graphemes = |unit| {
            match_remainder(text, written, self.grapheme_backspaces(text, unit), &shows)
                .map(|(_, remaining)| remaining.count())
        };
        match self.backspace_unit {
            Some(BackspaceUnit::CodePoint) => {
                return match_remainder(text, written, code_point_backspaces(text), &shows)
                    .map(|(_, remaining)| remaining.count());
            }
            Some(unit) => return after_graphemes(unit),
            None => {}
        }
        after_graphemes(BackspaceUnit::Grapheme)
            .or_else(|| after_code_points(text))
            .or_else(|| {
                if text.is_ascii() {
                    return None;
                }
                let composed = canonical_text(text);
                after_code_points(&composed).or_else(|| {
                    let decomposed: String = text.nfd().collect();
                    after_code_points(&decomposed)
                })
            })
    }

    /// Walks the grapheme boundaries once. Only each cluster's trailing exceptions are split
    /// out as separate keys, before removing the rest of that cluster in one key.
    fn grapheme_backspaces<'a>(
        &'a self,
        text: &'a str,
        unit: BackspaceUnit,
    ) -> impl Iterator<Item = usize> + 'a {
        let singles = self.backspace_single_code_points.as_ref();
        text.grapheme_indices(unit == BackspaceUnit::Grapheme)
            .rev()
            .flat_map(move |(at, mut cluster)| {
                std::iter::from_fn(move || {
                    let (offset, ch) = cluster.char_indices().next_back()?;
                    if singles.is_some_and(|pattern| pattern.is_match(ch.encode_utf8(&mut [0; 4])))
                    {
                        cluster = &cluster[..offset];
                        Some(at + offset)
                    } else {
                        cluster = "";
                        Some(at)
                    }
                })
            })
    }
}

fn code_point_backspaces(text: &str) -> impl Iterator<Item = usize> + '_ {
    text.char_indices().rev().map(|(at, _)| at)
}

/// Leaves the iterator ready to count the keys still needed, using the same boundary scan.
fn match_remainder<I: Iterator<Item = usize>>(
    text: &str,
    written: usize,
    mut backspaces: I,
    shows: impl Fn(&str) -> bool,
) -> Option<(&str, I)> {
    let end = match written.checked_sub(1) {
        Some(last) => backspaces.nth(last)?,
        None => text.len(),
    };
    let remaining = &text[..end];
    (!remaining.is_empty() && shows(remaining)).then_some((remaining, backspaces))
}

impl PasteRule {
    /// Whether the live composer shows the colored disclosure and its cursor. This allows a
    /// reveal gesture. The label gives no evidence of the draft's contents.
    pub fn shows_tab_to_expand(&self, reading: &BoxReading) -> bool {
        let (Some(pattern), Some(line), Some(draft)) = (
            self.tab_to_expand.as_ref(),
            reading.line.as_ref(),
            reading.draft.as_deref(),
        ) else {
            return false;
        };
        reading.info.state == InputState::Draft
            && reading.info.hidden.is_none()
            && !line.rest
            && pattern.is_match(draft.trim())
            && line
                .cells
                .iter()
                .filter(|cell| !cell.text.trim().is_empty())
                .all(|cell| cell.colored && !cell.dim)
            && line
                .cells
                .iter()
                .position(|cell| cell.text == "▸")
                .is_some_and(|at| line.cursor == (line.start + at + 2, line.row))
    }
}

/// Whether all of `text` is visible, allowing the same whitespace differences as a normal draft.
pub fn is_full_draft(draft: &str, text: &str, hidden: Option<HiddenRows>) -> bool {
    hidden.is_none_or(|rows| rows.above == 0 && rows.below == 0) && draws_text(draft, text, None)
}

/// Whether `draft` is `text` alone in the input box, or the CLI's placeholder for a paste of
/// `text`. `hidden` counts the draft's rows scrolled out of the input box. Never waits.
pub fn is_own_draft(
    paste: &PasteRule,
    draft: &str,
    text: &str,
    hidden: Option<HiddenRows>,
) -> bool {
    draws_text(draft, text, hidden) || shows_paste_placeholder(paste, draft, text)
}

/// Whether the CLI draws `draft` as a placeholder for this paste's size.
pub fn shows_paste_placeholder(paste: &PasteRule, draft: &str, text: &str) -> bool {
    paste
        .placeholders
        .iter()
        .any(|placeholder| draws_placeholder(placeholder, draft, None, text))
}

/// Whether this CLI draws the reading as a paste marker, independent of its number or size.
pub fn is_paste_placeholder(paste: &PasteRule, draft: &str) -> bool {
    paste.placeholders.iter().any(|placeholder| {
        let shown = placeholder_spacing(placeholder, draft);
        let shown = if placeholder.after_first_character {
            let mut chars = shown.chars();
            if chars.next().is_none_or(|first| first.is_ascii()) {
                return false;
            }
            chars.as_str()
        } else {
            shown.as_str()
        };
        placeholder.pattern.is_match(shown)
    })
}

/// Whether the complete painted input locates the end of a paste the CLI draws as it types.
pub fn shows_paste_end(reading: &BoxReading, text: &str) -> bool {
    let Some((draft, drawing)) = reading.draft.as_deref().zip(reading.paste_drawing) else {
        return false;
    };
    if reading.draft_hidden().is_some_and(|rows| rows.below != 0) {
        return false;
    }

    let (body, line_breaks) = before_final_lines(text);
    if drawing.final_line_breaks != line_breaks {
        return false;
    }
    let tail = &text[body.len()..];
    let body = canonical_text(body);
    let draft = canonical_text(draft);
    let wanted = body.graphemes(true).next_back();
    let shown = draft.graphemes(true).next_back();
    let glyph_changed = wanted != shown;

    let drawn = visible_presentation(&draft);
    let expected = visible_presentation(&body);
    let has_unicode_tail = text
        .trim_end_matches([' ', '\t'])
        .ends_with(|c: char| !c.is_ascii() && horizontal_space(c));
    if glyph_changed || has_unicode_tail {
        let mut spaces = trailing_horizontal_spaces(tail);
        if line_breaks == 0 {
            // The projection can expose blanks already drawn before a retained zero-width glyph.
            // Those are part of the drawn body, so count only the blanks the screen needs after it.
            let projected_spaces = spaces + trailing_horizontal_spaces(&expected);
            let Some(remaining) = projected_spaces.checked_sub(trailing_horizontal_spaces(&drawn))
            else {
                return false;
            };
            spaces = remaining;
        }
        if (line_breaks == 0 && spaces == 0) || drawing.final_spaces < spaces {
            return false;
        }
    }
    if glyph_changed {
        let drawn = keep_logical_lines(&drawn);
        let expected = keep_logical_lines(&expected);
        if caret_in_paste(&drawn, (0, 0), &expected).is_none() {
            return false;
        }
    }

    let drawn = without_space(&drawn);
    let text = without_space(&expected);
    let matching_bytes = drawn
        .chars()
        .rev()
        .zip(text.chars().rev())
        .take_while(|(drawn, wanted)| drawn == wanted)
        .map(|(_, wanted)| wanted.len_utf8())
        .sum::<usize>();
    if matching_bytes == 0 {
        return false;
    }
    let tail = &text[text.len() - matching_bytes..];
    if tail.is_ascii() {
        // A lost glyph can bring ASCII letters together earlier in the same paste.
        let ascii = text.chars().filter(char::is_ascii).collect::<String>();
        ascii.find(tail) == Some(ascii.len() - tail.len())
    } else {
        text.find(tail) == Some(text.len() - tail.len())
    }
}

/// Treat final horizontal padding like the logical draft summary. Count original hard breaks,
/// treating CRLF as one, so the caret at the end of the previous row cannot prove a paste.
fn before_final_lines(text: &str) -> (&str, usize) {
    let mut body = text.trim_end_matches(horizontal_space);
    let mut count = 0;
    while let Some(previous) = body
        .strip_suffix("\r\n")
        .or_else(|| body.strip_suffix(['\r', '\n']))
    {
        body = previous.trim_end_matches(horizontal_space);
        count += 1;
    }
    (body, count)
}

fn horizontal_space(c: char) -> bool {
    c.is_whitespace() && !matches!(c, '\r' | '\n')
}

fn trailing_horizontal_spaces(text: &str) -> usize {
    text.chars()
        .rev()
        .take_while(|&c| horizontal_space(c))
        .count()
}

fn keep_logical_lines(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(*c, '\r' | '\n') || !c.is_whitespace())
        .collect()
}

/// Text in an observed terminal presentation. Retains layout until the caller compares it.
fn visible_presentation(text: &str) -> String {
    let mut visible = String::with_capacity(text.len());
    for glyph in text.graphemes(true) {
        let shown = glyph
            .split_once('\u{200d}')
            .map_or(glyph, |(first, _)| first);
        visible.extend(shown.chars().filter(|&c| {
            !matches!(
                c,
                '\u{00ad}'
                    | '\u{200b}'
                    | '\u{2060}'
                    | '\u{feff}'
                    | '\u{fe0e}'
                    | '\u{fe0f}'
                    | '\u{1f3fb}'..='\u{1f3ff}'
            )
        }));
    }
    visible
}

/// How many characters Backspace can remove from a complete, plain draft at its end.
/// A paste marker, clipped rows, or an unproved cursor position has no such bound.
pub fn draft_backspace_count(paste: &PasteRule, reading: &BoxReading) -> Option<usize> {
    if reading.info.state != InputState::Draft
        || reading
            .draft_hidden()
            .is_some_and(|hidden| hidden.above != 0 || hidden.below != 0)
    {
        return None;
    }
    let (shown, line) = (reading.draft.as_deref()?, reading.line.as_ref()?);
    if is_paste_placeholder(paste, shown) {
        return None;
    }
    let last = shown.lines().last()?;
    let last_row = line.row + shown.lines().count() - 1;
    let width = if last_row == line.row {
        line.cells.len()
    } else if last.is_ascii() {
        last.len()
    } else {
        return None;
    };
    let (column, row) = line.cursor;
    if row != last_row || column < line.start + width {
        return None;
    }
    Some(paste.backspace_count(shown) + column - line.start - width)
}

/// For recovery, whether the visible draft shows the old typed prefix followed by the CLI's
/// placeholder for the separately pasted text.
pub fn is_legacy_split_paste(paste: &PasteRule, draft: &str, prefix: &str, pasted: &str) -> bool {
    !prefix.trim().is_empty()
        && paste
            .legacy_split_prefixes
            .iter()
            .any(|known| known == prefix)
        && paste
            .placeholders
            .iter()
            .any(|placeholder| draws_placeholder(placeholder, draft, Some(prefix), pasted))
}

/// Whether a complete recovered box shows the original paste in a layout the rule recognizes.
pub fn is_own_recovered_draft(
    paste: &PasteRule,
    draft: &str,
    text: &str,
    hidden: Option<HiddenRows>,
) -> bool {
    is_own_draft(paste, draft, text, hidden)
        || (hidden.is_none()
            && paste.legacy_split_prefixes.iter().any(|prefix| {
                text.strip_prefix(prefix)
                    .is_some_and(|rest| is_legacy_split_paste(paste, draft, prefix, rest))
            }))
}

/// Whether `shown` is the visible end of a paste made into a previously empty input.
pub fn is_own_paste_tail(shown: &str, text: &str) -> bool {
    let shown = without_space(shown);
    !shown.is_empty() && without_space(text).ends_with(&shown)
}

/// Whether `draft` is still `seen`, the draft an earlier reading took for the paste of `text`: the
/// same placeholder, paste number included, as a later paste of the same size gets another number;
/// or `text` itself. Never waits.
pub fn is_same_draft(draft: &str, seen: &str, text: &str, hidden: Option<HiddenRows>) -> bool {
    without_space(draft) == without_space(seen) || draws_text(draft, text, hidden)
}

/// Whether `draft` shows all of `text`, alone or with other text around it. A placeholder does not,
/// nor does a draft with rows scrolled out of the input box. Never waits.
pub fn shows_whole(draft: &str, text: &str, hidden: Option<HiddenRows>) -> bool {
    hidden.is_none_or(|hidden| hidden.above == 0 && hidden.below == 0)
        && without_space(draft).contains(&without_space(text))
}

/// Whether a literal draft could still be a prefix of the paste. Wrapped whitespace can be
/// absent, and a code-point editor can erase a combining mark while leaving its base character.
pub fn could_be_paste_prefix(paste: &str, shown: &str) -> bool {
    let visible = |ch: &char| !ch.is_whitespace();
    let mut original = paste.chars().filter(visible);
    if shown
        .chars()
        .filter(visible)
        .all(|ch| original.next() == Some(ch))
    {
        return true;
    }
    let mut original = paste.nfd().filter(visible);
    shown
        .nfd()
        .filter(visible)
        .all(|ch| original.next() == Some(ch))
}

pub use is_full_draft as shows_original_text;

/// `draft` with the placeholders the CLI draws for pastes of `texts` given back as their text. Each
/// paste, in order, takes the first placeholder of its size that no earlier paste took; a paste
/// the draft shows no placeholder for changes nothing. Never waits.
pub fn with_paste_text(paste: &PasteRule, draft: &str, texts: &[String]) -> String {
    // Where a placeholder may be: from a character that shows to a `]`, by start, then by end.
    let spans: Vec<Range<usize>> = draft
        .char_indices()
        .filter(|(_, c)| !c.is_whitespace())
        .flat_map(|(start, _)| {
            draft[start..]
                .match_indices(']')
                .map(move |(close, _)| start..start + close + 1)
        })
        .collect();
    let mut taken: Vec<(Range<usize>, &str)> = Vec::new();
    for text in texts {
        let free = |span: &Range<usize>| {
            taken
                .iter()
                .all(|(other, _)| span.end <= other.start || other.end <= span.start)
        };
        let fits = |span: &Range<usize>| {
            paste
                .placeholders
                .iter()
                .any(|placeholder| draws_placeholder(placeholder, &draft[span.clone()], None, text))
        };
        if let Some(span) = spans.iter().find(|span| free(span) && fits(span)) {
            taken.push((span.clone(), text));
        }
    }
    taken.sort_unstable_by_key(|(span, _)| span.start);
    let mut given = String::with_capacity(draft.len());
    let mut copied = 0;
    for (span, text) in &taken {
        given += &draft[copied..span.start];
        given += text;
        copied = span.end;
    }
    given + &draft[copied..]
}

/// How long a message's own draft shows before submission, including the wait for each line.
pub fn settle_time(paste: &PasteRule, text: &str) -> Duration {
    Duration::from_millis(paste.enter_ms + line_count(text) as u64 * paste.line_ms)
}

/// Lines end at `\n`, `\r` or `\r\n`.
fn line_count(text: &str) -> usize {
    1 + text.replace("\r\n", "\n").matches(['\n', '\r']).count()
}

/// Whether the placeholder's size count, if present, matches the paste.
fn matches_count(count: PasteCount, number: Option<usize>, text: &str) -> bool {
    let one_ending = || text.replace("\r\n", "\n");
    match (count, number) {
        (PasteCount::Lines, Some(n)) => n == line_count(text),
        (PasteCount::TrimmedLines, Some(n)) => n == line_count(text.trim()),
        (PasteCount::LinesAfterFirst, Some(n)) => n == line_count(text) - 1,
        (PasteCount::SingleLine, None) => !text.contains(['\n', '\r']),
        // CLIs count either code points or UTF-16 units.
        (PasteCount::Chars, Some(n)) => {
            let text = one_ending();
            n == text.chars().count() || n == text.encode_utf16().count()
        }
        (PasteCount::UnicodeScalars, Some(n)) => n == one_ending().chars().count(),
        (PasteCount::Utf16, Some(n)) => n == one_ending().encode_utf16().count(),
        (PasteCount::VisibleUtf16, Some(n)) => {
            let units = one_ending()
                .chars()
                .map(|c| match c {
                    '\t' => 4,
                    '\n' | '\r' => 1,
                    c if c < ' ' => 0,
                    c => c.len_utf16(),
                })
                .sum::<usize>();
            n == units
        }
        _ => false,
    }
}

/// `text` without whitespace, as wrapping and indentation draw it differently.
fn without_space(text: &str) -> String {
    text.split_whitespace().collect()
}

/// `text` with each run of whitespace as one space.
fn single_spaced(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `draft` shows `text` in full, or its end while rows are scrolled out above only.
fn draws_text(draft: &str, text: &str, hidden: Option<HiddenRows>) -> bool {
    let shown = without_space(&canonical_text(draft));
    let text = without_space(&canonical_text(text));
    let scrolled = hidden.filter(|hidden| hidden.above > 0 || hidden.below > 0);
    match scrolled {
        None => shown == text,
        Some(hidden) => hidden.below == 0 && !shown.is_empty() && text.ends_with(shown.as_str()),
    }
}

fn placeholder_spacing(placeholder: &PastePlaceholder, draft: &str) -> String {
    if placeholder.spaced && !placeholder.after_first_character {
        single_spaced(draft)
    } else {
        without_space(draft)
    }
}

/// Whether `draft` shows the placeholder for a paste of `text`, with a visible prefix required
/// during recovery of an old split paste.
fn draws_placeholder(
    placeholder: &PastePlaceholder,
    draft: &str,
    legacy_prefix: Option<&str>,
    text: &str,
) -> bool {
    let draft = placeholder_spacing(placeholder, draft);
    let prefix = legacy_prefix
        .map(|prefix| placeholder_spacing(placeholder, prefix))
        .unwrap_or_default();
    let Some(shown) = draft.strip_prefix(prefix.as_str()) else {
        return false;
    };
    let shown = shown.trim_start();
    let (shown, text) = if placeholder.after_first_character {
        // The CLI types a first character that is not ASCII itself, then a placeholder for the
        // rest.
        let mut chars = text.chars();
        let Some(first) = chars.next().filter(|c| !c.is_ascii() && !c.is_whitespace()) else {
            return false;
        };
        let Some(shown) = shown.strip_prefix(first) else {
            return false;
        };
        (shown, chars.as_str())
    } else {
        (shown, text)
    };
    let Some(found) = placeholder.pattern.captures(shown) else {
        return false;
    };
    let number = found.get(1).and_then(|size| size.as_str().parse().ok());
    matches_count(placeholder.count, number, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str) -> &'static PasteRule {
        &crate::find(name).unwrap().unwrap().paste
    }

    #[test]
    fn a_draft_is_its_message_s_own_when_it_shows_its_text_or_the_placeholder_for_its_size() {
        let fake = rule("fake");
        assert!(is_own_draft(fake, "hello there", "hello there", None));
        assert!(
            is_own_draft(fake, "hello\n  there", "hello there", None),
            "wrapped and indented rows show the same text"
        );
        assert!(
            !is_own_draft(fake, "hello there!", "hello there", None),
            "a person's addition makes it another draft"
        );
        assert!(is_own_draft(
            fake,
            "[Pasted text #3 +2 lines]",
            "a\nb\nc",
            None
        ));
        assert!(
            !is_own_draft(fake, "[Pasted text #3 +1 lines]", "a\nb\nc", None),
            "a paste of another size"
        );
        assert!(
            !is_own_draft(fake, "hold[Pasted text #3 +2 lines]", "a\nb\nc", None),
            "a person's text before the paste"
        );
        let scrolled = Some(HiddenRows { above: 3, below: 0 });
        assert!(
            is_own_draft(fake, "end of it", "the start\nand the end of it", scrolled),
            "only its end shows"
        );
        assert!(!is_own_draft(
            fake,
            "end of it",
            "the start\nand the end of it",
            Some(HiddenRows { above: 0, below: 1 })
        ));
    }

    #[test]
    fn an_old_split_paste_requires_its_visible_prefix_and_placeholder() {
        let claude = rule("claude");
        let prefix = "📨 Message ";
        let pasted = "m5 from command line\nhi";
        let draft = "📨 Message\n  [Pasted text #1 +1 lines]";
        assert!(is_legacy_split_paste(claude, draft, prefix, pasted));
        assert!(!is_legacy_split_paste(
            claude,
            "[Pasted text #1 +1 lines]",
            prefix,
            pasted
        ));
        assert!(!is_legacy_split_paste(
            claude,
            draft,
            prefix,
            "m5 from command line\nhi\nbye"
        ));
        assert!(!is_legacy_split_paste(
            claude,
            "📨 Message m5 from command line\nhi",
            prefix,
            pasted
        ));
        assert!(!is_own_draft(claude, draft, pasted, None));
    }

    #[test]
    fn a_placeholder_rule_alone_does_not_enable_legacy_split_pastes() {
        let fake = rule("fake");
        let prefix = "📨 Message ";
        let lines = "m1 from command line\nhi";
        assert!(is_own_draft(fake, "[Pasted text #1 +1 lines]", lines, None));
        assert!(!is_legacy_split_paste(
            fake,
            "📨 Message\n  [Pasted text #1 +1 lines]",
            prefix,
            lines
        ));
    }

    #[test]
    fn a_literal_draft_matches_its_canonically_equivalent_paste() {
        let pi = rule("pi");
        assert!(is_own_draft(pi, "h\u{e9}llo", "he\u{301}llo", None));
        assert!(is_own_draft(pi, "he\u{301}llo", "h\u{e9}llo", None));
        assert!(!is_own_draft(pi, "hello", "he\u{301}llo", None));
    }

    #[test]
    fn backspaces_use_the_established_editor_unit() {
        let pi = rule("pi");
        let code_point: PasteRule =
            serde_json::from_str(r#"{"backspace_unit":"code_point"}"#).unwrap();
        let unknown = PasteRule::default();
        let decomposed = "helloe\u{301}!";
        assert_eq!(pi.backspace_count(decomposed), 7);
        assert_eq!(
            pi.remaining_cleanup(decomposed, 2, |text| text == "hello"),
            Some(5)
        );
        assert_eq!(
            pi.remaining_cleanup(decomposed, 2, |text| text == "helloe"),
            None
        );
        assert_eq!(code_point.backspace_count(decomposed), 8);
        assert_eq!(
            code_point.remaining_cleanup(decomposed, 2, |text| text == "helloe"),
            Some(6)
        );
        assert_eq!(unknown.backspace_count(decomposed), 7);
        assert_eq!(
            unknown.remaining_cleanup(decomposed, 2, |text| text == "hello"),
            Some(5)
        );
        assert_eq!(
            unknown.remaining_cleanup(decomposed, 2, |text| text == "helloe"),
            Some(6)
        );
        assert_eq!(unknown.backspace_count("hello\u{e9}!"), 7);
        assert_eq!(
            unknown.remaining_cleanup("hello\u{e9}!?", 8, |text| text == "h"),
            Some(1)
        );
        assert_eq!(
            unknown.remaining_cleanup("hello\u{e9}!?", 8, |text| text == "he"),
            None
        );
    }

    #[test]
    fn the_managed_editors_use_their_observed_backspace_boundaries() {
        let plain = "q\u{301}!";
        let thai = "\u{e01}\u{e48}!";
        for (cli, unit, thai_keys) in [
            ("agy", BackspaceUnit::Grapheme, 2),
            ("claude", BackspaceUnit::Grapheme, 2),
            ("codex", BackspaceUnit::LegacyGrapheme, 3),
            ("muse", BackspaceUnit::Grapheme, 2),
            ("opencode", BackspaceUnit::Grapheme, 2),
            ("pi", BackspaceUnit::Grapheme, 2),
        ] {
            let paste = rule(cli);
            assert_eq!(paste.backspace_unit, Some(unit), "{cli}");
            assert_eq!(paste.backspace_count(plain), 2, "{cli}");
            assert_eq!(paste.backspace_count(thai), thai_keys, "{cli}");
            assert_eq!(
                paste.remaining_cleanup(thai, 2, |text| text == "\u{e01}"),
                (thai_keys > 2).then_some(1),
                "{cli}"
            );
        }
        assert!(rule("fake").rechecks_cleanup());
    }

    #[test]
    fn codex_finds_a_partial_cleanup_boundary_in_a_full_length_draft() {
        let codex = rule("codex");
        let text = format!("paste: {}\u{e01}\u{e48}!", "🇺🇸".repeat(3995));
        facade_base::model::message::check_message_text(&text).unwrap();
        assert_eq!(codex.backspace_count(&text), 4005);
        let expected = format!("paste: {}", "🇺🇸".repeat(1998));
        assert_eq!(
            codex.remaining_cleanup(&text, 2000, |shown| shown == expected),
            Some(2005)
        );
    }

    #[test]
    fn a_placeholder_counts_what_its_cli_counts() {
        let codex = rule("codex");
        assert!(is_own_draft(
            codex,
            "[Pasted Content 1004 chars]",
            &"x".repeat(1004),
            None
        ));
        assert!(
            is_own_draft(
                codex,
                "📨[Pasted Content 1004 chars]",
                &format!("📨{}", "x".repeat(1004)),
                None
            ),
            "after its first character"
        );
        let pi = rule("pi");
        assert!(
            is_own_draft(pi, "[paste #2 10 chars]", "a\tb\u{1}cdef", None),
            "a tab counts four, a control character none"
        );
        let agy = rule("agy");
        assert!(
            is_own_draft(agy, "[Pasted text #1 +3 lines]", "a\nb\nc", None),
            "every line, the first included"
        );
        let marker = "[Pasted text #12 4 chars]";
        assert!(is_own_draft(agy, marker, "a\r\n📨b", None));
        assert!(!is_own_draft(agy, marker, "a📨b", None));
        let claude = rule("claude");
        let marker = "[Pasted text #1]";
        let text = "x".repeat(1222);
        assert!(is_own_draft(claude, marker, &text, None));
        assert!(!is_own_draft(claude, marker, &(text + "\n"), None));
        let opencode = rule("opencode");
        let text = " \r\nfirst\r\nsecond\nthird\r\n ";
        assert!(is_own_draft(opencode, "[Pasted ~3 lines]", text, None));
        assert!(!is_own_draft(opencode, "[Pasted ~5 lines]", text, None));
        assert_eq!(
            settle_time(agy, "a\nb\nc"),
            Duration::from_millis(80 + 3 * 45)
        );
        assert_eq!(settle_time(rule("muse"), "a"), Duration::from_millis(250));
    }

    #[test]
    fn a_paste_s_placeholder_gives_back_its_text_for_each_cli() {
        let text = "first\nsecond\nthird";
        let cases = [
            ("claude", "[Pasted text #1 +2 lines]"),
            ("agy", "[Pasted text #1 +3 lines]"),
            ("muse", "[Pasted Content 18 chars]"),
            ("codex", "[Pasted Content 18 chars]"),
            ("opencode", "[Pasted ~3 lines]"),
            ("pi", "[paste #1 +3 lines]"),
        ];
        let given = |cli: &str, draft: &str, texts: &[&str]| {
            with_paste_text(
                rule(cli),
                draft,
                &texts
                    .iter()
                    .map(|text| text.to_string())
                    .collect::<Vec<_>>(),
            )
        };
        for (cli, placeholder) in cases {
            assert_eq!(
                given(cli, &format!("look at {placeholder} please"), &[text]),
                format!("look at {text} please"),
                "{cli}"
            );
            assert_eq!(
                given(cli, placeholder, &["another\npaste"]),
                placeholder,
                "{cli}: a paste of another size"
            );
        }
        let first = format!("é{}", "x".repeat(1003));
        assert_eq!(
            given("codex", "é[Pasted Content 1003 chars]", &[&first]),
            first,
            "after its first character"
        );
        assert_eq!(
            given("fake", "no placeholder here", &[text]),
            "no placeholder here"
        );
    }

    #[test]
    fn each_paste_takes_the_first_placeholder_of_its_size_in_order() {
        let texts = |texts: &[&str]| {
            texts
                .iter()
                .map(|text| text.to_string())
                .collect::<Vec<_>>()
        };
        let claude = rule("claude");
        let same = "[Pasted text #1 +1 lines] and [Pasted text #2 +1 lines]";
        assert_eq!(
            with_paste_text(claude, same, &texts(&["a\nb", "c\nd"])),
            "a\nb and c\nd"
        );
        // The person pasted the longer one after the shorter, but before it in the draft.
        let moved = "[Pasted text #2 +2 lines] then [Pasted text #1 +1 lines]";
        assert_eq!(
            with_paste_text(claude, moved, &texts(&["a\nb", "c\nd\ne"])),
            "c\nd\ne then a\nb"
        );
        // A paste's own text that looks like a placeholder is not taken for the next paste's.
        let inner = "[Pasted text #1 +1 lines]";
        assert_eq!(
            with_paste_text(
                claude,
                inner,
                &texts(&["[Pasted text #9 +1 lines]\nx", "y\nz"])
            ),
            "[Pasted text #9 +1 lines]\nx"
        );
    }

    #[test]
    fn a_draft_shows_the_whole_of_a_text_it_holds_among_others() {
        let text = "the start\nand the end";
        assert!(shows_whole(text, text, None));
        assert!(shows_whole(
            "the start\n  and the end, typed on",
            text,
            None
        ));
        assert!(!shows_whole("the start and the", text, None));
        assert!(!shows_whole("[Pasted text #1 +1 lines]", text, None));
        let scrolled = Some(HiddenRows { above: 1, below: 0 });
        assert!(!shows_whole(text, text, scrolled));
    }

    #[test]
    fn the_same_draft_keeps_its_paste_number() {
        assert!(is_same_draft(
            "[Pasted text #3 +2 lines]",
            "[Pasted text #3 +2 lines]",
            "a\nb\nc",
            None
        ));
        assert!(
            !is_same_draft(
                "[Pasted text #4 +2 lines]",
                "[Pasted text #3 +2 lines]",
                "a\nb\nc",
                None
            ),
            "a later paste of its size"
        );
        assert!(
            is_same_draft("hello", "[Pasted text #3 +0 lines]", "hello", None),
            "its text itself"
        );
    }
}
