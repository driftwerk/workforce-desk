//! The local hub's `workforce.toml`, regenerated on every start from the
//! ports Desk chose. Loopback only; every store that has a Postgres backend
//! uses it; Desk sessions on; memories in the local memory store once it can
//! take them; and every agent learning and checking its work as Driftwerk's
//! do, each of which an agent's own `config.toml` can turn off.

use desk_core::{HubPorts, Paths, Secret};
use toml::{Table, Value};

/// Sections whose `backend` can be Postgres.
const POSTGRES_STORES: &[&str] = &[
    "codegraph",
    "identity",
    "mcp_store",
    "pairing_store",
    "permissions",
    "projects",
    "scheduler_store",
    "self_learning",
    "sessions",
    "telemetry",
    "training",
    "vault",
];

pub const DATABASE: &str = "workforce";

/// Where the hub keeps memories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Memories {
    /// The hub's SQLite file, searched by keyword: until the memory store
    /// and its model are ready, and the memories moved into it.
    Sqlite,
    /// The local memory store (vellev), searched by meaning and keyword.
    Store,
}

/// The memory store's tenant: everything this computer remembers.
pub const MEMORY_TENANT: &str = "desk";

/// bge-base's certainty mapped onto the scale the recall floors were tuned
/// on, as the hub's `[embeddings] score_map` for bge-base (Driftwerk's).
const BGE_SCORE_MAP: [[f64; 2]; 8] = [
    [0.0, 0.0],
    [0.72, 0.60],
    [0.77, 0.65],
    [0.80, 0.70],
    [0.83, 0.80],
    [0.935, 0.92],
    [0.98, 0.97],
    [1.0, 1.0],
];

/// The read-only tools a chained-tools program may call: reading files,
/// code, code knowledge and the web, never anything that writes. (Memory
/// is one tool whose actions write too, so it is not among them.)
const PROGRAM_READ_TOOLS: [&str; 14] = [
    "filesystem.read",
    "filesystem.list",
    "filesystem.grep",
    "filesystem.glob",
    "code.read",
    "code.search",
    "code.find",
    "code.symbols",
    "code.tree",
    "web.fetch",
    "web.search",
    "knowledge.ask",
    "knowledge.symbol",
    "knowledge.impact",
];

/// Claude Code subprocesses at once across the hub (second opinions and
/// coding fan-outs): enough for one panel of second opinions on one computer.
pub const MAX_CLAUDE_CODE_AT_ONCE: i64 = 3;

/// The local agent Desk's hub always has.
pub const DESK_AGENT: &str = "desk";

const RICH_KINDS: [&str; 6] = ["tables", "charts", "forms", "maps", "diagrams", "images"];

/// Turns on every rich block for an agent whose `config.toml` says nothing
/// about them — Desk renders them all. An agent's own `[rich]` choices, and
/// the rest of its file, are left exactly as they are.
pub fn ensure_rich(workspace: &std::path::Path) -> eyre::Result<()> {
    let path = workspace.join("config.toml");
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut doc: toml_edit::DocumentMut = source.parse()?;
    if doc.contains_key("rich") {
        return Ok(());
    }
    let mut rich = toml_edit::Table::new();
    for kind in RICH_KINDS {
        rich.insert(kind, toml_edit::value(true));
    }
    doc.insert("rich", toml_edit::Item::Table(rich));
    std::fs::create_dir_all(workspace)?;
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}

/// Makes the agent the crew's overseer, only watching, when its
/// `config.toml` says nothing about overseeing — Desk's switch reads the
/// file, so the setting is written there. An `[oversight]` the person set
/// (on or off), and the rest of the file, are left exactly as they are.
pub fn ensure_oversight(workspace: &std::path::Path) -> eyre::Result<()> {
    let path = workspace.join("config.toml");
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut doc: toml_edit::DocumentMut = source.parse()?;
    if doc.contains_key("oversight") {
        return Ok(());
    }
    let mut oversight = toml_edit::Table::new();
    oversight.insert("enabled", toml_edit::value(true));
    oversight.insert("level", toml_edit::value("watch"));
    doc.insert("oversight", toml_edit::Item::Table(oversight));
    std::fs::create_dir_all(workspace)?;
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}
pub const DATABASE_USER: &str = "postgres";

