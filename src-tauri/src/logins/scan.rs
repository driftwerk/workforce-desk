//! Reading a sign-in CLI's terminal: the page to open, whether it waits for
//! a code pasted back, what it said of one that was, how it failed, and the
//! long-lived token `claude setup-token` shows when it's done.
//!
//! Claude Code (2.1.330) draws its screen as a full-screen program does:
//! it moves the cursor to each cell that changed and skips the blank ones,
//! so words and rows are apart only on the screen, never in the bytes. The
//! sign-in is read as a terminal shows it ([`Screen`]), and only rows with
//! something drawn below them count as whole, since the bytes of one frame
//! can arrive in more than one read.

use desk_machine::callback;

/// The terminal a sign-in runs on: wide, so neither the page's address
/// nor the token is ever wrapped. The CLI draws for this size, so Desk
/// reads it at the same.
pub const ROWS: u16 = 50;
pub const COLS: u16 = 1000;

/// Terminal output as plain text: escape sequences dropped, carriage
/// returns treated as new lines. For a program that prints lines (an
/// installer, `codex login`), not one that draws a screen.
pub fn plain(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' || (n == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => out.push('\n'),
            c if c == '\n' || !c.is_control() => out.push(c),
            _ => {}
        }
    }
    out
}

/// A sign-in's terminal as it shows: the CLI's output drawn on a
/// [`ROWS`]×[`COLS`] screen.
pub struct Screen(vt100::Parser);

impl Default for Screen {
    fn default() -> Self {
        let size = |n: u16| std::num::NonZeroU16::new(n).expect("a terminal has a size");
        Self(vt100::Parser::new(size(ROWS), size(COLS), 0))
    }
}

impl Screen {
    /// Draws `bytes`, each new line also back to the row's start, as the
    /// terminal's own `onlcr` does on the way out of the program.
    pub fn feed(&mut self, bytes: &[u8]) {
        let lines: Vec<&[u8]> = bytes.split(|&b| b == b'\n').collect();
        self.0.process(&lines.join(b"\r\n".as_slice()));
    }

    /// What the screen shows, row by row.
    pub fn text(&self) -> String {
        self.0.screen().contents()
    }
}

/// What `claude setup-token`'s screen shows, as far as Desk acts on it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Shown {
    /// The sign-in page it shows.
    pub page: Option<String>,
    /// Whether it waits for the code from the page.
    pub asks_for_code: bool,
    /// What Desk says of a pasted code the CLI turned down.
    pub refused: Option<&'static str>,
    /// Why it can't go on: it waits for nothing Desk can give.
    pub failure: Option<String>,
    pub token: Option<String>,
}

/// Reads the screen's `text`; with `ended`, the CLI is done drawing, so
/// its last row is whole too.
pub fn shown(text: &str, ended: bool) -> Shown {
    let whole = whole_rows(text, ended);
    Shown {
        page: sign_in_url(&whole),
        asks_for_code: asks_for_code(text),
        refused: refused(text),
        failure: failure(text, &whole),
        token: claude_token(text, ended),
    }
}

/// The screen's rows with something drawn below them (all of them once
/// the CLI has ended): what's on those is whole, while the last may still
/// be being drawn.
fn whole_rows(text: &str, ended: bool) -> String {
    let rows: Vec<&str> = text.lines().collect();
    let last = rows.iter().rposition(|r| !r.trim().is_empty());
    let whole = match (ended, last) {
        (true, _) => rows.len(),
        (false, Some(last)) => last,
        (false, None) => 0,
    };
    rows[..whole].join("\n")
}

/// The sign-in page in `text`: Claude's own when it shows one, else the
/// first web address.
pub fn sign_in_url(text: &str) -> Option<String> {
    let addresses: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
        .filter(|w| w.starts_with("https://") && w.len() > "https://".len() + 3)
        .map(|w| w.trim_end_matches(['.', ',', ')']))
        .collect();
    addresses
        .iter()
        .find(|a| callback::sign_in_page(a, callback::CLAUDE_PAGES).is_some())
        .or(addresses.first())
        .map(|a| a.to_string())
}

/// Whether Desk may open `url` in the browser itself: Claude's own sign-in
/// pages, and nothing else a CLI might show.
pub fn opens_itself(url: &str) -> bool {
    callback::sign_in_page(url, callback::CLAUDE_PAGES).is_some()
}

