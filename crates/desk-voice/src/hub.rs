//! The local hub, which holds the provider keys: it hands out realtime
//! sessions (`POST /api/desk/voice/session`) and speaks text in cloud
//! voices (`POST /api/desk/voice/speak`). The app's gateway token stays in
//! Rust.

use std::time::Duration;

use eyre::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::decode::{Audio, decode};
use crate::voices::VoiceSpec;

/// A way into one realtime session. `url` already carries the credential,
/// so it is never logged.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub token: String,
    pub expires_at: String,
    pub model: String,
    pub url: String,
}

pub trait Sessions: Send + Sync {
    fn grant(&self, engine: &str) -> Result<Grant>;
}

/// Why a cloud voice couldn't speak, worded for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeechError {
    /// The hub has no key for the provider (503); the message says where to add one.
    NoKey(String),
    /// The request itself was wrong (400): an unknown voice or model.
    Rejected(String),
    /// The provider refused or failed (502).
    Provider(String),
    /// The hub couldn't be reached, or answered with something unexpected.
    Hub(String),
}

impl std::fmt::Display for SpeechError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpeechError::NoKey(m)
            | SpeechError::Rejected(m)
            | SpeechError::Provider(m)
            | SpeechError::Hub(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SpeechError {}

/// Speech in a cloud voice.
pub trait CloudSpeech: Send + Sync {
    fn speak(&self, voice: &VoiceSpec, text: &str) -> std::result::Result<Audio, SpeechError>;
}

/// The local hub, reached with the app's gateway token.
pub struct Hub {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl Hub {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into();
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
            agent,
        }
    }

    fn post(
        &self,
        path: &str,
        body: String,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        self.agent
            .post(&format!("{}{path}", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .content_type("application/json")
            .send(body)
    }

    /// The key Desk keeps for a speech provider (`speech/<provider>/api_key`
    /// in the hub's vault, where Settings → Voices saves it); `None` when
    /// there's none. It is never logged.
    pub fn speech_key(&self, provider: &str) -> Result<Option<String>> {
        let mut response = self
            .agent
            .get(&format!(
                "{}/api/vault/speech/{provider}/api_key",
                self.base
            ))
            .header("Authorization", &format!("Bearer {}", self.token))
            .call()?;
        let status = response.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        let body = response.body_mut().read_to_string()?;
        if !status.is_success() {
            bail!(
                "Desk's hub wouldn't read the key ({status}): {}",
                refusal(&body)
            );
        }
        #[derive(Deserialize)]
        struct Entry {
            value: serde_json::Value,
        }
        let entry: Entry = serde_json::from_str(&body)?;
        Ok(entry
            .value
            .as_str()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(String::from))
    }
}

#[derive(Deserialize)]
struct Refusal {
    error: String,
}

/// The hub's `{"error": ...}`, or the body itself when it isn't that.
fn refusal(body: &str) -> String {
    serde_json::from_str::<Refusal>(body).map_or_else(|_| body.trim().to_string(), |r| r.error)
}

/// What the hub's speech endpoint said, as an error for the person.
pub fn speech_error(status: u16, body: &str) -> SpeechError {
    let message = refusal(body);
    match status {
        503 => SpeechError::NoKey(message),
        400 => SpeechError::Rejected(message),
        502 => SpeechError::Provider(message),
        _ => SpeechError::Hub(format!("the hub couldn't speak ({status}): {message}")),
    }
}

impl Sessions for Hub {
    fn grant(&self, engine: &str) -> Result<Grant> {
        let mut response = self.post(
            "/api/desk/voice/session",
            serde_json::json!({ "engine": engine }).to_string(),
        )?;
        let status = response.status();
        let body = response.body_mut().read_to_string()?;
        if !status.is_success() {
            bail!("the hub couldn't open a voice session: {}", refusal(&body));
        }
        Ok(serde_json::from_str(&body)?)
    }
}

#[derive(Serialize)]
struct SpeakRequest<'a> {
    #[serde(flatten)]
    voice: &'a VoiceSpec,
    text: &'a str,
}

const MAX_AUDIO_BYTES: u64 = 64 << 20;

impl CloudSpeech for Hub {
    fn speak(&self, voice: &VoiceSpec, text: &str) -> std::result::Result<Audio, SpeechError> {
        let body = serde_json::to_string(&SpeakRequest { voice, text })
            .map_err(|e| SpeechError::Hub(e.to_string()))?;
        let mut response = self
            .post("/api/desk/voice/speak", body)
            .map_err(|e| SpeechError::Hub(format!("couldn't reach Desk's hub: {e}")))?;
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_AUDIO_BYTES)
            .read_to_vec()
            .map_err(|e| SpeechError::Hub(e.to_string()))?;
        if !status.is_success() {
            return Err(speech_error(
                status.as_u16(),
                &String::from_utf8_lossy(&bytes),
            ));
        }
        decode(bytes, content_type.as_deref()).map_err(|e| SpeechError::Provider(format!("{e:#}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voices::Provider;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};

    struct Seen {
        head: String,
        body: String,
    }

    /// Answers one request with `status`, `content_type` and `body`.
    fn fake(status: u16, content_type: &str, body: Vec<u8>) -> (Hub, Receiver<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = channel();
        let content_type = content_type.to_string();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length = head
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut request = vec![0; length];
            reader.read_exact(&mut request).unwrap();
            let _ = tx.send(Seen {
                head,
                body: String::from_utf8(request).unwrap(),
            });
            let mut stream = reader.into_inner();
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        (Hub::new(base, "gateway-token"), rx)
    }

    fn fish() -> VoiceSpec {
        VoiceSpec {
            provider: Provider::FishAudio,
            model: Some("s1".into()),
            voice: Some("802e3bc2b27e49c2995d23ef70e6ac89".into()),
        }
    }

    #[test]
    fn speaks_through_the_hub_with_the_gateway_token() {
        let wav = crate::decode::wav(&[0.25; 2_400], 24_000, 1);
        let (hub, seen) = fake(200, "audio/wav", wav);
        let audio = hub.speak(&fish(), "Two tests failed.").unwrap();
        assert_eq!((audio.rate, audio.samples.len()), (24_000, 2_400));
        let seen = seen.recv().unwrap();
        assert!(seen.head.starts_with("POST /api/desk/voice/speak "));
        assert!(
            seen.head
                .to_lowercase()
                .contains("authorization: bearer gateway-token")
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen.body).unwrap(),
            serde_json::json!({
                "provider": "fish_audio", "model": "s1",
                "voice": "802e3bc2b27e49c2995d23ef70e6ac89", "text": "Two tests failed."
            })
        );
    }

    #[test]
    fn says_why_the_hub_couldnt_speak() {
        let no_key = r#"{"error":"Add a Fish Audio key under Plans to use this voice."}"#;
        let (hub, _) = fake(503, "application/json", no_key.into());
        assert_eq!(
            hub.speak(&fish(), "hi"),
            Err(SpeechError::NoKey(
                "Add a Fish Audio key under Plans to use this voice.".into()
            ))
        );
        let (hub, _) = fake(
            400,
            "application/json",
            r#"{"error":"unknown voice"}"#.into(),
        );
        assert_eq!(
            hub.speak(&fish(), "hi"),
            Err(SpeechError::Rejected("unknown voice".into()))
        );
        let (hub, _) = fake(
            502,
            "application/json",
            r#"{"error":"Fish Audio is down"}"#.into(),
        );
        assert_eq!(
            hub.speak(&fish(), "hi").unwrap_err().to_string(),
            "Fish Audio is down"
        );
        let (hub, _) = fake(500, "text/plain", "boom".into());
        assert!(
            matches!(hub.speak(&fish(), "hi"), Err(SpeechError::Hub(m)) if m.contains("500") && m.contains("boom"))
        );
        let (hub, _) = fake(200, "audio/mpeg", "not audio".into());
        assert!(matches!(
            hub.speak(&fish(), "hi"),
            Err(SpeechError::Provider(_))
        ));
    }

    #[test]
    fn reads_a_speech_key_from_the_vault() {
        let (hub, seen) = fake(
            200,
            "application/json",
            r#"{"path":"speech/fish_audio/api_key","value":"vault-key"}"#.into(),
        );
        assert_eq!(
            hub.speech_key("fish_audio").unwrap().as_deref(),
            Some("vault-key")
        );
        let seen = seen.recv().unwrap();
        assert!(
            seen.head
                .starts_with("GET /api/vault/speech/fish_audio/api_key ")
        );
        assert!(
            seen.head
                .to_lowercase()
                .contains("authorization: bearer gateway-token")
        );
        let (hub, _) = fake(404, "text/plain", Vec::new());
        assert_eq!(hub.speech_key("elevenlabs").unwrap(), None);
        let (hub, _) = fake(403, "application/json", r#"{"error":"no"}"#.into());
        assert!(hub.speech_key("elevenlabs").is_err());
    }

    #[test]
    fn an_unreachable_hub_is_said_plainly() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let hub = Hub::new(format!("http://127.0.0.1:{port}"), "t");
        assert!(
            matches!(hub.speak(&fish(), "hi"), Err(SpeechError::Hub(m)) if m.starts_with("couldn't reach"))
        );
    }
}
