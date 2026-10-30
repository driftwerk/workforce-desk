//! `%UserProfile%\.wslconfig`, changed only as far as Windows needs to reach
//! Desk inside WSL: `localhostForwarding=true` in `[wsl2]`.

/// The lines that let Windows reach a port bound inside WSL, as Help shows
/// them.
pub const FORWARDING: &str = "[wsl2]\nlocalhostForwarding=true";

fn is_section(line: &str) -> bool {
    let line = line.trim();
    line.starts_with('[') && line.ends_with(']')
}

fn key_of(line: &str) -> Option<String> {
    let (key, _) = line.split_once('=')?;
    Some(key.trim().to_ascii_lowercase())
}

/// `text` with localhost forwarding turned on in `[wsl2]`, everything else
/// as it was (its line endings too).
pub fn with_localhost_forwarding(text: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let wanted = "localhostForwarding=true".to_string();
    let section = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("[wsl2]"));
    match section {
        Some(start) => {
            let end = lines[start + 1..]
                .iter()
                .position(|l| is_section(l))
                .map_or(lines.len(), |i| start + 1 + i);
            match (start + 1..end)
                .find(|&i| key_of(&lines[i]).as_deref() == Some("localhostforwarding"))
            {
                Some(i) => lines[i] = wanted,
                None => lines.insert(start + 1, wanted),
            }
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.extend(FORWARDING.lines().map(str::to_string));
        }
    }
    let mut out = lines.join(newline);
    out.push_str(newline);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_gets_the_section() {
        assert_eq!(
            with_localhost_forwarding(""),
            "[wsl2]\nlocalhostForwarding=true\n"
        );
    }

    #[test]
    fn an_existing_setting_is_turned_on_and_the_rest_kept() {
        let before = "[wsl2]\r\nmemory=8GB\r\nlocalhostForwarding = false\r\n\r\n[experimental]\r\nsparseVhd=true\r\n";
        assert_eq!(
            with_localhost_forwarding(before),
            "[wsl2]\r\nmemory=8GB\r\nlocalhostForwarding=true\r\n\r\n[experimental]\r\nsparseVhd=true\r\n"
        );
    }

    #[test]
    fn the_setting_goes_into_the_wsl2_section_not_another() {
        let before = "[experimental]\nlocalhostForwarding=false\n[WSL2]\nmemory=8GB\n";
        assert_eq!(
            with_localhost_forwarding(before),
            "[experimental]\nlocalhostForwarding=false\n[WSL2]\nlocalhostForwarding=true\nmemory=8GB\n"
        );
        assert_eq!(
            with_localhost_forwarding("[boot]\nsystemd=true\n"),
            "[boot]\nsystemd=true\n\n[wsl2]\nlocalhostForwarding=true\n"
        );
    }
}
