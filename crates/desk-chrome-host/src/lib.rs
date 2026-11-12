//! Desk Helper as Chrome's native messaging host: Chrome starts it for
//! Desk's extension, and it relays the extension's messages to the local
//! hub's `/ws/desk/chrome`, frame for frame, and the hub's back. It opens
//! no port, reads nothing but its own connection to the hub, and never
//! prints, logs or forwards the hub's token.
//!
//! Who it serves: only an extension id Desk ships (`allowed_origins`, and
//! the origin Chrome passes it), started by Google Chrome (its parent
//! process). Neither is proof (an extension's id is public, and a program
//! running as the person can start this one), so the hub also has the
//! person confirm each Chrome profile once, and each connection sign its
//! challenge with that profile's key (see the hub's `desk_chrome`).

pub mod manifest;
pub mod parent;
mod relay;

pub use relay::{Hub, run};

/// The host's name, as the extension's `connectNative` asks for it.
pub const HOST: &str = "xyz.driftwerk.desk";

/// The one path on the hub it opens.
pub const HUB_PATH: &str = "/ws/desk/chrome";

/// Desk's extension in the Chrome Web Store. Set from the store's
/// dashboard once the item exists (`extension/store/SUBMIT.md`); until then
/// only a development build reaches Chrome.
pub const STORE_ID: &str = "";

/// An unpacked development build's id, given at build time; never in a
/// release.
pub fn dev_id() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        option_env!("DESK_DEV_EXTENSION_ID").filter(|id| is_extension_id(id))
    } else {
        None
    }
}

/// The extension ids this build serves.
pub fn extension_ids() -> Vec<&'static str> {
    [Some(STORE_ID).filter(|id| is_extension_id(id)), dev_id()]
        .into_iter()
        .flatten()
        .collect()
}

/// Whether `id` reads as a Chrome extension id: 32 letters a to p.
pub fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// The origin Chrome passes the host for extension `id`.
pub fn origin_of(id: &str) -> String {
    format!("chrome-extension://{id}/")
}

/// Whether Chrome started this host for one of `ids`: the origin it passes
/// is the first argument.
pub fn called_by(first_arg: &str, ids: &[&str]) -> bool {
    ids.iter().any(|id| origin_of(id) == first_arg)
}

/// Whether the arguments are Chrome starting a native messaging host (the
/// caller's origin first) rather than anyone asking Desk Helper something.
pub fn is_chrome_launch(args: &[String]) -> bool {
    args.first()
        .is_some_and(|a| a.starts_with("chrome-extension://"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_desks_own_extension_is_served() {
        let id = "abcdefghijklmnopabcdefghijklmnop";
        assert!(is_extension_id(id));
        assert!(called_by(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            &[id]
        ));
        for other in [
            "chrome-extension://pppppppppppppppppppppppppppppppp/",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "https://evil.example/",
            "",
        ] {
            assert!(!called_by(other, &[id]), "{other}");
        }
        assert!(!called_by(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            &[]
        ));
        for bad in [
            "",
            "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "qbcdefghijklmnopabcdefghijklmnop",
            "abc",
        ] {
            assert!(!is_extension_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_release_serves_the_store_id_only() {
        // The store's id isn't known until the item exists: until then a
        // release serves nobody, and never a development id.
        if !cfg!(debug_assertions) {
            assert_eq!(dev_id(), None);
        }
        for id in extension_ids() {
            assert!(is_extension_id(id));
        }
    }

    #[test]
    fn chrome_launching_the_host_is_told_from_anyone_asking() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_chrome_launch(&args(&[
            "chrome-extension://abc/",
            "--parent-window=0"
        ])));
        assert!(!is_chrome_launch(&args(&["connection", "--json"])));
        assert!(!is_chrome_launch(&args(&[])));
    }

    #[test]
    fn the_host_opens_one_path_on_the_hub() {
        assert_eq!(HUB_PATH, "/ws/desk/chrome");
        assert_eq!(HOST, "xyz.driftwerk.desk");
    }
}
