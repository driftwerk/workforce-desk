//! "Use this Mac's accounts" on a machine: copies this computer's Claude
//! accounts (Desk's own, each a `claude setup-token` token) to one of the
//! person's machines, so its sessions run on the same subscriptions, and its
//! hub moves them to another account at a limit as this computer's does.
//!
//! - **Asked once, natively, naming the accounts and the machine.** Nothing
//!   is read before the person's yes.
//! - **Over SSH alone.** Each token is read from this computer's hub by the
//!   native side (`POST /api/desk/accounts/{id}/hand-over`, a route the page
//!   can't ask, see [`crate::broker::routes::native_local`]) and sent in a
//!   request body to the machine's hub through Desk's forward to it (the
//!   machine's broker), as a pasted token is. Never in a command line, an
//!   environment, a file on this computer or a log; the page never sees it.
//! - **Kept there as a sign-in made there is**: the machine's hub checks it
//!   with its Claude Code, then keeps it in its private file store (0600).
//! - **Removed per machine** from the machine's own accounts, which never
//!   touches this computer's.
//! - **Signed in from the first session.** A machine whose Claude Code was
//!   never logged in, with no default account, takes this computer's first
//!   account (the order a switch takes them: the default, then the oldest)
//!   as its default, so its sessions start signed in, never at a login.
//! - **Never synced back.** A setup-token token is not refreshed: it works
//!   for a year wherever it is set, so the copy and this computer's are the
//!   same token, and neither makes the other stale. ChatGPT's sign-in is
//!   different (its refresh token turns over as it is used, and two
//!   computers using one log each other out), so it is never copied: the
//!   machine signs in to ChatGPT on its own, with Codex's device page.

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::CommandResult;
use crate::broker::{Answer, Broker, NativeAnswer};
use crate::machines::MachineIo;

/// What this computer is called to the person.
const HERE: &str = if cfg!(target_os = "macos") {
    "this Mac"
} else {
    "this computer"
};

/// Who is asked, and what: the machine, as the person knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub name: String,
    /// Its SSH address (`dev@2.29.244.189`).
    pub target: String,
}

/// One account as a hub lists it (never with its token).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub engine: String,
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub signed_in: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accounts {
    #[serde(default)]
    accounts: Vec<Listed>,
    /// Where the hub keeps sign-ins; none: it keeps no accounts.
    store: Option<String>,
    #[serde(default)]
    auto_switch: bool,
}

/// An account's sign-in, as this computer's hub hands it over.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandOver {
    token: String,
}

/// What copying did, for the page: names only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    /// The person said no: nothing was read or sent.
    pub cancelled: bool,
    pub copied: Vec<String>,
    /// There already, by name: left as they are.
    pub already: Vec<String>,
    pub failed: Vec<Failed>,
    /// The machine now moves sessions to another account at a limit, as
    /// this computer does.
    pub auto_switch: bool,
    /// The account the machine's sessions now start on by default: its
    /// Claude Code isn't signed in by itself, and it had none.
    pub made_default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failed {
    pub name: String,
    pub why: String,
}

/// A hub, as copying reaches it: this computer's through its broker, the
/// machine's through its own.
pub trait Hub: Sync {
    fn fetch(
        &self,
        method: &str,
        target: &str,
        body: Option<serde_json::Value>,
    ) -> impl Future<Output = Result<Answer, String>> + Send;
}

/// This computer's hub, which also hands over an account's sign-in.
pub trait Mine: Hub {
    fn hand_over(&self, account: &str)
    -> impl Future<Output = Result<NativeAnswer, String>> + Send;
}

/// The Claude accounts of this computer's that are signed in.
pub fn claude_accounts(listed: &[Listed]) -> Vec<&Listed> {
    listed
        .iter()
        .filter(|a| a.engine == "claude" && a.signed_in)
        .collect()
}

/// "Work", "Work and Personal", "Work, Personal and Spare".
pub fn names(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The native question: the accounts, the machine and who can use them
/// there, Cancel first.
pub fn question(place: &Place, copying: &[&str]) -> String {
    let what = if copying.len() == 1 {
        format!("your Claude account {}", names(copying))
    } else {
        format!("your Claude accounts {}", names(copying))
    };
    format!(
        "Copy {what} to {name}?\n\n{target}\n\nTheir sign-ins go over SSH into Desk's private file on {name}. Anyone who can sign in to {name} as that user, or who controls {name}, can use them. Removing them in Desk deletes them there while Desk can reach {name}; to stop a copy working anywhere, revoke it at claude.ai. {HERE} keeps its own.",
        name = place.name,
        target = place.target,
    )
}

/// The `error` a hub said, or its status.
fn said(a: &Answer) -> String {
    said_in(a.status, &a.body)
}

fn said_in(status: u16, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("its Desk answered {status}"))
}

