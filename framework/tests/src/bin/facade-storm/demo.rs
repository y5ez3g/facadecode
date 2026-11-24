//! A storm for a person to try by hand: a recipient in a window of its own, senders, and keys that
//! start and stop the messages.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crossterm::event::{Event, KeyCode, KeyEventKind};
use facade_scenarios::*;

use crate::client::{self, Mcp};
use crate::lab::Lab;
use crate::storm::{self, Shape};

const SENDERS: usize = 8;

pub fn run(folder: &Path) -> anyhow::Result<()> {
    let home = TestHome {
        path: folder.join("home"),
        project: folder.join("project"),
        fake_log: folder.join("fake.log"),
    };
    facade_base::files::create_private_folder_all(&home.path)?;
    std::fs::create_dir_all(&home.project)?;
    home.kill_home_processes();
    home.start_facade_with(&[]);
    let wire = client::terminal(&home.daemon_socket())?;
    let tapes = folder.join("tapes");
    std::fs::create_dir_all(&tapes)?;
    let lab = Lab { home, wire, tapes };

    let boss = lab.start_fake("boss", &[("FAKECLI_MOUSE", "1"), ("FAKECLI_NAME", "boss")])?;
    let names: Vec<String> = (1..=SENDERS).map(|n| format!("s{n:02}")).collect();
    let senders = storm::start_many(&lab, &names, &[])?;
    let mut all = vec![boss.clone()];
    all.extend(senders.iter().cloned());
    lab.wait_ready(&all, Duration::from_secs(60))?;
    let clients: Vec<Mcp> = senders
        .iter()
        .map(|sender| Mcp::managed(&lab.home, &sender.id))
        .collect::<anyhow::Result<_>>()?;
    if std::env::var_os("FACADE_STORM_NO_WINDOW").is_none() {
        open_window(&lab.home, &boss.address)?;
    }

    println!("home: {}", lab.home.path.display());
    println!("boss 的窗口已经在另一个窗口打开(也可以再开: look.ps1 attach boss)。");
    println!("在 boss 的窗口里随便打字、滚轮、点鼠标、切窗口。");
    println!(
        "这里按:空格 = 开始/停止灌消息   b = 一次来 50 条   + / - = 快 / 慢   q = 全部收掉退出"
    );
    let on = AtomicBool::new(false);
    let quit = AtomicBool::new(false);
    let burst = AtomicUsize::new(0);
    let every_ms = AtomicU64::new(500);
    let sent = AtomicUsize::new(0);
    std::thread::scope(|scope| -> anyhow::Result<()> {
        for (n, (sender, mcp)) in senders.iter().zip(&clients).enumerate() {
            let (on, quit, burst, every_ms, sent, boss) =
                (&on, &quit, &burst, &every_ms, &sent, &boss);
            scope.spawn(move || {
                let mut next = Instant::now() + Duration::from_millis(70) * n as u32;
                while !quit.load(Ordering::SeqCst) {
                    let wanted = burst
                        .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                            left.checked_sub(1)
                        })
                        .is_ok();
                    if wanted || (on.load(Ordering::SeqCst) && Instant::now() >= next) {
                        let seq = sent.fetch_add(1, Ordering::SeqCst) + 1;
                        let text = Shape::Short.text(&format!("demo-{seq:05}"));
                        storm::send(mcp, &sender.id, boss, seq, text, "inbox");
                        next = Instant::now()
                            + Duration::from_millis(
                                every_ms.load(Ordering::SeqCst) * SENDERS as u64,
                            );
                    } else {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            });
        }
        let talk = keys(&lab, &boss, &on, &quit, &burst, &every_ms);
        quit.store(true, Ordering::SeqCst);
        talk
    })?;
    println!("\r\n收掉……");
    let mut verdict = crate::judge::Verdict::default();
    storm::stop_all(&lab, &all, &mut verdict);
    drop(clients);
    drop(lab);
    println!("都收掉了。");
    Ok(())
}

