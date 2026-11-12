//! Desk's askpass as a program of its own, for the tests: what Desk itself
//! does when ssh runs it as `SSH_ASKPASS` (`desk_machine::askpass::client`).

fn main() {
    #[cfg(unix)]
    {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(desk_machine::askpass::client(&prompt));
    }
    #[cfg(not(unix))]
    std::process::exit(1);
}
