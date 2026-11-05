//! Desk Helper's systemd user service, as the text of its unit: written on
//! a Linux desktop for the person's own login, and on a machine (a Linux
//! box Desk drives over SSH) by the app on the Mac, which can't run
//! systemd itself.

/// The service's name, and its file's.
pub const UNIT: &str = "desk-helper.service";

/// What the service runs, and with what added to its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    pub program: String,
    pub args: Vec<String>,
    /// `Environment=` lines, in order.
    pub env: Vec<(String, String)>,
}

/// A value in a systemd unit, quoted: `%` is a specifier there.
pub fn value(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// A word of a systemd command line, quoted: `$` expands there too.
pub fn word(word: &str) -> String {
    value(&word.replace('$', "$$"))
}

/// The systemd user service that runs Desk Helper from login (or, with
/// linger, from boot), restarting it as launchd's KeepAlive does. When the
/// helper stops — an update's flip, a crash — systemd stops only it: the
/// helper stops the hub, the memory store and Postgres itself, and the PTY
/// holder it leaves keeps the sessions' terminals for the next one, as on
/// macOS. (By default systemd would end everything the service started.)
pub fn unit_text(unit: &Unit) -> String {
    let command = std::iter::once(word(&unit.program))
        .chain(unit.args.iter().map(|a| word(a)))
        .collect::<Vec<_>>()
        .join(" ");
    let environment: String = unit
        .env
        .iter()
        .map(|(k, v)| format!("Environment={}\n", value(&format!("{k}={v}"))))
        .collect();
    format!(
        "[Unit]\n\
         Description=Desk Helper: keeps Desk's agents and sessions running\n\
         \n\
         [Service]\n\
         ExecStart={command}\n\
         {environment}\
         Restart=always\n\
         RestartSec=2\n\
         TimeoutStopSec=90\n\
         KillMode=process\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odd_characters_are_quoted() {
        assert_eq!(word(r#"/a/100% "b"$c\d"#), r#""/a/100%% \"b\"$$c\\d""#);
        assert_eq!(value("A=50% $x"), r#""A=50%% $x""#);
    }

    #[test]
    fn each_variable_has_its_own_line_after_the_command() {
        let text = unit_text(&Unit {
            program: "/home/dev/.local/share/Desk/bin/current/desk-helper".into(),
            args: vec!["--machine".into()],
            env: vec![
                ("DESK_PERSON_NAME".into(), "Sarah O'Neil".into()),
                ("DESK_PERSON_EMAIL".into(), "sarah@example.com".into()),
            ],
        });
        assert!(text.contains(
            "ExecStart=\"/home/dev/.local/share/Desk/bin/current/desk-helper\" \"--machine\"\n\
             Environment=\"DESK_PERSON_NAME=Sarah O'Neil\"\n\
             Environment=\"DESK_PERSON_EMAIL=sarah@example.com\"\n\
             Restart=always\n"
        ));
        assert!(text.ends_with("[Install]\nWantedBy=default.target\n"));
    }
}
