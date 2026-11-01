//! What the page may ask of the local hub through the broker: exactly the
//! requests `DeskHub` (`src/hub/client.ts`) makes, and nothing else the
//! admin token could do. Matched on parsed path segments, never on prefixes.

use percent_encoding::percent_decode_str;

/// One segment of a route: a literal, any one segment, or (last only) one or
/// more segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Lit(&'static str),
    One,
    Tail,
}

struct Route {
    method: &'static str,
    pattern: &'static str,
    /// The query keys the route takes; none for most.
    query: &'static [&'static str],
    /// Literals the first segment of a `{*}` tail may not be: the hub's other
    /// routes under the same prefix.
    not: &'static [&'static str],
}

const fn route(method: &'static str, pattern: &'static str) -> Route {
    Route {
        method,
        pattern,
        query: &[],
        not: &[],
    }
}

const fn with_query(
    method: &'static str,
    pattern: &'static str,
    query: &'static [&'static str],
) -> Route {
    Route {
        method,
        pattern,
        query,
        not: &[],
    }
}

/// `{}` is one segment, `{*}` the rest of the path (one or more segments).
const HTTP: &[Route] = &[
    // Sessions.
    route("GET", "/api/desk/sessions"),
    route("POST", "/api/desk/sessions"),
    route("PATCH", "/api/desk/sessions/{}"),
    route("POST", "/api/desk/sessions/{}/stop"),
    route("POST", "/api/desk/sessions/{}/interrupt"),
    route("POST", "/api/desk/sessions/{}/asked/allow"),
    route("POST", "/api/desk/sessions/{}/asked/dismiss"),
    route("POST", "/api/desk/sessions/{}/resume"),
    route("POST", "/api/desk/sessions/{}/remove"),
    route("POST", "/api/desk/sessions/{}/end"),
    route("POST", "/api/desk/sessions/{}/approvals/{}"),
    route("PUT", "/api/desk/sessions/{}/name"),
    route("GET", "/api/desk/sessions/closed"),
    route("GET", "/api/desk/sessions/hidden"),
    route("DELETE", "/api/desk/sessions/hidden/{}/{}"),
    route("POST", "/api/desk/sessions/clear"),
    route("POST", "/api/desk/restore"),
    route("POST", "/api/desk/restore/dismiss"),
    with_query("GET", "/api/desk/spend", &["period", "by", "limit"]),
    route("GET", "/api/desk/engines"),
    // The vault: which keys there are, and setting one. Never a key's value.
    route("GET", "/api/vault"),
    Route {
        method: "POST",
        pattern: "/api/vault/{*}",
        query: &[],
        not: &["rename", "catalog"],
    },
    // Agents.
    route("POST", "/api/agents"),
    route("PATCH", "/api/agents/{}"),
    route("DELETE", "/api/agents/{}"),
    route("PUT", "/api/agents/{}/picture"),
    route("DELETE", "/api/agents/{}/picture"),
    route("GET", "/api/agents/{}/identity/{}"),
    route("PUT", "/api/agents/{}/identity/{}"),
    route("GET", "/api/agents/{}/identity/{}/revisions"),
    route("GET", "/api/agents/{}/identity/{}/revisions/{}"),
    route("POST", "/api/agents/{}/identity/{}/revisions/{}/restore"),
    route("GET", "/api/agents/{}/memory/summary"),
    route("GET", "/api/agents/{}/heartbeat"),
    route("GET", "/api/agents/{}/config"),
    route("PUT", "/api/agents/{}/config"),
    // The providers agents think with.
    route("GET", "/api/desk/providers"),
    route("POST", "/api/desk/providers/{}/connect"),
    route("DELETE", "/api/desk/providers/{}"),
    // The crew.
    route("GET", "/api/desk/overview"),
    with_query("GET", "/api/desk/activity", &["limit", "filter", "before"]),
    route("GET", "/api/desk/manager"),
    route("GET", "/api/desk/suggestions"),
    route("POST", "/api/desk/suggestions/{}/accept"),
    route("POST", "/api/desk/suggestions/{}/dismiss"),
    // Rooms.
    route("GET", "/api/desk/rooms"),
    route("POST", "/api/desk/rooms"),
    route("PATCH", "/api/desk/rooms/{}"),
    route("DELETE", "/api/desk/rooms/{}"),
    with_query(
        "GET",
        "/api/desk/rooms/{}/messages",
        &["limit", "thread", "before", "after", "around"],
    ),
    route("POST", "/api/desk/rooms/{}/messages"),
    route("GET", "/api/desk/rooms/{}/messages/{}"),
    route("POST", "/api/desk/rooms/{}/messages/{}/copy"),
    with_query(
        "GET",
        "/api/desk/rooms/search",
        &[
            "q", "limit", "room", "from", "has", "inThread", "after", "before",
        ],
    ),
    route("GET", "/api/desk/unread"),
    route("GET", "/api/desk/reads"),
    route("PUT", "/api/desk/reads"),
    route("POST", "/api/desk/reads/all"),
    // What Desk keeps on the hub.
    with_query("GET", "/api/desk/state", &["prefix", "values"]),
    route("PUT", "/api/desk/state/{}"),
    route("DELETE", "/api/desk/state/{}"),
    route("GET", "/api/desk/layout"),
    route("POST", "/api/desk/layout/import"),
    route("POST", "/api/desk/groups"),
    route("PATCH", "/api/desk/groups/{}"),
    route("DELETE", "/api/desk/groups/{}"),
    route("POST", "/api/desk/groups/{}/move"),
    route("PUT", "/api/desk/groups/{}/items/{*}"),
    route("PUT", "/api/desk/groups/ungrouped/order"),
    // Terminals.
    route("GET", "/api/desk/terminals"),
    route("POST", "/api/desk/terminals"),
    route("POST", "/api/desk/terminals/{}/reopen"),
    route("DELETE", "/api/desk/terminals/{}"),
];

