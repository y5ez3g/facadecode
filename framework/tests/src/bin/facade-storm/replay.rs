//! Replays an agent's screen log through Facade's own screen and input reader, and prints what the
//! input read as after each piece of output: what the typist saw, with no times.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use anyhow::Context;

/// Prints each change of the reading in `log`, and how many pieces of output kept it.
pub fn run(log: &Path, cli: &str) -> anyhow::Result<()> {
    let rule = facade_rules::find(cli)
        .map_err(anyhow::Error::msg)?
        .with_context(|| format!("no rule for {cli}"))?;
    let (cols, rows) = size(log).unwrap_or((120, 30));
    let mut input = BufReader::new(std::fs::File::open(log)?);
    let mut line = Vec::new();
    input.read_until(b'\n', &mut line)?;
    let mut offset = line.len() as u64;
    let mut screen = facade_screen::Screen::new(cols, rows, 1000);
    let mut last = String::new();
    let (mut records, mut same) = (0u64, 0u64);
    let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    loop {
        line.clear();
        let read = input.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        let head = String::from_utf8_lossy(&line).trim_end().to_string();
        let start = offset;
        offset += read as u64;
        if let Some(length) = head.strip_prefix("output ") {
            let length: usize = length.parse()?;
            let mut payload = vec![0; length + 1];
            input.read_exact(&mut payload)?;
            payload.pop();
            offset += length as u64 + 1;
            screen.feed(&payload);
        } else if let Some(size) = head.strip_prefix("resize ") {
            let (cols, rows) = size.split_once(' ').context("a resize record")?;
            screen.resize(cols.parse()?, rows.parse()?);
        } else if head == "sync_end" {
            screen.end_synchronized_update();
        }
        records += 1;
        let view = screen.view();
        let reading = facade_rules::read_box(&rule.input, &view);
        let in_update = screen.synchronized_update_deadline().is_some();
        let state = format!(
            "{:?} {:?}{}",
            reading.info.state,
            reading.draft.as_deref().map(crate::judge::short),
            if in_update {
                " in a synchronized update"
            } else {
                ""
            }
        );
        *counts
            .entry(format!("{:?}", reading.info.state))
            .or_default() += 1;
        if state == last {
            same += 1;
        } else {
            if same > 0 {
                println!("          … {same} more");
            }
            println!(
                "@{start:>8} #{records:>5} {state} | {}",
                reading.info.evidence
            );
            same = 0;
        }
        last = state;
    }
    println!("{records} records, readings {counts:?}");
    Ok(())
}

/// The size the log's checkpoint names.
fn size(log: &Path) -> Option<(u16, u16)> {
    let bytes = std::fs::read(log.with_extension("checkpoint")).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let mut sizes = text.lines().nth(1)?.split(' ').skip(1);
    Some((sizes.next()?.parse().ok()?, sizes.next()?.parse().ok()?))
}
