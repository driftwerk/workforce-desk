//! The realtime engines against a fake provider: the real wake models
//! decide when a session opens, the fake server plays the provider's side
//! of the documented protocol. Ignored by default (it needs the wake and
//! speech models in the Desk folder):
//!
//! `cargo test -p desk-voice --test realtime -- --ignored --nocapture --test-threads=1`

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use desk_voice::hub::{Grant, Sessions};
use desk_voice::models::{self, Models};
use desk_voice::realtime::gemini_live::GeminiLive;
use desk_voice::realtime::gpt_live::GptLive;
use desk_voice::realtime::pcm;
use desk_voice::realtime::protocol::Protocol;
use desk_voice::resample::{Resampler, SPEECH_RATE};
use desk_voice::speech::Speaker;
use desk_voice::{
    AudioIn, AudioOut, Member, Realtime, Utterance, VoiceEngine, VoiceEvents, VoiceSpec, VoiceState,
};
use serde_json::{Value, json};
use tungstenite::Message;

fn models() -> &'static Models {
    static MODELS: OnceLock<Models> = OnceLock::new();
    MODELS.get_or_init(|| {
        let models = Models::new(models::default_dir(&desk_core::Paths::new().unwrap()));
        models
            .ensure(&models::ALL, &AtomicBool::new(false), &mut |_| {})
            .unwrap();
        models
    })
}

fn spoken(text: &str) -> Vec<f32> {
    static SPEAKER: OnceLock<Speaker> = OnceLock::new();
    let speaker = SPEAKER.get_or_init(|| Speaker::new(models()).unwrap());
    let audio = speaker.synthesize(text, None).unwrap();
    Resampler::new(audio.rate, SPEECH_RATE).process(&audio.samples)
}

fn silence(seconds: f32) -> Vec<f32> {
    vec![0.0; (SPEECH_RATE as f32 * seconds) as usize]
}

/// The provider: records what the engine sends, sends what the test says.
struct Provider {
    url: String,
    received: Arc<Mutex<Vec<Value>>>,
    connections: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    send: Sender<String>,
}

impl Provider {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let (send, outbox): (Sender<String>, Receiver<String>) = channel();
        {
            let (received, connections, closed) =
                (received.clone(), connections.clone(), closed.clone());
            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                connections.fetch_add(1, Ordering::SeqCst);
                stream
                    .set_read_timeout(Some(Duration::from_millis(5)))
                    .unwrap();
                let mut ws = tungstenite::accept(stream).unwrap();
                loop {
                    while let Ok(m) = outbox.try_recv() {
                        ws.send(Message::text(m)).unwrap();
                    }
                    match ws.read() {
                        Ok(Message::Text(t)) => received
                            .lock()
                            .unwrap()
                            .push(serde_json::from_str(t.as_str()).unwrap()),
                        Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => {
                            closed.store(true, Ordering::SeqCst);
                            return;
                        }
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(_)) => {}
                        Err(_) => {
                            closed.store(true, Ordering::SeqCst);
                            return;
                        }
                    }
                }
            });
        }
        Self {
            url,
            received,
            connections,
            closed,
            send,
        }
    }

    fn say(&self, message: Value) {
        self.send.send(message.to_string()).unwrap();
    }

    fn received(&self, f: impl Fn(&Value) -> bool) -> Vec<Value> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter(|m| f(m))
            .cloned()
            .collect()
    }
}

struct FakeHub {
    url: String,
    model: &'static str,
    grants: AtomicUsize,
}

impl Sessions for FakeHub {
    fn grant(&self, _engine: &str) -> eyre::Result<Grant> {
        self.grants.fetch_add(1, Ordering::SeqCst);
        Ok(Grant {
            token: "t".into(),
            expires_at: "2026-10-27T18:00:00Z".into(),
            model: self.model.into(),
            url: self.url.clone(),
        })
    }
}

#[derive(Default)]
struct Recorded {
    states: Mutex<Vec<VoiceState>>,
    said: Mutex<Vec<Utterance>>,
    errors: Mutex<Vec<String>>,
}

