import type { Layout } from "../groups/model";
import { preview } from "../preview";
import type { TerminalPalette } from "../theme/xterm";
import type { Provider } from "./providers";
import type { SearchFilters } from "../rooms/search";
import type {
  BossPlan,
  BossPlanChanged,
  BossPlanDetail,
  BossPlanEdit,
  BossPlanState,
  OnPlanDrop,
  ActivityFilter,
  ActivityPage,
  Decision,
  AccountAdded,
  AccountSignIn,
  AccountsInfo,
  Engine,
  EngineAccount,
  EngineInfo,
  EngineSignIn,
  SpendBy,
  StandingElsewhere,
  SwitchedAll,
  SpendPeriod,
  SpendView,
  Budget,
  BudgetsView,
  BreakerRules,
  BreakerView,
  LedgerPage,
  NewBudget,
  OnExceed,
  DeskEvent,
  Manager,
  NewRoomMessage,
  HiddenSession,
  LineMessage,
  ChargeView,
  Board,
  Ticket,
  NewTicket,
  TicketPatch,
  TicketMove,
  TicketState,
  AssignTo,
  NewSession,
  NewTerminal,
  Overview,
  ReadPut,
  ReadRow,
  Room,
  RoomMemberRef,
  RoomMessage,
  SearchHit,
  Removed,
  Session,
  Suggestion,
  TerminalInfo,
  UnreadSummary,
  GroupMemory,
  HandedOff,
  HandoffAsk,
  HandoffPreview,
  LineageView,
  MemoryIndexStatus,
  MemoryNote,
  MemorySearch,
  MemorySettings,
  NoteChange,
  SessionMemory,
} from "./types";
import { pairedHub, type HubRef } from "./net";
import type { Body, DeskSocket, DeskTransport } from "./transport";
import { agentPicturePath, pictureOf, type Picture } from "../pictures/pictures";

/** A hub and the token to reach it with, outside the app: the browser
 *  preview's local hub and its admin token. In the app every hub is reached
 *  through the native side, which holds the tokens; the page has none. */
export interface HubConnection {
  url: string;
  token: string;
}

/** One saved version of an agent's file, newest first in a list. */
export interface Revision {
  rev: number;
  /** Only when one revision is fetched. */
  content?: string;
  /** `web`, `restore`, `agent_tool`, `oob`, `seed`, … */
  edited_via: string;
  edited_by: string | null;
  restored_from: number | null;
  created_at: string;
}

/** `GET /api/agents/{id}/memory/summary`. */
export interface MemorySummaryWire {
  memories: number;
  lessons: number;
  tidied_at: string | null;
}

/** `GET /api/agents/{id}/heartbeat`. */
export interface AgentHeartbeat {
  enabled: boolean;
  interval_secs: number;
  quiet_start: string | null;
  quiet_end: string | null;
  /** Things on the check-in list (HEARTBEAT.md). */
  items: number;
  last_checked: string | null;
  /** Whether the last check-in needed the person; null before any. */
  needed_you: boolean | null;
  last_error: string | null;
}

/** Something always allowed on this computer, or for one session. */
export interface ComputerGrant {
  id: string;
  agent: string;
  ability: "write" | "delete" | "run" | "session" | "connector_write";
  /** As you read it (`~/dev/acme-web`). */
  folder: string | null;
  connector: string | null;
  session_id: string | null;
  run_name: string | null;
  expires_at: string | null;
  created_at: string;
}

/** One call an agent made here, as Desk recorded it. */
export interface ComputerActivityRow {
  id: string;
  at: string;
  agent: string;
  kind: "read" | "write" | "delete" | "exec" | "session" | "connector";
  doing: string;
  folder: string | null;
  tool: string;
  decided_by: "rule" | "grant" | "session" | "person" | "classifier";
  outcome: { outcome: "ran" | "refused" | "allowed" | "declined" | "not_answered" | "unattended" };
  reason: string | null;
}

export interface ComputerActivityPage {
  rows: ComputerActivityRow[];
  next: string | null;
}

export type DiskAccess = "granted" | "missing" | "unknown";

/** What a hub without a route is taken to have said. */
const NO_ROUTE = "This hub doesn’t have that yet.";

/** One key of Desk's state on a hub. */
export interface StateRow {
  key: string;
  value: unknown;
  updatedAt: string | null;
}

const stateRow = (x: unknown): StateRow | null => {
  if (!x || typeof x !== "object") return null;
  const r = x as { key?: unknown; value?: unknown; updatedAt?: unknown; updated_at?: unknown };
  if (typeof r.key !== "string" || !("value" in r)) return null;
  const at = r.updatedAt ?? r.updated_at;
  return { key: r.key, value: r.value, updatedAt: typeof at === "string" ? at : null };
};

/** A listing (`[{key, value, updatedAt}]`, or the same under `entries`). A
 *  JSON answer that's no listing is a hub without the route (its `error`);
 *  one whose rows Desk can't read is said, not taken as an empty store. */
export const stateRows = (body: unknown): StateRow[] => {
  const o = body as Record<string, unknown> | null;
  const list = Array.isArray(body) ? body : o?.entries;
  if (!Array.isArray(list)) throw new HubError(404, NO_ROUTE);
  const rows = list.flatMap((x) => stateRow(x) ?? []);
  if (rows.length < list.length) {
    throw new HubError(502, `The hub's Desk state listing has ${list.length - rows.length} rows Desk can't read.`);
  }
  return rows;
};

/** What the hub did with Desk's groups and names on the first push. */
export interface LayoutImport {
  /** False when it already had its own, which it kept. */
  imported: boolean;
  layout: Layout;
  sessionNames: Record<string, string>;
}

/** An item key in a route (`agent:local/desk`), its `/` kept. */
const itemPath = (item: string): string => item.split("/").map(encodeURIComponent).join("/");

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The hub's own name for the refusal, when it gives one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The hub's code for a change only a move may make: the sidebar's own
 *  routes would put a session in another boss's group. Never retried; the
 *  person is asked with the move dialog instead. */
