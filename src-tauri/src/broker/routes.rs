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
    route("POST", "/api/desk/sessions/{}/restart"),
    route("POST", "/api/desk/sessions/{}/remove"),
    route("POST", "/api/desk/sessions/{}/end"),
    route("POST", "/api/desk/sessions/{}/approvals/{}"),
    // The colours its terminals are drawn in.
    route("PUT", "/api/desk/terminal/colors"),
    // Desk's line: a session's thread, your messages and answers, setting
    // a question aside, and putting your words in its prompt unsent.
    with_query("GET", "/api/desk/sessions/{}/line", &["before"]),
    route("POST", "/api/desk/sessions/{}/line"),
    route("PATCH", "/api/desk/line/{}"),
    route("DELETE", "/api/desk/line/{}"),
    route("POST", "/api/desk/line/{}/answer"),
    route("POST", "/api/desk/line/{}/dismiss"),
    route("POST", "/api/desk/sessions/{}/draft"),
    // Charges: which boss runs which session; Hand to, Release, the wheel.
    route("GET", "/api/desk/charges"),
    route("POST", "/api/desk/sessions/{}/charge"),
    route("DELETE", "/api/desk/sessions/{}/charge"),
    route("PATCH", "/api/desk/sessions/{}/charge"),
    // You're typing a draft to it: your draft holds its wheel.
    route("POST", "/api/desk/sessions/{}/typing"),
    // The board: boards, tickets, moves, needs, assignment and history.
    route("GET", "/api/desk/boards"),
    route("POST", "/api/desk/boards"),
    route("PATCH", "/api/desk/boards/{}"),
    route("DELETE", "/api/desk/boards/{}"),
    with_query(
        "GET",
        "/api/desk/boards/{}/tickets",
        &["state", "assignee", "q"],
    ),
    route("POST", "/api/desk/tickets"),
    // Before `tickets/{}`: the first route that matches is the one checked.
    with_query("GET", "/api/desk/tickets/search", &["q"]),
    route("GET", "/api/desk/tickets/{}"),
    route("PATCH", "/api/desk/tickets/{}"),
    route("DELETE", "/api/desk/tickets/{}"),
    route("POST", "/api/desk/tickets/{}/move"),
    route("PUT", "/api/desk/tickets/{}/needs/{}"),
    route("DELETE", "/api/desk/tickets/{}/needs/{}"),
    route("POST", "/api/desk/tickets/{}/assign"),
    // Keep or drop a ticket whose issue left its board's import filter.
    route("POST", "/api/desk/tickets/{}/left-filter"),
    with_query("GET", "/api/desk/tickets/{}/history", &["before"]),
    // A boss's plans: the list, one in full, the person's edit, pausing,
    // resuming and dropping. Approving one is the person's own (the Floor's
    // decide, as their device), never this token's.
    with_query("GET", "/api/desk/plans", &["state", "group"]),
    route("GET", "/api/desk/plans/{}"),
    route("PATCH", "/api/desk/plans/{}"),
    route("POST", "/api/desk/plans/{}/pause"),
    route("POST", "/api/desk/plans/{}/resume"),
    route("POST", "/api/desk/plans/{}/drop"),
    with_query("GET", "/api/desk/history", &["subject", "before"]),
    route("PUT", "/api/desk/sessions/{}/name"),
    route("GET", "/api/desk/sessions/closed"),
    route("GET", "/api/desk/sessions/hidden"),
    route("DELETE", "/api/desk/sessions/hidden/{}/{}"),
    route("POST", "/api/desk/sessions/clear"),
    route("POST", "/api/desk/restore"),
    route("POST", "/api/desk/restore/dismiss"),
    with_query("GET", "/api/desk/spend", &["period", "by", "limit"]),
    with_query("GET", "/api/desk/ledger", &["period", "session", "before"]),
    // Budgets, and what Desk's breaker holds.
    route("GET", "/api/desk/budgets"),
    route("POST", "/api/desk/budgets"),
    route("PATCH", "/api/desk/budgets/{}"),
    route("DELETE", "/api/desk/budgets/{}"),
    route("PUT", "/api/desk/breaker/rules"),
    route("POST", "/api/desk/breakers/continue"),
    route("POST", "/api/desk/breakers/keep"),
    route("GET", "/api/desk/engines"),
    // The person's engine accounts. A pasted sign-in is sent to the hub, and
    // never read back.
    route("GET", "/api/desk/accounts"),
    route("POST", "/api/desk/accounts"),
    route("PATCH", "/api/desk/accounts/{}"),
    route("DELETE", "/api/desk/accounts/{}"),
    route("POST", "/api/desk/accounts/sign-ins/{}/code"),
    route("DELETE", "/api/desk/accounts/sign-ins/{}"),
    route("POST", "/api/desk/accounts/switch-all"),
    route("POST", "/api/desk/accounts/needs/{}/put-off"),
    route("PUT", "/api/desk/accounts/auto-switch"),
    // Which account this computer's Claude Code is signed in to, and what
    // the person's other computers know of the accounts' plans (no token).
    route("PUT", "/api/desk/accounts/own-sign-in"),
    route("PUT", "/api/desk/accounts/standing"),
    route("POST", "/api/desk/accounts/problems/{}/dismiss"),
    route("POST", "/api/desk/sessions/{}/account"),
    // Desk Memory: what it remembers of a session, its notes, forgetting,
    // search, its index, and the person's switches.
    route("GET", "/api/desk/sessions/{}/memory"),
    route("DELETE", "/api/desk/sessions/{}/memory"),
    route("PATCH", "/api/desk/sessions/{}/memory"),
    route("POST", "/api/desk/sessions/{}/memory/derive"),
    route("PATCH", "/api/desk/memory/items/{}"),
    with_query(
        "GET",
        "/api/desk/memory/search",
        &["q", "session", "group", "kind", "limit"],
    ),
    route("GET", "/api/desk/memory/index"),
    route("POST", "/api/desk/memory/index/rebuild"),
    route("GET", "/api/desk/memory/settings"),
    route("PATCH", "/api/desk/memory/settings"),
    route("PATCH", "/api/desk/memory/groups/{}"),
    // Continuing a session in another engine: the preview (its brief, what
    // it holds and who receives it), the handoff or hand back, and where a
    // session's work came from and went.
    with_query(
        "GET",
        "/api/desk/sessions/{}/handoff",
        &["engine", "account", "place", "back", "goalOnly", "derive"],
    ),
    route("POST", "/api/desk/sessions/{}/handoff"),
    route("GET", "/api/desk/sessions/{}/lineage"),
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
    // What agents may touch on this computer.
    route("GET", "/api/desk/computer/access"),
    route("PUT", "/api/desk/computer/access"),
    with_query("GET", "/api/desk/computer/grants", &["agent"]),
    route("DELETE", "/api/desk/computer/grants/{}"),
    route("POST", "/api/desk/computer/sessions/{}/forget"),
    with_query(
        "GET",
        "/api/desk/computer/activity",
        &["agent", "kind", "before"],
    ),
    route("GET", "/api/desk/computer/disk-access"),
    // Desk's browser: its settings, which are open, Stop, and screenshots.
    route("GET", "/api/desk/browser/settings"),
    route("PUT", "/api/desk/browser/settings"),
    route("GET", "/api/desk/browser"),
    route("POST", "/api/desk/browser/stop"),
    route("GET", "/api/desk/browser/shots/{}"),
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
    route("PUT", "/api/desk/layout"),
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