fn b(v: bool) -> Value {
    Value::Boolean(v)
}

fn int(v: i64) -> Value {
    Value::Integer(v)
}

fn float(v: f64) -> Value {
    Value::Float(v)
}

fn strings(v: &[&str]) -> Value {
    Value::Array(v.iter().map(|x| s(x)).collect())
}

/// What every local agent does unless its own `config.toml` says otherwise:
/// the hub merges an agent's `[memory]`, `[know_how]` and `[tools.programs]`
/// over these field by field, and takes its `[advisor]`, `[self_learning]`
/// and `[claim_grounding]` in place of these. Background work runs on the
/// cheap tier and Claude Code where it can, so it is paid for by the
/// person's plan; each falls back to the agent's own model when Claude Code
/// can't serve it (a ChatGPT-only computer).
fn learning(doc: &mut Table, ports: &HubPorts, memories: Memories) {
    let mut memory = vec![
        ("passive", b(true)),
        ("passive_model", s("cheap")),
        ("lesson_extract", b(true)),
        ("lesson_extract_model", s("cheap")),
        ("lesson_inject", b(true)),
        ("consolidation", b(true)),
        ("consolidation_interval_secs", int(7200)),
        ("consolidation_source", s("claude_code")),
        ("consolidation_cc_failover", b(true)),
        ("relationship", b(true)),
    ];
    if memories == Memories::Store {
        memory.insert(0, ("backend", s("vellev")));
        doc.insert(
            "vellev".into(),
            table(&[
                ("url", s(&format!("http://127.0.0.1:{}", ports.memory))),
                ("api_key", s(&format!("${{{}}}", Secret::MemoryKey.env()))),
                ("tenant", s(MEMORY_TENANT)),
                // The first start loads the embedding model before it answers.
                ("connect_timeout_secs", int(300)),
            ]),
        );
        // The store embeds with its own bge-base; its certainty is mapped
        // onto the scale the recall floors below were tuned on.
        doc.insert(
            "embeddings".into(),
            table(&[(
                "score_map",
                Value::Array(
                    BGE_SCORE_MAP
                        .iter()
                        .map(|[x, y]| Value::Array(vec![float(*x), float(*y)]))
                        .collect(),
                ),
            )]),
        );
    }
    doc.insert("memory".into(), table(&memory));
    // Artifacts and code are searched by meaning in the same store; without
    // Weaviate they would be found by keyword alone.
    let vectors = (memories == Memories::Store).then_some(("vector_backend", s("vellev")));
    if memories == Memories::Store {
        doc.insert("artifacts".into(), table(&[("index_backend", s("vellev"))]));
    }
    doc.insert(
        "self_learning".into(),
        table(&[
            ("enabled", b(true)),
            ("backend", s("postgres")),
            ("source", s("claude_code")),
            ("cc_allow_failover_to_models", b(true)),
            ("model", s("cheap")),
            ("recall_top_k", int(3)),
            ("recall_threshold", float(0.45)),
            ("min_importance", float(0.4)),
        ]),
    );
    doc.insert(
        "advisor".into(),
        table(&[
            ("enabled", b(true)),
            ("source", s("claude_code")),
            ("cc_effort", s("high")),
            ("max_rounds", int(10)),
            ("cc_allow_failover_to_models", b(true)),
            ("cc_fallback_model", s("powerful")),
            (
                "fanout",
                table(&[
                    ("enabled", b(true)),
                    ("max_lenses", int(MAX_CLAUDE_CODE_AT_ONCE)),
                    ("max_concurrent", int(MAX_CLAUDE_CODE_AT_ONCE)),
                    ("hub_max_concurrent_cc", int(MAX_CLAUDE_CODE_AT_ONCE)),
                ]),
            ),
        ]),
    );
    doc.insert(
        "claim_grounding".into(),
        table(&[
            ("enabled", b(true)),
            ("flag_failed_tools", b(false)),
            ("data_claims", b(false)),
            ("commitments", b(false)),
        ]),
    );
    doc.insert(
        "know_how".into(),
        table(&[("mode", s("on")), ("inject", s("shadow"))]),
    );
    doc.insert(
        "tools".into(),
        table(&[(
            "programs",
            table(&[
                ("mode", s("on")),
                ("read_tools", strings(&PROGRAM_READ_TOOLS)),
            ]),
        )]),
    );
    // Code knowledge stays off until the person gives an agent a folder,
    // which its own `[knowledge]` turns on.
    let mut knowledge = vec![("enabled", b(false))];
    knowledge.extend(vectors);
    doc.insert("knowledge".into(), table(&knowledge));
    // Check-ins stay off until the person turns them on for an agent (its
    // own `[heartbeat]`); they then come every hour, into the agent's Desk
    // chat, and only when something needs the person.
    doc.insert(
        "heartbeat".into(),
        table(&[
            ("enabled", b(false)),
            ("interval_secs", int(3600)),
            ("deliver", s("actionable_only")),
        ]),
    );
}