/// Runs the demo in a pseudo console, opens no window, and goes through its keys: whether it starts,
/// storms and stops.
pub fn check(folder: &Path) -> anyhow::Result<()> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command.args(["demo", "--out"]).arg(folder);
    command.envs(std::env::vars_os());
    command.env("FACADE_STORM_NO_WINDOW", "1");
    let mut term = TestTerminal::spawn(&mut command, 140, 30);
    let wait = |what: &str, seconds: u64| {
        let shown = term.wait_for(Duration::from_secs(seconds), |text| text.contains(what));
        anyhow::ensure!(shown, "the demo never showed {what:?}:\n{}", term.text());
        Ok(())
    };
    wait("停着", 60)?;
    term.send(b" ");
    std::thread::sleep(Duration::from_secs(5));
    println!("{}", term.text());
    term.send(b"q");
    let ended = term.wait_exit(Duration::from_secs(30));
    println!("{}", term.text());
    anyhow::ensure!(
        ended.is_some_and(|status| status.success()),
        "the demo did not end"
    );
    Ok(())
}

/// Opens `facade attach` to the recipient in a console window of its own.
fn open_window(home: &TestHome, address: &str) -> anyhow::Result<()> {
    let mut command = home.command(&test_binaries().facade);
    command.args(["attach", address]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE);
    }
    command.spawn()?;
    Ok(())
}

/// Takes the person's keys until they quit, and keeps a line with how the messages fare.
fn keys(
    lab: &Lab,
    boss: &crate::lab::Agent,
    on: &AtomicBool,
    quit: &AtomicBool,
    burst: &AtomicUsize,
    every_ms: &AtomicU64,
) -> anyhow::Result<()> {
    crossterm::terminal::enable_raw_mode()?;
    let mut shown = Instant::now() - Duration::from_secs(1);
    let ended = loop {
        if crossterm::event::poll(Duration::from_millis(100))?
            && let Event::Key(key) = crossterm::event::read()?
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                KeyCode::Char(' ') => {
                    on.fetch_xor(true, Ordering::SeqCst);
                }
                KeyCode::Char('b') => {
                    burst.fetch_add(50, Ordering::SeqCst);
                }
                KeyCode::Char('+' | '=') => {
                    let ms = every_ms.load(Ordering::SeqCst);
                    every_ms.store((ms / 2).max(60), Ordering::SeqCst);
                }
                KeyCode::Char('-') => {
                    let ms = every_ms.load(Ordering::SeqCst);
                    every_ms.store((ms * 2).min(8000), Ordering::SeqCst);
                }
                KeyCode::Char('q') | KeyCode::Esc => break Ok(()),
                _ => {}
            }
        }
        if quit.load(Ordering::SeqCst) {
            break Ok(());
        }
        if shown.elapsed() >= Duration::from_millis(700) {
            shown = Instant::now();
            let rows = match lab.rows() {
                Ok(rows) => rows,
                Err(err) => break Err(err),
            };
            let to_boss: Vec<_> = rows.values().filter(|row| row.to == boss.id).collect();
            let of = |status: &str| {
                to_boss
                    .iter()
                    .filter(|row| row.status == status && !row.withdrawn)
                    .count()
            };
            let last = to_boss
                .iter()
                .rev()
                .find(|row| row.status == "failure" || row.withdrawn)
                .map_or(String::new(), |row| {
                    format!(
                        "  最近一条失败: m{} {}",
                        row.number,
                        row.reason.as_deref().unwrap_or("withdrawn")
                    )
                });
            print!(
                "\r\x1b[2K{}  每 {} ms 一条  送达 {}  等着 {}  失败 {}  框: {}{last}",
                if on.load(Ordering::SeqCst) {
                    "灌着"
                } else {
                    "停着"
                },
                every_ms.load(Ordering::SeqCst),
                of("success"),
                of("pending"),
                of("failure") + to_boss.iter().filter(|row| row.withdrawn).count(),
                lab.input_state(boss),
            );
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    };
    crossterm::terminal::disable_raw_mode()?;
    ended
}