impl VoiceEvents for Recorded {
    fn state(&self, state: &VoiceState) {
        self.states.lock().unwrap().push(state.clone());
    }
    fn utterance(&self, utterance: &Utterance) {
        self.said.lock().unwrap().push(utterance.clone());
    }
    fn unheard(&self) {}
    fn error(&self, message: &str) {
        self.errors.lock().unwrap().push(message.into());
    }
}

#[derive(Default)]
struct Playback {
    played: Mutex<Vec<(usize, u32)>>,
    stops: AtomicUsize,
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl AudioOut for Playback {
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
        self.played.lock().unwrap().push((samples.len(), rate));
        self.pending.lock().unwrap().push(done);
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let pending: Vec<_> = self.pending.lock().unwrap().drain(..).collect();
        pending.into_iter().for_each(|done| done());
    }
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct Rig {
    engine: Realtime,
    provider: Provider,
    hub: Arc<FakeHub>,
    events: Arc<Recorded>,
    out: Arc<Playback>,
    mic: Arc<Mutex<Option<AudioIn>>>,
}

impl Rig {
    fn new(protocol: Arc<dyn Protocol>, model: &'static str) -> Self {
        let provider = Provider::start();
        let hub = Arc::new(FakeHub {
            url: provider.url.clone(),
            model,
            grants: AtomicUsize::new(0),
        });
        let events = Arc::new(Recorded::default());
        let out = Arc::new(Playback::default());
        let mic: Arc<Mutex<Option<AudioIn>>> = Arc::default();
        let engine = {
            let (out, mic) = (out.clone(), mic.clone());
            Realtime::start(
                models(),
                protocol,
                hub.clone(),
                events.clone(),
                move |input| {
                    *mic.lock().unwrap() = Some(input);
                    Ok(out)
                },
            )
            .unwrap()
        };
        engine.set_roster(vec![
            Member {
                name: "Atlas".into(),
                voice: Some(VoiceSpec {
                    provider: desk_voice::voices::Provider::GeminiLive,
                    model: None,
                    voice: Some("Puck".into()),
                }),
            },
            Member {
                name: "Allan".into(),
                voice: None,
            },
        ]);
        Self {
            engine,
            provider,
            hub,
            events,
            out,
            mic,
        }
    }

