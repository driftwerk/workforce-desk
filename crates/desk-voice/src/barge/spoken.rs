//! Numbers and symbols as they're said. A reply is written "failed at 3",
//! "$2.50", "2.1"; the recogniser hearing it come back writes what it heard,
//! "three", "two dollars fifty cents", "two point one", or the digits, as it
//! pleases. Both sides are put in these words before they're compared, so the
//! same thing said reads the same, and nothing else matches it.

/// `text` with each number, amount and symbol in the words it's said with.
pub(super) fn said(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        let next_is_digit = chars.get(i + 1).is_some_and(char::is_ascii_digit);
        let money = currency(c).filter(|_| next_is_digit);
        if money.is_some() || c.is_ascii_digit() {
            let start = i + usize::from(money.is_some());
            let (number, end) = Number::read(&chars, start);
            out.push(' ');
            out.push_str(&number.said(money));
            out.push(' ');
            i = end;
            continue;
        }
        match symbol(c) {
            Some(word) => {
                out.push(' ');
                out.push_str(word);
                out.push(' ');
            }
            None => out.push(c),
        }
        i += 1;
    }
    out
}

/// "and" where it only joins a number up, as in "one hundred and five" or
/// "two dollars and fifty cents": some say it and some don't.
pub(super) fn without_joining_and(words: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(words.len());
    for (i, word) in words.iter().enumerate() {
        let joins = word == "and"
            && out.last().is_some_and(|w| SCALES.contains(&w.as_str()))
            && words.get(i + 1).is_some_and(|w| is_number_word(w));
        if !joins {
            out.push(word.clone());
        }
    }
    out
}

/// A currency's name, one and many.
fn currency(c: char) -> Option<(&'static str, &'static str, &'static str)> {
    match c {
        '$' => Some(("dollar", "dollars", "cents")),
        '£' => Some(("pound", "pounds", "pence")),
        '€' => Some(("euro", "euros", "cents")),
        _ => None,
    }
}

