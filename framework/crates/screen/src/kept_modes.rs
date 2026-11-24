//! The modes a CLI sets that alacritty keeps private, or keeps only with features a viewer may
//! lack, followed from the output so that a redraw can give them to a viewer.

/// The most entries a kitty keyboard stack holds; a push past it drops the oldest, as in kitty.
const MAX_KEYBOARD_ENTRIES: usize = 8;

/// Which of G0 and G1 is in use: SI picks G0, SO picks G1, as in alacritty.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ActiveCharset {
    #[default]
    G0,
    G1,
}

/// The modifyOtherKeys setting. The terminal's initial setting is neither level zero nor disabled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ModifyOtherKeys {
    /// As the terminal started: after `CSI > 4 m`, `CSI > m` or a full reset.
    #[default]
    Initial,
    /// `CSI > 4 ; level m`; level 0 counts.
    Level(u16),
    /// `CSI > 4 n`.
    Disabled,
}

/// A change to the kitty keyboard flags of the screen in use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyboardChange {
    /// `CSI > flags u`.
    Push(u8),
    /// `CSI < count u`.
    Pop(usize),
    /// `CSI = flags ; how u`: set (1), add (2) or remove (3) flags in the entry in force.
    Change { flags: u8, how: u16 },
}

/// The kitty keyboard flags, which decide how a viewer encodes keys. As in kitty, each screen has a
/// stack whose last entry is in force; an empty stack means no flags.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct KeyboardFlags {
    on_alternate: bool,
    main: Vec<u8>,
    alternate: Vec<u8>,
}

impl KeyboardFlags {
    /// The flags in force on the main screen.
    pub(crate) fn main(&self) -> u8 {
        self.main.last().map_or(0, |&flags| flags)
    }

    /// The flags in force on the alternate screen.
    pub(crate) fn alternate(&self) -> u8 {
        self.alternate.last().map_or(0, |&flags| flags)
    }

    fn change(&mut self, change: KeyboardChange) {
        let stack = match self.on_alternate {
            true => &mut self.alternate,
            false => &mut self.main,
        };
        match change {
            KeyboardChange::Push(flags) => {
                if stack.len() >= MAX_KEYBOARD_ENTRIES {
                    stack.remove(0);
                }
                stack.push(flags);
            }
            KeyboardChange::Pop(count) => stack.truncate(stack.len().saturating_sub(count)),
            KeyboardChange::Change { flags, how } => {
                let now = stack.last().map_or(0, |&flags| flags);
                let next = match how {
                    1 => flags,
                    2 => now | flags,
                    3 => now & !flags,
                    _ => return,
                };
                if let Some(last) = stack.last_mut() {
                    *last = next;
                } else {
                    stack.push(next);
                }
            }
        }
    }
}

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct KeptModes {
    /// The scrolling region, 1-based and inclusive; None for the whole screen.
    pub(crate) scroll_region: Option<(u16, u16)>,
    pub(crate) active_charset: ActiveCharset,
    pub(crate) modify_other_keys: ModifyOtherKeys,
    pub(crate) keyboard: KeyboardFlags,
}

impl KeptModes {
    pub(crate) fn switch_screen(&mut self, alternate: bool) {
        self.keyboard.on_alternate = alternate;
    }

    pub(crate) fn change_keyboard(&mut self, change: KeyboardChange) {
        self.keyboard.change(change);
    }

    /// A full reset: every mode as the terminal started.
    pub(crate) fn reset(&mut self) {
        *self = KeptModes::default();
    }
}

/// Where the tab stops are, by column. alacritty keeps its own private.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TabStops(Vec<bool>);

impl TabStops {
    /// A stop every eight columns, as a terminal starts.
    pub(crate) fn new(cols: usize) -> Self {
        TabStops((0..cols).map(is_default_stop).collect())
    }

    /// Fits the stops to `cols` columns: the ones kept stay, new columns get the default ones.
    pub(crate) fn resize(&mut self, cols: usize) {
        self.0.truncate(cols);
        let kept = self.0.len();
        self.0.extend((kept..cols).map(is_default_stop));
    }

    /// Sets or clears the stop at `column`, or at the last column when `column` is past it.
    pub(crate) fn set(&mut self, column: usize, stop: bool) {
        let column = column.min(self.0.len() - 1);
        self.0[column] = stop;
    }

    pub(crate) fn clear_all(&mut self) {
        self.0.iter_mut().for_each(|stop| *stop = false);
    }

    /// The columns with a stop.
    pub(crate) fn columns(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.0.len()).filter(|&column| self.0[column])
    }
}

fn is_default_stop(column: usize) -> bool {
    column.is_multiple_of(8)
}