    /// Microphone audio at 48 kHz in real time, as the hardware would give it.
    fn speak(&self, samples16k: &[f32]) {
        let audio = Resampler::new(SPEECH_RATE, 48_000).process(samples16k);
        for chunk in audio.chunks(4_800) {
            self.mic.lock().unwrap().as_ref().unwrap()(chunk, 48_000);
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn audio_sent(m: &Value) -> Option<usize> {
    let data = m["realtimeInput"]["audio"]["data"]
        .as_str()
        .or(m["audio"].as_str())?;
    Some(pcm::from_base64(data)?.len() / 2)
}

#[test]
#[ignore = "needs the wake and speech models"]
fn gemini_live_wakes_on_a_name_routes_the_call_and_ends_at_thanks() {
    let rig = Rig::new(Arc::new(GeminiLive), "gemini-3.8-live");

    rig.speak(
        &[
            silence(0.5),
            spoken("The weather is lovely today."),
            silence(1.0),
        ]
        .concat(),
    );
    assert_eq!(
        rig.hub.grants.load(Ordering::SeqCst),
        0,
        "nothing reaches the cloud without a name"
    );

    let wake = [spoken("Atlas, what failed overnight?"), silence(0.3)].concat();
    rig.speak(&wake);
    wait_for("the setup message", || {
        !rig.provider
            .received(|m| m.get("setup").is_some())
            .is_empty()
    });
    let setup = &rig.provider.received(|m| m.get("setup").is_some())[0]["setup"];
    assert_eq!(setup["model"], "models/gemini-3.8-live");
    assert_eq!(
        setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"],
        "Puck",
        "the session speaks in the woken agent's own voice"
    );
    let declared = &setup["tools"][0]["functionDeclarations"][0];
    assert_eq!(
        declared["parameters"]["properties"]["agent"]["enum"],
        json!(["Atlas", "Allan"])
    );
    assert!(
        setup["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("just addressed Atlas")
    );
    assert_eq!(
        rig.provider.received(|m| audio_sent(m).is_some()).len(),
        0,
        "no audio before setup completes"
    );

    rig.provider.say(json!({ "setupComplete": {} }));
    wait_for("the buffered wake audio", || {
        !rig.provider
            .received(|m| audio_sent(m).is_some())
            .is_empty()
    });
    let chunks = rig.provider.received(|m| audio_sent(m).is_some());
    let sent: usize = chunks.iter().filter_map(audio_sent).sum();
    eprintln!(
        "wake audio sent after setup: {:.2} s (the wake phrase is {:.2} s)",
        sent as f32 / SPEECH_RATE as f32,
        wake.len() as f32 / SPEECH_RATE as f32
    );
    assert!(
        sent > SPEECH_RATE as usize / 2,
        "the name and the start of the request are sent"
    );
    assert!(
        sent <= wake.len() + SPEECH_RATE as usize * 3 / 2,
        "at most the wake phrase and the look-back"
    );
    let first = pcm::Decoder::default().decode(
        &pcm::from_base64(
            chunks[0]["realtimeInput"]["audio"]["data"]
                .as_str()
                .unwrap(),
        )
        .unwrap(),
    );
    let lead = &first[..SPEECH_RATE as usize / 10];
    assert!(
        lead.iter().all(|s| s.abs() < 1e-3),
        "what is sent starts in the quiet before the name, not in the speech before it"
    );
    wait_for("live state", || {
        rig.engine.state()
            == VoiceState::Live {
                agent: Some("Atlas".into()),
            }
    });

    rig.provider.say(json!({ "toolCall": { "functionCalls": [{
        "id": "fc-1", "name": "ask_agent", "args": { "agent": "Atlas", "request": "what failed overnight?" } }] } }));
    wait_for("the utterance", || {
        !rig.events.said.lock().unwrap().is_empty()
    });
    let u = rig.events.said.lock().unwrap()[0].clone();
    assert_eq!(
        (u.agent.as_deref(), u.text.as_str(), u.call_id.as_deref()),
        (Some("Atlas"), "what failed overnight?", Some("fc-1"))
    );

    rig.engine
        .tool_result("fc-1".into(), "Two integration tests timed out.".into());
    wait_for("the tool response", || {
        !rig.provider
            .received(|m| m.get("toolResponse").is_some())
            .is_empty()
    });
    let reply = &rig.provider.received(|m| m.get("toolResponse").is_some())[0]["toolResponse"]["functionResponses"]
        [0];
    assert_eq!(
        (&reply["id"], &reply["response"]["result"]),
        (&json!("fc-1"), &json!("Two integration tests timed out."))
    );

    let speech = pcm::to_base64(&vec![0.1; 2_400]);
    rig.provider
        .say(json!({ "serverContent": { "modelTurn": { "parts": [
        { "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": speech } }] } } }));
    wait_for("playback", || !rig.out.played.lock().unwrap().is_empty());
    assert_eq!(rig.out.played.lock().unwrap()[0], (2_400, 24_000));
    let stops = rig.out.stops.load(Ordering::SeqCst);
    rig.provider
        .say(json!({ "serverContent": { "interrupted": true } }));
    wait_for("barge-in", || rig.out.stops.load(Ordering::SeqCst) > stops);

    rig.provider.say(
        json!({ "serverContent": { "inputTranscription": { "text": "Thanks, that's all." } } }),
    );
    wait_for("the session to close", || {
        rig.provider.closed.load(Ordering::SeqCst)
    });
    wait_for("listening again", || {
        rig.engine.state() == VoiceState::Listening { conversation: None }
    });
    assert_eq!(rig.provider.connections.load(Ordering::SeqCst), 1);
    assert!(
        rig.events.errors.lock().unwrap().is_empty(),
        "{:?}",
        rig.events.errors.lock().unwrap()
    );
}

#[test]
#[ignore = "needs the wake and speech models"]
fn gpt_live_opens_on_push_to_talk_and_returns_the_answer_as_function_output() {
    let rig = Rig::new(Arc::new(GptLive), "gpt-live-1");
    rig.engine.push_to_talk(true);
    wait_for("session.start", || {
        !rig.provider
            .received(|m| m["type"] == "session.start")
            .is_empty()
    });
    let start = &rig.provider.received(|m| m["type"] == "session.start")[0]["session"];
    assert_eq!(start["model"], "gpt-live-1");
    assert_eq!(
        start["delegation"]["responses"]["tools"][0]["name"],
        "ask_agent"
    );
    rig.provider
        .say(json!({ "type": "session.started", "session": { "id": "live_1" } }));
    wait_for("live state", || {
        rig.engine.state() == VoiceState::Live { agent: None }
    });

    rig.speak(&silence(0.5));
    rig.engine.push_to_talk(false);
    let end_of_turn = SPEECH_RATE as usize * 4 / 5;
    wait_for("trailing silence that ends the turn", || {
        !rig.provider
            .received(|m| {
                m["type"] == "session.input_audio.append" && audio_sent(m) == Some(end_of_turn)
            })
            .is_empty()
    });
    let streamed = rig
        .provider
        .received(|m| m["type"] == "session.input_audio.append")
        .len();
    rig.speak(&silence(0.5));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        rig.provider
            .received(|m| m["type"] == "session.input_audio.append")
            .len(),
        streamed,
        "nothing is streamed once push-to-talk is released"
    );

    rig.provider.say(json!({ "type": "response.event", "delegation_id": "del_1", "event": {
        "type": "response.output_item.done",
        "item": { "type": "function_call", "call_id": "call_9", "name": "ask_agent",
                  "arguments": "{\"agent\":\"Allan\",\"request\":\"what's left before the release?\"}" } } }));
    wait_for("the utterance", || {
        !rig.events.said.lock().unwrap().is_empty()
    });
    let u = rig.events.said.lock().unwrap()[0].clone();
    assert_eq!(
        (u.agent.as_deref(), u.call_id.as_deref()),
        (Some("Allan"), Some("call_9"))
    );

    rig.engine
        .tool_result("call_9".into(), "Two reviews and the changelog.".into());
    wait_for("the function output", || {
        !rig.provider
            .received(|m| m["type"] == "response.create")
            .is_empty()
    });
    let output = &rig
        .provider
        .received(|m| m["type"] == "response.item.create")[0]["item"];
    assert_eq!(output["call_id"], "call_9");
    assert_eq!(output["output"], "Two reviews and the changelog.");

    rig.provider.say(
        json!({ "type": "session.output_audio.delta", "delta": pcm::to_base64(&vec![0.1; 1_600]) }),
    );
    wait_for("playback", || !rig.out.played.lock().unwrap().is_empty());
    assert_eq!(rig.out.played.lock().unwrap()[0], (1_600, 16_000));
    let stops = rig.out.stops.load(Ordering::SeqCst);
    rig.provider.say(json!({ "type": "session.input_transcript.delta", "delta": "before the release?", "start_ms": 1, "end_ms": 2 }));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        rig.out.stops.load(Ordering::SeqCst),
        stops,
        "a late transcript of the question doesn't cut off the answer"
    );
    let interruption = spoken("Wait, stop, that's the wrong release.");
    let (head, tail) = interruption.split_at(interruption.len() / 2);
    rig.speak(head);
    rig.provider.say(json!({ "type": "session.input_transcript.delta", "delta": "Wait, stop", "start_ms": 3, "end_ms": 4 }));
    wait_for("barge-in", || rig.out.stops.load(Ordering::SeqCst) > stops);
    rig.speak(tail);

    drop(rig.engine);
    wait_for("session.close", || {
        !rig.provider
            .received(|m| m["type"] == "session.close")
            .is_empty()
    });
}

#[test]
#[ignore = "reaches generativelanguage.googleapis.com"]
fn gemini_live_refuses_a_bogus_token_over_real_tls() {
    let url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=bogus";
    match tungstenite::connect(url) {
        Err(tungstenite::Error::Http(response)) => {
            eprintln!("refused: {}", response.status());
            assert!(response.status().is_client_error());
        }
        Ok((mut ws, _)) => {
            ws.send(Message::text(
                json!({ "setup": { "model": "models/gemini-3.8-live" } }).to_string(),
            ))
            .unwrap();
            match ws.read() {
                Ok(Message::Close(frame)) => eprintln!("closed: {frame:?}"),
                Ok(other) => panic!("a bogus token got a session: {other:?}"),
                Err(e) => eprintln!("ended: {e}"),
            }
        }
        Err(e) => panic!("expected a refusal from Gemini, got {e}"),
    }
}
