//! A stand-in for `wsl.exe` in tests: answers each call from the
//! `scenario.json` beside the path it was run by (each test puts it in a
//! folder of its own), and notes every call in its log.
//!
//! A scenario is `{"log": path, "answers": [answer…]}`; an answer is chosen
//! when its `args` equal the call's, or the call starts with its `starts`
//! and contains its `contains`. It prints `stdout` (as UTF-16 with `utf16`)
//! and `stderr`, after `sleep_ms`, and exits with `code`.

use std::io::Write;

use serde::Deserialize;

#[derive(Deserialize)]
struct Scenario {
    log: std::path::PathBuf,
    answers: Vec<Answer>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Answer {
    args: Option<Vec<String>>,
    starts: Vec<String>,
    contains: Option<String>,
    stdout: String,
    stderr: String,
    utf16: bool,
    sleep_ms: u64,
    code: i32,
}

impl Answer {
    fn fits(&self, call: &[String]) -> bool {
        match &self.args {
            Some(args) => args == call,
            None => {
                call.starts_with(&self.starts)
                    && self
                        .contains
                        .as_ref()
                        .is_none_or(|c| call.join(" ").contains(c.as_str()))
            }
        }
    }
}

fn main() {
    let call: Vec<String> = std::env::args().skip(1).collect();
    // The path it was run by, not `current_exe`: the tests link one file
    // into each folder, and of a file with several names any may be said to
    // be this program's.
    let path =
        std::path::PathBuf::from(std::env::args_os().next().expect("the path it was run by"))
            .with_file_name("scenario.json");
    let scenario: Scenario =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the scenario"))
            .expect("a scenario");
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&scenario.log)
        .expect("the log");
    writeln!(log, "{}", serde_json::to_string(&call).expect("the call")).expect("logging the call");
    let Some(answer) = scenario.answers.iter().find(|a| a.fits(&call)) else {
        eprintln!("fake wsl: no answer for {call:?}");
        std::process::exit(1);
    };
    std::thread::sleep(std::time::Duration::from_millis(answer.sleep_ms));
    let out: Vec<u8> = if answer.utf16 {
        [0xFF, 0xFE]
            .into_iter()
            .chain(answer.stdout.encode_utf16().flat_map(u16::to_le_bytes))
            .collect()
    } else {
        answer.stdout.clone().into_bytes()
    };
    std::io::stdout().write_all(&out).expect("stdout");
    eprint!("{}", answer.stderr);
    std::process::exit(answer.code);
}
