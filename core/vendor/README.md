# Vendored crates

## alacritty_terminal 0.26.0

The crates.io release (upstream commit `94e7c8874e526b1e67b349d9ba30ddf81669119e`, see `.cargo_vcs_info.json`), used through
`[patch.crates-io]` in `core/Cargo.toml`. It is a workspace member so that `cargo test -p alacritty_terminal` runs its own
tests with Facade's. `vendor/rustfmt.toml` keeps its upstream formatting.

Facade changes it so that each agent's screen stays within its memory bound (`docs/core/islands/screen.md`).
Every change is marked `// Facade (memory)` in the source:

| File | Change | Why |
|---|---|---|
| `src/grid/storage.rs` | `MAX_CACHE_SIZE` 1,000 → 32 | A grid reserved 1,000 rows, about 2.9 MB at 120 columns, as soon as its history grew by one row, which a CLI's first screen clear does. 100 idle agents cost the daemon about 300 MB for nothing. Facade keeps a short history in each grid, so a small reserve is enough. |
| `src/grid/mod.rs` | `HistoryKeeper`, `KeeperSlot`, `Grid::set_history_keeper`; calls in `scroll_up` and `clear_history` | The grid tells Facade of every row its full history is about to drop, oldest first, and of every clear, so that `facade-screen` keeps the older rows compact, exactly. A cloned grid has no keeper. |
| `src/grid/mod.rs` | `Grid::restore_history` | Puts rows back above the oldest history row, raising the history's limit where needed: before a resize, alacritty must hold the rows its reflow depends on, as it would with the whole history. |
| `src/grid/row.rs` | `Row::grow` sets `occ` to the row's length | An upstream bug. The cells `grow` adds are not what the last reset left in the cells after `occ`, so a reused row could keep an earlier background in its old cells after the next reset. Which rows are reused depends on how much history the grid keeps, so a short history and a whole one drifted apart. Upstream, it shows as a stale background on blank cells of new lines after a terminal grew wider. |
| `src/term/mod.rs` | `Term::primary_grid`, `Term::primary_grid_mut` | The grid with the history, also while the alternate screen shows: a resize then still reflows it. |
| `src/lib.rs` | `#![allow(clippy::question_mark)]` | Clippy 1.98, the pinned toolchain, finds three cases in `tty/unix.rs`, which Facade does not use; upstream lints its own code. |
| `src/lib.rs` | `#![allow(rustdoc::invalid_html_tags, rustdoc::broken_intra_doc_links)]` | Facade documents its workspace with private items and every rustdoc warning as an error; three of upstream's doc comments have an unescaped `Row<T>` or a link rustdoc cannot resolve. |
| `Cargo.toml` | the `ref` test target and `resolver` removed; an `upstream_ref` test target added | The ref tests' recordings (`tests/ref`, 46 MB) are not vendored, and `upstream_ref` runs them from the crates.io package; `resolver` in a member only makes cargo warn. |
| `tests/upstream_ref.rs` | new | Runs upstream's 45 ref tests against the vendored source with every `cargo test`, so that the changes above are checked as upstream checks its own code. |

Not vendored: `tests/ref.rs` and `tests/ref/` (46 MB of recorded sessions) and the crate's `Cargo.lock`. The test
`tests/upstream_ref.rs` takes them from the crates.io package in the cargo registry, fetching it once where it is missing. It
copies the vendored `src/` beside them in `target/tmp/upstream-ref` and runs `cargo test --locked --test ref` there.

To move to a newer alacritty_terminal: vendor the new release the same way, carry over each change marked
`Facade (memory)`, name the release in `tests/upstream_ref.rs`, then run `cargo test -p alacritty_terminal`, which runs the ref
tests, and `cargo test -p facade-screen`, whose tests compare a screen that keeps its older rows compact with one that keeps
every row in alacritty.