/// Whether Claude Code on the machine is signed in by itself, as its hub
/// last read it; `None` when it can't say yet, or its hub couldn't be
/// asked.
async fn signed_in_there(hub: &impl Hub) -> Option<bool> {
    let a = hub.fetch("GET", "/api/desk/engines", None).await.ok()?;
    if a.status != 200 {
        return None;
    }
    let engines: Vec<serde_json::Value> = serde_json::from_str(&a.body).ok()?;
    let claude = engines.iter().find(|e| e["engine"] == "claude")?;
    match claude["signIn"]["state"].as_str() {
        Some("in") => Some(true),
        Some("out") => Some(false),
        // Not read yet (a hub just started), or unreadable: don't guess.
        _ => None,
    }
}

/// Makes the machine's account that comes first in `order` (names, this
/// computer's switch order), else its first, its default: what a session
/// there starts on. Nothing secret is sent, so it isn't asked about.
async fn make_default_there(theirs: &impl Hub, order: &[&str]) -> Option<String> {
    let there = accounts_of(theirs, "the machine's").await.ok()?;
    let signed_in: Vec<&Listed> = claude_accounts(&there.accounts);
    if signed_in.iter().any(|a| a.is_default) {
        return None;
    }
    let first = order
        .iter()
        .find_map(|n| signed_in.iter().find(|a| a.name.eq_ignore_ascii_case(n)))
        .or_else(|| signed_in.first())?;
    let path = account_path(&first.id).ok()?;
    let r = theirs
        .fetch("PATCH", &path, Some(serde_json::json!({"isDefault": true})))
        .await
        .ok()?;
    (r.status < 300).then(|| first.name.clone())
}

async fn accounts_of(hub: &impl Hub, whose: &str) -> Result<Accounts, String> {
    let a = hub.fetch("GET", "/api/desk/accounts", None).await?;
    if a.status == 404 {
        return Ok(Accounts::default());
    }
    if a.status != 200 {
        return Err(format!("Desk couldn't read {whose} accounts: {}", said(&a)));
    }
    serde_json::from_str(&a.body).map_err(|_| format!("Desk couldn't read {whose} accounts."))
}

