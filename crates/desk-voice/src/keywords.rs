//! Agent names as keyword-spotter keywords: each name is turned into the
//! words someone would say, then into the spotter model's BPE tokens.

use std::collections::{HashMap, HashSet};

use eyre::{Result, bail};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// The words a name is spoken as, lowercase ASCII: `cc-auth-fix` →
/// `c c auth fix`, `DeepThought2` → `deep thought two`, `Zoë` → `zoe`.
/// Vowelless words are spelled out, as people say them.
pub fn spoken_words(name: &str) -> Vec<String> {
    let name = name.split('@').next().unwrap_or_default();
    let plain: String = name.nfkd().filter(|c| !is_combining_mark(*c)).collect();
    pieces(&plain)
        .into_iter()
        .flat_map(|p| {
            if p.chars().all(|c| c.is_ascii_digit()) {
                number_words(&p)
            } else if p.len() > 1 && !p.chars().any(|c| "aeiouy".contains(c)) {
                p.chars().map(String::from).collect()
            } else {
                vec![p]
            }
        })
        .collect()
}

/// Splits on anything that isn't an ASCII letter or digit, between letters
/// and digits, and at camel-case humps (`HTTPServer` → `http`, `server`).
fn pieces(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            push(&mut out, &mut cur);
            continue;
        }
        if let Some(&prev) = i.checked_sub(1).and_then(|j| chars.get(j)) {
            let next = chars.get(i + 1).copied();
            let kind_change =
                prev.is_ascii_digit() != c.is_ascii_digit() && prev.is_ascii_alphanumeric();
            let hump = prev.is_ascii_lowercase() && c.is_ascii_uppercase();
            let acronym_end = prev.is_ascii_uppercase()
                && c.is_ascii_uppercase()
                && next.is_some_and(|n| n.is_ascii_lowercase());
            if kind_change || hump || acronym_end {
                push(&mut out, &mut cur);
            }
        }
        cur.push(c.to_ascii_lowercase());
    }
    push(&mut out, &mut cur);
    out
}

fn push(out: &mut Vec<String>, cur: &mut String) {
    if !cur.is_empty() {
        out.push(std::mem::take(cur));
    }
}

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/// Numbers up to 999 the way they are said; longer runs (or ones with a
/// leading zero) digit by digit.
fn number_words(digits: &str) -> Vec<String> {
    let as_digits = || {
        digits
            .bytes()
            .map(|b| ONES[usize::from(b - b'0')].to_string())
            .collect()
    };
    if digits.len() > 3 || (digits.len() > 1 && digits.starts_with('0')) {
        return as_digits();
    }
    let n: usize = digits.parse().unwrap_or_default();
    let mut words = Vec::new();
    if n >= 100 {
        words.extend([ONES[n / 100], "hundred"]);
    }
    match n % 100 {
        0 if n >= 100 => {}
        r if r < 20 => words.push(ONES[r]),
        r => {
            words.push(TENS[r / 10]);
            if r % 10 != 0 {
                words.push(ONES[r % 10]);
            }
        }
    }
    words.into_iter().map(String::from).collect()
}

/// The wake model's SentencePiece tokenizer (a unigram model, despite the
/// file being called `bpe.model`), read from its `.model` file: enough to
/// spell a few words the way the model's own tokenizer would.
pub struct SentencePiece {
    scores: HashMap<String, f32>,
    longest: usize,
    unknown: f32,
}

const WORD_START: char = '\u{2581}';
const UNIGRAM: u64 = 1;

impl SentencePiece {
    pub fn parse(model: &[u8]) -> Result<Self> {
        let mut pieces = Vec::new();
        let mut kind = UNIGRAM;
        for field in Fields::new(model) {
            match field? {
                (1, Value::Bytes(piece)) => {
                    let (text, score, kind) = parse_piece(piece)?;
                    if matches!(kind, PIECE_NORMAL | PIECE_USER_DEFINED) {
                        pieces.push((text, score));
                    }
                }
                (2, Value::Bytes(trainer)) => kind = model_type(trainer)?.unwrap_or(UNIGRAM),
                _ => {}
            }
        }
        if kind != UNIGRAM {
            bail!("the wake model's tokenizer isn't a unigram model");
        }
        if pieces.is_empty() {
            bail!("no pieces in the tokenizer model");
        }
        Ok(Self::from_pieces(pieces))
    }

    pub fn from_pieces(pieces: impl IntoIterator<Item = (String, f32)>) -> Self {
        let scores: HashMap<String, f32> = pieces.into_iter().collect();
        let longest = scores.keys().map(|p| p.chars().count()).max().unwrap_or(1);
        let lowest = scores.values().copied().fold(0.0, f32::min);
        Self {
            scores,
            longest,
            unknown: lowest - 10.0,
        }
    }

    /// The most likely segmentation of each word into pieces (Viterbi).
    pub fn encode(&self, text: &str) -> Vec<String> {
        text.split_whitespace()
            .flat_map(|w| self.encode_word(w))
            .collect()
    }

