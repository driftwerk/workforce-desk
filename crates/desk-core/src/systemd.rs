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

/// A word or value that can go in a unit: no line breaks or other control
/// characters, which would end its line and start one of their own.
fn plain(what: &str) -> eyre::Result<&str> {
    match what.chars().find(|c| c.is_control()) {
        Some(c) => eyre::bail!("{what:?} can't go in a systemd unit (it holds {c:?})"),
        None => Ok(what),
    }
}

/// The systemd user service that runs Desk Helper from login (or, with
/// linger, from boot), restarting it as launchd's KeepAlive does. When the
/// helper stops — an update's flip, a crash — systemd stops only it: the
/// helper stops the hub, the memory store and Postgres itself, and the PTY
/// holder it leaves keeps the sessions' terminals for the next one, as on
/// macOS. (By default systemd would end everything the service started.)
/// It is restarted however often it stops: no start limit gives up on it.
pub fn unit_text(unit: &Unit) -> eyre::Result<String> {
    let command = std::iter::once(&unit.program)
        .chain(&unit.args)
        .map(|w| plain(w).map(word))
        .collect::<eyre::Result<Vec<_>>>()?
        .join(" ");
    let environment: String = unit
        .env
        .iter()
        .map(|(k, v)| plain(&format!("{k}={v}")).map(|kv| format!("Environment={}\n", value(kv))))
        .collect::<eyre::Result<_>>()?;
    Ok(format!(
        "[Unit]\n\
         Description=Desk Helper: keeps Desk's agents and sessions running\n\
         StartLimitIntervalSec=0\n\
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
    ))
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
        })
        .unwrap();
        assert!(text.contains(
            "ExecStart=\"/home/dev/.local/share/Desk/bin/current/desk-helper\" \"--machine\"\n\
             Environment=\"DESK_PERSON_NAME=Sarah O'Neil\"\n\
             Environment=\"DESK_PERSON_EMAIL=sarah@example.com\"\n\
             Restart=always\n"
        ));
        assert!(text.ends_with("[Install]\nWantedBy=default.target\n"));
        assert!(text.contains("StartLimitIntervalSec=0\n"));
    }

    #[test]
    fn a_line_break_or_control_character_is_refused() {
        let unit = |program: &str, v: &str| Unit {
            program: program.into(),
            args: vec![],
            env: vec![("DESK_PERSON_NAME".into(), v.into())],
        };
        assert!(unit_text(&unit("/x/desk-helper", "Ana\nExecStartPre=/bin/evil")).is_err());
        assert!(unit_text(&unit("/x/desk-helper", "Ana\r")).is_err());
        assert!(unit_text(&unit("/x/desk\u{1b}helper", "Ana")).is_err());
        assert!(unit_text(&unit("/x/desk-helper", "Ana Lima-Ó'Neil")).is_ok());
    }
}
