//! Where realtime sessions come from: the local hub, which holds the
//! provider keys and hands out short-lived credentials
//! (`POST /api/desk/voice/session`).

use std::time::Duration;

use eyre::{Result, bail};
use serde::Deserialize;

/// A way into one session. `url` already carries the credential, so it is
/// never logged.
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

/// The local hub, reached with the app's gateway token.
pub struct HubSessions {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl HubSessions {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .into();
        Self {
            base: base.into(),
            token: token.into(),
            agent,
        }
    }
}

#[derive(Deserialize)]
struct Refusal {
    error: String,
}

impl Sessions for HubSessions {
    fn grant(&self, engine: &str) -> Result<Grant> {
        let url = format!("{}/api/desk/voice/session", self.base.trim_end_matches('/'));
        let mut response = self
            .agent
            .post(&url)
            .header("Authorization", &format!("Bearer {}", self.token))
            .content_type("application/json")
            .send(serde_json::json!({ "engine": engine }).to_string())?;
        let status = response.status();
        let body = response.body_mut().read_to_string()?;
        if !status.is_success() {
            let reason = serde_json::from_str::<Refusal>(&body).map_or(body, |r| r.error);
            bail!("the hub couldn't open a voice session: {reason}");
        }
        Ok(serde_json::from_str(&body)?)
    }
}
