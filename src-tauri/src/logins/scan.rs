//! Reading a sign-in CLI's terminal output: the page to open, whether it
//! wants a code pasted back, and the long-lived token `claude setup-token`
//! prints when it's done.

/// Terminal output as plain text: escape sequences dropped, carriage
/// returns treated as new lines.
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

/// The first web address the CLI asks the person to open.
pub fn sign_in_url(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
        .find(|w| w.starts_with("https://") && w.len() > "https://".len() + 3)
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// Whether the CLI is waiting for a code from the browser page.
pub fn wants_code(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("paste code")
        || lower.contains("paste the code")
        || lower.contains("enter the code")
}

const CLAUDE_TOKEN_PREFIX: &str = "sk-ant-oat";

/// The Claude OAuth token in the output, once it's been printed whole.
pub fn claude_token(text: &str) -> Option<String> {
    let start = text.find(CLAUDE_TOKEN_PREFIX)?;
    let token: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    // A token still being printed ends at the buffer's edge; wait for the
    // whitespace after it.
    let complete = text[start + token.len()..].starts_with(char::is_whitespace);
    (complete && token.len() > CLAUDE_TOKEN_PREFIX.len() + 40).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_read_as_plain_text() {
        let raw = "\x1b[1mBrowser didn't open?\x1b[0m Use the url below:\r\n\x1b]8;;x\x07https://claude.ai/oauth/authorize?code=true&client_id=abc\x1b]8;;\x07\r\n";
        let text = plain(raw);
        assert_eq!(
            sign_in_url(&text).as_deref(),
            Some("https://claude.ai/oauth/authorize?code=true&client_id=abc")
        );
    }

    #[test]
    fn a_code_prompt_is_noticed() {
        assert!(wants_code("Paste code here if prompted >"));
        assert!(!wants_code("Opening browser to sign in…"));
    }

    #[test]
    fn the_token_is_taken_only_once_it_is_whole() {
        let token = format!("sk-ant-oat01-{}", "a".repeat(80));
        assert_eq!(
            claude_token(&format!("Your token:\n\n{token}\n\nStore it")),
            Some(token.clone())
        );
        assert_eq!(
            claude_token(&format!("Your token:\n\n{}", &token[..50])),
            None
        );
        assert_eq!(claude_token("no token here"), None);
    }
}
