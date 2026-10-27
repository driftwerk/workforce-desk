//! Reading a transcript for who it is addressed to and whether it closes
//! the conversation. ASR spells names loosely ("Atlis", "CC auth fix"), so
//! names are compared as letters with a small edit distance.

use crate::keywords::spoken_words;

const FILLERS: [&str; 10] = [
    "hey", "hi", "hello", "ok", "okay", "so", "um", "uh", "yo", "oh",
];

const FAREWELLS: [&str; 13] = [
    "thanks",
    "thank you",
    "thanks a lot",
    "thank you very much",
    "thats all",
    "that is all",
    "thats it",
    "that will be all",
    "cheers",
    "goodbye",
    "bye",
    "never mind",
    "stop listening",
];

/// Transcript words with where each one ends in the text.
fn words(text: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices().chain([(text.len(), ' ')]) {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                out.push((spoken_words(&text[s..i]).concat(), i));
                start = None;
            }
            _ => {}
        }
    }
    out.retain(|(w, _)| !w.is_empty());
    out
}

fn letters(name: &str) -> String {
    spoken_words(name).concat()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != *cb)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// How far the first words are from `name`, and where they end; `None` when
/// they don't sound like it.
fn leading(text: &str, name: &str) -> Option<(usize, usize)> {
    let target = letters(name);
    if target.is_empty() {
        return None;
    }
    let words = words(text);
    let skip = words
        .iter()
        .take_while(|(w, _)| FILLERS.contains(&w.as_str()))
        .count();
    let rest = &words[skip..];
    let allowed = target.len() / 4;
    let span = spoken_words(name).len() + 1;
    (1..=span.min(rest.len()))
        .map(|k| {
            let said: String = rest[..k].iter().map(|(w, _)| w.as_str()).collect();
            (edit_distance(&said, &target), rest[k - 1].1)
        })
        .filter(|(d, _)| *d <= allowed)
        .min_by_key(|(d, _)| *d)
}

fn after(text: &str, end: usize) -> &str {
    text[end..]
        .trim_start_matches(|c: char| c.is_whitespace() || ",.:;!?-—".contains(c))
        .trim_end()
}

/// What follows `name` when the transcript opens with it ("Hey Atlas,
/// what failed?" → "what failed?").
pub fn strip_name<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    leading(text, name).map(|(_, end)| after(text, end))
}

/// The roster name the transcript opens with, if any, and the rest.
pub fn addressed<'a, 'n>(text: &'a str, names: &'n [String]) -> Option<(&'n str, &'a str)> {
    names
        .iter()
        .filter_map(|n| leading(text, n).map(|(d, end)| (d, n.as_str(), end)))
        .min_by_key(|(d, _, _)| *d)
        .map(|(_, name, end)| (name, after(text, end)))
}

/// "Thanks", "that's all", "thank you Atlas": the user is done.
pub fn is_farewell(text: &str) -> bool {
    let said: Vec<String> = words(text).into_iter().map(|(w, _)| w).collect();
    FAREWELLS.iter().any(|f| {
        let f: Vec<&str> = f.split(' ').collect();
        said.len() >= f.len() && said.len() <= f.len() + 2 && said[..f.len()] == f[..]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_name_and_fillers() {
        assert_eq!(
            strip_name("Atlas, what failed overnight?", "Atlas"),
            Some("what failed overnight?")
        );
        assert_eq!(
            strip_name("hey atlas what failed", "Atlas"),
            Some("what failed")
        );
        assert_eq!(
            strip_name("Atlis. What failed?", "Atlas"),
            Some("What failed?")
        );
        assert_eq!(strip_name("Atlas.", "Atlas"), Some(""));
        assert_eq!(
            strip_name("CC auth fix, run the tests", "cc-auth-fix"),
            Some("run the tests")
        );
        assert_eq!(strip_name("see see auth fix run it", "cc-auth-fix"), None);
        assert_eq!(strip_name("What failed overnight?", "Atlas"), None);
        assert_eq!(strip_name("I asked atlas", "Atlas"), None);
        assert_eq!(strip_name("Al, hi", "Al"), Some("hi"));
        assert_eq!(strip_name("All of it", "Al"), None);
    }

    #[test]
    fn finds_the_closest_roster_name() {
        let names = ["Atlas", "Allan", "scout"].map(String::from);
        assert_eq!(
            addressed("Allan, what's left?", &names),
            Some(("Allan", "what's left?"))
        );
        assert_eq!(
            addressed("okay Scout run it", &names),
            Some(("scout", "run it"))
        );
        assert_eq!(addressed("what's left", &names), None);
        assert_eq!(addressed("Atlas", &[]), None);
    }

    #[test]
    fn hears_farewells_but_not_requests_that_start_with_thanks() {
        assert!(is_farewell("Thanks."));
        assert!(is_farewell("thank you, Atlas"));
        assert!(is_farewell("That's all."));
        assert!(is_farewell("Thanks, that's all"));
        assert!(!is_farewell("Thanks, and can you rerun the failing test?"));
        assert!(!is_farewell("What failed?"));
        assert!(!is_farewell(""));
    }

    #[test]
    fn edit_distance_counts_single_edits() {
        assert_eq!(edit_distance("atlas", "atlis"), 1);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("", "abc"), 3);
    }
}
