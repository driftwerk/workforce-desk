//! A voice someone enters by its id (a cloned or community voice), looked
//! up with the provider so Desk can name it — or say plainly that it isn't
//! there, or that the key can't read it. Only providers whose voices are
//! open-ended ids take one: Fish Audio (`GET /model/{id}`) and ElevenLabs
//! (`GET /v1/voices/{id}`). The key is the one Desk keeps in the local
//! hub's vault; it stays in Rust and is never logged.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::voices::Provider;

/// What the provider said about a voice id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Lookup {
    Found {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    /// The provider has no voice with that id (or none this key may see).
    NotFound,
    /// Desk keeps no key for the provider.
    NoKey,
    /// The provider refused the key, or the key may not read voices; the
    /// provider's own words when it gives them.
    KeyRefused { message: String },
    /// Anything else: the provider unreachable or answering oddly.
    Failed { message: String },
}

/// The providers whose voices are open-ended ids anyone can enter.
pub fn takes_custom_ids(provider: Provider) -> bool {
    matches!(provider, Provider::FishAudio | Provider::Elevenlabs)
}

/// The provider's name in the vault path of its key
/// (`speech/<name>/api_key`).
pub fn key_name(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::FishAudio => Some("fish_audio"),
        Provider::Elevenlabs => Some("elevenlabs"),
        Provider::Openai => Some("openai"),
        _ => None,
    }
}

/// An id that is safe to put in a request path: letters, digits, `-` and
/// `_`, at most 64 — real Fish Audio and ElevenLabs ids, and the same rule
/// the hub applies before speaking with one.
pub fn plausible_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Where each provider is asked; tests point these at a fake.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub fish_audio: String,
    pub elevenlabs: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            fish_audio: "https://api.fish.audio".into(),
            elevenlabs: "https://api.elevenlabs.io".into(),
        }
    }
}

/// Asks `provider` for voice `id` with `key`.
pub fn lookup(endpoints: &Endpoints, provider: Provider, id: &str, key: &str) -> Lookup {
    let id = id.trim();
    if !takes_custom_ids(provider) {
        return Lookup::Failed {
            message: "this provider's voices can't be added by id".into(),
        };
    }
    if !plausible_id(id) {
        return Lookup::NotFound;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .into();
    let request = match provider {
        Provider::FishAudio => agent
            .get(&format!("{}/model/{id}", endpoints.fish_audio))
            .header("Authorization", &format!("Bearer {key}")),
        _ => agent
            .get(&format!("{}/v1/voices/{id}", endpoints.elevenlabs))
            .header("xi-api-key", key),
    };
    let mut response = match request.call() {
        Ok(r) => r,
        Err(e) => {
            return Lookup::Failed {
                message: format!("couldn't reach {}: {e}", label(provider)),
            };
        }
    };
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().unwrap_or_default();
    judge(provider, status, &body)
}

fn label(provider: Provider) -> &'static str {
    match provider {
        Provider::FishAudio => "Fish Audio",
        Provider::Elevenlabs => "ElevenLabs",
        _ => "the provider",
    }
}

