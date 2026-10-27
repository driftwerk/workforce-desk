//! One realtime session's socket, on its own thread: get a grant from the
//! hub, connect, send the protocol's opening messages, then pass messages
//! both ways until either side ends it.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::time::Duration;

use eyre::Result;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::protocol::{Live, Protocol};
use crate::hub::Sessions;

/// How long a read waits before the thread looks for something to send.
const POLL: Duration = Duration::from_millis(10);

pub enum Outgoing {
    Text(String),
    Close,
}

pub struct Opening {
    pub sessions: Arc<dyn Sessions>,
    pub protocol: Arc<dyn Protocol>,
    pub names: Vec<String>,
    pub opened_by: Option<String>,
    pub voice: Option<String>,
}

/// Starts the session; what it reports goes to `report`, ending with
/// [`Live::Closed`].
pub fn open(opening: Opening, report: impl Fn(Live) + Send + 'static) -> Result<Sender<Outgoing>> {
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("voice-session".into())
        .spawn(move || {
            if let Err(e) = run(&opening, &rx, &report) {
                report(Live::Error(format!("{e:#}")));
            }
            report(Live::Closed);
        })?;
    Ok(tx)
}

fn run(opening: &Opening, rx: &Receiver<Outgoing>, report: &dyn Fn(Live)) -> Result<()> {
    let grant = opening.sessions.grant(opening.protocol.engine())?;
    let (mut ws, _) = tungstenite::connect(grant.url.as_str())
        .map_err(|e| eyre::eyre!("couldn't connect the voice session: {e}"))?;
    set_poll(&ws)?;
    for m in opening.protocol.start(
        &grant.model,
        &opening.names,
        opening.opened_by.as_deref(),
        opening.voice.as_deref(),
    ) {
        ws.send(Message::text(m))?;
    }
    loop {
        loop {
            match rx.try_recv() {
                Ok(Outgoing::Text(m)) => ws.send(Message::text(m))?,
                Ok(Outgoing::Close) | Err(TryRecvError::Disconnected) => {
                    if let Some(bye) = opening.protocol.close() {
                        let _ = ws.send(Message::text(bye));
                    }
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    return Ok(());
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => opening
                .protocol
                .parse(t.as_str())
                .into_iter()
                .for_each(report),
            Ok(Message::Binary(b)) => {
                if let Ok(t) = std::str::from_utf8(&b) {
                    opening.protocol.parse(t).into_iter().for_each(report);
                }
            }
            Ok(Message::Close(frame)) => {
                if let Some(f) = frame.filter(|f| !f.reason.is_empty()) {
                    report(Live::Error(format!(
                        "the voice session ended: {}",
                        f.reason
                    )));
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        }
    }
}

fn set_poll(ws: &WebSocket<MaybeTlsStream<TcpStream>>) -> Result<()> {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(POLL))?,
        MaybeTlsStream::Rustls(s) => s.get_ref().set_read_timeout(Some(POLL))?,
        _ => {}
    }
    Ok(())
}
