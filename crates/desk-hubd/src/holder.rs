//! Starting the PTY holder (`workforce pty-holder`) before the hub, so the
//! hub finds it and keeps its terminals and sessions in it. The holder is
//! left running when the hub restarts and when Desk is updated; one that
//! turns the hub away (another protocol, or a token from before the
//! secrets were reset) is replaced.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::Paths;
use desk_core::holder::{PROTOCOL, TOKEN_ENV};
use eyre::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::Command;

/// What a holder said to a hello.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// None is listening.
    Absent,
    Welcome,
    /// It refused, and why (another protocol, another token).
    Denied(String),
}

/// A frame of the holder's protocol: `[u32 length][u32 header length][header]`.
fn frame(header: &serde_json::Value) -> Vec<u8> {
    let header = serde_json::to_vec(header).expect("JSON");
    let mut out = Vec::with_capacity(8 + header.len());
    out.extend_from_slice(
        &u32::try_from(4 + header.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    out.extend_from_slice(
        &u32::try_from(header.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    out.extend_from_slice(&header);
    out
}

async fn hello(socket: &Path, token: &str) -> Result<Probe> {
    let Ok(mut stream) = UnixStream::connect(socket).await else {
        return Ok(Probe::Absent);
    };
    let hello = serde_json::json!({ "op": "hello", "version": PROTOCOL, "token": token });
    stream.write_all(&frame(&hello)).await?;
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let total = u32::from_be_bytes(len) as usize;
    if !(4..=64 * 1024).contains(&total) {
        eyre::bail!("the PTY holder answered with a frame of {total} bytes");
    }
    let mut body = vec![0u8; total];
    stream.read_exact(&mut body).await?;
    let header_len = u32::from_be_bytes(body[..4].try_into().expect("4 bytes")) as usize;
    let header: serde_json::Value = serde_json::from_slice(
        body.get(4..4 + header_len)
            .ok_or_else(|| eyre::eyre!("the PTY holder's answer is cut short"))?,
    )?;
    Ok(match header["op"].as_str() {
        Some("welcome") => Probe::Welcome,
        Some("denied") => Probe::Denied(header["error"].as_str().unwrap_or("refused").to_string()),
        other => eyre::bail!("the PTY holder answered {other:?}"),
    })
}

/// Says hello to the holder at `socket`, giving up after a few seconds.
pub async fn probe(socket: &Path, token: &str) -> Result<Probe> {
    tokio::time::timeout(Duration::from_secs(5), hello(socket, token))
        .await
        .map_err(|_| eyre::eyre!("the PTY holder didn't answer"))?
}

/// The holder's environment: only what a process needs to run, and its
/// token. Its terminals get theirs from the hub.
pub fn holder_env(env: &BTreeMap<String, String>, token: &str) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = ["PATH", "HOME", "USER", "LANG", "TMPDIR"]
        .into_iter()
        .filter_map(|k| Some((k.to_string(), env.get(k)?.clone())))
        .collect();
    out.insert("RUST_LOG".into(), "info".into());
    out.insert(TOKEN_ENV.into(), token.into());
    out
}

/// Makes sure a holder that takes `token` serves `socket`: one already
/// running is kept, one that turns the token or protocol down is stopped,
/// and a new one is started (`<workforce> pty-holder --socket <socket>`)
/// and waited for. Never stops the hub from starting: without a holder its
/// terminals run in the hub.
pub async fn ensure(
    workforce: &Path,
    paths: &Paths,
    socket: &Path,
    env: &BTreeMap<String, String>,
    token: &str,
) -> Result<()> {
    match probe(socket, token).await {
        Ok(Probe::Welcome) => return Ok(()),
        Ok(Probe::Denied(why)) => {
            tracing::warn!(reason = %why, "the PTY holder turns the hub away; replacing it");
            let socket = socket.to_path_buf();
            tokio::task::spawn_blocking(move || {
                desk_core::holder::stop(&socket, Duration::from_secs(10))
            })
            .await??;
        }
        Ok(Probe::Absent) => {}
        Err(e) => tracing::warn!(error = %e, "the PTY holder didn't say hello; starting one"),
    }
    let log = crate::append_log(&paths.logs().join("pty-holder.log"), crate::LOG_LIMIT)?;
    // No kill_on_drop: the holder outlives this process (it starts its own
    // session) and is never stopped with the hub.
    let mut child = Command::new(workforce)
        .arg("pty-holder")
        .arg("--socket")
        .arg(socket)
        .current_dir(paths.hub())
        .env_clear()
        .envs(holder_env(env, token))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .with_context(|| format!("starting the PTY holder ({})", workforce.display()))?;
    let pid = child.id();
    // Reaped when it ends, so it never lingers as a zombie.
    tokio::spawn(async move {
        let status = child.wait().await;
        tracing::info!(?pid, ?status, "PTY holder exited");
    });
    let start = Instant::now();
    loop {
        match probe(socket, token).await {
            Ok(Probe::Welcome) => {
                tracing::info!(?pid, socket = %socket.display(), "PTY holder ready");
                return Ok(());
            }
            Ok(Probe::Denied(why)) => eyre::bail!("the new PTY holder refused the hub: {why}"),
            _ if start.elapsed() > Duration::from_secs(10) => {
                eyre::bail!(
                    "the PTY holder didn't start listening on {}",
                    socket.display()
                )
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_holder_gets_only_what_it_needs_and_its_token() {
        let env = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/Users/k".to_string()),
            ("WORKFORCE_GATEWAY_TOKEN".to_string(), "gw".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "k".to_string()),
        ]);
        let out = holder_env(&env, "tok");
        assert_eq!(
            out.keys().map(String::as_str).collect::<Vec<_>>(),
            ["HOME", "PATH", "RUST_LOG", TOKEN_ENV]
        );
        assert_eq!(out[TOKEN_ENV], "tok");
    }

    /// A stand-in holder that answers one hello with `answer`.
    async fn holder_saying(answer: serde_json::Value) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("pty.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut len = [0u8; 4];
            s.read_exact(&mut len).await.unwrap();
            let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
            s.read_exact(&mut body).await.unwrap();
            let hello: serde_json::Value = serde_json::from_slice(&body[4..]).unwrap();
            assert_eq!(
                (hello["op"].as_str(), hello["version"].as_u64()),
                (Some("hello"), Some(1))
            );
            s.write_all(&frame(&answer)).await.unwrap();
        });
        (dir, socket)
    }

    #[tokio::test]
    async fn a_hello_tells_a_welcome_from_a_refusal() {
        let (_d, socket) =
            holder_saying(serde_json::json!({ "op": "welcome", "version": 1 })).await;
        assert_eq!(probe(&socket, "t").await.unwrap(), Probe::Welcome);
        let (_d, socket) = holder_saying(
            serde_json::json!({ "op": "denied", "error": "this holder speaks protocol 2, not 1" }),
        )
        .await;
        assert_eq!(
            probe(&socket, "t").await.unwrap(),
            Probe::Denied("this holder speaks protocol 2, not 1".into())
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            probe(&dir.path().join("none.sock"), "t").await.unwrap(),
            Probe::Absent
        );
    }
}