#[derive(Deserialize)]
struct FishModel {
    title: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct ElevenVoice {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    labels: std::collections::BTreeMap<String, serde_json::Value>,
}

/// The provider's own words in an error body: ElevenLabs'
/// `{"detail": {"message"}}` or `{"detail": "…"}`, Fish Audio's
/// `{"message"}`.
fn said(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let detail = &v["detail"];
    [&detail["message"], detail, &v["message"]]
        .into_iter()
        .find_map(|m| m.as_str().map(str::trim).filter(|m| !m.is_empty()))
        .map(String::from)
}

fn blank_to_none(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// What an answer means. Unknown ids come back as 404 (Fish Audio, and
/// ElevenLabs today) or as a 400/422 naming `voice_not_found` (ElevenLabs'
/// older answer); 401/403 is the key.
fn judge(provider: Provider, status: u16, body: &str) -> Lookup {
    let named = label(provider);
    match status {
        200..=299 => {
            let found = match provider {
                Provider::FishAudio => serde_json::from_str::<FishModel>(body)
                    .ok()
                    .map(|m| (blank_to_none(m.title), blank_to_none(m.description))),
                _ => serde_json::from_str::<ElevenVoice>(body).ok().map(|v| {
                    let description = blank_to_none(v.description).or_else(|| {
                        let labels: Vec<&str> = ["gender", "age", "accent", "description"]
                            .iter()
                            .filter_map(|k| v.labels.get(*k)?.as_str())
                            .filter(|s| !s.trim().is_empty())
                            .collect();
                        (!labels.is_empty()).then(|| labels.join(", "))
                    });
                    (blank_to_none(v.name), description)
                }),
            };
            match found {
                Some((Some(name), description)) => Lookup::Found { name, description },
                _ => Lookup::Failed {
                    message: format!("{named} answered, but not with a voice Desk could read"),
                },
            }
        }
        404 => Lookup::NotFound,
        400 | 422 if body.contains("not_found") || body.contains("not found") => Lookup::NotFound,
        401 | 403 => Lookup::KeyRefused {
            message: said(body).unwrap_or_else(|| format!("{named} refused the key ({status})")),
        },
        _ => Lookup::Failed {
            message: format!(
                "{named} couldn't look that voice up ({status}){}",
                said(body).map(|m| format!(": {m}")).unwrap_or_default()
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};

    /// Answers one request with `status` and `body`; hands back its head.
    fn fake(status: u16, body: &str) -> (Endpoints, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = channel();
        let body = body.to_string();
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
            let _ = tx.send(head);
            let mut stream = reader.into_inner();
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        (
            Endpoints {
                fish_audio: base.clone(),
                elevenlabs: base,
            },
            rx,
        )
    }

    #[test]
    fn a_fish_audio_voice_is_named_with_its_title() {
        let (at, seen) = fake(
            200,
            r#"{"_id":"abc123","title":"Narrator","description":"Deep and slow","tags":["male"]}"#,
        );
        assert_eq!(
            lookup(&at, Provider::FishAudio, "abc123", "test-key"),
            Lookup::Found {
                name: "Narrator".into(),
                description: Some("Deep and slow".into())
            }
        );
        let head = seen.recv().unwrap();
        assert!(head.starts_with("GET /model/abc123 "));
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer test-key")
        );
    }

    #[test]
    fn an_elevenlabs_voice_is_named_and_described_by_its_labels() {
        let (at, seen) = fake(
            200,
            r#"{"voice_id":"Xb7hH8MSUJpSbSDYk0k2","name":"Alice","description":null,"labels":{"gender":"female","accent":"british"}}"#,
        );
        assert_eq!(
            lookup(
                &at,
                Provider::Elevenlabs,
                "Xb7hH8MSUJpSbSDYk0k2",
                "test-key"
            ),
            Lookup::Found {
                name: "Alice".into(),
                description: Some("female, british".into())
            }
        );
        let head = seen.recv().unwrap();
        assert!(head.starts_with("GET /v1/voices/Xb7hH8MSUJpSbSDYk0k2 "));
        assert!(head.to_lowercase().contains("xi-api-key: test-key"));
    }

    #[test]
    fn an_unknown_id_is_not_found() {
        let (at, _) = fake(404, r#"{"status":404,"message":"Model not found"}"#);
        assert_eq!(
            lookup(&at, Provider::FishAudio, "0000", "k"),
            Lookup::NotFound
        );
        let (at, _) = fake(
            400,
            r#"{"detail":{"status":"voice_not_found","message":"A voice with that id was not found."}}"#,
        );
        assert_eq!(
            lookup(&at, Provider::Elevenlabs, "nope", "k"),
            Lookup::NotFound
        );
    }

    #[test]
    fn a_refused_key_is_said_in_the_providers_words() {
        let (at, _) = fake(
            401,
            r#"{"detail":{"status":"missing_permissions","message":"The API key is missing the permission voices_read."}}"#,
        );
        assert_eq!(
            lookup(&at, Provider::Elevenlabs, "abc", "k"),
            Lookup::KeyRefused {
                message: "The API key is missing the permission voices_read.".into()
            }
        );
        let (at, _) = fake(403, "");
        assert!(matches!(
            lookup(&at, Provider::FishAudio, "abc", "k"),
            Lookup::KeyRefused { message } if message.contains("403")
        ));
    }

    #[test]
    fn an_id_that_isnt_one_is_never_sent() {
        // Nothing listens here: a request would fail, not come back NotFound.
        let nowhere = Endpoints {
            fish_audio: "http://127.0.0.1:9".into(),
            elevenlabs: "http://127.0.0.1:9".into(),
        };
        for id in ["", "../v1/user", "a b", "x?y=1", &"a".repeat(65)] {
            assert_eq!(
                lookup(&nowhere, Provider::Elevenlabs, id, "k"),
                Lookup::NotFound,
                "{id}"
            );
        }
        assert!(matches!(
            lookup(&nowhere, Provider::Openai, "alloy", "k"),
            Lookup::Failed { .. }
        ));
    }

    #[test]
    fn serialises_for_the_page() {
        assert_eq!(
            serde_json::to_value(Lookup::Found {
                name: "Alice".into(),
                description: None
            })
            .unwrap(),
            serde_json::json!({"state": "found", "name": "Alice"})
        );
        assert_eq!(
            serde_json::to_value(Lookup::NoKey).unwrap(),
            serde_json::json!({"state": "no-key"})
        );
        assert_eq!(
            serde_json::to_value(Lookup::KeyRefused {
                message: "m".into()
            })
            .unwrap(),
            serde_json::json!({"state": "key-refused", "message": "m"})
        );
    }
}