/// Copies this computer's signed-in Claude accounts to the machine at
/// `place` (see the module): those it hasn't already, by name, once
/// `ask` (the native question) says yes. The first to be this computer's
/// default becomes the machine's, when it has none; the machine switches
/// at a limit when this computer does.
pub async fn share<A, F>(
    mine: &impl Mine,
    theirs: &impl Hub,
    place: &Place,
    ask: A,
) -> Result<Shared, String>
where
    A: FnOnce(String) -> F,
    F: Future<Output = bool>,
{
    let here = accounts_of(mine, &format!("{HERE}'s")).await?;
    let mut wanted = claude_accounts(&here.accounts);
    // In the order a switch takes them: the default, then the oldest.
    wanted.sort_by_key(|a| !a.is_default);
    let order: Vec<&str> = wanted.iter().map(|a| a.name.as_str()).collect();
    if wanted.is_empty() {
        return Err(format!(
            "{} has no Claude accounts to copy. Add one in Settings → Engines first.",
            capital(HERE)
        ));
    }
    let there = accounts_of(theirs, &format!("{}'s", place.name)).await?;
    if there.store.is_none() {
        return Err(format!(
            "Desk on {} keeps no accounts yet. Update it to match {HERE}, then try again.",
            place.name
        ));
    }
    let taken = |name: &str| {
        there
            .accounts
            .iter()
            .any(|a| a.engine == "claude" && a.name.eq_ignore_ascii_case(name))
    };
    let (already, copying): (Vec<&Listed>, Vec<&Listed>) =
        wanted.into_iter().partition(|a| taken(&a.name));
    let mut shared = Shared {
        already: already.iter().map(|a| a.name.clone()).collect(),
        ..Shared::default()
    };
    let mut has_default = there
        .accounts
        .iter()
        .any(|a| a.engine == "claude" && a.is_default && a.signed_in);
    // No sign-in of its own there: a session starts on the default.
    let needs_default = !has_default && signed_in_there(theirs).await == Some(false);
    if copying.is_empty() {
        if needs_default {
            shared.made_default = make_default_there(theirs, &order).await;
        }
        return Ok(shared);
    }
    let named: Vec<&str> = copying.iter().map(|a| a.name.as_str()).collect();
    if !ask(question(place, &named)).await {
        shared.cancelled = true;
        return Ok(shared);
    }
    for a in copying {
        let fail = |why: String| Failed {
            name: a.name.clone(),
            why,
        };
        let handed = match mine.hand_over(&a.id).await {
            Ok(h) if h.status == 200 => h,
            Ok(h) => {
                shared.failed.push(fail(format!(
                    "Desk on {HERE} didn't give its sign-in: {}",
                    said_in(h.status, &h.body)
                )));
                continue;
            }
            Err(e) => {
                shared.failed.push(fail(e));
                continue;
            }
        };
        let Ok(HandOver { token }) = serde_json::from_str::<HandOver>(&handed.body) else {
            shared
                .failed
                .push(fail(format!("Desk on {HERE} didn't give its sign-in.")));
            continue;
        };
        let token = zeroize::Zeroizing::new(token);
        let make_default = !has_default && (a.is_default || needs_default);
        let body = serde_json::json!({
            "engine": "claude",
            "name": a.name,
            "token": token.as_str(),
            "makeDefault": make_default,
        });
        drop(token);
        match theirs.fetch("POST", "/api/desk/accounts", Some(body)).await {
            Ok(r) if r.status == 200 || r.status == 201 => {
                has_default |= make_default;
                if make_default {
                    shared.made_default = Some(a.name.clone());
                }
                shared.copied.push(a.name.clone());
            }
            Ok(r) => shared
                .failed
                .push(fail(format!("{} refused it: {}", place.name, said(&r)))),
            // Sent, with no answer: it may have got there all the same.
            Err(e) => shared.failed.push(fail(format!(
                "{e} It may be on {name} anyway: look at {name}'s accounts before copying it again.",
                name = place.name
            ))),
        }
    }
    // One that was already there, when none copied could be.
    if needs_default && !has_default {
        shared.made_default = make_default_there(theirs, &order).await;
    }
    if here.auto_switch && !there.auto_switch && !shared.copied.is_empty() {
        let on = theirs
            .fetch(
                "PUT",
                "/api/desk/accounts/auto-switch",
                Some(serde_json::json!({"on": true})),
            )
            .await;
        shared.auto_switch = matches!(on, Ok(r) if r.status < 300);
    } else {
        shared.auto_switch = there.auto_switch;
    }
    tracing::info!(
        machine = %place.name,
        copied = shared.copied.len(),
        made_default = shared.made_default.is_some(),
        already = shared.already.len(),
        failed = shared.failed.len(),
        "copied this computer's accounts to a machine"
    );
    Ok(shared)
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// This computer's hub, through its broker.
struct Local<'a>(&'a Broker);

impl Hub for Local<'_> {
    fn fetch(
        &self,
        method: &str,
        target: &str,
        body: Option<serde_json::Value>,
    ) -> impl Future<Output = Result<Answer, String>> + Send {
        self.0.fetch(method, target, json_body(body))
    }
}

impl Mine for Local<'_> {
    fn hand_over(
        &self,
        account: &str,
    ) -> impl Future<Output = Result<NativeAnswer, String>> + Send {
        let path = hand_over_path(account);
        async move { self.0.fetch_native("POST", &path?).await }
    }
}

/// Where account `account`'s sign-in is asked for: only ever an account's
/// id as the hub gives them (a UUID).
fn hand_over_path(account: &str) -> Result<String, String> {
    let uuid = account.len() == 36
        && account.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    if !uuid {
        return Err("That isn't one of this computer's accounts.".into());
    }
    Ok(format!("/api/desk/accounts/{account}/hand-over"))
}

/// Where a machine's account `account` is changed: only ever an account's
/// id as its hub listed it.
fn account_path(account: &str) -> Result<String, String> {
    let ok = !account.is_empty()
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err("That isn't one of the machine's accounts.".into());
    }
    Ok(format!("/api/desk/accounts/{account}"))
}

/// A machine's hub, through its broker (and so its forward).
struct Theirs(std::sync::Arc<Broker>);