/// What the page may ask of a machine's hub besides: the folders there, to
/// type a session's folder, what runs in one of its terminals (`ps` on
/// this computer can't see it), and signing Codex in there by its device
/// page (this computer signs its own Codex in itself).
const MACHINE_HTTP: &[Route] = &[
    with_query("GET", "/api/desk/folders", &["path", "hidden"]),
    // Making one there for New session (the hub makes it in its home only).
    route("POST", "/api/desk/folders"),
    route("GET", "/api/desk/terminals/{}/programs"),
    route("POST", "/api/desk/engines/sign-ins"),
    route("GET", "/api/desk/engines/sign-ins/{}"),
    route("DELETE", "/api/desk/engines/sign-ins/{}"),
    // Asked by the native side alone (see NATIVE_ONLY).
    route("GET", "/api/desk/accounts/sign-ins/{}/direct"),
];

/// Of [`MACHINE_HTTP`], what only the native side asks, never the page: the
/// page that comes back by itself for a sign-in, to listen for it.
const NATIVE_ONLY: &[Route] = &[route("GET", "/api/desk/accounts/sign-ins/{}/direct")];

/// Whether `method target` is one only the native side asks of a machine's
/// hub, matched as every route is.
pub fn native_only(method: &str, target: &str) -> bool {
    allowed(NATIVE_ONLY, method, target).is_ok()
}

