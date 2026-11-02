//! Voice directions a voice here can't perform. Fish Audio takes tags like
//! `(excited)` or `[whispering]` and the hub checks them against the model
//! before they're spoken; Kokoro takes none, and would read them out. When a
//! cloud voice fails part-way and Kokoro says the rest, the text it's handed
//! was written for the cloud voice, so the directions come out first.
//!
//! A direction is a group in parentheses or square brackets that names one of
//! the tags the hub writes ([`TAGS`]) and isn't attached to a word: `(soft
//! tone)`, `[laughing]`. Everything else in brackets is said, as Desk says every
//! word of a reply: `(yes)`, `(re)start`, `(API)`, `f(x)` and `[1, 2]` stay.

/// The tags the hub writes into speech, as its `llm::speech::markup` tables
/// name them (Fish Audio's emotions, tones, sounds and pauses), and the moods
/// it names but no voice performs, which an S2 voice is still given.
const TAGS: &[&str] = &[
    "happy",
    "sad",
    "angry",
    "excited",
    "calm",
    "nervous",
    "confident",
    "surprised",
    "satisfied",
    "delighted",
    "scared",
    "worried",
    "upset",
    "frustrated",
    "depressed",
    "empathetic",
    "embarrassed",
    "disgusted",
    "moved",
    "proud",
    "relaxed",
    "grateful",
    "curious",
    "sarcastic",
    "disdainful",
    "unhappy",
    "anxious",
    "hysterical",
    "indifferent",
    "uncertain",
    "doubtful",
    "confused",
    "disappointed",
    "regretful",
    "guilty",
    "ashamed",
    "jealous",
    "envious",
    "hopeful",
    "optimistic",
    "pessimistic",
    "nostalgic",
    "lonely",
    "bored",
    "contemptuous",
    "sympathetic",
    "compassionate",
    "determined",
    "resigned",
    "in a hurry tone",
    "shouting",
    "screaming",
    "whispering",
    "soft tone",
    "emphasis",
    "laughing",
    "chuckling",
    "sobbing",
    "crying loudly",
    "sighing",
    "groaning",
    "panting",
    "gasping",
    "yawning",
    "snoring",
    "clear throat",
    "audience laughing",
    "background laughter",
    "crowd laughing",
    "break",
    "long-break",
    "pensive",
    "thoughtful",
    "serious",
];

/// The longest a tag is, brackets included.
const MAX_CHARS: usize = 24;

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
    let (end, _) = chars.take(MAX_CHARS).find(|(_, c)| *c == close)?;
    let name = text[1..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    TAGS.contains(&name.to_lowercase().as_str())
        .then_some(end + close.len_utf8())
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

    /// Desk says every word of a reply: only what names a tag goes.
    #[test]
    fn words_in_brackets_are_said() {
        for said in [
            "Choose (yes) or (no).",
            "The mode is (strict) by default",
            "(re)start it",
            "Menu (file) > [edit]",
            "Pass the flag (optional) too.",
        ] {
            assert_eq!(without_directions(said), said);
        }
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