impl Hub for Theirs {
    fn fetch(
        &self,
        method: &str,
        target: &str,
        body: Option<serde_json::Value>,
    ) -> impl Future<Output = Result<Answer, String>> + Send {
        self.0.fetch(method, target, json_body(body))
    }
}

/// How long a Cancel quietens the question, doubling with each Cancel in
/// a row (as adding a machine's question does), so a script asking in a
/// loop gets refusals, not a stream of dialogs.
const QUIET_AFTER_CANCEL: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_QUIET: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Default)]
struct AskState {
    open: bool,
    cancels: u32,
    quiet_until: Option<std::time::Instant>,
}

/// One question about copying accounts at a time, and none for a while
/// after a Cancel.
pub struct ShareGate {
    state: std::sync::Mutex<AskState>,
    quiet: std::time::Duration,
}

/// The question is open until this drops.
pub struct Asking<'a>(&'a ShareGate);

impl ShareGate {
    pub const fn with_quiet(quiet: std::time::Duration) -> Self {
        Self {
            state: std::sync::Mutex::new(AskState {
                open: false,
                cancels: 0,
                quiet_until: None,
            }),
            quiet,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AskState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self) -> Result<Asking<'_>, String> {
        let mut st = self.lock();
        if st.open {
            return Err("Desk is already asking about copying accounts.".into());
        }
        if let Some(left) = st
            .quiet_until
            .and_then(|u| u.checked_duration_since(std::time::Instant::now()))
            .filter(|l| !l.is_zero())
        {
            return Err(format!(
                "Copying accounts was cancelled. Try again in {} seconds.",
                left.as_secs().max(1)
            ));
        }
        st.open = true;
        Ok(Asking(self))
    }

    /// The person answered: a yes clears the wait, a Cancel lengthens it.
    pub fn answered(&self, agreed: bool) {
        let mut st = self.lock();
        if agreed {
            st.cancels = 0;
            st.quiet_until = None;
        } else {
            st.cancels = st.cancels.saturating_add(1);
            let wait = self
                .quiet
                .saturating_mul(1 << (st.cancels - 1).min(16))
                .min(MAX_QUIET);
            st.quiet_until = Some(std::time::Instant::now() + wait);
        }
    }
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.lock().open = false;
    }
}

static GATE: ShareGate = ShareGate::with_quiet(QUIET_AFTER_CANCEL);

/// "Use this Mac's accounts" on machine `id` (see the module).
#[tauri::command]
pub async fn machine_share_accounts(
    app: tauri::AppHandle,
    local: tauri::State<'_, Broker>,
    io: tauri::State<'_, MachineIo>,
    id: String,
) -> CommandResult<Shared> {
    let link = io.link(&id)?;
    let place = Place {
        name: link.machine().name.clone(),
        target: link.machine().target.to_string(),
    };
    let theirs = Theirs(io.broker(&id)?);
    let _asking = GATE.start()?;
    let confirm = crate::pair_gate::NativeConfirm(app.clone());
    share(&Local(&local), &theirs, &place, |question| async move {
        let yes = tauri::async_runtime::spawn_blocking(move || {
            confirm.ask(&format!("Use {HERE}'s accounts"), question, "Copy Accounts")
        })
        .await
        .unwrap_or(false);
        GATE.answered(yes);
        yes
    })
    .await
}

