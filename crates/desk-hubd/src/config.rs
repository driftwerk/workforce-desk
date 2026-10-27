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
            ("default_model", s("claude-sonnet-5-5")),
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