export const CROSSES_BOSS = "crosses_boss";

/** Whether `e` is the hub refusing a change only a move may make. */
export const crossesBoss = (e: unknown): boolean => e instanceof HubError && e.status === 409 && e.code === CROSSES_BOSS;

/** What a hub said when it refused: its JSON `error` when it gives one,
 *  else a plain-text body as written (never JSON or a web page), else the
 *  status line. */
export const refusal = async (res: Response): Promise<HubError> => {
  const text = (await res.text().catch(() => "")).trim();
  let message = text.startsWith("<") ? "" : text;
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const { error, code: c } = body as { error?: unknown; code?: unknown };
      message = typeof error === "string" && error.trim() ? error : "";
      if (typeof c === "string" && c) code = c;
    }
  } catch {
    /* a plain-text body */
  }
  return new HubError(res.status, message || res.statusText || "The hub refused that.", code);
};

/** Chooses `image` as the picture at `path` on a hub (null: chooses none,
 *  so its Slack picture, if any, shows again); the picture shown after. */
export const sendPicture = (hub: HubRef, path: string, image: Blob | null): Promise<Picture | null> =>
  pictureVia(pairedHub(hub), path, image);

const pictureVia = async (t: DeskTransport, path: string, image: Blob | null): Promise<Picture | null> => {
  const res = await t.fetch(image ? "PUT" : "DELETE", path, image ? { type: image.type || "application/octet-stream", data: image } : undefined);
  if (!res.ok) throw await refusal(res);
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new HubError(404, NO_ROUTE);
  return pictureOf(((await res.json()) as { picture?: unknown }).picture);
};

const json = (body: unknown): Body | undefined => (body === undefined ? undefined : { type: "application/json", data: JSON.stringify(body) });

/** A hub's answer: its status and JSON (none for a 204), and a `HubError`
 *  for a refusal or a route the hub doesn't have. */
const answer = async <T>(res: Response): Promise<{ status: number; body: T }> => {
  if (!res.ok) throw await refusal(res);
  if (res.status === 204) return { status: res.status, body: undefined as T };
  // A hub without this route answers with its web page, not a 404.
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new HubError(404, NO_ROUTE);
  }
  return { status: res.status, body: (await res.json()) as T };
};

/** A Desk route; in the browser preview, the dev bridge answers the ones
 *  the running hub doesn't have yet. */
const withDevBridge = async <T>(method: string, path: string, body: unknown, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    if (!preview || !(e instanceof HubError) || e.status !== 404) throw e;
    const { devHub } = await import("../devBridge");
    return devHub<T>(method, path, body);
  }
};

/** One call through `t` to a hub's API: its JSON answer, nothing for a 204,
 *  and a `HubError` for a refusal. For a machine's own routes, which this
 *  computer's hub doesn't have (so aren't `DeskHub`'s). */
export const transportCall = async <T>(t: DeskTransport, method: string, path: string, body?: unknown): Promise<T> =>
  (await answer<T>(await t.fetch(method, path, json(body)))).body;

/** One call to paired hub `hub`'s API: its status and JSON answer (none
 *  for a 204), and a `HubError` for a refusal or a route the hub doesn't
 *  have. */
