//! Alacritty - The GPU Enhanced Terminal.

#![warn(rust_2018_idioms, future_incompatible)]
#![deny(clippy::all, clippy::if_not_else, clippy::enum_glob_use)]
// Facade (memory): clippy 1.98, Facade's pinned toolchain, finds three `question_mark` cases in `tty/unix.rs`, which Facade does
// not use; the crate is a workspace member only so that its own tests run with Facade's.
#![allow(clippy::question_mark)]
// Facade (memory): Facade documents its workspace with private items and every rustdoc warning as an error; three of upstream's
// doc comments have an unescaped `Row<T>` or a link rustdoc cannot resolve.
#![allow(rustdoc::invalid_html_tags, rustdoc::broken_intra_doc_links)]
#![cfg_attr(clippy, deny(warnings))]

pub mod event;
pub mod event_loop;
pub mod grid;
pub mod index;
pub mod selection;
pub mod sync;
pub mod term;
pub mod thread;
pub mod tty;
pub mod vi_mode;

pub use crate::grid::Grid;
pub use crate::term::Term;
pub use vte;
