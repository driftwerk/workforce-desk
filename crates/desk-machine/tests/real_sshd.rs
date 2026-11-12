//! Putting Desk's own key on a machine with its password, against real
//! `sshd`s and the system's real `ssh` and Desk's real askpass: the
//! prompts ssh really prints, which the fake can only imitate. Run by
//! `scripts/real-sshd.sh`, which starts the sshds (Docker) and writes the
//! SSH config this reads (`DESK_REAL_SSHD`); skipped without it.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use desk_core::machine::{Machine, MachineId, Target};
use desk_machine::own_key::{self, Problem, Prompted};
use desk_machine::secret::Secret;
use desk_machine::{SshExe, ssh};

/// The folder the script made: `config` (its Host entries), `ssh` (the
/// system's ssh with that config), and `own/id_ed25519` to come.
fn place() -> Option<PathBuf> {
    std::env::var_os("DESK_REAL_SSHD").map(PathBuf::from)
}

fn machine(target: &str) -> Machine {
    Machine {
        id: MachineId::new("real").unwrap(),
        name: target.into(),
        target: Target::new(target).unwrap(),
    }
}

fn exe(dir: &Path) -> SshExe {
    SshExe::at(dir.join("ssh")).with_own_key(dir.join("own").join("id_ed25519"))
}

fn prompted(ssh: &SshExe, m: &Machine) -> Prompted {
    let s = ssh::settings(ssh, m).unwrap();
    Prompted {
        user: s.user.clone().unwrap(),
        hostname: s.prompted_host().unwrap().to_string(),
        direct: s.via.is_none(),
    }
}

fn install(dir: &Path, target: &str, password: &str) -> Result<own_key::Installed, Problem> {
    let ssh = exe(dir);
    let m = machine(target);
    let public = own_key::ensure(ssh.own_key_file().unwrap()).unwrap();
    let p = prompted(&ssh, &m);
    let secret = Secret::new(zeroize::Zeroizing::new(password.to_string())).unwrap();
    own_key::install(
        &ssh,
        &m,
        &p,
        &public,
        secret,
        Path::new(env!("CARGO_BIN_EXE_desk-askpass")),
    )
}

/// Desk's key gets in now, with nothing to type.
fn reaches_with_own_key(dir: &Path, target: &str) -> bool {
    let ssh = exe(dir);
    ssh.uses_own_key(target, true);
    let out = ssh.output(&machine(target).reachable()).unwrap();
    out.status.success()
}

#[test]
#[ignore = "needs scripts/real-sshd.sh"]
fn a_password_puts_desks_key_there_on_real_sshds() {
    let Some(dir) = place() else { return };
    // Wrong first: said as wrong, not as keys only.
    assert_eq!(install(&dir, "pw", "wrong").unwrap_err(), Problem::Wrong);
    // Password authentication.
    install(&dir, "pw", "pw-target").unwrap();
    assert!(reaches_with_own_key(&dir, "pw"));
    // Keyboard-interactive through PAM only.
    install(&dir, "kbd", "pw-target").unwrap();
    assert!(reaches_with_own_key(&dir, "kbd"));
    // A Host entry with a HostKeyAlias.
    install(&dir, "alias", "pw-target").unwrap();
    assert!(reaches_with_own_key(&dir, "alias"));
    // Keys only: never asked.
    assert_eq!(
        install(&dir, "keys", "pw-target").unwrap_err(),
        Problem::KeysOnly
    );
    // Through a jump host that asks for its own password: refused there,
    // and the jump host never given the machine's.
    let jump = install(&dir, "behind", "pw-target").unwrap_err();
    assert!(
        matches!(jump, Problem::JumpHost | Problem::Other(_)),
        "{jump:?}"
    );
    assert_ne!(jump, Problem::KeysOnly, "never said as keys only");
}