export const hubRequest = async <T>(hub: HubRef, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> =>
  answer<T>(await pairedHub(hub).fetch(method, path, json(body)));

/** One call to paired hub `hub`'s API: its JSON answer, nothing for a 204. */
export const hubCall = async <T>(hub: HubRef, method: string, path: string, body?: unknown): Promise<T> =>
  (await hubRequest<T>(hub, method, path, body)).body;

/** A Desk route; in the browser preview, the dev bridge answers the ones
 *  the running hub doesn't have yet. */
export const deskCall = <T>(hub: HubRef, method: string, path: string, body?: unknown): Promise<T> =>
  withDevBridge(method, path, body, () => hubCall<T>(hub, method, path, body));

/** The most messages one read of a room or thread returns. */
export const ROOM_PAGE = 100;

/** The local hub's admin surface: sessions, terminals, rooms, the crew and
 *  its agents. In the app `t` is `brokered`, which holds no token. */
export class DeskHub {
  constructor(private readonly t: DeskTransport) {}

  private request = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> =>
    answer<T>(await this.t.fetch(method, path, json(body)));

  private call = async <T>(method: string, path: string, body?: unknown): Promise<T> => (await this.request<T>(method, path, body)).body;

  private desk = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    withDevBridge(method, path, body, () => this.call<T>(method, path, body));

  private async text(path: string): Promise<string> {
    const res = await this.t.fetch("GET", path);
    if (!res.ok) throw await refusal(res);
    return res.text();
  }

  private async putText(path: string, text: string): Promise<void> {
    const res = await this.t.fetch("PUT", path, { type: "text/plain", data: text });
    if (!res.ok) throw await refusal(res);
  }

  sessions = (): Promise<Session[]> => this.call("GET", "/api/desk/sessions");
  start = (s: NewSession): Promise<Session> => this.call("POST", "/api/desk/sessions", s);
  /** What sessions spent since `period` began, grouped `by`, the costliest
   *  first; null from a hub without a ledger. */
  spend = async (period: SpendPeriod, by: SpendBy, limit: number): Promise<SpendView | null> => {
    try {
      return await this.call<SpendView>("GET", `/api/desk/spend?period=${period}&by=${by}&limit=${limit}`);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return null;
      throw e;
    }
  };
  /** The budgets, where each stands, Desk's breakers and their rules; null
   *  from a hub without budgets (an older one). */
  budgets = async (): Promise<BudgetsView | null> => {
    try {
      return await this.call<BudgetsView>("GET", "/api/desk/budgets");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** Sets a budget: one for the same group, scope, period and unit is replaced. */
  putBudget = (b: NewBudget): Promise<Budget> => this.call("POST", "/api/desk/budgets", b);
  patchBudget = (id: string, patch: { amount?: number; warnAt?: number; onExceed?: OnExceed }): Promise<Budget> =>
    this.call("PATCH", `/api/desk/budgets/${encodeURIComponent(id)}`, patch);
  deleteBudget = (id: string): Promise<void> => this.call("DELETE", `/api/desk/budgets/${encodeURIComponent(id)}`);
  setBreakerRules = (rules: BreakerRules): Promise<BreakerRules> => this.call("PUT", "/api/desk/breaker/rules", rules);
  /** Lets what a breaker holds go on. */
  breakerContinue = (subject: string): Promise<BreakerView> => this.call("POST", "/api/desk/breakers/continue", { subject });
  /** Leaves what a breaker holds paused; its Floor need goes. */
  breakerKeep = (subject: string): Promise<BreakerView> => this.call("POST", "/api/desk/breakers/keep", { subject });
  /** The ledger's calls in `period`, newest first, a page from `before`. */
  ledger = (q: { period: SpendPeriod; session?: string; before?: string }): Promise<LedgerPage> => {
    const params = new URLSearchParams({ period: q.period });
    if (q.session) params.set("session", q.session);
    if (q.before) params.set("before", q.before);
    return this.call("GET", `/api/desk/ledger?${params.toString()}`);
  };
  /** Every engine the hub knows: installed, its version and sign-in, and
   *  where it starts it; null from a hub that doesn't say (an older one). */
  engines = async (): Promise<EngineInfo[] | null> => {
    try {
      return await this.call<EngineInfo[]>("GET", "/api/desk/engines");
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return null;
      throw e;
    }
  };
  /** The person's engine accounts; null from a hub without them. */
  accounts = async (): Promise<AccountsInfo | null> => {
    try {
      return await this.call<AccountsInfo>("GET", "/api/desk/accounts");
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return null;
      throw e;
    }
  };
  /** Adds an account: with a pasted token, checked and kept; without, the
   *  engine's own sign-in begins. */
  addAccount = (a: { engine: Engine; name: string; token?: string; makeDefault?: boolean; remote?: boolean }): Promise<AccountAdded> =>
    this.call("POST", "/api/desk/accounts", a);

  updateAccount = (id: string, patch: { name?: string; isDefault?: boolean }): Promise<EngineAccount> =>
    this.call("PATCH", `/api/desk/accounts/${id}`, patch);
  removeAccount = (id: string): Promise<void> => this.call("DELETE", `/api/desk/accounts/${id}`);
  /** The code the sign-in page showed, for the sign-in waiting on it. */
  signInCode = (id: string, code: string): Promise<AccountSignIn> =>
    this.call("POST", `/api/desk/accounts/sign-ins/${id}/code`, { code });
  /** An engine's own sign-in, run by the hub (Codex's device page). */
  startEngineSignIn = (engine: Engine): Promise<EngineSignIn> => this.call("POST", "/api/desk/engines/sign-ins", { engine });
  engineSignIn = (id: string): Promise<EngineSignIn> => this.call("GET", `/api/desk/engines/sign-ins/${encodeURIComponent(id)}`);
  cancelEngineSignIn = (id: string): Promise<void> => this.call("DELETE", `/api/desk/engines/sign-ins/${encodeURIComponent(id)}`);
  /** "OK" on a sign-in problem the person has dealt with. */
  dismissSignInProblem = (account: string): Promise<void> => this.call("POST", `/api/desk/accounts/problems/${account}/dismiss`);
  cancelSignIn = (id: string): Promise<void> => this.call("DELETE", `/api/desk/accounts/sign-ins/${id}`);
  /** Moves every session on one account to another: "Switch all". */
  switchAll = (from: string | null, to: string | null): Promise<SwitchedAll> =>
    this.call("POST", "/api/desk/accounts/switch-all", { engine: "claude", from, to });
  /** "Not now" on an account need. */
  putOffNeed = (id: string): Promise<void> => this.call("POST", `/api/desk/accounts/needs/${encodeURIComponent(id)}/put-off`);
  setAutoSwitch = (on: boolean): Promise<void> => this.call("PUT", "/api/desk/accounts/auto-switch", { on });
  /** "This computer's sign-in is …": which account its Claude Code is
   *  signed in to (null: none of them). */
  setOwnSignIn = (account: string | null): Promise<void> => this.call("PUT", "/api/desk/accounts/own-sign-in", { account });
  /** What the person's other computers know of their accounts' plans. */
  learnStanding = (accounts: StandingElsewhere[], sentAt: string): Promise<void> =>
    this.call("PUT", "/api/desk/accounts/standing", { accounts, sentAt });
  /** Moves a session to another account (null: the CLI's own sign-in). */
  switchAccount = (id: string, account: string | null): Promise<Session> =>
    this.call("POST", `/api/desk/sessions/${id}/account`, { account });
  update = (id: string, patch: { name?: string; goal?: string; approvals?: "desk" | "terminal" }): Promise<Session> =>
    this.call("PATCH", `/api/desk/sessions/${id}`, patch);
  stop = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/stop`);
  /** Esc in its terminal: ends the turn it is working on, and nothing else. */
  interrupt = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/interrupt`);
  /** Allows the tool auto mode refused for the rest of the session, and
   *  tells it to carry on. */
  allowAsked = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/asked/allow`);
  /** Leaves what it asked unanswered: it is done. */
  dismissAsked = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/asked/dismiss`);
  resume = (id: string, prompt?: string): Promise<Session> =>
    this.call("POST", `/api/desk/sessions/${id}/resume`, { prompt });
  /** Stops it and resumes its conversation, as a new process: what a CLI
   *  that reads the terminal's colours only at its start needs to take new
   *  ones. */
  restart = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/restart`);
  /** Tells the hub the colours its terminals are drawn in, which it answers
   *  programs' colour queries with while no pane is there to, and gives the
   *  CLIs it starts. False from a hub without the route. */
  setTerminalColors = async (palette: TerminalPalette): Promise<boolean> => {
    try {
      await this.call("PUT", "/api/desk/terminal/colors", palette);
      return true;
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return false;
      throw e;
    }
  };
  /** Removes a session from Desk: its record, Activity, read points and
   *  floor turns; never adopted again. Its engine's transcript is deleted
   *  only when `transcript` (it can't be resumed then). */
  remove = (id: string, transcript = false): Promise<Removed> => this.call("POST", `/api/desk/sessions/${id}/remove`, { transcript });
  /** Stops it if it runs here and closes it: it leaves the sidebar and
   *  stays resumable from Settings → Sessions. */
  end = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/end`);
  /** The most recently closed sessions, newest first. */
  closedSessions = (): Promise<Session[]> => this.call("GET", "/api/desk/sessions/closed");
  /** Sessions removed from Desk, which it no longer tracks. */
  hiddenSessions = (): Promise<HiddenSession[]> => this.call("GET", "/api/desk/sessions/hidden");
  /** Tracks a removed session again, the next time it runs. */
  trackAgain = (h: Pick<HiddenSession, "engine" | "cliSessionId">): Promise<void> =>
    this.call("DELETE", `/api/desk/sessions/hidden/${h.engine}/${encodeURIComponent(h.cliSessionId)}`);
  /** Removes every session finished more than `olderThanDays` ago, or only
   *  counts them (`dryRun`). */
  clearFinished = (c: { olderThanDays: number; dryRun?: boolean; transcripts?: boolean }): Promise<Removed> =>
    this.call("POST", "/api/desk/sessions/clear", c);
  decide = (id: string, approval: string, decision: Decision): Promise<Session> =>
    this.desk("POST", `/api/desk/sessions/${id}/approvals/${approval}`, { decision });
  /** The person's own name for a session (null or blank: none, so the
   *  hub's shows). */
  nameSession = (id: string, name: string | null): Promise<Session> =>
    this.call("PUT", `/api/desk/sessions/${encodeURIComponent(id)}/name`, { name });
  restore = (ids: string[]): Promise<Session[]> => this.call("POST", "/api/desk/restore", { ids });
  dismissRestore = (): Promise<void> => this.call("POST", "/api/desk/restore/dismiss");

  /** Whether agents may use this computer at all (the kill switch). */
  computerAccess = async (): Promise<{ stopped: boolean }> => this.call("GET", "/api/desk/computer/access");
  setComputerStopped = (stopped: boolean): Promise<{ stopped: boolean }> => this.call("PUT", "/api/desk/computer/access", { stopped });
  /** What is always allowed (and for which session), one agent's or all. */
  computerGrants = (agent?: string): Promise<ComputerGrant[]> =>
    this.call("GET", `/api/desk/computer/grants${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
  revokeGrant = (id: string): Promise<void> => this.call("DELETE", `/api/desk/computer/grants/${encodeURIComponent(id)}`);
  forgetSession = (sessionId: string): Promise<void> =>
    this.call("POST", `/api/desk/computer/sessions/${encodeURIComponent(sessionId)}/forget`);
  /** What agents did here, newest first; `next` goes on from the page. */
  computerActivity = (f: { agent?: string; kind?: string; before?: string } = {}): Promise<ComputerActivityPage> => {
    const q = new URLSearchParams();
    if (f.agent) q.set("agent", f.agent);
    if (f.kind) q.set("kind", f.kind);
    if (f.before) q.set("before", f.before);
    const qs = q.toString();
    return this.call("GET", `/api/desk/computer/activity${qs ? `?${qs}` : ""}`);
  };
  /** Whether macOS lets agents read other apps' files here. */
  diskAccess = async (): Promise<DiskAccess> => (await this.call<{ state: DiskAccess }>("GET", "/api/desk/computer/disk-access")).state;

  /** Vault paths (never values) on this hub. */
  vaultPaths = async (): Promise<string[]> => (await this.call<{ keys: string[] }>("GET", "/api/vault")).keys;
  saveVault = (path: string, value: string): Promise<void> => this.call("POST", `/api/vault/${path}`, { value });

  /** The local agents themselves, created and configured on the person's behalf. */
  createAgent = (agent: { id: string; name: string; system_prompt: string }): Promise<unknown> =>
    this.call("POST", "/api/agents", agent);
  deleteAgent = (id: string): Promise<unknown> => this.call("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  /** A new name and, for agents Desk made, the instructions that say it. */
  renameAgent = (id: string, name: string, systemPrompt?: string): Promise<unknown> =>
    this.call("PATCH", `/api/agents/${encodeURIComponent(id)}`, systemPrompt === undefined ? { name } : { name, system_prompt: systemPrompt });
  /** Chooses a picture for an agent here (null: none); the one it shows after. */
  setAgentPicture = (id: string, image: Blob | null): Promise<Picture | null> => pictureVia(this.t, agentPicturePath(id), image);
  /** What agents on this computer can think with, connected or not. */
  providers = async (): Promise<Provider[]> =>
    (await this.desk<{ providers: Provider[] }>("GET", "/api/desk/providers")).providers;
  /** Connects a provider with its fields (keys, an address); answers with
   *  it as it now is. */
  connectProvider = (id: string, fields: Record<string, string>): Promise<Provider> =>
    this.desk("POST", `/api/desk/providers/${encodeURIComponent(id)}/connect`, { fields });
  disconnectProvider = (id: string): Promise<void> =>
    this.desk<unknown>("DELETE", `/api/desk/providers/${encodeURIComponent(id)}`).then(() => undefined);

  /** An agent's identity file (SOUL.md, IDENTITY.md, …), as text; one it
   *  doesn't have yet is empty. */
  identityFile = async (id: string, file: string): Promise<string> => {
    try {
      return await this.text(`/api/agents/${encodeURIComponent(id)}/identity/${file}`);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return "";
      throw e;
    }
  };
  saveIdentityFile = (id: string, file: string, text: string): Promise<void> =>
    this.putText(`/api/agents/${encodeURIComponent(id)}/identity/${file}`, text);
  /** Every saved version of an identity file, newest first. */
  identityRevisions = async (id: string, file: string): Promise<Revision[]> =>
    (await this.call<{ revisions: Revision[] }>("GET", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions`)).revisions;
  identityRevision = (id: string, file: string, rev: number): Promise<Revision> =>
    this.call("GET", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions/${rev}`);
  /** Puts version `rev` back (as a new version: history is never lost). */
  restoreIdentityRevision = (id: string, file: string, rev: number): Promise<unknown> =>
    this.call("POST", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions/${rev}/restore`);

  /** How much an agent remembers of you and has learned, and when your
   *  memories with it were last tidied. */
  memorySummary = (id: string): Promise<MemorySummaryWire> =>
    this.call("GET", `/api/agents/${encodeURIComponent(id)}/memory/summary`);
  /** An agent's own check-ins: on or off, its check-in list, the last run. */
  agentHeartbeat = (id: string): Promise<AgentHeartbeat> => this.call("GET", `/api/agents/${encodeURIComponent(id)}/heartbeat`);

  /** An agent's own `config.toml`, as text. */
  agentConfig = (id: string): Promise<string> => this.text(`/api/agents/${encodeURIComponent(id)}/config`);
  saveAgentConfig = (id: string, toml: string): Promise<void> => this.putText(`/api/agents/${encodeURIComponent(id)}/config`, toml);

  /** The crew at a glance: who needs you, who's working, what's done today,
   *  and the overseer's latest brief. */
  overview = (): Promise<Overview> => this.desk("GET", "/api/desk/overview");
  /** A page of what happened, newest first, from before event `before`. */
  activity = (q: { filter?: ActivityFilter; before?: string; limit?: number } = {}): Promise<ActivityPage> => {
    const params = new URLSearchParams({ limit: String(q.limit ?? 100), filter: q.filter ?? "all" });
    if (q.before) params.set("before", q.before);
    return this.desk("GET", `/api/desk/activity?${params}`);
  };
  /** A session's line, oldest first: the page before `before`. */
  lineThread = (id: string, before?: string): Promise<LineMessage[]> =>
    this.call("GET", `/api/desk/sessions/${encodeURIComponent(id)}/line${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  /** Your message to a session: at its turn's end, or `now` into it. */
  postLine = (id: string, text: string, when: "queue" | "now"): Promise<LineMessage> =>
    this.call("POST", `/api/desk/sessions/${encodeURIComponent(id)}/line`, { text, when });
  /** Changes a message of yours that hasn't gone out. */
  editLine = (id: string, text: string): Promise<void> => this.call("PATCH", `/api/desk/line/${encodeURIComponent(id)}`, { text });
  /** Takes back a message of yours that hasn't gone out. */
  takeBackLine = (id: string): Promise<void> => this.call("DELETE", `/api/desk/line/${encodeURIComponent(id)}`);
  /** Your answer to a question on a session's line. */
  answerLine = (id: string, text: string): Promise<LineMessage> => this.call("POST", `/api/desk/line/${encodeURIComponent(id)}/answer`, { text });
  /** Sets a session's question aside unanswered: it leaves what needs you,
   *  and nothing is sent to the session. */
  dismissLine = (id: string): Promise<LineMessage> => this.call("POST", `/api/desk/line/${encodeURIComponent(id)}/dismiss`);
  /** Puts `text` in a session's prompt without sending it, for you to add
   *  to and send yourself. */
  draftLine = (sessionId: string, text: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${encodeURIComponent(sessionId)}/draft`, { text });
  /** Every session a boss runs now, with who drives each; null from a hub
   *  without charges (an older one). */
  charges = async (): Promise<ChargeView[] | null> => {
    try {
      return await this.call<ChargeView[]>("GET", "/api/desk/charges");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** Hands a session to its boss (the one there is, unless `boss` says). */
  handTo = (id: string, boss?: string): Promise<ChargeView> =>
    this.call("POST", `/api/desk/sessions/${encodeURIComponent(id)}/charge`, boss ? { boss } : {});
  /** Takes a session back from the boss that runs it. */
  releaseCharge = (id: string): Promise<ChargeView> => this.call("DELETE", `/api/desk/sessions/${encodeURIComponent(id)}/charge`);
  /** **I'll drive** (`person_pinned`) or **Hand back** (`boss`). */
  setWheel = (id: string, wheel: "person_pinned" | "boss"): Promise<ChargeView> =>
    this.call("PATCH", `/api/desk/sessions/${encodeURIComponent(id)}/charge`, { wheel });
  /** The person's boards; null from a hub without a board (an older one). */
  boards = async (): Promise<Board[] | null> => {
    try {
      return await this.call<Board[]>("GET", "/api/desk/boards");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** A new board; its prefix comes from its name unless said. */
  createBoard = (b: { name: string; group?: string | null; prefix?: string }): Promise<Board> => this.call("POST", "/api/desk/boards", b);
  /** Renames a board, moves it to a group (null: ungrouped), or changes its
   *  prefix while it has no tickets. */
  updateBoard = (id: string, patch: { name?: string; group?: string | null; prefix?: string }): Promise<Board> =>
    this.call("PATCH", `/api/desk/boards/${encodeURIComponent(id)}`, patch);
  deleteBoard = (id: string): Promise<void> => this.call("DELETE", `/api/desk/boards/${encodeURIComponent(id)}`);
  /** A board's tickets, each with what the board computes of it. */
  tickets = (board: string, q: { state?: TicketState; assignee?: string; q?: string } = {}): Promise<Ticket[]> => {
    const params = new URLSearchParams();
    if (q.state) params.set("state", q.state);
    if (q.assignee) params.set("assignee", q.assignee);
    if (q.q) params.set("q", q.q);
    const query = params.toString();
    return this.call("GET", `/api/desk/boards/${encodeURIComponent(board)}/tickets${query ? `?${query}` : ""}`);
  };
  createTicket = (t: NewTicket): Promise<Ticket> => this.call("POST", "/api/desk/tickets", t);
  /** Tickets on any board, by their words or their key (`ACM-12`). */
  searchTickets = (q: string): Promise<Ticket[]> => this.call("GET", `/api/desk/tickets/search?q=${encodeURIComponent(q)}`);
  ticket = (id: string): Promise<Ticket> => this.call("GET", `/api/desk/tickets/${encodeURIComponent(id)}`);
  /** What it says, its pin and its snooze; its state changes by `moveTicket`. */
  editTicket = (id: string, patch: TicketPatch): Promise<Ticket> => this.call("PATCH", `/api/desk/tickets/${encodeURIComponent(id)}`, patch);
  deleteTicket = (id: string): Promise<void> => this.call("DELETE", `/api/desk/tickets/${encodeURIComponent(id)}`);
  /** A drop anywhere in a column. */
  moveTicket = (id: string, move: TicketMove): Promise<Ticket> => this.call("POST", `/api/desk/tickets/${encodeURIComponent(id)}/move`, move);
  /** Ticket `id` needs `other` done first (`needs`), or no longer does; a
   *  cycle is refused in plain words. */
  needTicket = (id: string, other: string, needs: boolean): Promise<Ticket> =>
    this.call(needs ? "PUT" : "DELETE", `/api/desk/tickets/${encodeURIComponent(id)}/needs/${encodeURIComponent(other)}`);
  /** Gives a ticket to a session, an agent or a new session, as you. */
  assignTicket = (id: string, to: AssignTo): Promise<Ticket> => this.call("POST", `/api/desk/tickets/${encodeURIComponent(id)}/assign`, { to });
  /** A boss's plans with where their tickets stand; null from a hub
   *  without plans (an older one). */
  plans = async (q: { state?: BossPlanState; group?: string } = {}): Promise<BossPlan[] | null> => {
    const query = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined)).toString();
    try {
      return await this.call<BossPlan[]>("GET", `/api/desk/plans${query ? `?${query}` : ""}`);
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** A plan in full: its tickets, waves and revisions. */
  plan = (id: string): Promise<BossPlanDetail> => this.call("GET", `/api/desk/plans/${encodeURIComponent(id)}`);
  /** The person's edit, from the revision they read: a newer one refuses it (409). */
  editPlan = (id: string, edit: BossPlanEdit): Promise<BossPlanChanged> => this.call("PATCH", `/api/desk/plans/${encodeURIComponent(id)}`, edit);
  pausePlan = (id: string): Promise<BossPlanDetail> => this.call("POST", `/api/desk/plans/${encodeURIComponent(id)}/pause`);
  resumePlan = (id: string): Promise<BossPlanDetail> => this.call("POST", `/api/desk/plans/${encodeURIComponent(id)}/resume`);
  /** Drops a plan, stopping the sessions on it or leaving them as yours. */
  dropPlan = (id: string, sessions: OnPlanDrop): Promise<BossPlanDetail> =>
    this.call("POST", `/api/desk/plans/${encodeURIComponent(id)}/drop`, { sessions });
  /** A page of a ticket's history, newest first. */
  ticketHistory = (id: string, before?: string): Promise<ActivityPage> =>
    this.call("GET", `/api/desk/tickets/${encodeURIComponent(id)}/history${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  /** A page of what a session or an agent did, and had done to it. */
  history = (subject: string, before?: string): Promise<ActivityPage> => {
    const params = new URLSearchParams({ subject });
    if (before) params.set("before", before);
    return this.call("GET", `/api/desk/history?${params}`);
  };
  /** Which agent oversees the crew, and how much it does on its own. */
  manager = (): Promise<Manager> => this.desk("GET", "/api/desk/manager");
  suggestions = async (): Promise<Suggestion[]> =>
    (await this.desk<{ suggestions: Suggestion[] }>("GET", "/api/desk/suggestions")).suggestions;
  /** Does what the overseer suggested, as you. */
  acceptSuggestion = (id: string): Promise<unknown> => this.desk("POST", `/api/desk/suggestions/${encodeURIComponent(id)}/accept`);
  dismissSuggestion = (id: string): Promise<unknown> => this.desk("POST", `/api/desk/suggestions/${encodeURIComponent(id)}/dismiss`);

  rooms = (): Promise<Room[]> => this.call("GET", "/api/desk/rooms");
  createRoom = (name: string, members: RoomMemberRef[], defaultMember?: string): Promise<Room> =>
    this.call("POST", "/api/desk/rooms", { name, members, defaultMember });
  updateRoom = (
    id: string,
    patch: { name?: string; members?: RoomMemberRef[]; defaultMember?: string | null },
  ): Promise<Room> => this.call("PATCH", `/api/desk/rooms/${id}`, patch);
  deleteRoom = (id: string): Promise<void> => this.call("DELETE", `/api/desk/rooms/${id}`);
  /** A page of a room's main timeline (or of one thread), oldest first: its
   *  newest, or those `before` or `after` a message, or `around` one. */
  roomMessages = (
    id: string,
    q: { thread?: string; before?: string; after?: string; around?: string; limit?: number } = {},
  ): Promise<RoomMessage[]> => {
    const params = new URLSearchParams({ limit: String(q.limit ?? ROOM_PAGE) });
    for (const k of ["thread", "before", "after", "around"] as const) if (q[k]) params.set(k, q[k]);
    return this.call("GET", `/api/desk/rooms/${id}/messages?${params}`);
  };
  /** One message of a room. */
  roomMessage = (roomId: string, id: string): Promise<RoomMessage> =>
    this.call("GET", `/api/desk/rooms/${roomId}/messages/${encodeURIComponent(id)}`);
  /** Keeps a message in a room; `created` is false when one with its
   *  source was kept already (a hub that keeps no sources keeps it anew). */
  post = async (id: string, m: NewRoomMessage): Promise<{ message: RoomMessage; created: boolean }> => {
    const { status, body } = await this.request<RoomMessage>("POST", `/api/desk/rooms/${id}/messages`, m);
    return { message: body, created: status === 201 || (!!m.source && !body.source) };
  };
  /** Posts thread message `id` to its room's timeline; `created` is false
   *  when it was posted there already, and the copy then is the first. */
  copyToRoom = async (roomId: string, id: string): Promise<{ message: RoomMessage; created: boolean }> => {
    const { status, body } = await this.request<RoomMessage>("POST", `/api/desk/rooms/${roomId}/messages/${encodeURIComponent(id)}/copy`);
    return { message: body, created: status === 201 };
  };
  /** What's unread of this computer's places. */
  unread = (): Promise<UnreadSummary> => this.call("GET", "/api/desk/unread");
  /** Every read point this computer's hub keeps. */
  reads = async (): Promise<ReadRow[]> => (await this.call<{ reads: ReadRow[] }>("GET", "/api/desk/reads")).reads;
  /** Moves read points; answers the ones that moved. */
  putReads = async (puts: ReadPut[]): Promise<ReadRow[]> => (await this.call<{ reads: ReadRow[] }>("PUT", "/api/desk/reads", { puts })).reads;
  /** Every place with something unread (or a room's, with its threads)
   *  read through its newest; answers the points that moved. */
  markAllRead = async (scope: "everything" | { room: string }): Promise<ReadRow[]> =>
    (await this.call<{ reads: ReadRow[] }>("POST", "/api/desk/reads/all", { scope })).reads;
  /** Room messages matching `f`'s text and filters: by rank with text,
   *  else newest first. */
  search = (f: SearchFilters, limit = 50): Promise<SearchHit[]> => {
    const params = new URLSearchParams({ q: f.q, limit: String(limit) });
    if (f.room) params.set("room", f.room);
    if (f.from) params.set("from", f.from);
    if (f.has.length) params.set("has", f.has.join(","));
    if (f.inThread) params.set("inThread", "true");
    if (f.after) params.set("after", f.after);
    if (f.before) params.set("before", f.before);
    return this.call("GET", `/api/desk/rooms/search?${params}`);
  };

  /** Desk's restorable state on this hub (see restore/store.ts); a hub
   *  without a state store answers 404. */
  stateList = async (prefix: string): Promise<StateRow[]> =>
    stateRows(await this.desk<unknown>("GET", `/api/desk/state?prefix=${encodeURIComponent(prefix)}&values=true`));
  statePut = async (key: string, value: unknown): Promise<{ updatedAt: string | null }> => {
    const body = await this.desk<unknown>("PUT", `/api/desk/state/${encodeURIComponent(key)}`, { value });
    return { updatedAt: stateRow(body)?.updatedAt ?? null };
  };
  stateRemove = async (key: string): Promise<void> => {
    try {
      await this.desk<unknown>("DELETE", `/api/desk/state/${encodeURIComponent(key)}`);
    } catch (e) {
      // Already gone is gone; a hub without the store says so another way.
      if (!(e instanceof HubError && e.status === 404 && e.message !== NO_ROUTE)) throw e;
    }
  };

  events(onEvent: (e: DeskEvent) => void, onState: (open: boolean) => void): () => void {
    let ws: DeskSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      ws = this.t.socket("/api/desk/events");
      ws.onopen = () => {
        retry = 0;
        onState(true);
      };
      ws.onmessage = (m) => onEvent(JSON.parse(m.data as string) as DeskEvent);
      ws.onclose = () => {
        onState(false);
        if (closed) return;
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }

  ptySocket(id: string): DeskSocket {
    return this.t.socket(`/api/desk/sessions/${id}/pty`);
  }

  // ── Continue in another engine ──────────────────────────────────────────

  /** What continuing session `id` as `ask` asks would give it: the brief,
   *  what it holds and leaves out, and who receives it. `derive` has Desk
   *  note what it hasn't of the session first (a model call, waited on up
   *  to 45 s): only the dialog's first look asks it, never a prefetch. */
  handoffPreview = (id: string, ask: Pick<HandoffAsk, "engine" | "account" | "place" | "back" | "goalOnly">, derive = false): Promise<HandoffPreview> => {
    const params = new URLSearchParams();
    if (ask.engine) params.set("engine", ask.engine);
    if (ask.account !== undefined) params.set("account", ask.account ?? "own");
    if (ask.place) params.set("place", ask.place);
    if (ask.back) params.set("back", "true");
    if (ask.goalOnly) params.set("goalOnly", "true");
    if (derive) params.set("derive", "1");
    const q = params.toString();
    return this.call("GET", `/api/desk/sessions/${encodeURIComponent(id)}/handoff${q ? `?${q}` : ""}`);
  };
  /** Continues session `id` in another engine, or hands its work back. */
  handoff = (id: string, ask: HandoffAsk): Promise<HandedOff> => this.call("POST", `/api/desk/sessions/${encodeURIComponent(id)}/handoff`, ask);
  /** Session `id`'s place in its work: where it came from and went. */
  lineage = (id: string): Promise<LineageView> => this.call("GET", `/api/desk/sessions/${encodeURIComponent(id)}/lineage`);

  // ── Desk Memory: what it remembers of sessions ─────────────────────────

  /** What Desk remembers of a session; null when it remembers nothing of it,
   *  or the hub keeps no memory (an older one). */
  sessionMemory = async (id: string): Promise<SessionMemory | null> => {
    try {
      return await this.call<SessionMemory>("GET", `/api/desk/sessions/${encodeURIComponent(id)}/memory`);
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** Forgets what Desk remembers of a session; it is never remembered again.
   *  What the person should know of it, if anything: the sessions its work
   *  was handed on to may still hold what they read. */
  forgetMemory = async (id: string): Promise<string | null> =>
    (await this.call<{ notice?: string } | undefined>("DELETE", `/api/desk/sessions/${encodeURIComponent(id)}/memory`))?.notice ?? null;
  /** Turns a session's own remembering on or off: what the person should
   *  know of it, if anything (some of what it said last may not be kept). */
  rememberSession = async (id: string, on: boolean): Promise<string | null> =>
    (await this.call<{ notice?: string } | undefined>("PATCH", `/api/desk/sessions/${encodeURIComponent(id)}/memory`, { on }))?.notice ?? null;
  /** Reads the session's new exchanges for decisions, facts and to-dos now
   *  (the hub answers 202, with nothing). */
  deriveMemory = async (id: string): Promise<void> => {
    const res = await this.t.fetch("POST", `/api/desk/sessions/${encodeURIComponent(id)}/memory/derive`);
    if (!res.ok) throw await refusal(res);
  };
  /** Confirms, corrects or drops a note: the note as it now stands, none once dropped. */
  changeNote = async (id: string, change: NoteChange): Promise<MemoryNote | null> =>
    (await this.call<{ item?: MemoryNote } | undefined>("PATCH", `/api/desk/memory/items/${encodeURIComponent(id)}`, change))?.item ?? null;
  /** Searches what Desk remembers: every session's, or one session's or group's. */
  searchMemory = (q: { q: string; session?: string; group?: string; kind?: string; limit?: number }): Promise<MemorySearch> => {
    const params = new URLSearchParams({ q: q.q });
    if (q.session) params.set("session", q.session);
    if (q.group) params.set("group", q.group);
    if (q.kind) params.set("kind", q.kind);
    if (q.limit) params.set("limit", String(q.limit));
    return this.call("GET", `/api/desk/memory/search?${params.toString()}`);
  };
  /** How Desk Memory's search index stands; null from a hub without one. */
  memoryIndex = async (): Promise<MemoryIndexStatus | null> => {
    try {
      return await this.call<MemoryIndexStatus>("GET", "/api/desk/memory/index");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** Starts the search index again from what Desk keeps: how many exchanges it adds back. */
  rebuildMemoryIndex = async (): Promise<number> =>
    (await this.call<{ queued?: number } | undefined>("POST", "/api/desk/memory/index/rebuild"))?.queued ?? 0;
  /** The person's memory settings, the install's limits and what is kept;
   *  null from a hub that can't set them (an older one). */
  memorySettings = async (): Promise<MemorySettings | null> => {
    try {
      return await this.call<MemorySettings>("GET", "/api/desk/memory/settings");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  };
  /** Pauses or resumes remembering every session. */
  pauseMemory = (paused: boolean): Promise<MemorySettings> => this.call("PATCH", "/api/desk/memory/settings", { paused });
  /** Changes a group's memory switches: what `change` names, the rest kept. */
  changeGroupMemory = (id: string, change: Partial<Omit<GroupMemory, "deriveDecided">>): Promise<GroupMemory & { notice?: string }> =>
    this.call("PATCH", `/api/desk/memory/groups/${encodeURIComponent(id)}`, change);

  // ── The sidebar's groups, kept by the hub ───────────────────────────────
  // Every route answers with the whole layout as it now is.

  layout = (): Promise<Layout> => this.call("GET", "/api/desk/layout");
  /** Replaces the whole layout: for what no one route says, a machine's
   *  sessions forgotten or its groups merged in. With `expected`, the layout
   *  it was made from: one that changed since is refused with a 409. */
  replaceLayout = (l: Layout, expected?: Layout): Promise<Layout> =>
    this.call("PUT", "/api/desk/layout", expected ? { ...l, expected } : l);
  /** Desk's first push of the groups and names it kept itself; a hub that
   *  already has some keeps its own (unless `force`). */
  importLayout = (i: { layout: Layout; sessionNames: Record<string, string>; force?: boolean }): Promise<LayoutImport> =>
    this.call("POST", "/api/desk/layout/import", i);
  createGroup = (g: { id: string; name: string; items?: string[]; before?: string | null }): Promise<Layout> =>
    this.call("POST", "/api/desk/groups", g);
  /** Renames a group, or opens or closes it (Ungrouped too, by `ungrouped`). */
  updateGroup = (id: string, patch: { name?: string; collapsed?: boolean }): Promise<Layout> =>
    this.call("PATCH", `/api/desk/groups/${encodeURIComponent(id)}`, patch);
  deleteGroup = (id: string): Promise<Layout> => this.call("DELETE", `/api/desk/groups/${encodeURIComponent(id)}`);
  moveGroup = (id: string, before: string | null): Promise<Layout> =>
    this.call("POST", `/api/desk/groups/${encodeURIComponent(id)}/move`, { before });
  /** Puts an item in a group (or `ungrouped`) before another, out of
   *  wherever it was. */
  putInGroup = (group: string, item: string, before: string | null): Promise<Layout> =>
    this.call("PUT", `/api/desk/groups/${encodeURIComponent(group)}/items/${itemPath(item)}`, { before });
  /** Sets Ungrouped's order to `items` as Desk shows it (only Desk knows
   *  what shows there unlisted), taking each out of whichever group held it. */
  orderUngrouped = (items: string[]): Promise<Layout> =>
    this.call("PUT", "/api/desk/groups/ungrouped/order", { items });

  // ── Terminals: login shells the hub hosts for grid panes ─────────────────

  /** Opens a login shell; it runs until closed, whether or not Desk is. */
  openTerminal = (t: NewTerminal): Promise<TerminalInfo> => this.call("POST", "/api/desk/terminals", t);
  terminals = (): Promise<TerminalInfo[]> => this.call("GET", "/api/desk/terminals");
  /** Starts a terminal whose shell ended again, where it was. */
  reopenTerminal = (id: string): Promise<TerminalInfo> => this.call("POST", `/api/desk/terminals/${encodeURIComponent(id)}/reopen`);
  closeTerminal = async (id: string): Promise<void> => {
    try {
      await this.call<unknown>("DELETE", `/api/desk/terminals/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof HubError && e.status === 404)) throw e;
    }
  };

  /** The same protocol as a session's: binary frames both ways, text
   *  frames for control (see session/Terminal.tsx). */
  terminalSocket(id: string): DeskSocket {
    return this.t.socket(`/api/desk/terminals/${encodeURIComponent(id)}/pty`);
  }
}
