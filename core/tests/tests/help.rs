//! Help as the built `facade` prints it: every public page against its file in
//! `core/tests/golden/help/`, each page the same from every way of asking, and help that reaches no
//! Facade. Where a change to a page is meant, regenerate the files and read every changed one:
//! `FACADE_REGENERATE=1 cargo test -p facade-scenarios --test help`.

use std::path::PathBuf;
use std::process::Output;

use facade_scenarios::*;

/// Every public page under the root, by its command path.
const PAGES: &[&[&str]] = &[
    &["start"],
    &["list"],
    &["attach"],
    &["stop"],
    &["resume"],
    &["remove"],
    &["rename"],
    &["inspect"],
    &["screen"],
    &["type"],
    &["send"],
    &["messages"],
    &["machine"],
    &["machine", "add"],
    &["machine", "connect"],
    &["machine", "list"],
    &["machine", "remove"],
    &["machine", "rename"],
    &["integration"],
    &["integration", "add"],
    &["integration", "remove"],
    &["integration", "list"],
    &["status"],
    &["version"],
    &["completion"],
];

/// Each alias, and the command whose page it prints.
const ALIASES: &[(&str, &str)] = &[("ls", "list"), ("rm", "remove")];

/// Help is read at this width; one page is read narrower too.
const WIDTH: &str = "100";
const NARROW: &str = "60";

fn golden(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("golden")
        .join("help")
        .join(format!("{name}.txt"))
}

/// `facade <args>` with plain styles at `columns`, without a terminal.
fn help(home: &TestHome, args: &[&str], columns: &str) -> Output {
    home.command(&test_binaries().facade)
        .args(args)
        .env("NO_COLOR", "1")
        .env("COLUMNS", columns)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("could not run facade")
}

/// What differs between the pages and their files, one entry per page; the files are written
/// instead where `FACADE_REGENERATE` is set.
#[derive(Default)]
struct Pages {
    differences: Vec<String>,
}

impl Pages {
    /// Checks that each way of asking in `forms` prints the same page on stdout, nothing on stderr,
    /// and exits 0, and that the page is golden file `name`.
    fn check(&mut self, home: &TestHome, name: &str, forms: &[Vec<&str>], columns: &str) {
        let mut page = None::<String>;
        for form in forms {
            let output = help(home, form, columns);
            let (out, err) = (stdout(&output), stderr(&output));
            if output.status.code() != Some(0) || !err.is_empty() {
                self.differences.push(format!(
                    "facade {form:?} exited {:?} with stderr {err:?}",
                    output.status.code()
                ));
            }
            if out.contains("facade.exe") {
                self.differences
                    .push(format!("facade {form:?} names facade.exe:\n{out}"));
            }
            match &page {
                None => page = Some(out),
                Some(first) if *first != out => self.differences.push(format!(
                    "facade {form:?} differs from facade {:?}:\n{out}\n---\n{first}",
                    forms[0]
                )),
                Some(_) => {}
            }
        }
        let page = page.unwrap_or_default();
        let file = golden(name);
        if std::env::var_os("FACADE_REGENERATE").is_some() {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, &page).unwrap();
            return;
        }
        let kept = std::fs::read_to_string(&file).unwrap_or_default();
        // Git may give the files CRLF line endings on Windows; the pages have LF.
        if kept.replace("\r\n", "\n") != page {
            self.differences.push(format!(
                "{} differs from facade {:?}:\n{page}",
                file.display(),
                forms[0]
            ));
        }
    }

    fn assert_none(self) {
        assert!(
            self.differences.is_empty(),
            "{}\n\nWhere the change is meant, regenerate the files: FACADE_REGENERATE=1 cargo test \
             -p facade-scenarios --test help",
            self.differences.join("\n\n")
        );
    }
}

/// The three ways of asking for a page: `<cmd> -h`, `<cmd> --help` and `help <cmd>`.
fn forms<'a>(path: &[&'a str]) -> Vec<Vec<&'a str>> {
    let with = |option: &'a str| path.iter().copied().chain([option]).collect();
    let asked = ["help"].into_iter().chain(path.iter().copied()).collect();
    vec![with("-h"), with("--help"), asked]
}

/// `facade`, `facade -h`, `facade --help` and `facade help` print the root page, every command's
/// three forms print its page, and an alias prints its command's page. Asking for help starts no
/// Facade.
#[test]
fn every_help_page_is_its_golden_file_whichever_way_it_is_asked_for() {
    let home = TestHome::new("helppages");
    let mut pages = Pages::default();
    pages.check(
        &home,
        "root",
        &[vec![], vec!["-h"], vec!["--help"], vec!["help"]],
        WIDTH,
    );
    for path in PAGES {
        pages.check(&home, &path.join("-"), &forms(path), WIDTH);
    }
    for (alias, command) in ALIASES {
        pages.check(&home, command, &forms(&[alias]), WIDTH);
    }
    pages.check(
        &home,
        &format!("start-{NARROW}"),
        &forms(&["start"]),
        NARROW,
    );
    pages.assert_none();
    assert!(
        !socket_exists(&home.daemon_socket()) && !home.path.join("core").exists(),
        "help reached Facade"
    );
}

/// Every golden file belongs to a page this test reads, so none is left behind when a page goes.
#[test]
fn every_golden_help_file_is_a_page() {
    // The files are being written meanwhile.
    if std::env::var_os("FACADE_REGENERATE").is_some() {
        return;
    }
    let mut names: Vec<String> = PAGES.iter().map(|path| path.join("-")).collect();
    names.push("root".to_string());
    names.push(format!("start-{NARROW}"));
    let folder = golden("root").parent().unwrap().to_path_buf();
    let kept: Vec<String> = std::fs::read_dir(&folder)
        .unwrap_or_else(|_| panic!("no folder {}", folder.display()))
        .map(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".txt")
                .to_string()
        })
        .filter(|name| !names.contains(name))
        .collect();
    assert!(kept.is_empty(), "files of no page: {kept:?}");
}

/// The root page lists the commands in their groups, with the pointer to per-command help.
#[test]
fn the_root_page_groups_the_commands() {
    let home = TestHome::new("helproot");
    let root = stdout(&help(&home, &[], WIDTH));
    let headings: Vec<&str> = root
        .lines()
        .filter(|line| !line.starts_with(' ') && line.ends_with(':'))
        .collect();
    assert_eq!(
        headings,
        [
            "Agents:",
            "Inspect and control:",
            "Messages:",
            "Setup and info:",
            "Options:"
        ],
        "{root}"
    );
    assert!(
        root.starts_with("Facade runs AI coding agents")
            && root.contains("\nUsage: facade [OPTIONS] [COMMAND]\n")
            && root
                .ends_with("\nRun 'facade <COMMAND> --help' for more information on a command.\n"),
        "{root}"
    );
}