/// The sockets the page keeps open to the local hub.
const SOCKETS: &[Route] = &[
    route("GET", "/api/desk/events"),
    route("GET", "/api/desk/sessions/{}/pty"),
    route("GET", "/api/desk/terminals/{}/pty"),
];

/// A request the broker may make: its path and query exactly as asked,
/// checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allowed {
    pub method: &'static str,
    pub path: String,
    pub query: Option<String>,
}

/// Why a request was turned away. Says what was asked, never anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `method target` (a path and an optional query) as one of `DeskHub`'s
/// requests, or why it isn't one.
pub fn http(method: &str, target: &str) -> Result<Allowed, Refused> {
    allowed(HTTP, method, target)
}

/// `target` as one of the sockets the page opens, or why it isn't one.
pub fn socket(target: &str) -> Result<Allowed, Refused> {
    allowed(SOCKETS, "GET", target)
}

fn allowed(routes: &'static [Route], method: &str, target: &str) -> Result<Allowed, Refused> {
    let refuse = || {
        Refused(format!(
            "Desk doesn't send {method} {target} to this computer's hub."
        ))
    };
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    let segments = segments(path).ok_or_else(refuse)?;
    let keys = match query {
        Some(q) => Some(query_keys(q).ok_or_else(refuse)?),
        None => None,
    };
    let route = routes
        .iter()
        .find(|r| r.method == method && matches(r, &segments))
        .ok_or_else(refuse)?;
    if let Some(keys) = &keys
        && keys.iter().any(|k| !route.query.contains(&k.as_str()))
    {
        return Err(refuse());
    }
    Ok(Allowed {
        method: route.method,
        path: path.to_string(),
        query: query.filter(|q| !q.is_empty()).map(str::to_string),
    })
}

/// The characters a path segment may carry as written: what
/// `encodeURIComponent` leaves, and `%`-escapes.
fn segment_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!*'()%".contains(c)
}

/// `path`'s segments, when it is an absolute path whose every segment is
/// non-empty and written with safe characters and well-formed escapes.
/// Decoded, a segment may hold a `/` (Desk's state keys do: the hub routes
/// on the path as written, so it stays one parameter), but never a `.` or
/// `..` step or a control character, whatever reads it as a path later.
fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix('/')?;
    let parts: Vec<&str> = rest.split('/').collect();
    for p in &parts {
        if p.is_empty() || !p.chars().all(segment_char) || !escapes_ok(p) {
            return None;
        }
        let decoded = percent_decode_str(p).decode_utf8().ok()?;
        if decoded
            .split(['/', '\\'])
            .any(|step| step == "." || step == "..")
            || decoded.chars().any(char::is_control)
        {
            return None;
        }
    }
    Some(parts)
}