/// The page-facing body of a request (JSON, as `DeskHub` sends it).
pub fn json_body(body: Option<serde_json::Value>) -> Option<(String, Vec<u8>)> {
    body.map(|b| ("application/json".to_string(), b.to_string().into_bytes()))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    const TOKEN: &str = "sk-ant-oat01-work-0123456789abcdefghijklmnopqrstuvwxyz";

    fn answer(status: u16, body: serde_json::Value) -> Answer {
        Answer {
            status,
            content_type: Some("application/json".into()),
            body: body.to_string(),
        }
    }

    /// A hub as a test sets it: its accounts, what it was asked.
    #[derive(Default)]
    struct Fake {
        accounts: Mutex<serde_json::Value>,
        asked: Mutex<Vec<(String, String, Option<serde_json::Value>)>>,
        refuse_add: bool,
        /// The add is sent, and the connection drops before any answer.
        drop_add: bool,
        refuse_hand_over: Option<String>,
        /// What its engines say of Claude Code's own sign-in (`in`, `out`);
        /// none: its hub doesn't say (as an older one).
        claude_sign_in: Option<&'static str>,
    }

    impl Fake {
        fn with(accounts: serde_json::Value) -> Self {
            Self {
                accounts: Mutex::new(accounts),
                ..Self::default()
            }
        }
        fn asked(&self) -> Vec<(String, String, Option<serde_json::Value>)> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Hub for Fake {
        fn fetch(
            &self,
            method: &str,
            target: &str,
            body: Option<serde_json::Value>,
        ) -> impl Future<Output = Result<Answer, String>> + Send {
            self.asked
                .lock()
                .unwrap()
                .push((method.into(), target.into(), body.clone()));
            let out = match (method, target) {
                ("GET", "/api/desk/accounts") => {
                    Ok(answer(200, self.accounts.lock().unwrap().clone()))
                }
                ("POST", "/api/desk/accounts") if self.drop_add => {
                    Err("Desk couldn't reach devbox's hub: connection closed.".into())
                }
                ("POST", "/api/desk/accounts") if self.refuse_add => Ok(answer(
                    400,
                    serde_json::json!({"error": "Claude Code there didn't take that sign-in"}),
                )),
                ("POST", "/api/desk/accounts") => {
                    let b = body.unwrap();
                    let mut all = self.accounts.lock().unwrap();
                    all["accounts"]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!({
                            "id": format!("m-{}", b["name"].as_str().unwrap()),
                            "engine": "claude",
                            "name": b["name"],
                            "isDefault": b["makeDefault"],
                            "signedIn": true,
                        }));
                    Ok(answer(201, serde_json::json!({"kind": "account"})))
                }
                ("PUT", "/api/desk/accounts/auto-switch") => {
                    Ok(answer(204, serde_json::Value::Null))
                }
                ("GET", "/api/desk/engines") => match self.claude_sign_in {
                    Some(state) => Ok(answer(
                        200,
                        serde_json::json!([
                            {"engine": "codex", "signIn": {"state": "out"}},
                            {"engine": "claude", "signIn": {"state": state}},
                        ]),
                    )),
                    None => Ok(answer(404, serde_json::Value::Null)),
                },
                ("PATCH", t) if t.starts_with("/api/desk/accounts/") => {
                    let id = t.trim_start_matches("/api/desk/accounts/");
                    let make = body.as_ref().unwrap()["isDefault"] == true;
                    let mut all = self.accounts.lock().unwrap();
                    for a in all["accounts"].as_array_mut().unwrap() {
                        if make {
                            a["isDefault"] = serde_json::json!(a["id"] == id);
                        }
                    }
                    Ok(answer(200, serde_json::json!({})))
                }
                _ => Ok(answer(404, serde_json::Value::Null)),
            };
            async move { out }
        }
    }

    impl Mine for Fake {
        fn hand_over(
            &self,
            account: &str,
        ) -> impl Future<Output = Result<NativeAnswer, String>> + Send {
            self.asked
                .lock()
                .unwrap()
                .push(("POST".into(), format!("hand-over {account}"), None));
            let out = match &self.refuse_hand_over {
                Some(id) if id == account => Ok(answer(
                    409,
                    serde_json::json!({"error": "its sign-in is no longer in the keychain"}),
                )),
                _ => Ok(answer(
                    200,
                    serde_json::json!({"engine": "claude", "name": account, "isDefault": false, "token": format!("{TOKEN}-{account}")}),
                )),
            }
            .map(|a: Answer| NativeAnswer {
                status: a.status,
                body: zeroize::Zeroizing::new(a.body),
            });
            async move { out }
        }
    }

    fn mac() -> Fake {
        Fake::with(serde_json::json!({
            "store": "the keychain",
            "autoSwitch": true,
            "accounts": [
                {"id": "work", "engine": "claude", "name": "Work", "isDefault": true, "signedIn": true},
                {"id": "personal", "engine": "claude", "name": "Personal", "isDefault": false, "signedIn": true},
                {"id": "gone", "engine": "claude", "name": "Gone", "isDefault": false, "signedIn": false},
            ],
            "signIns": [],
        }))
    }

    fn devbox() -> Fake {
        Fake::with(
            serde_json::json!({"store": "Desk's private file", "autoSwitch": false, "accounts": [], "signIns": []}),
        )
    }

    /// This Mac as it really is: its sessions on its own sign-in, so no
    /// account is the default.
    fn mac_without_default() -> Fake {
        Fake::with(serde_json::json!({
            "store": "the keychain",
            "autoSwitch": true,
            "accounts": [
                {"id": "work", "engine": "claude", "name": "Work", "isDefault": false, "signedIn": true},
                {"id": "personal", "engine": "claude", "name": "Personal", "isDefault": false, "signedIn": true},
            ],
            "signIns": [],
        }))
    }

    /// A machine Claude Code was never logged in on.
    fn never_logged_in() -> Fake {
        Fake {
            claude_sign_in: Some("out"),
            ..devbox()
        }
    }

    fn defaults(hub: &Fake) -> Vec<String> {
        hub.accounts.lock().unwrap()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["isDefault"] == true)
            .map(|a| a["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn place() -> Place {
        Place {
            name: "devbox".into(),
            target: "dev@2.29.244.189".into(),
        }
    }

    fn block<T>(f: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn asks_once_naming_the_accounts_then_copies_each_over_the_machines_hub_with_its_default_and_auto_switch()
     {
        let (mine, theirs) = (mac(), devbox());
        let questions = Mutex::new(Vec::new());
        let shared = block(share(&mine, &theirs, &place(), |q| {
            questions.lock().unwrap().push(q);
            async { true }
        }))
        .unwrap();
        assert_eq!(shared.copied, ["Work", "Personal"]);
        assert!(shared.failed.is_empty() && shared.already.is_empty() && !shared.cancelled);
        assert!(shared.auto_switch);
        let q = questions.into_inner().unwrap();
        assert_eq!(q.len(), 1, "one question for every account");
        assert!(
            q[0].starts_with("Copy your Claude accounts Work and Personal to devbox?"),
            "{}",
            q[0]
        );
        assert!(
            q[0].contains("dev@2.29.244.189") && q[0].contains("private file"),
            "{}",
            q[0]
        );
        assert!(!q[0].contains("Gone"), "only accounts signed in here");

        // Each token goes to the machine's hub as a pasted one does, in the
        // body alone; Work stays the default.
        let posted: Vec<serde_json::Value> = theirs
            .asked()
            .into_iter()
            .filter(|(m, t, _)| m == "POST" && t == "/api/desk/accounts")
            .map(|(_, _, b)| b.unwrap())
            .collect();
        assert_eq!(posted.len(), 2);
        assert_eq!(posted[0]["name"], "Work");
        assert_eq!(posted[0]["makeDefault"], true);
        assert_eq!(posted[0]["token"], format!("{TOKEN}-work"));
        assert_eq!(posted[1]["makeDefault"], false);
        assert!(theirs.asked().iter().any(|(m, t, b)| m == "PUT"
            && t == "/api/desk/accounts/auto-switch"
            && b.as_ref().unwrap()["on"] == true));
        // This computer was asked for those two, nothing else of its, and never asked to change.
        let of_mine: Vec<String> = mine
            .asked()
            .into_iter()
            .map(|(m, t, _)| format!("{m} {t}"))
            .collect();
        assert_eq!(
            of_mine,
            [
                "GET /api/desk/accounts",
                "POST hand-over work",
                "POST hand-over personal"
            ]
        );
        // What the page is told never holds a token.
        assert!(!serde_json::to_string(&shared).unwrap().contains("sk-ant"));
    }

    #[test]
    fn a_machine_never_logged_in_takes_the_first_account_as_its_default() {
        let (mine, theirs) = (mac_without_default(), never_logged_in());
        let shared = block(share(&mine, &theirs, &place(), |_| async { true })).unwrap();
        assert_eq!(shared.copied, ["Work", "Personal"]);
        assert_eq!(shared.made_default.as_deref(), Some("Work"));
        let posted: Vec<serde_json::Value> = theirs
            .asked()
            .into_iter()
            .filter(|(m, t, _)| m == "POST" && t == "/api/desk/accounts")
            .map(|(_, _, b)| b.unwrap())
            .collect();
        assert_eq!(
            (
                posted[0]["name"].as_str(),
                posted[0]["makeDefault"].as_bool()
            ),
            (Some("Work"), Some(true))
        );
        assert_eq!(posted[1]["makeDefault"], false);
        assert_eq!(defaults(&theirs), ["Work"]);

        // Signed in there by itself: its sessions stay on its own sign-in.
        let signed_in = Fake {
            claude_sign_in: Some("in"),
            ..devbox()
        };
        let shared = block(share(
            &mac_without_default(),
            &signed_in,
            &place(),
            |_| async { true },
        ))
        .unwrap();
        assert_eq!(shared.made_default, None);
        assert!(defaults(&signed_in).is_empty());

        // Not read yet there: left to the machine's hub.
        let unknown = Fake {
            claude_sign_in: Some("unknown"),
            ..devbox()
        };
        let shared = block(share(
            &mac_without_default(),
            &unknown,
            &place(),
            |_| async { true },
        ))
        .unwrap();
        assert_eq!(shared.made_default, None);
        assert!(defaults(&unknown).is_empty());

        // An older hub that doesn't say: left to the machine's hub.
        let older = devbox();
        let shared = block(share(&mac_without_default(), &older, &place(), |_| async {
            true
        }))
        .unwrap();
        assert_eq!(shared.made_default, None);
    }

    #[test]
    fn copying_again_to_a_machine_left_without_a_default_makes_one_without_asking() {
        // As the first copy left the machine: both there, neither the default.
        let theirs = Fake {
            claude_sign_in: Some("out"),
            ..Fake::with(serde_json::json!({
                "store": "Desk's private file",
                "autoSwitch": true,
                "accounts": [
                    {"id": "m-personal", "engine": "claude", "name": "Personal", "isDefault": false, "signedIn": true},
                    {"id": "m-work", "engine": "claude", "name": "Work", "isDefault": false, "signedIn": true},
                ],
            }))
        };
        let shared = block(share(
            &mac_without_default(),
            &theirs,
            &place(),
            |_| async { panic!("nothing secret is sent: nothing to ask") },
        ))
        .unwrap();
        assert_eq!(shared.already, ["Work", "Personal"]);
        assert_eq!(
            shared.made_default.as_deref(),
            Some("Work"),
            "this Mac's first, not the machine's"
        );
        assert_eq!(defaults(&theirs), ["Work"]);
        assert!(theirs.asked().iter().any(|(m, t, b)| m == "PATCH"
            && t == "/api/desk/accounts/m-work"
            && b.as_ref().unwrap()["isDefault"] == true));
    }

    #[test]
    fn when_the_first_cant_be_copied_the_next_is_the_default() {
        let mine = Fake {
            refuse_hand_over: Some("work".into()),
            ..mac_without_default()
        };
        let theirs = never_logged_in();
        let shared = block(share(&mine, &theirs, &place(), |_| async { true })).unwrap();
        assert_eq!(shared.copied, ["Personal"]);
        assert_eq!(shared.made_default.as_deref(), Some("Personal"));
        assert_eq!(defaults(&theirs), ["Personal"]);
    }

    #[test]
    fn a_no_reads_and_sends_nothing() {
        let (mine, theirs) = (mac(), devbox());
        let shared = block(share(&mine, &theirs, &place(), |_| async { false })).unwrap();
        assert!(shared.cancelled && shared.copied.is_empty());
        assert!(
            mine.asked()
                .iter()
                .all(|(_, t, _)| !t.starts_with("hand-over"))
        );
        assert!(theirs.asked().iter().all(|(m, _, _)| m == "GET"));
    }

    #[test]
    fn copying_again_asks_nothing_and_changes_nothing() {
        let (mine, theirs) = (mac(), devbox());
        block(share(&mine, &theirs, &place(), |_| async { true })).unwrap();
        let again = block(share(&mine, &theirs, &place(), |_| async {
            panic!("nothing new to ask about")
        }))
        .unwrap();
        assert_eq!(again.already, ["Work", "Personal"]);
        assert!(again.copied.is_empty());
        assert_eq!(
            theirs
                .asked()
                .iter()
                .filter(|(m, _, _)| m == "POST")
                .count(),
            2
        );
    }

    #[test]
    fn the_machines_own_default_and_names_are_kept() {
        let mine = mac();
        let theirs = Fake::with(serde_json::json!({
            "store": "Desk's private file",
            "autoSwitch": true,
            "accounts": [{"id": "own", "engine": "claude", "name": "work", "isDefault": true, "signedIn": true}],
        }));
        let shared = block(share(&mine, &theirs, &place(), |q| {
            assert!(
                q.starts_with("Copy your Claude account Personal to devbox?"),
                "{q}"
            );
            async { true }
        }))
        .unwrap();
        assert_eq!(
            (shared.already.as_slice(), shared.copied.as_slice()),
            (&["Work".to_string()][..], &["Personal".to_string()][..])
        );
        let posted = theirs
            .asked()
            .into_iter()
            .find(|(m, _, _)| m == "POST")
            .unwrap()
            .2
            .unwrap();
        assert_eq!(posted["makeDefault"], false, "the machine's default stays");
        assert!(
            !theirs.asked().iter().any(|(m, _, _)| m == "PUT"),
            "already switching"
        );
    }

    #[test]
    fn a_failure_is_said_per_account_and_the_rest_go_on() {
        let mine = Fake {
            refuse_hand_over: Some("work".into()),
            ..mac()
        };
        let theirs = devbox();
        let shared = block(share(&mine, &theirs, &place(), |_| async { true })).unwrap();
        assert_eq!(shared.copied, ["Personal"]);
        assert_eq!(shared.failed.len(), 1);
        assert!(
            shared.failed[0].why.contains("no longer in the keychain"),
            "{:?}",
            shared.failed
        );
        // Personal wasn't this computer's default: the machine has none to take.
        let posted = theirs
            .asked()
            .into_iter()
            .find(|(m, _, _)| m == "POST")
            .unwrap()
            .2
            .unwrap();
        assert_eq!(posted["makeDefault"], false);

        let refusing = Fake {
            refuse_add: true,
            ..devbox()
        };
        let shared = block(share(&mac(), &refusing, &place(), |_| async { true })).unwrap();
        assert!(shared.copied.is_empty() && !shared.auto_switch);
        assert!(shared.failed.iter().all(|f| {
            f.why
                .starts_with("devbox refused it: Claude Code there didn't take")
        }));
    }

    #[test]
    fn a_copy_that_drops_halfway_says_it_may_be_there_anyway() {
        let dropping = Fake {
            drop_add: true,
            ..devbox()
        };
        let shared = block(share(&mac(), &dropping, &place(), |_| async { true })).unwrap();
        assert!(shared.copied.is_empty());
        assert_eq!(shared.failed.len(), 2);
        assert!(
            shared.failed.iter().all(|f| f
                .why
                .contains("It may be on devbox anyway: look at devbox's accounts")),
            "{:?}",
            shared.failed
        );
    }

    #[test]
    fn a_cancel_quietens_the_question_for_a_while_and_a_yes_clears_it() {
        let gate = ShareGate::with_quiet(std::time::Duration::from_secs(60));
        let open = gate.start().ok().unwrap();
        assert!(gate.start().err().unwrap().contains("already asking"));
        gate.answered(false);
        drop(open);
        let quiet = gate.start().err().expect("refused after a Cancel");
        assert!(quiet.contains("Try again in"), "{quiet}");
        gate.answered(true);
        assert!(gate.start().is_ok());
    }

    #[test]
    fn the_question_says_who_can_use_the_copies_and_how_to_revoke_them() {
        let q = question(&place(), &["Work"]);
        assert!(q.contains("or who controls devbox"), "{q}");
        assert!(q.contains("revoke it at claude.ai"), "{q}");
        assert!(!q.contains("at any time"), "{q}");
    }

    #[test]
    fn says_plainly_when_there_is_nothing_to_copy_or_nowhere_to_keep_it() {
        let empty = Fake::with(serde_json::json!({"store": "the keychain", "accounts": []}));
        let e = block(share(&empty, &devbox(), &place(), |_| async { true })).unwrap_err();
        assert!(e.contains("no Claude accounts"), "{e}");
        let old = Fake::with(serde_json::json!({"store": null, "accounts": []}));
        let e = block(share(&mac(), &old, &place(), |_| async { true })).unwrap_err();
        assert!(e.contains("keeps no accounts yet"), "{e}");
    }

    #[test]
    fn a_sign_in_is_asked_for_by_an_accounts_id_alone() {
        let id = "0f8e5a4c-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
        assert_eq!(
            hand_over_path(id).unwrap(),
            format!("/api/desk/accounts/{id}/hand-over")
        );
        for odd in [
            "a%2Fb",
            "../sessions",
            "0f8e5a4c-1d2b-4c3a-9e8f-7a6b5c4d3e2",
            "0f8e5a4c/1d2b-4c3a-9e8f-7a6b5c4d3e2f",
            "",
        ] {
            assert!(hand_over_path(odd).is_err(), "{odd}");
        }
        assert!(crate::broker::routes::native_local("POST", &hand_over_path(id).unwrap()).is_ok());
    }

    #[test]
    fn names_read_as_a_list() {
        assert_eq!(names(&["Work"]), "Work");
        assert_eq!(names(&["Work", "Personal"]), "Work and Personal");
        assert_eq!(names(&["A", "B", "C"]), "A, B and C");
    }
}
