//! OpenAI GPT-Live over its primary WebSocket, with Responses delegation:
//! the backend model's only tool is `ask_agent`, which Desk answers.
//! <https://developers.openai.com/api/docs/guides/live-delegation>

use serde_json::{Value, json};

use super::pcm;
use super::protocol::{
    ASK_AGENT, ASK_AGENT_DESCRIPTION, HandOff, Live, Protocol, ask_agent_parameters, call,
    instructions,
};
use crate::resample::SPEECH_RATE;

/// The Responses model GPT-Live delegates to; it routes, the agents work.
pub const BACKEND_MODEL: &str = "gpt-6-luna";
const VOICE: &str = "marin";
/// 800 ms at 16 kHz.
const END_SILENCE: usize = SPEECH_RATE as usize * 4 / 5;
/// `session.commentary.append` takes at most 500 tokens.
const SAY_CHARS: usize = 1_500;

pub struct GptLive;

fn backend_instructions(names: &[String]) -> String {
    format!(
        "You route a spoken request to one of the user's Desk agents ({}). Call {ASK_AGENT} \
         with the agent the user addressed, or the last one they talked to, and the request in \
         their words. When the agent's answer comes back, reply with it condensed for speech: \
         a few plain sentences, no markdown.",
        if names.is_empty() {
            "any name the user says".to_string()
        } else {
            names.join(", ")
        }
    )
}