/// What only the native side asks of this computer's hub, never the page
/// (they are on no list the page's requests are checked against): an
/// account's sign-in, to copy it to one of the person's machines.
const NATIVE_LOCAL: &[Route] = &[route("POST", "/api/desk/accounts/{}/hand-over")];

/// `method target` as one of the native side's own requests to this
/// computer's hub, or why it isn't one.
pub fn native_local(method: &str, target: &str) -> Result<Allowed, Refused> {
    allowed(NATIVE_LOCAL, method, target)
}

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

/// `method target` as one of `DeskHub`'s requests to a machine's hub: the
/// same as to this computer's, and [`MACHINE_HTTP`].
pub fn machine_http(method: &str, target: &str) -> Result<Allowed, Refused> {
    http(method, target).or_else(|_| allowed(MACHINE_HTTP, method, target))
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
                // Asked of a machine's hub alone: refused for this computer's.
                "machine_http" => {
                    assert!(
                        http(&r.method, &r.path).is_err(),
                        "{} {} is a machine's alone",
                        r.method,
                        r.path
                    );
                    machine_http(&r.method, &r.path)
                }
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
            // The board, the wrong way.
            ("PUT", "/api/desk/boards/b1"),
            ("GET", "/api/desk/boards/b1"),
            ("POST", "/api/desk/tickets/t1"),
            ("PATCH", "/api/desk/tickets/t1/needs/t2"),
            ("GET", "/api/desk/tickets/t1/move"),
            ("GET", "/api/desk/tickets/search?q=a&token=x"),
            ("GET", "/api/desk/tickets/t1?q=a"),
            ("GET", "/api/desk/history?subject=s1&limit=500"),
            ("GET", "/api/desk/boards/b1/tickets?token=x"),
            ("GET", "/api/desk/tickets/t1/left-filter"),
            ("PUT", "/api/desk/tickets/t1/left-filter"),
            ("POST", "/api/desk/tickets/t1/left-filter?keep=true"),
            ("POST", "/api/desk/tickets/t1/left-filter/x"),
            // A board's sync is the person's: never the hub's token, which
            // the hub refuses for it anyway (the page asks as the person).
            ("GET", "/api/desk/sync-hubs"),
            ("PUT", "/api/desk/sync-hubs/atlas"),
            ("DELETE", "/api/desk/sync-hubs/atlas"),
            ("POST", "/api/desk/boards/link/check"),
            ("PUT", "/api/desk/boards/b1/link"),
            ("DELETE", "/api/desk/boards/b1/link"),
            ("POST", "/api/desk/boards/b1/pause"),
            ("POST", "/api/desk/boards/b1/sync"),
            ("POST", "/api/desk/tickets/t1/take"),
            ("POST", "/api/me/remote-mcp-tokens/desk"),
            // Plans, the wrong way: a boss proposes and changes its plans
            // with its crew tools, never through the page.
            ("POST", "/api/desk/plans"),
            ("DELETE", "/api/desk/plans/p1"),
            ("GET", "/api/desk/plans/p1/approve"),
            ("POST", "/api/desk/plans/p1/approve"),
            ("POST", "/api/desk/plans/p1/finish"),
            ("GET", "/api/desk/plans?token=x"),
            ("GET", "/api/desk/plans?boss=sarah"),
            // Desk Memory, the wrong way.
            ("PUT", "/api/desk/sessions/s1/memory"),
            ("POST", "/api/desk/sessions/s1/memory"),
            ("GET", "/api/desk/sessions/s1/memory/derive"),
            ("GET", "/api/desk/memory/items/n1"),
            ("DELETE", "/api/desk/memory/items/n1"),
            ("DELETE", "/api/desk/memory/settings"),
            ("PUT", "/api/desk/memory/settings"),
            ("POST", "/api/desk/memory/index"),
            ("GET", "/api/desk/memory/index/rebuild"),
            ("GET", "/api/desk/memory/groups/g"),
            ("PATCH", "/api/desk/memory/groups/g/x"),
            ("GET", "/api/desk/memory/search?q=a&token=x"),
            ("GET", "/api/desk/memory/search?q=a&reader=overseer"),
            ("GET", "/api/desk/memory/search?q=a&since=2026-11-01"),
            ("GET", "/api/desk/sessions/s1/memory?q=a"),
            ("GET", "/api/desk/spend?period=a#b"),
            ("GET", "/api/desk/spend?period=a b"),
        ] {
            assert!(
                http(method, target).is_err(),
                "{method} {target} was allowed"
            );
        }
    }

    /// Moves between groups (and the handover notes they carry) are the
    /// hub holder's alone: the page asks them as the person over the paired
    /// path, and the broker's token, which the hub refuses for them, is
    /// never let ask them, nor is a machine's.
    #[test]
    fn moves_are_asked_as_the_person_never_through_the_broker() {
        for (method, target) in [
            ("POST", "/api/desk/moves/preview"),
            ("POST", "/api/desk/moves"),
            ("GET", "/api/desk/handovers/h1"),
            ("GET", "/api/desk/moves/preview"),
            ("PUT", "/api/desk/handovers/h1"),
        ] {
            assert!(
                http(method, target).is_err(),
                "{method} {target} was allowed"
            );
            assert!(
                machine_http(method, target).is_err(),
                "{method} {target} was allowed on a machine"
            );
            assert!(
                native_local(method, target).is_err(),
                "{method} {target} was native"
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
        // Search is its own route, not a ticket called "search".
        assert!(http("GET", "/api/desk/tickets/search?q=ACM-12").is_ok());
        assert!(http("GET", "/api/desk/tickets/t1").is_ok());
        assert!(http("GET", "/api/desk/history?subject=s1&before=e1").is_ok());
    }

    #[test]
    fn desk_memory_takes_a_sessions_memory_its_notes_search_and_switches() {
        for (method, target) in [
            ("GET", "/api/desk/sessions/s1/memory"),
            ("DELETE", "/api/desk/sessions/s1/memory"),
            ("PATCH", "/api/desk/sessions/s1/memory"),
            ("POST", "/api/desk/sessions/s1/memory/derive"),
            ("PATCH", "/api/desk/memory/items/n1"),
            ("GET", "/api/desk/memory/index"),
            ("POST", "/api/desk/memory/index/rebuild"),
            ("GET", "/api/desk/memory/settings"),
            ("PATCH", "/api/desk/memory/settings"),
            ("PATCH", "/api/desk/memory/groups/g-acme"),
        ] {
            assert!(
                http(method, target).is_ok(),
                "{method} {target} was refused"
            );
        }
        let got = http(
            "GET",
            "/api/desk/memory/search?q=the+cookie&session=s1&group=g&kind=decisions&limit=20",
        )
        .unwrap();
        assert_eq!(got.path, "/api/desk/memory/search");
        assert_eq!(
            got.query.as_deref(),
            Some("q=the+cookie&session=s1&group=g&kind=decisions&limit=20")
        );
        // A machine's hub takes the same, and the composer's /recall search
        // of a session's own group there.
        assert!(machine_http("PATCH", "/api/desk/memory/groups/g-acme").is_ok());
        assert!(
            machine_http(
                "GET",
                "/api/desk/memory/search?q=cookie&group=g-acme&limit=20"
            )
            .is_ok()
        );
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

    /// An account's sign-in leaves this computer's hub only for the native
    /// side: the page can't ask it of this computer's hub or a machine's.
    #[test]
    fn an_accounts_sign_in_is_asked_by_the_native_side_alone() {
        let id = "0f8e5a4c-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
        let path = format!("/api/desk/accounts/{id}/hand-over");
        assert!(native_local("POST", &path).is_ok());
        assert!(http("POST", &path).is_err());
        assert!(machine_http("POST", &path).is_err());
        assert!(
            !native_only("POST", &path),
            "never through a machine either"
        );
        assert!(native_local("GET", &path).is_err());
        for odd in [
            "/api/desk/accounts/../sessions/hand-over",
            "/api/desk/accounts/x/hand-over?token=t",
            "/api/desk/accounts/x/hand-over/more",
            "/api/desk/accounts/hand-over",
        ] {
            assert!(native_local("POST", odd).is_err(), "{odd}");
        }
        // Nothing else of this computer's hub through this list.
        assert!(native_local("GET", "/api/desk/accounts").is_err());
        assert!(native_local("POST", "/api/desk/accounts").is_err());
    }

    /// A machine's hub takes what this computer's does, and its folders
    /// and a terminal's programs; nothing else.
    #[test]
    fn a_machine_takes_the_same_list_and_its_folders() {
        assert!(machine_http("GET", "/api/desk/sessions").is_ok());
        assert!(machine_http("GET", "/api/desk/folders?path=%2Fhome%2Fdev&hidden=1").is_ok());
        assert!(machine_http("POST", "/api/desk/folders").is_ok());
        assert!(
            http("POST", "/api/desk/folders").is_err(),
            "not this computer's"
        );
        assert!(machine_http("GET", "/api/desk/terminals/t1/programs").is_ok());
        assert!(machine_http("POST", "/api/desk/engines/sign-ins").is_ok());
        assert!(machine_http("GET", "/api/desk/engines/sign-ins/e1").is_ok());
        assert!(machine_http("DELETE", "/api/desk/engines/sign-ins/e1").is_ok());
        assert!(native_only("GET", "/api/desk/accounts/sign-ins/s1/direct"));
        assert!(
            native_only("GET", "/api/desk/accounts/sign-ins/s1/%64irect")
                || machine_http("GET", "/api/desk/accounts/sign-ins/s1/%64irect").is_err()
        );
        assert!(!native_only("POST", "/api/desk/accounts/sign-ins/s1/code"));
        assert!(http("GET", "/api/desk/accounts/sign-ins/s1/direct").is_err());
        assert!(
            http("GET", "/api/desk/folders").is_err(),
            "not this computer's"
        );
        assert!(
            http("POST", "/api/desk/engines/sign-ins").is_err(),
            "not this computer's"
        );
        for (m, p) in [
            ("GET", "/api/desk/folders?path=x&token=y"),
            ("POST", "/api/desk/folders?path=x"),
            ("PUT", "/api/desk/folders"),
            ("GET", "/api/desk/terminals/t1/programs/x"),
            ("GET", "/api/admin/reset-model"),
            ("GET", "/api/vault/speech/openai/api_key"),
            ("GET", "/api/desk/folders/%2e%2e"),
            ("GET", "/api/desk/engines/sign-ins"),
            ("PATCH", "/api/desk/engines/sign-ins/e1"),
            ("POST", "/api/desk/engines/sign-ins/e1/code"),
        ] {
            assert!(machine_http(m, p).is_err(), "{m} {p}");
        }
    }
}