    fn encode_word(&self, word: &str) -> Vec<String> {
        let chars: Vec<char> = std::iter::once(WORD_START).chain(word.chars()).collect();
        let mut best: Vec<Option<(f32, usize)>> = vec![None; chars.len() + 1];
        best[0] = Some((0.0, 0));
        for end in 1..=chars.len() {
            for start in end.saturating_sub(self.longest)..end {
                let Some((before, _)) = best[start] else {
                    continue;
                };
                let piece: String = chars[start..end].iter().collect();
                let score = match self.scores.get(&piece) {
                    Some(s) => *s,
                    None if end - start == 1 => self.unknown,
                    None => continue,
                };
                if best[end].is_none_or(|(b, _)| before + score > b) {
                    best[end] = Some((before + score, start));
                }
            }
        }
        let mut pieces = Vec::new();
        let mut end = chars.len();
        while end > 0 {
            let Some((_, start)) = best[end] else { break };
            pieces.push(chars[start..end].iter().collect());
            end = start;
        }
        pieces.reverse();
        pieces
    }
}

fn model_type(trainer: &[u8]) -> Result<Option<u64>> {
    for field in Fields::new(trainer) {
        if let (3, Value::Varint(v)) = field? {
            return Ok(Some(v));
        }
    }
    Ok(None)
}

const PIECE_NORMAL: u64 = 1;
const PIECE_USER_DEFINED: u64 = 4;

fn parse_piece(bytes: &[u8]) -> Result<(String, f32, u64)> {
    let (mut text, mut score, mut kind) = (String::new(), 0.0, PIECE_NORMAL);
    for field in Fields::new(bytes) {
        match field? {
            (1, Value::Bytes(b)) => text = String::from_utf8(b.to_vec())?,
            (2, Value::Fixed32(bits)) => score = f32::from_bits(bits),
            (3, Value::Varint(v)) => kind = v,
            _ => {}
        }
    }
    Ok((text, score, kind))
}

enum Value<'a> {
    Varint(u64),
    Fixed32(u32),
    Fixed64,
    Bytes(&'a [u8]),
}

/// The fields of one protobuf message, without a schema.
struct Fields<'a> {
    rest: &'a [u8],
}

impl<'a> Fields<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { rest: bytes }
    }

    fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let Some((&b, rest)) = self.rest.split_first() else {
                bail!("truncated varint")
            };
            self.rest = rest;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        bail!("varint too long")
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.rest.len() < n {
            bail!("truncated field");
        }
        let (head, rest) = self.rest.split_at(n);
        self.rest = rest;
        Ok(head)
    }

    fn field(&mut self) -> Result<(u64, Value<'a>)> {
        let key = self.varint()?;
        let value = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                self.take(8)?;
                Value::Fixed64
            }
            2 => {
                let n = usize::try_from(self.varint()?)?;
                Value::Bytes(self.take(n)?)
            }
            5 => Value::Fixed32(u32::from_le_bytes(self.take(4)?.try_into()?)),
            t => bail!("unsupported wire type {t}"),
        };
        Ok((key >> 3, value))
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = Result<(u64, Value<'a>)>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.rest.is_empty() {
            return None;
        }
        let field = self.field();
        if field.is_err() {
            self.rest = &[];
        }
        Some(field)
    }
}

/// The token symbols a model knows: the first column of its `tokens.txt`.
pub fn vocabulary(tokens_txt: &str) -> HashSet<String> {
    tokens_txt
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(String::from)
        .collect()
}

/// The roster as the spotter's keyword list. Each line ends `@<index>` so a
/// hit maps back to the name exactly as it was given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Keywords {
    pub lines: Vec<String>,
    names: Vec<String>,
}