/// Every `%` starts a two-digit hex escape.
fn escapes_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            match (b.get(i + 1), b.get(i + 2)) {
                (Some(x), Some(y)) if x.is_ascii_hexdigit() && y.is_ascii_hexdigit() => i += 3,
                _ => return false,
            }
        } else {
            i += 1;
        }
    }
    true
}

/// The keys of a `application/x-www-form-urlencoded` query, when it is
/// written with what `URLSearchParams` writes.
fn query_keys(query: &str) -> Option<Vec<String>> {
    let ok = |c: char| c.is_ascii_alphanumeric() || "-._~!*'()%+=&".contains(c);
    if !query.chars().all(ok) || !escapes_ok(query) {
        return None;
    }
    let mut keys = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let key = pair.split_once('=').map_or(pair, |(k, _)| k);
        let key = percent_decode_str(&key.replace('+', " "))
            .decode_utf8()
            .ok()?
            .into_owned();
        keys.push(key);
    }
    Some(keys)
}

fn parts(pattern: &'static str) -> impl Iterator<Item = Part> {
    pattern[1..].split('/').map(|p| match p {
        "{}" => Part::One,
        "{*}" => Part::Tail,
        lit => Part::Lit(lit),
    })
}

fn matches(route: &Route, segments: &[&str]) -> bool {
    let pattern: Vec<Part> = parts(route.pattern).collect();
    for (i, part) in pattern.iter().enumerate() {
        match part {
            Part::Tail => {
                let tail = &segments[i.min(segments.len())..];
                return !tail.is_empty() && !route.not.contains(&tail[0]);
            }
            Part::One => {
                if i >= segments.len() {
                    return false;
                }
            }
            Part::Lit(lit) => {
                if segments.get(i) != Some(lit) {
                    return false;
                }
            }
        }
    }
    pattern.len() == segments.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every request `DeskHub` makes, as its own test records them
    /// (`src/hub/brokered.test.ts`): the page and this list can't drift.
    const RECORDED: &str = include_str!("../../../src/hub/brokered-requests.json");

    #[derive(serde::Deserialize)]
    struct Recorded {
        kind: String,
        method: String,
        path: String,
    }

    #[test]
    fn every_request_desk_hub_makes_is_allowed() {
        let recorded: Vec<Recorded> = serde_json::from_str(RECORDED).unwrap();
        assert!(recorded.len() > 60, "the recording covers DeskHub");
        for r in recorded {
            let got = match r.kind.as_str() {
                "http" => http(&r.method, &r.path),
                "socket" => socket(&r.path),
                k => panic!("unknown kind {k}"),
            };
            assert!(
                got.is_ok(),
                "{} {} {} was refused",
                r.kind,
                r.method,
                r.path
            );
        }
    }

    /// And the other way: every route allowed is one `DeskHub` uses, so the
    /// list is exactly what the page needs.
    #[test]
    fn every_route_allowed_is_one_desk_hub_uses() {
        let recorded: Vec<Recorded> = serde_json::from_str(RECORDED).unwrap();
        for (kind, routes) in [("http", HTTP), ("socket", SOCKETS)] {
            for route in routes {
                let used = recorded.iter().any(|r| {
                    let path = r.path.split('?').next().unwrap();
                    r.kind == kind
                        && r.method == route.method
                        && segments(path).is_some_and(|s| matches(route, &s))
                });
                assert!(
                    used,
                    "{} {} {} is allowed but DeskHub never asks it",
                    kind, route.method, route.pattern
                );
            }
        }
    }

    #[test]
    fn nothing_else_the_admin_token_could_do_is() {
        for (method, target) in [
            // The hub's admin surface.
            ("GET", "/api/admin/reset-model"),
            ("POST", "/api/admin/reset-model"),
            ("GET", "/api/sessions"),
            ("POST", "/api/agents/import"),
            ("GET", "/api/agents"),
            ("GET", "/api/me"),
            ("GET", "/mcp"),
            // A vault value, or its other routes.
            ("GET", "/api/vault/speech/openai/api_key"),
            ("DELETE", "/api/vault/speech/openai/api_key"),
            ("POST", "/api/vault/rename"),
            ("POST", "/api/vault/catalog"),
            ("POST", "/api/vault"),
            // Known routes, the wrong way.
            ("DELETE", "/api/desk/sessions"),
            ("GET", "/api/desk/sessions/s1/pty"),
            ("TRACE", "/api/desk/sessions"),
            ("get", "/api/desk/sessions"),
            ("GET", "/api/desk/sessions/"),
            ("GET", "/api/desk/sessions/extra"),
            ("PUT", "/api/desk/groups/g/items"),
            // Escaping the route.
            ("PATCH", "/api/desk/sessions/.."),
            ("PATCH", "/api/desk/sessions/%2e%2e"),
            ("PATCH", "/api/desk/sessions/%2E"),
            ("PATCH", "/api/desk/sessions/..%2Fadmin"),
            ("PATCH", "/api/desk/sessions/a%2F..%2Fb"),
            ("PATCH", "/api/desk/sessions/a%5C..%5Cb"),
            ("GET", "/api/agents/a/identity/..%2F..%2Fetc%2Fpasswd"),
            ("GET", "/api/agents/a/identity/.%2FSOUL.md"),
            ("PATCH", "/api/desk/sessions/a%00"),
            ("PATCH", "/api/desk/sessions/a%zz"),
            ("PATCH", "/api/desk/sessions/a%2"),
            ("PATCH", "/api/desk/sessions/a\\b"),
            ("PATCH", "/api/desk/sessions//x"),
            ("PATCH", "//api/desk/sessions/x"),
            ("PATCH", "/api/desk/sessions/a b"),
            ("PATCH", "/api/desk/sessions/a\r\nHost: x"),
            ("PATCH", "/api/desk/sessions/x#y"),
            ("PATCH", "api/desk/sessions/x"),
            ("PATCH", "http://evil.example/api/desk/sessions/x"),
            ("PUT", "/api/desk/groups/g/items/a/../../../admin"),
            ("POST", "/api/vault/a/%2e%2e/b"),
            ("PATCH", "/api/desk/sessions/é"),
            // Queries a route doesn't take, and never a token.
            ("GET", "/api/desk/sessions?token=x"),
            ("GET", "/api/desk/spend?period=day&token=x"),
            ("GET", "/api/desk/spend?period=day&%74oken=x"),
            ("GET", "/api/desk/spend?other=1"),
            ("GET", "/api/desk/spend?period=a#b"),
            ("GET", "/api/desk/spend?period=a b"),
        ] {
            assert!(
                http(method, target).is_err(),
                "{method} {target} was allowed"
            );
        }
    }

    #[test]
    fn a_route_takes_its_own_segments_and_queries() {
        let got = http("GET", "/api/desk/spend?period=week&by=engine&limit=10").unwrap();
        assert_eq!(got.path, "/api/desk/spend");
        assert_eq!(got.query.as_deref(), Some("period=week&by=engine&limit=10"));
        assert!(
            http(
                "GET",
                "/api/desk/rooms/search?q=hello+there%21&inThread=true"
            )
            .is_ok()
        );
        assert!(http("PUT", "/api/desk/groups/g1/items/session/abc%3A1").is_ok());
        assert!(http("POST", "/api/vault/speech/openai/api_key").is_ok());
        assert!(http("DELETE", "/api/desk/sessions/hidden/claude/a%2Bb").is_ok());
        // A key with a `/` in it stays one segment.
        assert!(http("PUT", "/api/desk/state/grid%2Fa%20b").is_ok());
        assert!(http("PUT", "/api/desk/state/grid%2F..x").is_ok());
        assert_eq!(http("GET", "/api/desk/sessions?").unwrap().query, None);
    }

    #[test]
    fn sockets_are_their_own_list() {
        assert!(socket("/api/desk/events").is_ok());
        assert!(socket("/api/desk/sessions/s1/pty").is_ok());
        assert!(socket("/api/desk/terminals/t%201/pty").is_ok());
        for bad in [
            "/api/desk/events?token=x",
            "/api/desk/sessions",
            "/ws/desk",
            "/api/desk/voice/relay",
            "/api/desk/sessions/../pty",
        ] {
            assert!(socket(bad).is_err(), "{bad} was allowed");
        }
    }

    #[test]
    fn a_refusal_names_only_what_was_asked() {
        let e = http("GET", "/api/admin/x").unwrap_err();
        assert_eq!(
            e.to_string(),
            "Desk doesn't send GET /api/admin/x to this computer's hub."
        );
    }
}