fn table(entries: &[(&str, Value)]) -> Value {
    Value::Table(
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

pub fn render(paths: &Paths, ports: &HubPorts, memories: Memories) -> String {
    let mut doc = Table::new();
    doc.insert(
        "hub".into(),
        table(&[
            ("listen", s(&format!("127.0.0.1:{}", ports.admin))),
            ("data_dir", s(&paths.hub_data().to_string_lossy())),
            ("log_level", s("info")),
        ]),
    );
    doc.insert(
        "gateway".into(),
        table(&[
            ("listen", s(&format!("127.0.0.1:{}", ports.gateway))),
            ("cors", Value::Boolean(true)),
            // The app's page: macOS's and Linux's webview origin, Windows'
            // (WebView2), and the development server.
            (
                "cors_allowed_origins",
                Value::Array(vec![
                    s("tauri://localhost"),
                    s("http://tauri.localhost"),
                    s("http://localhost:5183"),
                ]),
            ),
        ]),
    );
    doc.insert(
        "postgres".into(),
        table(&[
            ("enabled", Value::Boolean(true)),
            ("host", s("127.0.0.1")),
            ("port", Value::Integer(ports.postgres.into())),
            ("database", s(DATABASE)),
            ("user", s(DATABASE_USER)),
            (
                "password",
                s(&format!("${{{}}}", Secret::PostgresPassword.env())),
            ),
        ]),
    );
    for store in POSTGRES_STORES {
        doc.insert(store.to_string(), table(&[("backend", s("postgres"))]));
    }
    doc.insert(
        "weaviate".into(),
        table(&[("enabled", Value::Boolean(false))]),
    );
    learning(&mut doc, ports, memories);
    // Desk pairs itself as a device to chat (`/ws` takes no admin token).
    // Loopback-only and Desk holds the admin token, so its token never lapses.
    doc.insert(
        "pairing".into(),
        table(&[
            ("device_pairing_enabled", Value::Boolean(true)),
            ("device_token_ttl_secs", Value::Integer(0)),
        ]),
    );
    doc.insert(
        "llm".into(),
        table(&[
            ("provider", s("claude-code")),
            ("default_model", s("standard")),
        ]),
    );
    // Terminals and sessions live in the PTY holder desk-hubd starts, so
    // they outlive the hub restarting; it takes the hub's admin token.
    doc.insert(
        "desk".into(),
        table(&[
            ("enabled", Value::Boolean(true)),
            (
                "pty_holder_socket",
                s(&paths.pty_socket().to_string_lossy()),
            ),
            (
                "pty_holder_token",
                s(&format!("${{{}}}", Secret::GatewayToken.env())),
            ),
        ]),
    );
    // A job or workflow made in Desk that needs the person's approval asks
    // them in Desk, where they decide it; nothing else is routed without
    // `[permissions]` rules.
    doc.insert(
        "approvals".into(),
        table(&[
            ("enabled", Value::Boolean(true)),
            ("backend", s("postgres")),
        ]),
    );
    // Local agents may run on the person's ChatGPT plan as well as Claude's.
    doc.insert(
        "subscription".into(),
        table(&[("chatgpt_direct", Value::Boolean(true))]),
    );
    let agent = table(&[
        ("id", s("desk")),
        ("name", s("Desk")),
        (
            "workspace",
            s(&paths.hub_data().join("agents/desk").to_string_lossy()),
        ),
        ("default", Value::Boolean(true)),
    ]);
    doc.insert("agents".into(), Value::Array(vec![agent]));
    format!(
        "# Written by desk-hubd on every start; edit Desk's settings instead.\n{}",
        toml::to_string(&doc).expect("a TOML table always serialises")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_blocks_are_turned_on_once_and_an_agents_own_choice_kept() {
        let dir = tempfile::tempdir().unwrap();
        ensure_rich(dir.path()).unwrap();
        let fresh: Table =
            toml::from_str(&std::fs::read_to_string(dir.path().join("config.toml")).unwrap())
                .unwrap();
        assert!(
            RICH_KINDS
                .iter()
                .all(|k| fresh["rich"][*k].as_bool() == Some(true))
        );

        let mine = "# my agent\n[llm]\nprovider = \"chatgpt\"\n\n[rich]\ncharts = false\n";
        std::fs::write(dir.path().join("config.toml"), mine).unwrap();
        ensure_rich(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config.toml")).unwrap(),
            mine
        );

        std::fs::write(
            dir.path().join("config.toml"),
            "# keep me\n[llm]\nprovider = \"chatgpt\"\n",
        )
        .unwrap();
        ensure_rich(dir.path()).unwrap();
        let kept = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(kept.starts_with("# keep me\n[llm]\nprovider = \"chatgpt\"\n"));
        assert!(kept.contains("[rich]\ntables = true"));
    }

    #[test]
    fn the_desk_agent_oversees_the_crew_once_and_a_persons_choice_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let read = || std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        ensure_oversight(dir.path()).unwrap();
        let fresh: Table = toml::from_str(&read()).unwrap();
        assert_eq!(fresh["oversight"]["enabled"].as_bool(), Some(true));
        assert_eq!(fresh["oversight"]["level"].as_str(), Some("watch"));

        let off = "# mine\n[rich]\ncharts = false\n\n[oversight]\nenabled = false\n";
        std::fs::write(dir.path().join("config.toml"), off).unwrap();
        ensure_oversight(dir.path()).unwrap();
        assert_eq!(read(), off);

        let inline = "oversight = { enabled = true, level = \"act\" }\n";
        std::fs::write(dir.path().join("config.toml"), inline).unwrap();
        ensure_oversight(dir.path()).unwrap();
        assert_eq!(read(), inline);

        std::fs::write(
            dir.path().join("config.toml"),
            "# keep me\n[llm]\nprovider = \"chatgpt\"\n",
        )
        .unwrap();
        ensure_rich(dir.path()).unwrap();
        ensure_oversight(dir.path()).unwrap();
        let kept = read();
        assert!(kept.starts_with("# keep me\n[llm]\nprovider = \"chatgpt\"\n"));
        let doc: Table = toml::from_str(&kept).unwrap();
        assert_eq!(doc["rich"]["tables"].as_bool(), Some(true));
        assert_eq!(doc["oversight"]["level"].as_str(), Some("watch"));
    }

    fn ports() -> HubPorts {
        HubPorts {
            postgres: 54001,
            admin: 54002,
            gateway: 54003,
            memory: 54004,
        }
    }

    fn rendered(memories: Memories) -> Table {
        let paths = Paths::at("/Users/k/Library/Application Support/Desk");
        toml::from_str(&render(&paths, &ports(), memories)).unwrap()
    }

    #[test]
    fn the_hub_listens_on_loopback_and_keeps_everything_in_postgres() {
        let doc = rendered(Memories::Sqlite);
        assert_eq!(doc["hub"]["listen"].as_str(), Some("127.0.0.1:54002"));
        assert_eq!(doc["gateway"]["listen"].as_str(), Some("127.0.0.1:54003"));
        assert_eq!(doc["postgres"]["port"].as_integer(), Some(54001));
        assert_eq!(
            doc["postgres"]["password"].as_str(),
            Some("${DESK_POSTGRES_PASSWORD}")
        );
        for store in POSTGRES_STORES {
            assert_eq!(doc[*store]["backend"].as_str(), Some("postgres"), "{store}");
        }
        assert_eq!(doc["weaviate"]["enabled"].as_bool(), Some(false));
        assert_eq!(doc["desk"]["enabled"].as_bool(), Some(true));
        let origins: Vec<_> = doc["gateway"]["cors_allowed_origins"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|o| o.as_str())
            .collect();
        assert_eq!(
            origins,
            [
                "tauri://localhost",
                "http://tauri.localhost",
                "http://localhost:5183"
            ]
        );
        assert_eq!(
            doc["desk"]["pty_holder_socket"].as_str(),
            Some("/Users/k/Library/Application Support/Desk/hub/run/pty.sock")
        );
        assert_eq!(
            doc["desk"]["pty_holder_token"].as_str(),
            Some("${WORKFORCE_GATEWAY_TOKEN}")
        );
        assert_eq!(
            doc["pairing"]["device_pairing_enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(doc["approvals"]["enabled"].as_bool(), Some(true));
        assert_eq!(doc["approvals"]["backend"].as_str(), Some("postgres"));
        assert!(
            doc.get("permissions")
                .and_then(|p| p.get("enabled"))
                .is_none(),
            "the permission cascade stays off"
        );
    }

    #[test]
    fn memories_stay_in_sqlite_until_the_store_takes_them() {
        let doc = rendered(Memories::Sqlite);
        assert!(doc["memory"].get("backend").is_none());
        assert!(doc.get("vellev").is_none());
        assert!(doc.get("embeddings").is_none());
    }

    #[test]
    fn memories_in_the_store_are_reached_on_loopback_with_desks_key() {
        let doc = rendered(Memories::Store);
        assert_eq!(doc["memory"]["backend"].as_str(), Some("vellev"));
        let vellev = &doc["vellev"];
        assert_eq!(vellev["url"].as_str(), Some("http://127.0.0.1:54004"));
        assert_eq!(vellev["api_key"].as_str(), Some("${DESK_MEMORY_KEY}"));
        assert_eq!(vellev["tenant"].as_str(), Some(MEMORY_TENANT));
        // bge-base's certainty, on the scale the recall floors were tuned on.
        let knots = doc["embeddings"]["score_map"].as_array().unwrap();
        assert_eq!(knots.len(), BGE_SCORE_MAP.len());
        assert_eq!(knots[1].as_array().unwrap()[0].as_float(), Some(0.72));
        // The store embeds with its own model: the hub sends no vectors.
        assert!(doc["embeddings"].get("provider").is_none());
        assert_eq!(doc["artifacts"]["index_backend"].as_str(), Some("vellev"));
        assert_eq!(doc["knowledge"]["vector_backend"].as_str(), Some("vellev"));
    }

    #[test]
    fn every_agent_learns_and_checks_its_work_on_the_persons_plan() {
        for memories in [Memories::Sqlite, Memories::Store] {
            let doc = rendered(memories);
            let memory = &doc["memory"];
            for on in [
                "passive",
                "lesson_extract",
                "lesson_inject",
                "consolidation",
                "relationship",
            ] {
                assert_eq!(memory[on].as_bool(), Some(true), "{on}");
            }
            assert_eq!(memory["passive_model"].as_str(), Some("cheap"));
            assert_eq!(memory["lesson_extract_model"].as_str(), Some("cheap"));
            assert_eq!(memory["consolidation_source"].as_str(), Some("claude_code"));
            assert_eq!(memory["consolidation_cc_failover"].as_bool(), Some(true));
            assert_eq!(
                memory["consolidation_interval_secs"].as_integer(),
                Some(7200)
            );

            let learning = &doc["self_learning"];
            assert_eq!(learning["enabled"].as_bool(), Some(true));
            assert_eq!(learning["backend"].as_str(), Some("postgres"));
            assert_eq!(learning["source"].as_str(), Some("claude_code"));

            let advisor = &doc["advisor"];
            assert_eq!(advisor["enabled"].as_bool(), Some(true));
            assert_eq!(advisor["source"].as_str(), Some("claude_code"));
            assert_eq!(advisor["max_rounds"].as_integer(), Some(10));
            let fanout = &advisor["fanout"];
            // A panel's legs never wait on each other for a place.
            assert_eq!(
                fanout["max_lenses"].as_integer(),
                fanout["max_concurrent"].as_integer()
            );
            assert!(
                fanout["max_concurrent"].as_integer()
                    <= fanout["hub_max_concurrent_cc"].as_integer()
            );

            assert_eq!(doc["claim_grounding"]["enabled"].as_bool(), Some(true));
            assert_eq!(doc["know_how"]["mode"].as_str(), Some("on"));
            assert_eq!(doc["know_how"]["inject"].as_str(), Some("shadow"));
            let programs = &doc["tools"]["programs"];
            assert_eq!(programs["mode"].as_str(), Some("on"));
            let tools = programs["read_tools"].as_array().unwrap();
            assert!(!tools.is_empty());
            for t in tools {
                let t = t.as_str().unwrap();
                assert!(!t.contains("write") && !t.contains("edit"), "{t}");
                // A tool whose actions write may not be listed whole.
                assert!(t.contains('.'), "{t}");
            }
            // Off until the person turns them on for an agent.
            assert_eq!(doc["knowledge"]["enabled"].as_bool(), Some(false));
            assert_eq!(doc["heartbeat"]["enabled"].as_bool(), Some(false));
            assert_eq!(doc["heartbeat"]["interval_secs"].as_integer(), Some(3600));
            assert_eq!(
                doc["heartbeat"]["deliver"].as_str(),
                Some("actionable_only")
            );
            // No other provider's model is named anywhere.
            let text = toml::to_string(&doc).unwrap();
            for name in ["gpt-", "haiku", "sonnet", "opus", "gemini", "llama"] {
                assert!(!text.contains(name), "{name}");
            }
        }
    }

    #[test]
    fn an_agents_own_choices_are_left_as_they_are() {
        // An agent that turned learning off keeps it off: Desk Helper writes
        // only the hub-wide defaults, which an agent's own file overrides.
        let dir = tempfile::tempdir().unwrap();
        let mine = "# mine\n[memory]\npassive = false\nconsolidation = false\n\n[advisor]\nenabled = false\n\n[know_how]\nenabled = false\n\n[tools.programs]\nenabled = false\n";
        std::fs::write(dir.path().join("config.toml"), mine).unwrap();
        let paths = Paths::at(dir.path());
        let _ = render(&paths, &ports(), Memories::Store);
        ensure_rich(dir.path()).unwrap();
        ensure_oversight(dir.path()).unwrap();
        let kept = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(kept.starts_with(mine));
        let doc: Table = toml::from_str(&kept).unwrap();
        assert_eq!(doc["memory"]["passive"].as_bool(), Some(false));
        assert_eq!(doc["advisor"]["enabled"].as_bool(), Some(false));
        assert_eq!(doc["tools"]["programs"]["enabled"].as_bool(), Some(false));
    }
}
