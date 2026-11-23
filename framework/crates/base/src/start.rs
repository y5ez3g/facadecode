//! The program, arguments and folder shared by the daemon and keeper. The daemon can receive
//! an omitted folder. The keeper gets the resolved folder.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartCommand<F> {
    pub program: String,
    pub args: Vec<String>,
    pub folder: F,
}

impl<F> StartCommand<F> {
    /// Splits a legacy command vector. An empty vector leaves an empty program for the
    /// receiving operation to refuse.
    pub fn from_words(command: Vec<String>, folder: F) -> Self {
        let mut words = command.into_iter();
        let program = words.next().unwrap_or_default();
        Self {
            program,
            args: words.collect(),
            folder,
        }
    }

    /// The old wire formats put the program before the CLI's arguments.
    pub fn into_words(self) -> (Vec<String>, F) {
        let command = std::iter::once(self.program).chain(self.args).collect();
        (command, self.folder)
    }
}