impl Protocol for GptLive {
    fn engine(&self) -> &'static str {
        "gpt-live"
    }

    fn output_rate(&self) -> u32 {
        SPEECH_RATE
    }

    fn start(&self, model: &str, names: &[String], opened_by: Option<&str>) -> Vec<String> {
        vec![
            json!({
                "type": "session.start",
                "event_id": "desk_start",
                "session": {
                    "model": model,
                    "instructions": instructions(names, opened_by, HandOff::Delegate),
                    "audio": {
                        "format": { "type": "audio/pcm", "rate": SPEECH_RATE },
                        "output": { "voice": VOICE },
                    },
                    "delegation": {
                        "type": "responses",
                        "responses": {
                            "model": BACKEND_MODEL,
                            "instructions": backend_instructions(names),
                            "tools": [{
                                "type": "function",
                                "name": ASK_AGENT,
                                "description": ASK_AGENT_DESCRIPTION,
                                "parameters": ask_agent_parameters(names, false),
                                "strict": true,
                            }],
                            "tool_choice": "auto",
                            "parallel_tool_calls": false,
                        },
                    },
                },
            })
            .to_string(),
        ]
    }

    fn audio(&self, samples: &[f32]) -> String {
        json!({ "type": "session.input_audio.append", "audio": pcm::to_base64(samples) })
            .to_string()
    }

    /// Live has no end-of-audio message and its turn detection needs
    /// silence, so release sends some.
    fn audio_end(&self) -> Option<String> {
        Some(self.audio(&[0.0; END_SILENCE]))
    }

    fn say(&self, text: &str) -> String {
        json!({
            "type": "session.commentary.append",
            "delegation_id": null,
            "content": text.chars().take(SAY_CHARS).collect::<String>(),
        })
        .to_string()
    }

    fn tool_result(&self, call_id: &str, text: &str) -> Vec<String> {
        vec![
            json!({
                "type": "response.item.create",
                "item": { "type": "function_call_output", "call_id": call_id, "output": text },
            })
            .to_string(),
            json!({ "type": "response.create" }).to_string(),
        ]
    }

    fn close(&self) -> Option<String> {
        Some(json!({ "type": "session.close" }).to_string())
    }

    fn parse(&self, message: &str) -> Vec<Live> {
        let Ok(event) = serde_json::from_str::<Value>(message) else {
            return Vec::new();
        };
        let str_at = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(String::from);
        match event.get("type").and_then(Value::as_str) {
            Some("session.started") => vec![Live::Ready],
            Some("session.output_audio.delta") => str_at(&event, "delta")
                .and_then(|d| pcm::from_base64(&d))
                .map(Live::Audio)
                .into_iter()
                .collect(),
            // GPT-Live yields to the user by itself and sends no interruption
            // event; its transcript of the user is the only sign, and the
            // engine drops queued speech on it when the microphone agrees.
            Some("session.input_transcript.delta") => match str_at(&event, "delta") {
                Some(d) if !d.trim().is_empty() => vec![Live::Heard(d)],
                _ => Vec::new(),
            },
            Some("response.event") => {
                let inner = &event["event"];
                let item = &inner["item"];
                let is_ask = inner["type"] == "response.output_item.done"
                    && item["type"] == "function_call"
                    && item["name"] == ASK_AGENT;
                match (is_ask, item["call_id"].as_str()) {
                    (true, Some(id)) => call(id, &item["arguments"])
                        .map(Live::Call)
                        .into_iter()
                        .collect(),
                    _ => Vec::new(),
                }
            }
            Some("error") => {
                let error = &event["error"];
                if error["code"] == "responses_validation_failed" {
                    tracing::debug!(%error, "GPT-Live: backend validation");
                    return Vec::new();
                }
                vec![Live::Error(
                    str_at(error, "message").unwrap_or_else(|| "GPT-Live reported an error".into()),
                )]
            }
            Some("session.closed") => vec![Live::Closed],
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["Atlas".into(), "Allan".into()]
    }

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn starts_a_responses_delegated_session_with_one_tool() {
        let start = json(&GptLive.start("gpt-live-1", &names(), Some("Atlas"))[0]);
        assert_eq!(start["type"], "session.start");
        let session = &start["session"];
        assert_eq!(session["model"], "gpt-live-1");
        assert_eq!(
            session["audio"]["format"],
            json(r#"{"type":"audio/pcm","rate":16000}"#)
        );
        let responses = &session["delegation"]["responses"];
        assert_eq!(session["delegation"]["type"], "responses");
        assert_eq!(responses["model"], BACKEND_MODEL);
        assert_eq!(
            responses["tool_choice"], "auto",
            "required would loop after each result"
        );
        assert_eq!(responses["parallel_tool_calls"], false);
        let tool = &responses["tools"][0];
        assert_eq!(
            (&tool["type"], &tool["name"], &tool["strict"]),
            (&json!("function"), &json!(ASK_AGENT), &json!(true))
        );
        assert_eq!(
            tool["parameters"]["properties"]["agent"]["enum"],
            json!(["Atlas", "Allan"])
        );
    }

    #[test]
    fn sends_audio_as_base64_pcm16() {
        let m = json(&GptLive.audio(&[0.0, 1.0]));
        assert_eq!(m["type"], "session.input_audio.append");
        assert_eq!(m["audio"], pcm::to_base64(&[0.0, 1.0]));
    }

    #[test]
    fn a_function_call_from_the_backend_becomes_a_call() {
        let event = r#"{"type":"response.event","event_id":"e1","delegation_id":"del_1","event":{
            "type":"response.output_item.done","output_index":0,
            "item":{"type":"function_call","id":"fc_1","call_id":"call_123","name":"ask_agent",
                    "arguments":"{\"agent\":\"Atlas\",\"request\":\"what failed overnight?\"}"}}}"#;
        let parsed = GptLive.parse(event);
        let [Live::Call(c)] = parsed.as_slice() else {
            panic!()
        };
        assert_eq!(
            (c.id.as_str(), c.agent.as_deref(), c.request.as_str()),
            ("call_123", Some("Atlas"), "what failed overnight?")
        );
    }

    #[test]
    fn other_backend_events_are_ignored() {
        let delta = r#"{"type":"response.event","delegation_id":"d","event":{"type":"response.output_text.delta","delta":"The forecast is"}}"#;
        assert!(GptLive.parse(delta).is_empty());
        let other_tool = r#"{"type":"response.event","event":{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c","name":"web","arguments":"{}"}}}"#;
        assert!(GptLive.parse(other_tool).is_empty());
    }

    #[test]
    fn answers_go_back_as_function_output_then_continue() {
        let msgs: Vec<Value> = GptLive
            .tool_result("call_123", "Two tests failed.")
            .iter()
            .map(|m| json(m))
            .collect();
        assert_eq!(msgs[0]["type"], "response.item.create");
        assert_eq!(
            msgs[0]["item"],
            json(
                r#"{"type":"function_call_output","call_id":"call_123","output":"Two tests failed."}"#
            )
        );
        assert_eq!(msgs[1]["type"], "response.create");
    }

    #[test]
    fn maps_audio_transcripts_and_lifecycle() {
        assert_eq!(
            GptLive.parse(r#"{"type":"session.started","session":{"id":"live_123"}}"#),
            [Live::Ready]
        );
        assert_eq!(
            GptLive.parse(r#"{"type":"session.output_audio.delta","delta":"AACAAA=="}"#),
            [Live::Audio(vec![0, 0, 0x80, 0])]
        );
        assert_eq!(
            GptLive.parse(r#"{"type":"session.input_transcript.delta","event_id":"x","delta":"wait, stop","start_ms":1,"end_ms":2}"#),
            [Live::Heard("wait, stop".into())]
        );
        assert!(
            GptLive
                .parse(r#"{"type":"session.input_transcript.delta","delta":" "}"#)
                .is_empty()
        );
        assert_eq!(
            GptLive.parse(r#"{"type":"session.closed","usage":{}}"#),
            [Live::Closed]
        );
        assert_eq!(
            GptLive.parse(r#"{"type":"error","error":{"type":"invalid_request_error","code":"unknown_parameter","message":"Unknown parameter"}}"#),
            [Live::Error("Unknown parameter".into())]
        );
        assert!(GptLive.parse(r#"{"type":"error","error":{"code":"responses_validation_failed","message":"x"}}"#).is_empty());
        assert!(GptLive.parse("not json").is_empty());
    }

    #[test]
    fn says_through_commentary_and_closes_gracefully() {
        let say = json(&GptLive.say("Atlas can't be reached."));
        assert_eq!(say["type"], "session.commentary.append");
        assert_eq!(say["delegation_id"], Value::Null);
        assert_eq!(json(&GptLive.close().unwrap())["type"], "session.close");
        let end = json(&GptLive.audio_end().unwrap());
        assert_eq!(
            pcm::from_base64(end["audio"].as_str().unwrap())
                .unwrap()
                .len(),
            END_SILENCE * 2
        );
    }
}
