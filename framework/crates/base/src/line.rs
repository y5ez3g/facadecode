//! The one limit both protocols put on a line.

/// The most bytes one protocol line may hold, its newline included. A longer line is an error.
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