fn symbol(c: char) -> Option<&'static str> {
    match c {
        '&' => Some("and"),
        '+' => Some("plus"),
        '@' => Some("at"),
        '=' => Some("equals"),
        '%' => Some("percent"),
        _ => None,
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
/// What a number's "and" may follow.
const SCALES: &[&str] = &[
    "hundred", "thousand", "million", "billion", "dollar", "dollars", "pound", "pounds", "euro",
    "euros",
];
/// The most digits read as one number; more are read one by one, as a code is.
const MAX_DIGITS: usize = 12;

fn is_number_word(word: &str) -> bool {
    ONES.contains(&word) || TENS[2..].contains(&word)
}

/// Whether `word` is part of how a number is said: "three", "hundred",
/// "point", "third".
pub(super) fn of_a_number(word: &str) -> bool {
    is_number_word(word)
        || matches!(
            word,
            "hundred" | "thousand" | "million" | "billion" | "point" | "oh"
        )
        || ONES[1..]
            .iter()
            .chain(&TENS[2..])
            .any(|n| ordinal(n) == word)
}

/// A number as written: its whole part, a time's minutes, what follows a point.
#[derive(Debug, Default)]
struct Number {
    whole: String,
    minutes: Option<String>,
    /// Each group after a point, "2.1.3" having two.
    points: Vec<String>,
    ordinal: bool,
    percent: bool,
}

impl Number {
    /// The number starting at `start`, a digit, and where it ends.
    fn read(chars: &[char], start: usize) -> (Self, usize) {
        let digits = |from: usize| {
            chars[from..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        };
        let mut number = Number {
            whole: digits(start),
            ..Self::default()
        };
        let mut i = start + number.whole.len();
        // Thousands separators: a comma and exactly three digits.
        while chars.get(i) == Some(&',') {
            let group = digits(i + 1);
            if group.len() != 3 {
                break;
            }
            number.whole.push_str(&group);
            i += 4;
        }
        if chars.get(i) == Some(&':') {
            let minutes = digits(i + 1);
            if minutes.len() == 2 {
                number.minutes = Some(minutes);
                i += 3;
            }
        }
        while number.minutes.is_none() && chars.get(i) == Some(&'.') {
            let group = digits(i + 1);
            if group.is_empty() {
                break;
            }
            i += 1 + group.len();
            number.points.push(group);
        }
        let suffix: String = chars[i..].iter().take(2).collect::<String>().to_lowercase();
        let ends_word = !chars.get(i + 2).is_some_and(|c| c.is_alphanumeric());
        if number.points.is_empty()
            && ends_word
            && matches!(suffix.as_str(), "st" | "nd" | "rd" | "th")
        {
            number.ordinal = true;
            i += 2;
        } else if chars.get(i) == Some(&'%') {
            number.percent = true;
            i += 1;
        }
        (number, i)
    }

    /// In words, as an amount of `money` if it's one.
    fn said(&self, money: Option<(&str, &str, &str)>) -> String {
        let mut words = whole(&self.whole);
        if let Some(minutes) = &self.minutes {
            match minutes.as_str() {
                "00" => {}
                m if m.starts_with('0') => {
                    words.push_str(" oh ");
                    words.push_str(&whole(&m[1..]));
                }
                m => {
                    words.push(' ');
                    words.push_str(&whole(m));
                }
            }
        }
        let cents = match (money, self.points.as_slice()) {
            (Some(_), [cents]) if cents.len() == 2 => Some(cents),
            _ => None,
        };
        if cents.is_none() {
            for group in &self.points {
                words.push_str(" point");
                for digit in group.chars() {
                    words.push(' ');
                    words.push_str(ONES[digit as usize - '0' as usize]);
                }
            }
        }
        if self.ordinal {
            words = ordinal(&words);
        }
        if let Some((one, many, hundredth)) = money {
            words.push(' ');
            words.push_str(if self.whole == "1" && self.points.is_empty() {
                one
            } else {
                many
            });
            if let Some(cents) = cents.filter(|c| *c != "00") {
                words.push(' ');
                words.push_str(&whole(cents));
                words.push(' ');
                words.push_str(hundredth);
            }
        }
        if self.percent {
            words.push_str(" percent");
        }
        words
    }
}

/// Digits as a whole number, or one by one past [`MAX_DIGITS`].
fn whole(digits: &str) -> String {
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return ONES[0].to_string();
    }
    match digits.parse::<u64>() {
        Ok(n) if digits.len() <= MAX_DIGITS => cardinal(n),
        _ => digits
            .chars()
            .map(|d| ONES[d as usize - '0' as usize])
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn cardinal(n: u64) -> String {
    const SCALE: [(u64, &str); 3] = [
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1_000, "thousand"),
    ];
    if n < 20 {
        return ONES[n as usize].to_string();
    }
    if n < 100 {
        let tens = TENS[(n / 10) as usize];
        return match n % 10 {
            0 => tens.to_string(),
            ones => format!("{tens} {}", ONES[ones as usize]),
        };
    }
    if n < 1_000 {
        let hundreds = format!("{} hundred", ONES[(n / 100) as usize]);
        return match n % 100 {
            0 => hundreds,
            rest => format!("{hundreds} {}", cardinal(rest)),
        };
    }
    let (scale, name) = SCALE
        .into_iter()
        .find(|(scale, _)| n >= *scale)
        .unwrap_or((1_000, "thousand"));
    let head = format!("{} {name}", cardinal(n / scale));
    match n % scale {
        0 => head,
        rest => format!("{head} {}", cardinal(rest)),
    }
}

/// "twenty one" as "twenty first".
fn ordinal(words: &str) -> String {
    let (head, last) = words.rsplit_once(' ').unwrap_or(("", words));
    let last = match last {
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        tens if tens.ends_with('y') => format!("{}ieth", &tens[..tens.len() - 1]),
        other => format!("{other}th"),
    };
    if head.is_empty() {
        last
    } else {
        format!("{head} {last}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tidy(text: &str) -> String {
        said(text).split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn numbers_are_said_as_words() {
        assert_eq!(tidy("at 3 today"), "at three today");
        assert_eq!(tidy("0"), "zero");
        assert_eq!(tidy("21 tests"), "twenty one tests");
        assert_eq!(tidy("1,234"), "one thousand two hundred thirty four");
        assert_eq!(tidy("2,000,000"), "two million");
        assert_eq!(tidy("version 2.1"), "version two point one");
        assert_eq!(tidy("v1.2.3"), "v one point two point three");
        assert_eq!(tidy("the 3rd and 21st"), "the third and twenty first");
        assert_eq!(tidy("the 40th"), "the fortieth");
        assert_eq!(
            tidy("at 3:30 or 3:05 or 3:00"),
            "at three thirty or three oh five or three"
        );
        assert_eq!(
            tidy("a 1234567890123 code"),
            "a one two three four five six seven eight nine zero one two three code"
        );
    }

    #[test]
    fn amounts_and_symbols_are_said_as_words() {
        assert_eq!(tidy("$5"), "five dollars");
        assert_eq!(tidy("$1"), "one dollar");
        assert_eq!(tidy("$2.50"), "two dollars fifty cents");
        assert_eq!(tidy("£3.00"), "three pounds");
        assert_eq!(tidy("€1.5"), "one point five euros");
        assert_eq!(tidy("10% & up"), "ten percent and up");
        assert_eq!(tidy("1+1=2"), "one plus one equals two");
        assert_eq!(tidy("$ alone"), "$ alone");
    }

    #[test]
    fn the_words_of_a_number_are_known() {
        for word in [
            "three",
            "fourteen",
            "ninety",
            "hundred",
            "point",
            "third",
            "twentieth",
        ] {
            assert!(of_a_number(word), "{word}");
        }
        for word in ["the", "tests", "dollars", "on"] {
            assert!(!of_a_number(word), "{word}");
        }
    }

    #[test]
    fn an_and_that_only_joins_a_number_goes() {
        let words =
            |text: &str| without_joining_and(text.split(' ').map(String::from).collect()).join(" ");
        assert_eq!(words("one hundred and five"), "one hundred five");
        assert_eq!(
            words("two dollars and fifty cents"),
            "two dollars fifty cents"
        );
        assert_eq!(words("tests and builds"), "tests and builds");
        assert_eq!(words("a hundred and then"), "a hundred and then");
    }
}
