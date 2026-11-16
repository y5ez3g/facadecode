//! How a space typed and taken back tells a hint from a draft where an input's first row may be
//! either: what the space did to the row, and whether Backspace put it back. Compared from
//! readings alone, never logged as text.

use facade_base::daemon::InputState;

use super::{BoxReading, InputLine, LineCell};

/// What a probe found an input's first row to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeVerdict {
    /// A hint: the input is empty.
    Hint,
    Draft,
    /// Neither for sure.
    Other,
}

fn text(line: &InputLine) -> String {
    line.cells.iter().map(|cell| cell.text.as_str()).collect()
}

/// `before`'s text with a space where its cursor was: the cells ahead of the cursor are the
/// input's blank margin.
fn spaced(before: &InputLine) -> String {
    let at = before
        .cursor
        .0
        .saturating_sub(before.start)
        .min(before.cells.len());
    let (ahead, after) = before.cells.split_at(at);
    let join =
        |cells: &[LineCell]| -> String { cells.iter().map(|cell| cell.text.as_str()).collect() };
    format!("{} {}", join(ahead), join(after))
}

/// Whether the space went in, by the cursor and the text alone: on the same row, one column on,
/// the row its space ahead of the text it held, or its space alone.
pub fn space_taken(before: &InputLine, after: &BoxReading) -> bool {
    let Some(line) = &after.line else {
        return false;
    };
    if line.row != before.row || line.cursor != (before.cursor.0 + 1, before.cursor.1) {
        return false;
    }
    let now = text(line);
    now == spaced(before) || now.trim().is_empty()
}

/// What the row was, once the space went in, by the text alone: gone, a hint; moved on by the
/// space, a draft; else neither.
pub fn verdict_of(before: &InputLine, after: &BoxReading) -> ProbeVerdict {
    let Some(line) = after.line.as_ref().filter(|line| !line.rest) else {
        return ProbeVerdict::Other;
    };
    if after.info.state == InputState::Interaction {
        return ProbeVerdict::Other;
    }
    let now = text(line);
    if now.trim().is_empty() {
        ProbeVerdict::Hint
    } else if now == spaced(before) {
        ProbeVerdict::Draft
    } else {
        ProbeVerdict::Other
    }
}

/// Whether Backspace put the input back, every cell and the cursor compared: a hint's input empty
/// again, or showing a hint, maybe another, where the input starts; else the row as it was.
pub fn restored(verdict: ProbeVerdict, before: &InputLine, after: &BoxReading) -> bool {
    let line = after.line.as_ref().filter(|line| !line.rest);
    if verdict == ProbeVerdict::Hint
        && (after.info.state == InputState::Usable
            || after.unsure && line.is_some_and(|line| line.cursor == before.cursor))
    {
        return true;
    }
    line.is_some_and(|line| {
        line.row == before.row && line.cursor == before.cursor && line.cells == before.cells
    })
}

/// The row's shape for a log: its cells, how many dim and colored, and the cursor's column;
/// never its text.
pub fn shape_of(line: Option<&InputLine>) -> String {
    let Some(line) = line else {
        return "no input row".into();
    };
    let dim = line.cells.iter().filter(|cell| cell.dim).count();
    let colored = line.cells.iter().filter(|cell| cell.colored).count();
    format!(
        "row {}: {} cells, {dim} dim, {colored} colored, cursor at column {}{}",
        line.row + 1,
        line.cells.len(),
        line.cursor.0 + 1,
        if line.rest { ", rows under it" } else { "" }
    )
}
