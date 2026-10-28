//! The local hub's `workforce.toml`, regenerated on every start from the
//! ports Desk chose. Loopback only; every store that has a Postgres backend
//! uses it; Desk sessions on.

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

pub fn render(paths: &Paths, ports: &HubPorts) -> String {
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
            (
                "cors_allowed_origins",
                Value::Array(vec![s("tauri://localhost"), s("http://localhost:5183")]),
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
    doc.insert("desk".into(), table(&[("enabled", Value::Boolean(true))]));
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

    #[test]
    fn the_hub_listens_on_loopback_and_keeps_everything_in_postgres() {
        let paths = Paths::at("/Users/k/Library/Application Support/Desk");
        let ports = HubPorts {
            postgres: 54001,
            admin: 54002,
            gateway: 54003,
        };
        let doc: Table = toml::from_str(&render(&paths, &ports)).unwrap();
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
        assert_eq!(
            doc["pairing"]["device_pairing_enabled"].as_bool(),
            Some(true)
        );
    }
}
