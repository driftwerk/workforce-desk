//! What the two realtime APIs say, mapped to one vocabulary. Pure: messages
//! in, events out, so the mapping is tested against the providers' own
//! documented payloads.

use serde_json::{Value, json};

/// The one tool a realtime model gets: hand a request to a Desk agent.
pub const ASK_AGENT: &str = "ask_agent";

/// A request the model handed to an agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub id: String,
    pub agent: Option<String>,
    pub request: String,
}

/// What a realtime session reported.
#[derive(Debug, Clone, PartialEq)]
pub enum Live {
    /// Configured; audio may flow.
    Ready,
    /// Speech to play, PCM16 LE at the protocol's output rate.
    Audio(Vec<u8>),
    /// The user talked over the model: drop what's queued.
    Interrupted,
    /// Part of what the user said, transcribed by the provider.
    Heard(String),
    Call(Call),
    /// Calls the model no longer wants answered.
    Cancelled(Vec<String>),
    /// A problem the session survives.
    Error(String),
    /// The provider ended the session.
    Closed,
}

/// One realtime API's wire format.
pub trait Protocol: Send + Sync + 'static {
    /// The engine name the hub grants sessions for.
    fn engine(&self) -> &'static str;
    /// The rate of the audio the model sends back.
    fn output_rate(&self) -> u32;
    /// What to send first, before any audio.
    fn start(&self, model: &str, names: &[String], opened_by: Option<&str>) -> Vec<String>;
    /// 16 kHz microphone audio.
    fn audio(&self, samples: &[f32]) -> String;
    /// The microphone stopped (push-to-talk released).
    fn audio_end(&self) -> Option<String>;
    /// Something Desk wants the model to tell the user.
    fn say(&self, text: &str) -> String;
    fn tool_result(&self, call_id: &str, text: &str) -> Vec<String>;
    /// A graceful goodbye before the socket closes.
    fn close(&self) -> Option<String>;
    fn parse(&self, message: &str) -> Vec<Live>;
}

/// How the request reaches an agent, in the model's own terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandOff {
    /// The model calls `ask_agent` itself (Gemini).
    Tool,
    /// The model delegates to a backend that calls `ask_agent` (GPT-Live).
    Delegate,
}

/// How the model should behave.
pub fn instructions(names: &[String], opened_by: Option<&str>, hand_off: HandOff) -> String {
    let roster = if names.is_empty() {
        "The user's agents aren't known yet; use the name the user says.".to_string()
    } else {
        format!("Their agents are: {}.", names.join(", "))
    };
    let opener = opened_by.map_or(String::new(), |a| format!(" The user just addressed {a}."));
    let how = match hand_off {
        HandOff::Tool => format!(
            "Hand every request, question or follow-up for an agent to the {ASK_AGENT} tool: the \
             agent's exact name and the request in the user's own words."
        ),
        HandOff::Delegate => "Delegation policy: delegate every request, question or follow-up \
             for an agent to the backend, which passes it to that agent and returns its answer."
            .to_string(),
    };
    format!(
        "You are the voice of Desk, which connects the user to their AI agents. {roster}{opener} \
         {how} Never answer for an agent yourself. If the user doesn't name an agent, it is for \
         the one they last addressed. While an agent works, say briefly that it's on it. When \
         its answer arrives, give the user the gist in a sentence or two; the details stay on \
         screen in Desk. Keep your own replies short and stop talking when the user interrupts. \
         If the user says thanks or that's all, just say goodbye."
    )
}

/// The `ask_agent` arguments as a JSON Schema; `upper` spells types the
/// way Gemini's schema does.
pub fn ask_agent_parameters(names: &[String], upper: bool) -> Value {
    let t = |name: &str| {
        if upper {
            name.to_uppercase()
        } else {
            name.to_string()
        }
    };
    let mut agent =
        json!({ "type": t("string"), "description": "The agent's name, exactly as listed." });
    if !names.is_empty() {
        agent["enum"] = json!(names);
        if upper {
            agent["format"] = json!("enum");
        }
    }
    let mut schema = json!({
        "type": t("object"),
        "properties": {
            "agent": agent,
            "request": { "type": t("string"), "description": "What the user asked, in their words." },
        },
        "required": ["agent", "request"],
    });
    if !upper {
        schema["additionalProperties"] = json!(false);
    }
    schema
}

pub const ASK_AGENT_DESCRIPTION: &str =
    "Send the user's request to one of their Desk agents and get its answer.";

/// `ask_agent`'s arguments, however the provider encoded them.
pub fn call(id: &str, args: &Value) -> Option<Call> {
    let args = match args {
        Value::String(s) => serde_json::from_str(s).ok()?,
        other => other.clone(),
    };
    let request = args.get("request")?.as_str()?.trim().to_string();
    let agent = args
        .get("agent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(String::from);
    Some(Call {
        id: id.to_string(),
        agent,
        request,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_lists_the_roster() {
        let names = ["Atlas".to_string(), "Allan".to_string()];
        let s = ask_agent_parameters(&names, false);
        assert_eq!(
            s["properties"]["agent"]["enum"],
            json!(["Atlas", "Allan"])
        );
        assert_eq!(s["additionalProperties"], json!(false));
        assert_eq!(s["required"], json!(["agent", "request"]));
        let g = ask_agent_parameters(&names, true);
        assert_eq!(g["type"], "OBJECT");
        assert_eq!(g["properties"]["agent"]["format"], "enum");
        assert!(g.get("additionalProperties").is_none());
    }

    #[test]
    fn an_empty_roster_has_no_enum() {
        let s = ask_agent_parameters(&[], false);
        assert!(s["properties"]["agent"].get("enum").is_none());
    }

    #[test]
    fn reads_arguments_as_json_text_or_an_object() {
        let want = Call {
            id: "c1".into(),
            agent: Some("Atlas".into()),
            request: "what failed overnight?".into(),
        };
        let text = json!(r#"{"agent":"Atlas","request":" what failed overnight? "}"#);
        assert_eq!(call("c1", &text), Some(want.clone()));
        let object = json!({"agent": "Atlas", "request": "what failed overnight?"});
        assert_eq!(call("c1", &object), Some(want));
        assert_eq!(
            call("c2", &json!({"agent": "", "request": "hi"}))
                .unwrap()
                .agent,
            None
        );
        assert_eq!(call("c3", &json!({"agent": "x"})), None);
    }

    #[test]
    fn instructions_name_the_roster_and_who_woke_it() {
        let names = ["Atlas".into(), "Allan".into()];
        let tool = instructions(&names, None, HandOff::Tool);
        assert!(tool.contains(ASK_AGENT) && !tool.contains("just addressed"));
        let delegate = instructions(&names, Some("Atlas"), HandOff::Delegate);
        assert!(delegate.contains("Delegation policy") && !delegate.contains(ASK_AGENT));
        let i = instructions(&names, Some("Atlas"), HandOff::Tool);
        assert!(
            i.contains("Atlas, Allan")
                && i.contains("just addressed Atlas")
                && i.contains(ASK_AGENT)
        );
    }
}