impl Keywords {
    /// Names that can't be spelled in the model's tokens are left out (one
    /// unknown token would make the spotter reject the whole list), as are
    /// names that sound the same as one already listed.
    pub fn build(
        names: &[String],
        tokenizer: &SentencePiece,
        vocabulary: &HashSet<String>,
    ) -> Self {
        let mut seen = HashSet::new();
        let mut out = Self::default();
        for name in names {
            let words = spoken_words(name);
            if words.is_empty() || !seen.insert(words.clone()) {
                continue;
            }
            let tokens = tokenizer.encode(&words.join(" ").to_uppercase());
            if tokens.is_empty() || !tokens.iter().all(|t| vocabulary.contains(t)) {
                tracing::warn!(
                    name,
                    "can't listen for this name: the wake model can't spell it"
                );
                continue;
            }
            out.lines
                .push(format!("{} @{}", tokens.join(" "), out.names.len()));
            out.names.push(name.clone());
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn buffer(&self) -> String {
        self.lines.join("\n")
    }

    /// The name a spotted keyword (`"3"` from `@3`) stands for.
    pub fn name(&self, keyword: &str) -> Option<&str> {
        self.names
            .get(keyword.parse::<usize>().ok()?)
            .map(String::as_str)
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(name: &str) -> String {
        spoken_words(name).join(" ")
    }

    #[test]
    fn names_become_the_words_people_say() {
        assert_eq!(words("Atlas"), "atlas");
        assert_eq!(words("cc-auth-fix"), "c c auth fix");
        assert_eq!(words("DeepThought"), "deep thought");
        assert_eq!(words("HTTPServer"), "h t t p server");
        assert_eq!(words("Zoë"), "zoe");
        assert_eq!(words("  allan_the_great "), "allan the great");
        assert_eq!(words("R2D2"), "r two d two");
        assert_eq!(words("agent-42"), "agent forty two");
        assert_eq!(words("build-105"), "build one hundred five");
        assert_eq!(words("v007"), "v zero zero seven");
        assert_eq!(words("atlas@acme"), "atlas");
        assert_eq!(words("🤖"), "");
        assert_eq!(words("Ålesund"), "alesund");
    }

    #[test]
    fn numbers_read_naturally() {
        let n = |d: &str| number_words(d).join(" ");
        assert_eq!(n("0"), "zero");
        assert_eq!(n("13"), "thirteen");
        assert_eq!(n("40"), "forty");
        assert_eq!(n("300"), "three hundred");
        assert_eq!(n("999"), "nine hundred ninety nine");
        assert_eq!(n("2026"), "two zero two six");
    }

    fn toy() -> SentencePiece {
        let pieces = [
            ("▁", -2.0),
            ("▁L", -3.0),
            ("A", -3.0),
            ("Q", -4.0),
            ("T", -4.0),
            ("ICE", -4.0),
            ("▁LAT", -5.0),
            ("TICE", -3.0),
            ("▁LATT", -4.5),
        ];
        SentencePiece::from_pieces(pieces.into_iter().map(|(p, s)| (p.to_string(), s)))
    }

    #[test]
    fn picks_the_most_likely_segmentation() {
        assert_eq!(toy().encode("ATLAS"), ["▁LAT", "TICE"]);
        assert_eq!(toy().encode("LA ATLAS"), ["▁L", "A", "▁LAT", "TICE"]);
        assert_eq!(toy().encode("Q"), ["▁", "Q"]);
        assert_eq!(toy().encode("LAZ"), ["▁L", "A", "Z"]);
    }

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }

    fn piece(text: &str, score: f32, kind: u64) -> Vec<u8> {
        let mut p = vec![0x0a];
        varint(text.len() as u64, &mut p);
        p.extend(text.as_bytes());
        p.push(0x15);
        p.extend(score.to_le_bytes());
        p.push(0x18);
        varint(kind, &mut p);
        let mut field = vec![0x0a];
        varint(p.len() as u64, &mut field);
        field.extend(p);
        field
    }

    #[test]
    fn reads_pieces_from_a_sentencepiece_model() {
        let mut model = piece("<unk>", 0.0, 2);
        model.extend(piece("▁H", -1.0, 1));
        model.extend(piece("▁HE", -1.5, 1));
        model.extend(piece("LL", -2.0, 1));
        model.extend([0x12, 0x02, 0x18, 0x01]);
        let sp = SentencePiece::parse(&model).unwrap();
        assert_eq!(sp.scores.get("▁HE"), Some(&-1.5));
        assert!(!sp.scores.contains_key("<unk>"));
        assert_eq!(sp.encode("HELL"), ["▁HE", "LL"]);
        assert!(SentencePiece::parse(&[0x0a, 0x09]).is_err());
        let mut bpe_model = model.clone();
        bpe_model.extend([0x12, 0x02, 0x18, 0x02]);
        assert!(SentencePiece::parse(&bpe_model).is_err());
    }

    #[test]
    fn keywords_map_back_to_the_given_names() {
        let sp = toy();
        let vocab: HashSet<String> = ["▁LAT", "TICE", "▁L", "A", "▁", "Q"]
            .map(String::from)
            .into();
        let names = ["Atlas", "atlas", "Q", "Zed", "🤖", "la"].map(String::from);
        let k = Keywords::build(&names, &sp, &vocab);
        assert_eq!(k.lines, ["▁LAT TICE @0", "▁ Q @1", "▁L A @2"]);
        assert_eq!(k.name("0"), Some("Atlas"));
        assert_eq!(k.name("2"), Some("la"));
        assert_eq!(k.name("9"), None);
        assert_eq!(k.buffer(), "▁LAT TICE @0\n▁ Q @1\n▁L A @2");
        assert!(Keywords::build(&[], &sp, &vocab).is_empty());
    }

    #[test]
    fn vocabulary_is_the_first_column() {
        let v = vocabulary("<blk> 0\n▁HE 1\nLL 2\n");
        assert!(v.contains("▁HE") && v.contains("LL") && v.contains("<blk>"));
        assert_eq!(v.len(), 3);
    }
}