/// What the CLI shows while it waits for the page's code: Claude Code's
/// field ("Paste code here if prompted", "Paste code here") and its
/// earlier prompts.
const CODE_PROMPTS: [&str; 4] = [
    "paste code",
    "paste the code",
    "enter the code",
    "paste the redirect url",
];

fn asks_for_code(text: &str) -> bool {
    let lower = text.to_lowercase();
    CODE_PROMPTS.iter().any(|p| lower.contains(p))
}

/// Where the code prompt starts in `text`: what follows it may echo the
/// code the person pasted, which no message repeats.
fn before_code(text: &str) -> &str {
    let lower = text.to_lowercase();
    let at = CODE_PROMPTS.iter().filter_map(|p| lower.find(p)).min();
    match at {
        // Lowercasing can move byte offsets; cut only on a boundary.
        Some(i) if text.is_char_boundary(i) => &text[..i],
        Some(_) => "",
        None => text,
    }
}

/// What the CLI says of a code it turns down while still waiting for one
/// (Claude Code 2.1.330's own words, on the left), and what Desk says.
const REFUSED: [(&str, &str); 4] = [
    (
        "That address only works in a browser on this machine",
        "That address only works in the browser it came back to. Paste the code the last page shows instead.",
    ),
    (
        "That's a web address, not the code",
        "That's a web address, not the code. Paste the code the last page shows.",
    ),
    (
        "That looks like a verification code",
        "That looks like a verification code: enter it on the page that asks for it, then paste the longer code the page shows next.",
    ),
    (
        "That doesn't look like the full code",
        "That isn't the whole code. Copy all of it, including the # in the middle.",
    ),
];

fn refused(text: &str) -> Option<&'static str> {
    REFUSED
        .iter()
        .find(|(cli, _)| text.contains(cli))
        .map(|(_, desk)| *desk)
}

/// Why the CLI can't go on, in its words: the error drawn above "Press
/// Enter to retry" (nothing Desk can give retries it), from below the last
/// code prompt so never the code it may echo, or an account on hold once
/// its row is `whole`.
fn failure(text: &str, whole: &str) -> Option<String> {
    let rows: Vec<&str> = text.lines().map(str::trim).collect();
    let error = rows
        .iter()
        .position(|r| r.contains("Press Enter to retry"))
        .map(|at| {
            let from = rows[..at]
                .iter()
                .rposition(|r| asks_for_code(r))
                .map_or(0, |prompt| prompt + 1);
            let block: Vec<String> = rows[from..at]
                .iter()
                .rev()
                .skip_while(|r| r.is_empty())
                .take_while(|r| !r.is_empty())
                .map(|r| said(r))
                .collect();
            block.into_iter().rev().collect::<Vec<_>>().join(" ")
        })
        .filter(|e| !e.is_empty());
    let on_hold = || whole.lines().find(|r| r.contains("is on hold")).map(said);
    error.or_else(on_hold)
}

/// The last thing the CLI said before its code prompt, for when it ended
/// without a token.
pub fn last_words(text: &str) -> Option<String> {
    before_code(text)
        .lines()
        .map(str::trim)
        .rfind(|r| !r.is_empty())
        .map(said)
}

/// A row of the screen as a sentence: without the mark it starts with.
fn said(row: &str) -> String {
    row.trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim()
        .to_string()
}

const CLAUDE_TOKEN_PREFIX: &str = "sk-ant-oat";

/// What the CLI draws below the token once the token's row is done.
const TOKEN_DRAWN: &str = "Store this token securely";

/// The Claude OAuth token the screen shows: on the row above "Store this
/// token securely", or on any row once the CLI has `ended`. A row still
/// being drawn over an earlier screen shows the old screen past its end.
fn claude_token(text: &str, ended: bool) -> Option<String> {
    let rows: Vec<&str> = text.lines().collect();
    let drawn: Vec<&str> = match rows.iter().position(|r| r.contains(TOKEN_DRAWN)) {
        Some(at) => rows[..at]
            .iter()
            .rfind(|r| !r.trim().is_empty())
            .copied()
            .into_iter()
            .collect(),
        None if ended => rows,
        None => Vec::new(),
    };
    drawn.into_iter().find_map(token_on)
}

