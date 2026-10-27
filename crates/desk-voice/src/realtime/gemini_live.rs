//! Gemini Live over its WebSocket, with `ask_agent` as an asynchronous
//! (non-blocking) function so the model keeps talking while an agent works.
//! <https://ai.google.dev/api/live>

use serde_json::{Value, json};

use super::pcm;
use super::protocol::{
    ASK_AGENT, ASK_AGENT_DESCRIPTION, HandOff, Live, Protocol, ask_agent_parameters, call,
    instructions,
};
use crate::resample::SPEECH_RATE;

/// Gemini Live always speaks at 24 kHz.
const OUTPUT_RATE: u32 = 24_000;
const VOICE: &str = "Kore";

pub struct GeminiLive;

impl Protocol for GeminiLive {
    fn engine(&self) -> &'static str {
        "gemini-live"
    }

    fn output_rate(&self) -> u32 {
        OUTPUT_RATE
    }

    fn start(&self, model: &str, names: &[String], opened_by: Option<&str>) -> Vec<String> {
        vec![
            json!({
                "setup": {
                    "model": format!("models/{model}"),
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": VOICE } } },
                    },
                    "systemInstruction": { "parts": [{ "text": instructions(names, opened_by, HandOff::Tool) }] },
                    "tools": [{
                        "functionDeclarations": [{
                            "name": ASK_AGENT,
                            "description": ASK_AGENT_DESCRIPTION,
                            "parameters": ask_agent_parameters(names, true),
                            "behavior": "NON_BLOCKING",
                        }],
                    }],
                    "inputAudioTranscription": {},
                },
            })
            .to_string(),
        ]
    }

    fn audio(&self, samples: &[f32]) -> String {
        json!({
            "realtimeInput": {
                "audio": { "data": pcm::to_base64(samples), "mimeType": format!("audio/pcm;rate={SPEECH_RATE}") },
            },
        })
        .to_string()
    }

    fn audio_end(&self) -> Option<String> {
        Some(json!({ "realtimeInput": { "audioStreamEnd": true } }).to_string())
    }

    fn say(&self, text: &str) -> String {
        json!({
            "clientContent": {
                "turns": [{ "role": "user", "parts": [{ "text": format!("(From Desk, not the user) Tell the user: {text}") }] }],
                "turnComplete": true,
            },
        })
        .to_string()
    }

    fn tool_result(&self, call_id: &str, text: &str) -> Vec<String> {
        vec![
            json!({
                "toolResponse": {
                    "functionResponses": [{
                        "id": call_id,
                        "name": ASK_AGENT,
                        "response": { "result": text, "scheduling": "WHEN_IDLE" },
                    }],
                },
            })
            .to_string(),
        ]
    }

    fn close(&self) -> Option<String> {
        None
    }

    fn parse(&self, message: &str) -> Vec<Live> {
        let Ok(m) = serde_json::from_str::<Value>(message) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if m.get("setupComplete").is_some() {
            out.push(Live::Ready);
        }
        if let Some(content) = m.get("serverContent") {
            if content["interrupted"] == true {
                out.push(Live::Interrupted);
            }
            let parts = content["modelTurn"]["parts"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            out.extend(
                parts
                    .iter()
                    .filter_map(|p| p["inlineData"]["data"].as_str())
                    .filter_map(pcm::from_base64)
                    .map(Live::Audio),
            );
            if let Some(text) = content["inputTranscription"]["text"]
                .as_str()
                .filter(|t| !t.trim().is_empty())
            {
                out.push(Live::Heard(text.to_string()));
            }
        }
        if let Some(calls) = m["toolCall"]["functionCalls"].as_array() {
            out.extend(
                calls
                    .iter()
                    .filter(|c| c["name"] == ASK_AGENT)
                    .filter_map(|c| call(c["id"].as_str()?, &c["args"]))
                    .map(Live::Call),
            );
        }
        if let Some(ids) = m["toolCallCancellation"]["ids"].as_array() {
            out.push(Live::Cancelled(
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect(),
            ));
        }
        if m.get("goAway").is_some() {
            out.push(Live::Error("Gemini is ending the session".into()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn sets_up_audio_with_an_async_ask_agent() {
        let setup =
            &json(&GeminiLive.start("gemini-3.8-live", &["Atlas".into()], None)[0])["setup"];
        assert_eq!(setup["model"], "models/gemini-3.8-live");
        assert_eq!(
            setup["generationConfig"]["responseModalities"],
            json!(["AUDIO"])
        );
        let f = &setup["tools"][0]["functionDeclarations"][0];
        assert_eq!(
            (&f["name"], &f["behavior"]),
            (&json!(ASK_AGENT), &json!("NON_BLOCKING"))
        );
        assert_eq!(
            f["parameters"]["properties"]["agent"]["enum"],
            json!(["Atlas"])
        );
        assert_eq!(setup["inputAudioTranscription"], json!({}));
        assert!(
            setup["systemInstruction"]["parts"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Atlas")
        );
    }

    #[test]
    fn sends_16k_audio_and_ends_the_stream() {
        let m = json(&GeminiLive.audio(&[0.5]));
        assert_eq!(
            m["realtimeInput"]["audio"]["mimeType"],
            "audio/pcm;rate=16000"
        );
        assert_eq!(m["realtimeInput"]["audio"]["data"], pcm::to_base64(&[0.5]));
        assert_eq!(
            json(&GeminiLive.audio_end().unwrap())["realtimeInput"]["audioStreamEnd"],
            true
        );
    }

    #[test]
    fn a_tool_call_becomes_a_call_and_its_answer_a_tool_response() {
        let msg = r#"{"toolCall":{"functionCalls":[
            {"id":"fc-1","name":"ask_agent","args":{"agent":"Atlas","request":"what failed overnight?"}},
            {"id":"fc-2","name":"other","args":{}}]}}"#;
        let parsed = GeminiLive.parse(msg);
        let [Live::Call(c)] = parsed.as_slice() else {
            panic!()
        };
        assert_eq!(
            (c.id.as_str(), c.agent.as_deref()),
            ("fc-1", Some("Atlas"))
        );
        let reply = json(&GeminiLive.tool_result("fc-1", "Two tests failed.")[0]);
        assert_eq!(
            reply["toolResponse"]["functionResponses"][0],
            json(
                r#"{"id":"fc-1","name":"ask_agent","response":{"result":"Two tests failed.","scheduling":"WHEN_IDLE"}}"#
            )
        );
    }

    #[test]
    fn maps_audio_interruptions_transcripts_and_cancellations() {
        assert_eq!(GeminiLive.parse(r#"{"setupComplete":{}}"#), [Live::Ready]);
        assert_eq!(
            GeminiLive.parse(r#"{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AACAAA=="}}]}}}"#),
            [Live::Audio(vec![0, 0, 0x80, 0])]
        );
        assert_eq!(
            GeminiLive.parse(r#"{"serverContent":{"interrupted":true}}"#),
            [Live::Interrupted]
        );
        assert_eq!(
            GeminiLive.parse(r#"{"serverContent":{"inputTranscription":{"text":"thanks"}}}"#),
            [Live::Heard("thanks".into())]
        );
        assert_eq!(
            GeminiLive.parse(r#"{"toolCallCancellation":{"ids":["fc-1"]}}"#),
            [Live::Cancelled(vec!["fc-1".into()])]
        );
        assert!(matches!(
            GeminiLive
                .parse(r#"{"goAway":{"timeLeft":"5s"}}"#)
                .as_slice(),
            [Live::Error(_)]
        ));
        assert!(
            GeminiLive
                .parse(r#"{"serverContent":{"turnComplete":true}}"#)
                .is_empty()
        );
        assert_eq!(GeminiLive.output_rate(), 24_000);
        assert_eq!(GeminiLive.close(), None);
    }

    #[test]
    fn says_as_desk_not_as_the_user() {
        let m = json(&GeminiLive.say("Atlas is offline."));
        let text = m["clientContent"]["turns"][0]["parts"][0]["text"]
            .as_str()
            .unwrap();
        assert!(
            text.starts_with("(From Desk, not the user)") && text.ends_with("Atlas is offline.")
        );
    }
}
