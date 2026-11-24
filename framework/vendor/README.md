# Vendored crates

## ConPTY 1.25.260303002

Microsoft's [Microsoft.Windows.Console.ConPTY 1.25.260303002-preview NuGet package](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY/1.25.260303002-preview),
from [Windows Terminal](https://github.com/microsoft/terminal), under the MIT license. The x64 and arm64 runtime files
are unchanged in `conpty/1.25.260303002/win-x64/` and `conpty/1.25.260303002/win-arm64/`, respectively:

- `conpty.dll`, from the package's `runtimes/win-x64/native/conpty.dll` or `runtimes/win-arm64/native/conpty.dll`;
- `OpenConsole.exe`, from `build/native/runtimes/x64/OpenConsole.exe` or `build/native/runtimes/arm64/OpenConsole.exe`.

The package declares MIT through its license expression and link; it contains no separate license file.
`conpty/1.25.260303002/LICENSE` contains the upstream project's MIT license and Microsoft copyright notice; it covers
both folders.

The keeper's `build.rs` selects `win-x64` for Windows `x86_64` targets and `win-arm64` for Windows `aarch64`
targets, and rejects other Windows architectures. It copies both files into `<target dir>[/<triple>]/<profile>/conpty/`,
including when the build uses `--target` or a custom target directory. Installation copies that folder into the
running build's folder. The keeper loads only that build's DLL and keeps the console's signal pipe so either service
can hold the terminal alive. The packaged console host also supplies `ReleasePseudoConsole` on every supported
Windows version.

To update: take the four files, two for each architecture, from the new NuGet release, keep its MIT license, update
the vendor folder and keeper build path together, then run the scenario tests, including the tests where the keeper
ends while agents run.

## alacritty_terminal 0.26.0

The crates.io release (upstream commit `94e7c8874e526b1e67b349d9ba30ddf81669119e`, see `.cargo_vcs_info.json`), used through
`[patch.crates-io]` in `framework/Cargo.toml`. It is a workspace member so that `cargo test -p alacritty_terminal` runs its own
tests with Facade's. `vendor/rustfmt.toml` keeps its upstream formatting.

Facade changes it so that each agent's screen stays within its memory bound (`docs/framework/islands/screen.md`).
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