/// A token alone on `row`: a space or the row's end follows it.
fn token_on(row: &str) -> Option<String> {
    let from = &row[row.find(CLAUDE_TOKEN_PREFIX)?..];
    let end = from
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(from.len());
    let (token, after) = from.split_at(end);
    (token.len() > CLAUDE_TOKEN_PREFIX.len() + 40
        && after.chars().next().is_none_or(char::is_whitespace))
    .then(|| token.to_string())
}

/// Claude Code 2.1.330's screens, drawn as its renderer draws them.
#[cfg(test)]
pub mod fixtures {
    use super::Screen;

    pub const TOKEN: &str = "sk-ant-oat01-Qw3rTy_uIoP-aSdFgHjKl0123456789zXcVbNm-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    pub fn screen(chunks: &[&[u8]]) -> Screen {
        let mut s = Screen::default();
        for c in chunks {
            s.feed(c);
        }
        s
    }

    /// Words drawn as Claude Code 2.1.330's renderer draws a fresh row at
    /// column `col` (1-based) from wherever the cursor is: to the column
    /// (`CSI n G`), a row down (`CSI B`), then each word, the blank cells
    /// between them skipped (`CSI n G`), never written.
    pub fn row(col: usize, words: &str) -> Vec<u8> {
        let mut out = format!("\x1b[{col}G\x1b[B");
        let mut at = col;
        for w in words.split(' ') {
            out.push_str(&format!("\x1b[{at}G{w}"));
            at += w.chars().count() + 1;
        }
        out.into_bytes()
    }

    /// The waiting screen `claude setup-token` 2.1.330 draws, its page
    /// outdented to column 0 in a terminal link, the code field below.
    pub fn waiting(url: &str) -> Vec<u8> {
        [
            b"\x1b[?25l\x1b[2mClaude Code\x1b[22m".to_vec(),
            row(2, "This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required."),
            row(2, "Browser didn't open? Use the URL below to sign in c to copy"),
            format!("\r\n\x1b]8;;{url}\x07\x1b[2m{url}\x1b[22m\x1b]8;;\x07").into_bytes(),
            row(2, "Paste code here if prompted >"),
        ]
        .concat()
    }

    /// Its screen once the token is made: the waiting screen's rows erased
    /// (`ED`, `EL`, `ECH`), the token's own run of `A`s repeated (`REP`).
    pub fn token_frame(token: &str) -> Vec<u8> {
        let (head, run) = token.split_at(token.find('A').unwrap());
        [
            b"\x1b[3A\x1b[2G\x1b[J".to_vec(),
            b"\x1b[32m\xe2\x9c\x93\x1b[39m\x1b[4GLong-lived\x1b[15Gauthentication\x1b[30Gtoken\x1b[36Gcreated\x1b[X".to_vec(),
            row(2, "Your OAuth token (valid for 1 year):"),
            format!(
                "\x1b[2G\x1b[B\x1b[33m{head}A\x1b[{}b\x1b[39m\x1b[K",
                run.len() - 1
            )
            .into_bytes(),
            row(2, "Store this token securely. You won't be able to see it again."),
            row(2, "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"),
        ]
        .concat()
    }

    pub const FULL: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=x&code_challenge_method=S256&state=s";
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn claude_code_2_1_330s_screen_is_read_as_it_shows() {
        let s = screen(&[&waiting(FULL)]);
        // As plain text its words run together: no code field, no token.
        assert!(!plain(&String::from_utf8_lossy(&waiting(FULL))).contains("Paste code"));
        let seen = shown(&s.text(), false);
        assert_eq!(seen.page.as_deref(), Some(FULL));
        assert!(opens_itself(FULL));
        assert!(seen.asks_for_code);
        assert_eq!((seen.token, seen.failure, seen.refused), (None, None, None));

        let s = screen(&[&waiting(FULL), &token_frame(TOKEN)]);
        let seen = shown(&s.text(), false);
        assert_eq!(seen.token.as_deref(), Some(TOKEN));
        assert_eq!(seen.failure, None);
    }

    #[test]
    fn a_token_split_across_reads_is_taken_only_once_whole() {
        let frame = token_frame(TOKEN);
        let cut = frame.windows(10).position(|w| w == b"sk-ant-oat").unwrap() + 40;
        let mut s = screen(&[&waiting(FULL), &frame[..cut]]);
        assert_eq!(shown(&s.text(), false).token, None);
        s.feed(&frame[cut..]);
        assert_eq!(shown(&s.text(), false).token.as_deref(), Some(TOKEN));
    }

    #[test]
    fn a_token_drawn_over_the_page_is_taken_only_once_the_rows_below_it_are() {
        let frame = format!(
            "\x1b[A\x1b[2G\x1b[33m{TOKEN}\x1b[39m\x1b[K\x1b[2G\x1b[B\x1b[2KStore this token securely. You won't be able to see it again."
        )
        .into_bytes();
        let cut = frame.windows(10).position(|w| w == b"sk-ant-oat").unwrap() + 50;
        let mut s = screen(&[&waiting(FULL), &frame[..cut]]);
        let partial = s.text();
        assert!(partial.contains(&format!("{}ient_id", &TOKEN[..50])));
        assert_eq!(shown(&partial, false).token, None);
        s.feed(&frame[cut..]);
        assert_eq!(shown(&s.text(), false).token.as_deref(), Some(TOKEN));
        let stale = format!("{TOKEN}ab/cd\nStore this token securely.");
        assert_eq!(shown(&stale, true).token, None);
    }

    #[test]
    fn a_page_still_being_drawn_isnt_shown_until_its_row_is_whole() {
        let s = screen(&[format!("Use the url below:\r\n{}", &FULL[..60]).as_bytes()]);
        assert_eq!(shown(&s.text(), false).page, None);
        assert_eq!(shown(&s.text(), true).page.as_deref(), Some(&FULL[..60]));
    }

    #[test]
    fn a_token_shown_last_is_taken_once_the_cli_has_ended() {
        let s = screen(&[format!("Your token:\n\n{TOKEN}\n").as_bytes()]);
        assert_eq!(shown(&s.text(), false).token, None);
        assert_eq!(shown(&s.text(), true).token.as_deref(), Some(TOKEN));
    }

    #[test]
    fn earlier_clis_printed_lines_and_are_read_as_before() {
        // As Claude Code 2.1.318 drew it: the link as a terminal hyperlink,
        // then the prompt.
        let raw = "\x1b[2mBrowser didn't open? Use the url below to sign in \x1b[22m\r\n\
                   \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x\x1b\\\
                   \x1b[2mhttps://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x\x1b[22m\
                   \x1b]8;;\x1b\\\r\n\r\nPaste code here if prompted > ";
        let seen = shown(&screen(&[raw.as_bytes()]).text(), false);
        assert_eq!(
            seen.page.as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x")
        );
        assert!(seen.asks_for_code);
        let printed = format!("Your token:\n\n{TOKEN}\n\nStore this token securely.");
        assert_eq!(
            shown(&screen(&[printed.as_bytes()]).text(), false)
                .token
                .as_deref(),
            Some(TOKEN)
        );
        assert_eq!(
            shown(
                &screen(&[b"Your token:\n\nsk-ant-oat01-short\n\nStore this token securely."])
                    .text(),
                true
            )
            .token,
            None
        );
    }

    #[test]
    fn claudes_sign_in_page_is_shown_before_any_other_address() {
        let s = screen(&[
            format!("Docs: https://code.claude.com/docs\n{FULL}\nPaste code here >").as_bytes(),
        ]);
        assert_eq!(shown(&s.text(), false).page.as_deref(), Some(FULL));
        let s = screen(&[b"Open https://example.com/login.\nthen come back"]);
        assert_eq!(
            shown(&s.text(), false).page.as_deref(),
            Some("https://example.com/login")
        );
        assert!(!opens_itself("https://example.com/login"));
    }

    #[test]
    fn desk_opens_only_claudes_own_sign_in_pages_itself() {
        assert!(opens_itself("https://claude.ai/oauth/authorize?x=1"));
        assert!(opens_itself(
            "https://claude.ai/oauth/authorize?I5Z5LGBcsA8jJxigKaWbSU59zxsdc6QtHJYj-jFOZ9Oo"
        ));
        assert!(!opens_itself(
            "https://platform.claude.com/oauth/code/success"
        ));
        assert!(!opens_itself("http://claude.ai/oauth/authorize"));
        assert!(!opens_itself(
            "https://claude.ai.example.com/oauth/authorize"
        ));
        assert!(!opens_itself("https://evilclaude.ai/oauth/authorize"));
        assert!(!opens_itself("file:///etc/passwd"));
    }

    #[test]
    fn a_code_prompt_is_noticed_in_each_cli_s_words() {
        for prompt in [
            "Paste code here if prompted >",
            "Paste code here >",
            "Or paste the redirect URL here:",
            "Enter the code shown",
        ] {
            assert!(shown(prompt, false).asks_for_code, "{prompt}");
        }
        assert!(!shown("Opening browser to sign in…", false).asks_for_code);
    }

    #[test]
    fn a_code_the_cli_turns_down_is_said_in_desks_words_while_it_still_waits() {
        let s = screen(&[
            &waiting(FULL),
            &row(
                2,
                "That doesn't look like the full code. Copy all of it, including the # in the middle.",
            ),
        ]);
        let seen = shown(&s.text(), false);
        assert!(seen.asks_for_code);
        assert_eq!(seen.refused, Some(REFUSED[3].1));
        assert_eq!(seen.failure, None);
    }

    #[test]
    fn an_error_the_cli_waits_on_enter_for_ends_the_sign_in_in_its_words() {
        let s = screen(&[
            &waiting(FULL),
            b"\x1b[2J\x1b[H",
            &row(
                1,
                "\u{2717} OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
            ),
            &row(1, "Press Enter to retry"),
        ]);
        assert_eq!(
            shown(&s.text(), false).failure.as_deref(),
            Some(
                "OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."
            )
        );
    }

    #[test]
    fn an_error_never_repeats_the_code_prompt_or_the_code_it_echoes() {
        let s = screen(&[
            &waiting(FULL),
            b" abc#secret",
            &row(2, "OAuth error: That code wasn't accepted."),
            &row(2, "Press Enter to retry"),
        ]);
        let seen = shown(&s.text(), false);
        assert_eq!(
            seen.failure.as_deref(),
            Some("OAuth error: That code wasn't accepted.")
        );

        let pasted = format!(" {}#secret", "x".repeat(usize::from(COLS)));
        let s = screen(&[
            &waiting(FULL),
            pasted.as_bytes(),
            &row(2, "OAuth error: That code wasn't accepted."),
            &row(2, "Press Enter to retry"),
        ]);
        let text = s.text();
        assert!(
            text.lines()
                .any(|r| r.ends_with("#secret") && asks_for_code(r))
        );
        assert_eq!(
            shown(&text, false).failure.as_deref(),
            Some("OAuth error: That code wasn't accepted.")
        );
    }

    #[test]
    fn an_account_on_hold_ends_the_sign_in() {
        let s = screen(&[
            &waiting(FULL),
            b"\x1b[2J\x1b[H",
            &row(
                2,
                "\u{26a0} Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted",
            ),
        ]);
        assert_eq!(
            shown(&s.text(), false).failure,
            None,
            "its row may be partial"
        );
        assert_eq!(
            shown(&s.text(), true).failure.as_deref(),
            Some(
                "Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted"
            )
        );
    }

    #[test]
    fn the_last_words_never_repeat_what_followed_the_code_prompt() {
        let text = "Opening browser\nhttps://claude.ai/oauth\nPaste code here if prompted > abc#secret\nOAuth error: invalid code";
        assert_eq!(last_words(text).as_deref(), Some("https://claude.ai/oauth"));
        assert_eq!(
            last_words("x\n\u{2717} Error: not logged in\n\n").as_deref(),
            Some("Error: not logged in")
        );
        assert_eq!(last_words("   \n"), None);
    }

    #[test]
    fn printed_lines_read_as_plain_text() {
        let raw = "\x1b[1mBrowser didn't open?\x1b[0m Use the url below:\r\n\x1b]8;;x\x07https://claude.ai/oauth/authorize?code=true&client_id=abc\x1b]8;;\x07\r\n";
        assert_eq!(
            plain(raw),
            "Browser didn't open? Use the url below:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\n\n"
        );
    }
}
