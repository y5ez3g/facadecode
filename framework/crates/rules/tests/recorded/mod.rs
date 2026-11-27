//! Screens recorded from the CLIs, as the readers see them. A recorded screen keeps its width
//! (`cols`), its rows' text (`cells`, a string or one string per cell), the characters of each row
//! drawn bold, dim, inverse, or coloured (each a list of start and end indexes), and the cursor
//! where it shows one.

use facade_screen::{ScreenView, VisibleCell};
use serde_json::Value;
use unicode_width::UnicodeWidthStr;

/// The screens recorded from `cli` in `tests/<folder>/<cli>.json`.
pub fn screens(folder: &str, cli: &str) -> Vec<Value> {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/{folder}/{cli}.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// Whether character `index` of a row lies in one of `ranges`, each a start and an end index.
fn within(ranges: &Value, index: usize) -> bool {
    ranges.as_array().is_some_and(|ranges| {
        ranges.iter().any(|range| {
            range[0].as_u64().is_some_and(|start| index as u64 >= start)
                && range[1].as_u64().is_some_and(|end| (index as u64) < end)
        })
    })
}

/// The view of a recorded screen: each row's characters at their columns, padded to the screen's
/// width.
pub fn view_of(screen: &Value) -> ScreenView {
    let cols = screen["cols"].as_u64().unwrap() as usize;
    let rows: Vec<Vec<VisibleCell>> = screen["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let chars: Vec<String> = match &row["cells"] {
                Value::String(text) => text.chars().map(|c| c.to_string()).collect(),
                Value::Array(cells) => cells
                    .iter()
                    .map(|cell| cell.as_str().unwrap_or(" ").to_string())
                    .collect(),
                _ => Vec::new(),
            };
            let (mut cells, mut column, mut index) = (Vec::new(), 0, 0);
            while index < chars.len() || column < cols {
                let text = chars.get(index).cloned().unwrap_or_else(|| " ".into());
                let width = UnicodeWidthStr::width(text.as_str()).max(1);
                cells.push(VisibleCell::new(
                    &text,
                    column,
                    within(&row["bold"], index),
                    within(&row["dim"], index),
                    within(&row["inverse"], index),
                    within(&row["colored"], index),
                ));
                column += width;
                index += 1;
            }
            cells
        })
        .collect();
    let cursor = &screen["cursor"];
    let cursor = (
        cursor["x"].as_u64().unwrap_or(0) as usize,
        cursor["y"].as_u64().unwrap_or(0) as usize,
    );
    let continues = vec![false; rows.len()];
    ScreenView {
        rows,
        cols,
        continues,
        cursor,
        cursor_visible: screen["cursor_hidden"] != true,
        synchronized_update: false,
    }
}
