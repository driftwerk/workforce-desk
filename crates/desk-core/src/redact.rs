//! Takes secrets out of text before it leaves the Mac — the logs a person
//! saves into a report. The patterns are the hub's own (`common::redact`),
//! but a match is replaced whole: nothing of a secret, not even its first
//! characters, is kept.

use std::sync::LazyLock;

use regex::Regex;

pub const REDACTED: &str = "[redacted]";

const CREDENTIAL_KEYWORDS: &str = "api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|webhook[_-]?secret|apikey|authorization|password|passwd|secret|token";

/// Known formats, most specific first, then the keyword sweep that catches
/// vendors without a fixed prefix.
static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let env_credential = format!(
        r#"(?i)\b[a-z0-9_-]*?(?:{CREDENTIAL_KEYWORDS}|key)\b(\s*[=:]\s*['"]?)[a-zA-Z0-9._+/=_-]{{20,}}['"]?"#
    );
    let raw: Vec<String> = [
        r"sk-ant-oat[a-zA-Z0-9_-]{17,}",
        r"sk-ant-[a-zA-Z0-9_-]{20,}",
        r"sk-proj-[a-zA-Z0-9_-]{20,}",
        r"sk-or-v1-[a-zA-Z0-9]{32,}",
        r"sk-or-[a-zA-Z0-9]{20,}",
        r"sk-[a-zA-Z0-9]{20,}",
        r"pplx-[a-zA-Z0-9]{32,}",
        r"r8_[a-zA-Z0-9]{32,}",
        r"fw_[a-zA-Z0-9]{32,}",
        r"hf_[a-zA-Z0-9]{32,}",
        r"pa-[a-zA-Z0-9_-]{32,}",
        r"gsk_[a-zA-Z0-9]{20,}",
        r"AIza[a-zA-Z0-9_-]{35}",
        r"gh[opsu]_[a-zA-Z0-9]{36,}",
        r"github_pat_[a-zA-Z0-9_]{20,}",
        r"glpat-[a-zA-Z0-9_-]{20,}",
        r"xox[bpras]-[a-zA-Z0-9-]{20,}",
        r"xapp-[a-zA-Z0-9-]{20,}",
        r"lin_api_[a-zA-Z0-9]{20,}",
        r"ATATT[a-zA-Z0-9_-]{20,}",
        r"ntn_[a-zA-Z0-9]{30,}",
        r"secret_[a-zA-Z0-9]{43}",
        r"pat-(?:na1|eu1)-[a-f0-9-]{36}",
        r"ddapp_[a-zA-Z0-9]{20,}",
        r"phx_[A-Za-z0-9]{32,}",
        r"SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}",
        r"sntry[us]_[a-zA-Z0-9_]{60,}",
        r"\bAC[a-f0-9]{32}\b",
        r"\b[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b",
        r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b",
        r"1/\d{16}:[a-f0-9]{32}",
        r"do[oprt]_v1_[a-f0-9]{64}",
        r"BSA[a-zA-Z0-9_-]{20,}",
        r"wf[pr]_[a-zA-Z0-9_-]{20,}",
        r"(?:sk|rk)_(?:live|test)_[a-zA-Z0-9]{24,}",
        r"whsec_[a-zA-Z0-9]{32,}",
        r"AKIA[0-9A-Z]{16}",
        r#"(?i)aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?"#,
        r"AccountKey=[A-Za-z0-9+/=]{88}",
        r"AGE-SECRET-KEY-[A-Z0-9]{20,}",
        r"npm_[a-zA-Z0-9]{20,}",
        r"dckr_pat_[a-zA-Z0-9_-]{27,}",
        r"pypi-AgEIcHlwaS5vcmc[a-zA-Z0-9_-]{50,}",
        r"rubygems_[a-f0-9]{48}",
        r"eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+",
        r"(?i)\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{20,}",
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([env_credential])
    .collect();
    raw.iter()
        .map(|p| Regex::new(p).expect("redaction pattern"))
        .collect()
});

/// The password in a URL's userinfo: `postgres://user:pass@host`.
static URL_PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(://[^:/@\s]+:)[^@\s]+@").expect("url pattern"));

/// `text` with every secret the hub's patterns know replaced by
/// [`REDACTED`], and every exact `known` value too (Desk's own tokens and
/// keys, which have no recognisable shape). Known values shorter than 8
/// characters are ignored, so a stray short one can't blank the log.
pub fn redact(text: &str, known: &[String]) -> String {
    let mut out = text.to_string();
    let mut known: Vec<&String> = known.iter().filter(|k| k.len() >= 8).collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.len()));
    for k in known {
        out = out.replace(k.as_str(), REDACTED);
    }
    out = URL_PASSWORD
        .replace_all(&out, format!("${{1}}{REDACTED}@"))
        .into_owned();
    for p in PATTERNS.iter() {
        out = p
            .replace_all(&out, |c: &regex::Captures| {
                let whole = c.get(0).expect("match");
                match c.get(1) {
                    // The keyword sweep keeps `api_key=` and drops the value.
                    Some(sep) => {
                        format!("{}{REDACTED}", &whole.as_str()[..sep.end() - whole.start()])
                    }
                    None => REDACTED.to_string(),
                }
            })
            .into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_formats_are_replaced_whole() {
        let key = format!("sk-ant-api03-{}", "a".repeat(40));
        let pat = format!("ghp_{}", "B".repeat(36));
        let text = format!("using {key} and {pat} now");
        let out = redact(&text, &[]);
        assert_eq!(out, "using [redacted] and [redacted] now");
        assert!(!out.contains("sk-ant"));
        assert!(!out.contains("ghp_"));
    }

    #[test]
    fn a_keyword_keeps_its_name_and_loses_its_value() {
        let out = redact("WORKFORCE_VAULT_KEY: abcdefghijklmnopqrstuvwxyz0123", &[]);
        assert!(!out.contains("abcdefghij"), "{out}");
        let out = redact("api_key=Zm9vYmFyYmF6cXV4cXV1eHF1dXg", &[]);
        assert_eq!(out, "api_key=[redacted]");
    }

    #[test]
    fn desk_s_own_values_bearer_headers_and_url_passwords_go() {
        let token = "q3Y0bT1x-Nm2Lr9pZ8wVv7uU6tT5sS4rR3qQ2pP1oO0".to_string();
        let text = format!(
            "gateway {token}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\npostgres://postgres:hunter2hunter2@127.0.0.1:5432/workforce"
        );
        let out = redact(&text, &[token.clone(), "short".into()]);
        assert!(!out.contains(&token));
        assert!(!out.contains("abcdefghijklmnop"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains("postgres://postgres:[redacted]@127.0.0.1"));
    }

    #[test]
    fn ordinary_lines_are_left_alone() {
        let line = "2026-10-28T10:00:00Z INFO local hub starting gateway=http://127.0.0.1:61234";
        assert_eq!(redact(line, &[]), line);
    }
}
