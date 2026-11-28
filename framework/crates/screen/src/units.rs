//! Cuts a CLI's output into units a viewer can take whole: characters, escape sequences, control
//! strings. A unit that has not ended yet waits here for the rest of it.

/// The longest CSI sequence held; a longer one is dropped whole.
const MAX_CSI_BYTES: usize = 4096;
/// The longest control string (OSC, DCS, APC, PM, SOS) held; a longer one is dropped whole.
const MAX_STRING_BYTES: usize = 1 << 20;

const BEL: u8 = 0x07;
const ESC: u8 = 0x1b;

/// One piece of output, complete.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Piece<'a> {
    /// A byte outside any sequence: text, a control, or a byte that starts no UTF-8 character.
    Byte(u8),
    /// A C0 control inside an escape or CSI sequence, which acts at once and is passed on at once:
    /// held, it would act again after a redraw that already shows what it did. CAN and SUB also
    /// cancel the sequence.
    Control(u8),
    /// A UTF-8 character, or the start of one that a byte other than a continuation cut short.
    Char(&'a [u8]),
    /// `ESC` and the bytes after it, but not a CSI sequence or a string.
    Escape(&'a [u8]),
    /// `ESC [` through the final byte.
    Csi(&'a [u8]),
    /// A control string with its terminator, ST or (for OSC) BEL.
    String(&'a [u8]),
    /// A control string an ESC ended without making ST.
    CutString(&'a [u8]),
}

/// Which piece a unit makes once it ends.
#[derive(Clone, Copy)]
enum Kind {
    Char,
    Escape,
    Csi,
    String,
    CutString,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Between,
    /// Inside a UTF-8 character, with this many continuation bytes to come.
    Char(u8),
    Escape,
    /// After an escape's intermediate bytes, such as a charset designation's.
    Intermediate,
    Csi,
    /// Dropping a CSI sequence that grew too long, through its final byte.
    DroppingCsi,
    String,
    /// After an ESC inside a string: a backslash makes ST.
    StringEscape,
    /// Dropping a string that grew too long, through its end. BEL ends only an OSC.
    DroppingString {
        osc: bool,
    },
    DroppingStringEscape,
}

/// See the module documentation.
#[derive(Debug, Default)]
pub(crate) struct Splitter {
    state: State,
    /// The unit so far.
    held: Vec<u8>,
}

impl Splitter {
    /// Calls `each` with every piece `bytes` completes and its ending offset. Returns where a unit
    /// already under way first came to an end.
    pub(crate) fn split(
        &mut self,
        bytes: &[u8],
        mut each: impl FnMut(usize, Piece<'_>),
    ) -> Option<usize> {
        let mut carried = self.is_inside_unit();
        let mut ended_at = None;
        for (at, &byte) in bytes.iter().enumerate() {
            self.take(byte, &mut |piece| each(at + 1, piece));
            if carried && !self.is_inside_unit() {
                ended_at = Some(at + 1);
                carried = false;
            }
        }
        ended_at
    }

    /// Whether a unit has started and not ended.
    pub(crate) fn is_inside_unit(&self) -> bool {
        self.state != State::Between
    }

    /// The entire byte interval is still held as an Escape or CSI prefix.
    pub(crate) fn holds_escape_prefix(&self, bytes: usize) -> bool {
        matches!(self.state, State::Escape | State::Csi) && self.held.len() == bytes
    }

    fn take(&mut self, byte: u8, each: &mut dyn FnMut(Piece<'_>)) {
        let in_sequence = matches!(
            self.state,
            State::Escape | State::Intermediate | State::Csi | State::DroppingCsi
        );
        if in_sequence && byte < 0x20 {
            match byte {
                ESC => self.open(State::Escape, byte),
                0x18 | 0x1a => {
                    self.reset();
                    each(Piece::Control(byte));
                }
                _ => each(Piece::Control(byte)),
            }
            return;
        }
        match self.state {
            State::Between => match byte {
                ESC => self.open(State::Escape, byte),
                0xc2..=0xdf => self.open(State::Char(1), byte),
                0xe0..=0xef => self.open(State::Char(2), byte),
                0xf0..=0xf4 => self.open(State::Char(3), byte),
                _ => each(Piece::Byte(byte)),
            },
            State::Char(left) if byte & 0xc0 == 0x80 => {
                self.held.push(byte);
                match left {
                    1 => self.close(each, Kind::Char),
                    _ => self.state = State::Char(left - 1),
                }
            }
            State::Char(_) => {
                self.close(each, Kind::Char);
                self.take(byte, each);
            }
            State::Escape => {
                self.held.push(byte);
                match byte {
                    b'[' => self.state = State::Csi,
                    b']' | b'P' | b'_' | b'^' | b'X' => self.state = State::String,
                    0x20..=0x2f => self.state = State::Intermediate,
                    _ => self.close(each, Kind::Escape),
                }
            }
            State::Intermediate => {
                self.held.push(byte);
                if !(0x20..=0x2f).contains(&byte) {
                    self.close(each, Kind::Escape);
                }
            }
            State::Csi => {
                self.held.push(byte);
                if (0x40..=0x7e).contains(&byte) {
                    self.close(each, Kind::Csi);
                } else if self.held.len() > MAX_CSI_BYTES {
                    self.held.clear();
                    self.state = State::DroppingCsi;
                }
            }
            State::DroppingCsi => {
                if (0x40..=0x7e).contains(&byte) {
                    self.state = State::Between;
                }
            }
            State::String => self.take_in_string(byte, each),
            State::StringEscape if byte == b'\\' => {
                self.held.extend([ESC, byte]);
                self.close(each, Kind::String);
            }
            State::StringEscape => {
                self.close(each, Kind::CutString);
                self.open(State::Escape, ESC);
                self.take(byte, each);
            }
            State::DroppingString { osc } => match byte {
                BEL if osc => self.state = State::Between,
                ESC => self.state = State::DroppingStringEscape,
                0x18 | 0x1a => {
                    self.state = State::Between;
                    each(Piece::Control(byte));
                }
                _ => {}
            },
            State::DroppingStringEscape if byte == b'\\' => self.state = State::Between,
            State::DroppingStringEscape => {
                self.open(State::Escape, ESC);
                self.take(byte, each);
            }
        }
    }

    fn take_in_string(&mut self, byte: u8, each: &mut dyn FnMut(Piece<'_>)) {
        let osc = self.held[1] == b']';
        match byte {
            BEL if osc => {
                self.held.push(byte);
                self.close(each, Kind::String);
            }
            ESC => self.state = State::StringEscape,
            0x18 | 0x1a => {
                self.reset();
                each(Piece::Control(byte));
            }
            _ if self.held.len() >= MAX_STRING_BYTES => {
                self.held.clear();
                self.state = State::DroppingString { osc };
            }
            _ => self.held.push(byte),
        }
    }

    fn open(&mut self, state: State, byte: u8) {
        self.held.clear();
        self.held.push(byte);
        self.state = state;
    }

    fn close(&mut self, each: &mut dyn FnMut(Piece<'_>), kind: Kind) {
        let held = &self.held[..];
        each(match kind {
            Kind::Char => Piece::Char(held),
            Kind::Escape => Piece::Escape(held),
            Kind::Csi => Piece::Csi(held),
            Kind::String => Piece::String(held),
            Kind::CutString => Piece::CutString(held),
        });
        self.reset();
    }

    fn reset(&mut self) {
        self.held.clear();
        self.state = State::Between;
    }
}
