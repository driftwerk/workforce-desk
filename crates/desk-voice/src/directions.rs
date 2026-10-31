//! Voice directions a voice here can't perform. Fish Audio takes tags like
//! `(excited)` or `[whispering]` and the hub checks them against the model
//! before they're spoken; Kokoro takes none, and would read them out. When a
//! cloud voice fails part-way and Kokoro says the rest, the text it's handed
//! was written for the cloud voice, so the directions come out first.
//!
//! A direction is a group in parentheses or square brackets of up to four
//! lower-case words (letters, spaces, hyphens, apostrophes) that isn't
//! attached to a word: `(soft tone)`, `[laughing]`. Spoken, a short aside in
//! brackets goes with them, which costs little; `(API)`, `f(x)`, `(page 4)`
//! and `[1, 2]` stay.

const MAX_WORDS: usize = 4;
const MAX_CHARS: usize = 40;

fn closer(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        _ => None,
    }
}

/// The direction opening `text`, as the bytes it spans.
fn direction(text: &str) -> Option<usize> {
    let mut chars = text.char_indices();
    let close = closer(chars.next()?.1)?;
    for (i, c) in chars {
        if i > MAX_CHARS {
            return None;
        }
        if c == close {
            let words = text[1..i].split_whitespace().count();
            return (1..=MAX_WORDS).contains(&words).then_some(i + 1);
        }
        let allowed = c.is_alphabetic() && !c.is_uppercase() || matches!(c, ' ' | '-' | '\'' | '’');
        if !allowed {
            return None;
        }
    }
    None
}

/// `text` without voice directions, spaced as if they'd never been there.
pub fn without_directions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(c) = text[i..].chars().next() {
        let attached = out.chars().last().is_some_and(char::is_alphanumeric);
        if let Some(len) = direction(&text[i..]).filter(|_| !attached) {
            i += len;
            let next = text[i..].chars().next();
            if out.ends_with(' ') && next.is_some_and(|n| n == ' ' || ".,!?;:".contains(n)) {
                out.pop();
            } else if out.is_empty() && next == Some(' ') {
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directions_are_taken_out() {
        assert_eq!(without_directions("(excited) Found it!"), "Found it!");
        assert_eq!(without_directions("[whispering] Over here."), "Over here.");
        assert_eq!(
            without_directions("Well (soft tone) that's that."),
            "Well that's that."
        );
        assert_eq!(without_directions("Done (laughing)."), "Done.");
        assert_eq!(without_directions("(sad)(soft tone) Oh."), "Oh.");
        assert_eq!(without_directions("Hi. (calm) Next."), "Hi. Next.");
    }

    #[test]
    fn prose_stays() {
        for prose in [
            "Ask Alice (API) first.",
            "Use f(x) here.",
            "See the docs (page 4).",
            "It returned [1, 2, 3].",
            "Files(s) left.",
            "(This matters.) Read it.",
            "Unclosed (bracket",
        ] {
            assert_eq!(without_directions(prose), prose);
        }
    }
}
