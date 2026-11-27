//! Whether the input box shows a pasted message as its own draft: the message's text, wrapped and
//! indented as the CLI's rows draw it, or the placeholder the CLI draws for a paste of its size. A
//! message's submission key goes only over its own draft.

use std::ops::Range;
use std::time::Duration;

use facade_base::model::terminal::{HiddenRows, InputState};

use crate::{PasteCount, PastePlaceholder, PasteRule};

use super::BoxReading;

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
    draws_text(draft, text, hidden)
        || paste
            .placeholders
            .iter()
            .any(|placeholder| draws_placeholder(placeholder, draft, None, text))
}

/// For recovery, whether the visible draft shows the old typed prefix followed by the CLI's
/// placeholder for the separately pasted text.
pub fn is_legacy_split_paste(paste: &PasteRule, draft: &str, prefix: &str, pasted: &str) -> bool {
    !prefix.trim().is_empty()
        && paste
            .placeholders
            .iter()
            .any(|placeholder| draws_placeholder(placeholder, draft, Some(prefix), pasted))
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
    let shown = without_space(draft);
    let text = without_space(text);
    let scrolled = hidden.filter(|hidden| hidden.above > 0 || hidden.below > 0);
    match scrolled {
        None => shown == text,
        Some(hidden) => hidden.below == 0 && !shown.is_empty() && text.ends_with(shown.as_str()),
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
    let spacing = if placeholder.spaced && !placeholder.after_first_character {
        single_spaced
    } else {
        without_space
    };
    let draft = spacing(draft);
    let prefix = legacy_prefix.map(spacing).unwrap_or_default();
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
