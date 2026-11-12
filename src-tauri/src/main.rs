#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run by ssh as its askpass (a machine's password, a key's passphrase):
    // ask the Desk that ran it for the answer, print it, and end. Nothing of
    // the app starts.
    #[cfg(unix)]
    if std::env::var_os(desk_machine::askpass::SOCKET_ENV).is_some() {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(desk_machine::askpass::client(&prompt));
    }
    desk_lib::run()
}
