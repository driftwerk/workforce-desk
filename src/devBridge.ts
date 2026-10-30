// Lets `vite dev` run the UI in a plain browser against a running local hub,
// for checking screens without the app: open
// http://localhost:5183/?hub=<gateway url>&admin=<gateway token>&device=<device token>
// (and &platform=linux or windows to see another system's screens).
// Only reachable from development builds.

import { HubError } from "./hub/client";
import { deskListeners } from "./hub/store";
import { DEFAULT_HOST } from "./shell/host";

const params = (() => {
  const keys = ["hub", "admin", "device", "platform"] as const;
  const fromUrl = new URLSearchParams(location.search);
  const read = (k: string) => {
    const v = fromUrl.get(k);
    try {
      if (v) sessionStorage.setItem(`desk.dev.${k}`, v);
      return v ?? sessionStorage.getItem(`desk.dev.${k}`);
    } catch {
      return v;
    }
  };
  return Object.fromEntries(keys.map((k) => [k, read(k)])) as Record<(typeof keys)[number], string | null>;
})();

const need = (k: keyof typeof params): string => {
  const v = params[k];
  if (!v) throw new Error(`browser preview needs ?${k}= in the URL`);
  return v;
};

let settings = {
  theme: "system",
  themePick: "harbour",
  tuple: false,
  newAgent: null as { provider: string; model?: string; effort?: string } | null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  customVoices: {},
  voice: false,
  voiceEngine: "cascade",
  shortcuts: {} as Record<string, string>,
  groups: [] as unknown[],
  ungrouped: { collapsed: false, items: [] as string[] },
  sessionNames: {} as Record<string, string>,
  layoutOnHub: false,
};

// ── Desk's state file and the hub's state store, for the preview ──────────
// The file is this browser's localStorage; the hub's store (answering
// `/api/desk/state` while the running hub doesn't) is another key of it, so
// a reload of the preview comes back as it was, like the app.

type DevEntry = { value: unknown; updatedAt?: string | null; dirty?: boolean };
const stored = <V>(key: string): Record<string, V> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, V>;
  } catch {
    return {};
  }
};
const store = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private window: kept for this page only */
  }
};
const FILE = "desk.dev.stateFile";
const HUB_STATE = "desk.dev.hubState";
const stateFile = stored<DevEntry>(FILE);
const hubState = stored<{ value: unknown; updatedAt: string }>(HUB_STATE);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function stateCommand(cmd: string, args: Record<string, unknown> = {}): { answer: unknown } | null {
  const key = args.key as string;
  switch (cmd) {
    case "desk_state_load":
      return { answer: stateFile };
    case "desk_state_put":
      stateFile[key] = { value: args.value, updatedAt: stateFile[key]?.updatedAt ?? null, dirty: true };
      break;
    case "desk_state_remove":
      delete stateFile[key];
      break;
    case "desk_state_synced":
      if (stateFile[key] && same(stateFile[key].value, args.value)) stateFile[key] = { ...stateFile[key], dirty: false, updatedAt: args.updatedAt as string };
      break;
    case "desk_state_adopt":
      if (stateFile[key]?.dirty) return { answer: false };
      if (args.value === null || args.value === undefined) delete stateFile[key];
      else stateFile[key] = { value: args.value, updatedAt: (args.updatedAt as string) ?? null, dirty: false };
      store(FILE, stateFile);
      return { answer: true };
    case "desk_state_flush":
    case "desk_ready":
      return { answer: undefined };
    default:
      return null;
  }
  store(FILE, stateFile);
  return { answer: undefined };
}

function stateRoute(method: string, path: string, body: unknown): { answer: unknown } | null {
  const url = new URL(path, "http://preview");
  if (method === "GET" && url.pathname === "/api/desk/state") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const values = url.searchParams.get("values") === "true";
    return {
      answer: Object.entries(hubState)
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, e]) => (values ? { key, ...e } : { key, updatedAt: e.updatedAt })),
    };
  }
  const m = url.pathname.match(/^\/api\/desk\/state\/(.+)$/);
  if (!m) return null;
  const key = decodeURIComponent(m[1]!);
  const announce = (value: unknown) => deskListeners.forEach((f) => f({ type: "state", key, value }));
  if (method === "PUT") {
    const value = (body as { value?: unknown } | undefined)?.value ?? null;
    hubState[key] = { value, updatedAt: new Date().toISOString() };
    store(HUB_STATE, hubState);
    announce(value);
    return { answer: { key, ...hubState[key] } };
  }
  if (method === "DELETE") {
    delete hubState[key];
    store(HUB_STATE, hubState);
    announce(null);
    return { answer: undefined };
  }
  if (method === "GET") {
    if (!hubState[key]) throw new Error(`no ${key}`);
    return { answer: { key, ...hubState[key] } };
  }
  return null;
}

export async function devInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const answer = (v: unknown) => v as T;
  const state = stateCommand(cmd, args);
  if (state) return answer(state.answer);
  switch (cmd) {
    case "hub_connection":
      return answer({ url: need("hub"), token: need("admin") });
    case "host_info":
      // Windows before its setup: no backend yet.
      return answer(
        params.platform === "windows"
          ? { ...DEFAULT_HOST, platform: "windows", host: null, keys: "Credential Manager" }
          : { ...DEFAULT_HOST, platform: params.platform ?? DEFAULT_HOST.platform },
      );
    case "wsl_detect":
      return answer(WSL_FIXTURE);
    case "hubs_list":
      return answer([{ id: "local", label: "This computer", url: need("hub"), local: true, token: need("device") }]);
    case "settings_load":
      return answer(settings);
    case "settings_save":
      settings = args?.settings as typeof settings;
      return answer(undefined);
    case "themes_list":
      return answer([]);
    case "fonts_list":
      // What a computer's own list looks like; the app reads the real one.
      return answer(["Arial", "Avenir Next", "Courier New", "Georgia", "Helvetica Neue", "IBM Plex Sans", "Inter", "JetBrains Mono", "Menlo", "Times New Roman", "Verdana"]);
    default:
      // Voice and Tuple live in the app process; in the preview they are off.
      if (cmd === "voice_status") return answer({ state: "off" });
      if (cmd === "voice_lookup") return answer({ state: "failed", message: "Looking a voice up needs the Desk app." });
      if (/^(voice|tuple)_/.test(cmd)) return answer(undefined);
      throw new Error(`${cmd} is only available in the Desk app`);
  }
}

// ── WSL, for Windows' first run in the preview ─────────────────────────────

const probe = (glibc: string) => ({
  arch: "x86_64",
  kernel: "6.6.36.6-microsoft-standard-WSL2",
  user: "sarah",
  home: "/home/sarah",
  automount: "/mnt/",
  glibc,
});

const WSL_FIXTURE = {
  problem: null,
  distros: [
    { distro: { name: "Ubuntu-24.04", state: "Running", version: 2, default: true }, probe: probe("2.39"), problem: null },
    { distro: { name: "Debian", state: "Stopped", version: 2, default: false }, probe: probe("2.36"), problem: null },
    { distro: { name: "Ubuntu-20.04", state: "Stopped", version: 1, default: false }, probe: null, problem: { kind: "wsl1", distro: "Ubuntu-20.04" } },
  ],
};

// ── Providers, until the hub has them ──────────────────────────────────────
// Answers `/api/desk/providers` (see hub/client.ts `desk`) while the running
// hub doesn't: connecting and disconnecting change it, for this tab.

type Fixture = import("./hub/providers").Provider;

const key = (hint: string, placeholder = ""): Fixture["connect"] => ({
  kind: "fields",
  hint,
  fields: [{ name: "api_key", label: "API key", secret: true, placeholder }],
});

const CLAUDE_EFFORTS = ["low", "medium", "high", "max"];
const OPENAI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const claudeModels = (prefix = "claude-"): Fixture["models"] => [
  { id: `${prefix}fable-5-1`, name: "Fable 5.1", description: "Most capable — for hard, long-running work", default: false },
  { id: `${prefix}opus-5-5`, name: "Opus 5.5", description: "Deep reasoning and careful writing", default: false },
  { id: `${prefix}sonnet-5-5`, name: "Sonnet 5.5", description: "Fast and strong — the everyday choice", default: true },
  { id: `${prefix}haiku-5-5`, name: "Haiku 5.5", description: "Quickest, for light chores", default: false },
];

const fixtures: Fixture[] = [
  {
    id: "claude-code",
    name: "Claude plan",
    group: "plan",
    description: "Your Pro or Max subscription",
    connected: true,
    connect: { kind: "login", fields: [], hint: "Sign in with your Claude account. Desk keeps the login on this computer." },
    models: claudeModels(),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "chatgpt",
    name: "ChatGPT plan",
    group: "plan",
    description: "Your Plus or Pro subscription",
    connected: false,
    connect: { kind: "login", fields: [], hint: "Sign in with your ChatGPT account. Desk keeps the login on this computer." },
    models: [
      { id: "gpt-6-astra", name: "GPT-6 Astra", description: "Most capable — for hard, long-running work", default: false },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "Strong all-rounder", default: true },
      { id: "gpt-6-sol", name: "GPT-6 Sol", description: "The previous Sol", default: false },
      { id: "gpt-6-luna", name: "GPT-6 Luna", description: "Quickest, for light chores", default: false },
    ],
    efforts: OPENAI_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "anthropic",
    name: "Anthropic API",
    group: "key",
    description: "Claude, paid per use",
    connected: false,
    connect: key("Paste your Anthropic API key. Make one at console.anthropic.com.", "sk-ant-…"),
    models: claudeModels(),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    group: "key",
    description: "Claude and other models in your AWS account",
    connected: false,
    connect: {
      kind: "fields",
      hint: "Use an IAM user or role that can call Bedrock in your region.",
      fields: [
        { name: "access_key_id", label: "Access key ID", secret: false, placeholder: "AKIA…" },
        { name: "secret_access_key", label: "Secret access key", secret: true },
        { name: "region", label: "Region", secret: false, placeholder: "eu-west-2" },
      ],
    },
    models: claudeModels("us.anthropic.claude-"),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "vertex-anthropic",
    name: "Google Vertex AI",
    group: "key",
    description: "Claude on Google Cloud",
    connected: false,
    connect: {
      kind: "fields",
      hint: "A Google Cloud project with Claude enabled in Vertex AI.",
      fields: [
        { name: "project_id", label: "Project ID", secret: false, placeholder: "my-project" },
        { name: "region", label: "Region", secret: false, placeholder: "europe-west1" },
        { name: "service_account_json", label: "Service account key (JSON)", secret: true, placeholder: "Paste the key file’s contents" },
      ],
    },
    models: claudeModels(),
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    group: "key",
    description: "Gemini models with an API key",
    connected: false,
    connect: key("Paste your Gemini API key. Make one in Google AI Studio."),
    models: [
      { id: "gemini-3.5-pro", name: "Gemini 3.5 Pro", description: "Most capable Gemini", default: true },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", description: "Fast and inexpensive", default: false },
    ],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "key",
    description: "Many providers’ models with one key",
    connected: false,
    connect: key("Paste your OpenRouter key. Make one at openrouter.ai/keys.", "sk-or-…"),
    models: [
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", description: "Anthropic’s everyday model", default: true },
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", description: "OpenAI’s all-rounder", default: false },
      { id: "deepseek/deepseek-v4", name: "DeepSeek V4", description: "Strong open model", default: false },
    ],
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "grok",
    name: "xAI Grok",
    group: "key",
    description: "Grok models",
    connected: false,
    connect: key("Paste your xAI API key. Make one at console.x.ai.", "xai-…"),
    models: [
      { id: "grok-5", name: "Grok 5", description: "xAI’s most capable", default: true },
      { id: "grok-5-mini", name: "Grok 5 Mini", description: "Faster and cheaper", default: false },
    ],
    efforts: ["low", "high"],
    defaultEffort: "low",
  },
  {
    id: "zai",
    name: "Z.ai",
    group: "key",
    description: "GLM models",
    connected: false,
    connect: key("Paste your Z.ai API key."),
    models: [{ id: "glm-5", name: "GLM-5", description: "Z.ai’s flagship", default: true }],
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    group: "key",
    description: "Very fast open models",
    connected: false,
    connect: key("Paste your Cerebras API key.", "csk-…"),
    models: [
      { id: "qwen-4-235b", name: "Qwen 4 235B", description: "Large and very fast", default: true },
      { id: "llama-5-70b", name: "Llama 5 70B", description: "Quick and capable", default: false },
    ],
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "ollama",
    name: "Ollama",
    group: "local",
    description: "Models running on this computer",
    connected: false,
    connect: {
      kind: "probe",
      hint: "Not running. Start Ollama and Desk finds it at localhost:11434.",
      fields: [{ name: "address", label: "Address", secret: false, placeholder: "http://localhost:11434" }],
    },
    models: [],
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "vllm",
    name: "vLLM server",
    group: "local",
    description: "Any OpenAI-compatible server you run",
    connected: false,
    connect: {
      kind: "fields",
      hint: "Any OpenAI-compatible server you run, here or on your network.",
      fields: [
        { name: "url", label: "Server URL", secret: false, placeholder: "http://gpu-box.local:8000" },
        { name: "api_key", label: "API key (optional)", secret: true },
      ],
    },
    models: [],
    efforts: [],
    defaultEffort: null,
  },
];

let probes = 0;

export async function devHub<T>(method: string, path: string, body?: unknown): Promise<T> {
  await new Promise((r) => setTimeout(r, 250));
  const answer = (v: unknown) => structuredClone(v) as T;
  const crew = crewRoute(method, path) ?? floorRoute(method, path, body);
  if (crew) return answer(crew.answer);
  const state = stateRoute(method, path, body);
  if (state) return answer(state.answer);
  if (method === "GET" && path === "/api/desk/providers") return answer({ providers: fixtures });
  const m = path.match(/^\/api\/desk\/providers\/([^/]+)(\/connect)?$/);
  const p = m && fixtures.find((f) => f.id === decodeURIComponent(m[1]!));
  if (!p) throw new Error(`the preview has no ${method} ${path}`);
  if (method === "DELETE" && !m![2]) {
    p.connected = false;
    return answer(undefined);
  }
  if (method === "POST" && m![2]) {
    const fields = ((body as { fields?: Record<string, string> } | undefined)?.fields ?? {}) as Record<string, string>;
    if (p.connect.kind === "probe") {
      // Ollama "starts" on the second look.
      probes += 1;
      p.connected = probes > 1;
      if (p.connected) p.models = [{ id: "qwen3:32b", name: "qwen3:32b", description: "On this computer · 20 GB", default: true }];
      else p.connect.hint = "Still not running. Start Ollama, then check again.";
    } else {
      const missing = p.connect.fields.find((f) => !f.label.includes("optional") && !fields[f.name]?.trim());
      if (missing) throw new Error(`${missing.label} is needed.`);
      if (fields.api_key === "bad") throw new Error(`${p.name} didn’t accept that key.`);
      p.connected = true;
      if (p.id === "vllm") p.models = [{ id: "served-model", name: "Qwen3 32B (your server)", description: "The model your server runs", default: true }];
    }
    return answer(p);
  }
  throw new Error(`the preview has no ${method} ${path}`);
}

// ── The crew overview, until the hub has it ────────────────────────────────
// Answers the overview, Activity, the manager and its suggestions (and the
// approvals of the sessions in it) with the crew of the design: Desk
// overseeing Ledger, Scout and four sessions. Acting on them changes them,
// for this tab, and a new event arrives every so often.

type Party = import("./hub/types").ActivityParty;
type Event = import("./hub/types").ActivityEvent;
type Item = import("./hub/types").OverviewItem;

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const desk: Party = { kind: "manager", id: "desk", name: "Desk" };
const party = (kind: Party["kind"], id: string, name: string, engine?: "claude" | "codex"): Party => ({
  kind,
  id,
  name,
  ...(engine ? { engine, origin: id === "s-oss" ? ("external" as const) : ("desk" as const) } : {}),
});
const LEDGER = party("agent", "ledger", "Ledger");
const SCOUT = party("agent", "scout", "Scout");
const WEB = party("session", "s-web", "acme-web", "claude");
const E7 = party("session", "s-e7", "workforce-e7", "claude");
const OSS = party("session", "s-oss", "open-sourcing", "codex");
const SHADOW = party("session", "s-shadow", "dw-676-read-shadow", "claude");
const HERALD = party("agent", "herald", "Herald");

const items: Item[] = [
  {
    ...WEB,
    kind: "session",
    state: "needs_you",
    task: "Upgrading the date picker to the new design system",
    detail: "● Bash npm install @acme/ds@4.2.0",
    since: ago(6),
    lastActivity: ago(6),
    approval: { id: "ap-web", summary: "Run npm install @acme/ds@4.2.0?" },
    question: null,
  },
  {
    ...SCOUT,
    kind: "agent",
    state: "needs_you",
    task: "Preparing the staging deploy",
    detail: null,
    since: ago(3),
    lastActivity: ago(3),
    approval: null,
    question: { text: "Should I deploy main or release/4.2 to staging?", options: ["main", "release/4.2"] },
  },
  {
    ...LEDGER,
    kind: "agent",
    state: "working",
    task: "Comparing yesterday’s RDS spend with the last 30 days",
    detail: "● aws.cost_explorer",
    since: ago(2),
    lastActivity: ago(1),
  },
  {
    ...E7,
    kind: "session",
    state: "quiet",
    task: "Provider list for Desk",
    detail: "● cargo nextest run -p workforce-desk",
    since: ago(28),
    lastActivity: ago(40),
  },
  {
    ...OSS,
    kind: "session",
    state: "working",
    task: "Writing the README for the public repo",
    detail: "● Edit README.md",
    since: ago(72),
    lastActivity: ago(2),
  },
  { ...SHADOW, kind: "session", state: "done", task: "Read shadow for memories", detail: "Merged. Session closed.", since: ago(44) },
  {
    ...HERALD,
    kind: "agent",
    state: "done",
    task: "Morning triage",
    detail: "3 issues labelled, 1 assigned to you.",
    since: ago(150),
  },
];

let seq = 0;
const event = (min: number, kind: Event["kind"], actor: Party, subject: Party | null, text: string, reason?: string): Event => ({
  id: `ev-${String(++seq).padStart(4, "0")}`,
  at: ago(min),
  kind,
  actor,
  subject,
  text,
  reason: reason ?? null,
  suggestionId: null,
  approvalId: null,
});

// Oldest first as made; listed newest first.
const events: Event[] = [
  ...Array.from({ length: 110 }, (_, i) => {
    const min = 1500 - i * 12;
    return i % 3 === 0
      ? event(min, "finished", LEDGER, LEDGER, `finished “Spend check ${110 - i}”`)
      : i % 3 === 1
        ? event(min, "started", SHADOW, SHADOW, "started “Read shadow for memories”")
        : event(min, "nudged", desk, SHADOW, "asked dw-676-read-shadow how the review is going", "Quiet for 30 min while working.");
  }),
  event(204, "summary", desk, null, "sent your morning summary"),
  event(164, "finished", SHADOW, SHADOW, "finished · PR merged"),
  event(146, "started", E7, E7, "started “Provider list for Desk”"),
  event(139, "resumed", desk, OSS, "resumed open-sourcing after its usage limit reset", "You allow Desk to resume stopped sessions."),
  event(132, "finished", LEDGER, LEDGER, "finished Daily AWS check"),
  event(3, "question", SCOUT, SCOUT, "asked which branch to deploy"),
  event(6, "needs_you", WEB, WEB, "wants to run npm install"),
  event(0.5, "nudged", desk, E7, "asked workforce-e7 “Still on the provider tests, or stuck?”", "Quiet for 40 min while working."),
];

const suggestions = [
  {
    id: "sg-e7",
    at: ago(0.5),
    text: "Stop the test and ask it to run the suite without the network tests.",
    action: { type: "restart", session: "s-e7", prompt: "Run the suite without the network tests." },
    state: "open" as "open" | "done" | "dismissed",
    subject: E7,
  },
];

const needsYou = (e: Event) => e.kind === "needs_you" || e.kind === "question";

const record = (e: Event) => {
  events.push(e);
  for (const f of deskListeners) f({ type: "activity", event: e });
};

let live: ReturnType<typeof setInterval> | undefined;
const LIVE: [Event["kind"], Party, string][] = [
  ["working", LEDGER, "is reading the RDS cost report"],
  ["working", OSS, "is editing CONTRIBUTING.md"],
  ["finished", LEDGER, "finished comparing RDS spend · report in your DM"],
  ["started", OSS, "started “Licence headers”"],
];
const startLive = () => {
  let n = 0;
  live ??= setInterval(() => {
    const [kind, who, text] = LIVE[n++ % LIVE.length]!;
    record({ ...event(0, kind, who, who, text), at: new Date().toISOString() });
  }, 45_000);
};

function crewRoute(method: string, path: string): { answer: unknown } | null {
  const url = new URL(path, "http://preview");
  const route = `${method} ${url.pathname}`;
  if (route === "GET /api/desk/manager") return { answer: { agentId: "desk", level: "suggest" } };
  if (route === "GET /api/desk/overview") {
    const n = (f: (i: Item) => boolean) => items.filter(f).length;
    return {
      answer: {
        brief: {
          text: "Two things need you: **acme-web** wants to run `npm install`, and **Scout** is asking which branch to deploy. Ledger is part-way through the AWS check. **workforce-e7** has been quiet for 40 minutes; I asked whether it’s stuck.",
          at: ago(0.5),
          by: { id: "desk", name: "Desk" },
        },
        counts: {
          working: n((i) => i.state === "working" || i.state === "quiet"),
          needsYou: n((i) => i.state === "needs_you"),
          doneToday: n((i) => i.state === "done"),
        },
        items,
      },
    };
  }
  if (route === "GET /api/desk/activity") {
    startLive();
    const filter = url.searchParams.get("filter") ?? "all";
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const before = url.searchParams.get("before");
    const all = [...events]
      .reverse()
      .filter((e) => filter === "all" || (filter === "needs_you" ? needsYou(e) : e.actor.kind === "manager"));
    const from = before ? all.findIndex((e) => e.id === before) + 1 : 0;
    return { answer: { events: all.slice(from, from + limit), more: from + limit < all.length } };
  }
  if (route === "GET /api/desk/suggestions") return { answer: { suggestions } };
  const sg = url.pathname.match(/^\/api\/desk\/suggestions\/([^/]+)\/(accept|dismiss)$/);
  if (method === "POST" && sg) {
    const s = suggestions.find((x) => x.id === decodeURIComponent(sg[1]!));
    if (!s) throw new Error("That suggestion isn’t there any more.");
    s.state = sg[2] === "accept" ? "done" : "dismissed";
    record(
      sg[2] === "accept"
        ? { ...event(0, "restarted", { kind: "you", id: "you", name: "You" }, E7, "restarted workforce-e7 without the network tests"), suggestionId: s.id }
        : { ...event(0, "dismissed", { kind: "you", id: "you", name: "You" }, E7, "dismissed Desk’s suggestion"), suggestionId: s.id },
    );
    return { answer: s };
  }
  const ap = url.pathname.match(/^\/api\/desk\/sessions\/([^/]+)\/approvals\/([^/]+)$/);
  const it = ap && items.find((i) => i.id === ap[1] && i.approval?.id === ap[2]);
  if (method === "POST" && it) {
    it.approval = null;
    it.state = "working";
    it.since = new Date().toISOString();
    record(event(0, "approved", { kind: "you", id: "you", name: "You" }, WEB, "allowed npm install"));
    return { answer: {} };
  }
  return null;
}

/** The overseer's side of its DM in the design, with what it mentions to act
 *  on: an approval and a suggestion. */
export const devConversation = (
  agentId: string,
): { id: string; from: string; text: string; at: string; desk?: import("./hub/types").DeskExtras }[] =>
  agentId !== "desk"
    ? []
    : [
        {
          id: "dev-m1",
          from: "agent",
          text: "`acme-web` is waiting on you to run `npm install @acme/ds@4.2.0`. It’s upgrading the date picker, so the install looks expected.",
          at: ago(6),
          desk: { approvals: [{ sessionId: "s-web", approvalId: "ap-web", summary: "Run npm install @acme/ds@4.2.0?" }] },
        },
        {
          id: "dev-m2",
          from: "agent",
          text: "`workforce-e7` has run the same test for 40 minutes without output. I think it’s stuck on a test waiting for the network.",
          at: ago(0.5),
          desk: { suggestions: [{ id: "sg-e7", text: suggestions[0]!.text, state: "open" }] },
        },
        { id: "dev-m3", from: "user", text: "What’s everyone doing?", at: ago(0.4) },
        {
          id: "dev-m4",
          from: "agent",
          text: "| Who | Doing | State | For |\n| --- | --- | --- | --- |\n| **Ledger** | Comparing RDS spend with the last 30 days | Working | 4m |\n| **Scout** | Staging deploy: asked you main or release/4.2 | Needs you | 11m |\n| `acme-web` | Date picker upgrade: waiting on npm install | Needs you | 32m |\n| `workforce-e7` | Provider list for Desk: test stuck? | Working | 28m |\n| `open-sourcing` | README for the public repo · other terminal | Working | 1h 12m |\n\nTwo are waiting on you. The rest are moving; I’ll tell you when Ledger’s report is in.",
          at: ago(0.3),
        },
      ];

// ── The floor and the plans' usage, until the hub has them ─────────────────
// Needs, work and today's lanes for the same crew; Allow answers a need once
// (a second answer is the hub's 409).

type Need = import("./hub/types").Need;
type Work = import("./hub/types").Work;
type Who = import("./hub/types").Who;

const who = (p: Party): Who => ({ kind: p.kind === "session" ? "session" : "agent", id: p.id, name: p.name, engine: p.engine ?? null });

const floorNeeds: Need[] = [
  {
    id: "wait:t-web:ap-web",
    kind: "approval",
    who: who(WEB),
    ask: "Run npm install @acme/ds@4.2.0?",
    options: null,
    since: ago(6),
    place: { kind: "session" },
    answer: { kind: "decide", at: { kind: "session", sessionId: "s-web", approvalId: "ap-web" } },
  },
  {
    id: "question:t-scout",
    kind: "question",
    who: who(SCOUT),
    ask: "Should I deploy main or release/4.2 to staging?",
    options: ["main", "release/4.2"],
    since: ago(3),
    place: { kind: "dm" },
    answer: { kind: "reply" },
  },
];

const work = (p: Party, what: string, since: number, ended: number | null, over: Partial<Work> = {}): Work => ({
  who: who(p),
  what,
  place: p.kind === "session" ? { kind: "session" } : { kind: "dm" },
  since: ago(since),
  heardAt: ago(ended ?? 1),
  endedAt: ended === null ? null : ago(ended),
  outcome: ended === null ? null : "finished",
  background: null,
  ...over,
});

const floorWorking: Work[] = [
  work(LEDGER, "● aws.cost_explorer", 2, null),
  work(OSS, "Writing the README for the public repo", 72, null, { background: { count: 2, since: ago(6) } }),
  work(E7, "● Bash cargo nextest run -p workforce-desk", 28, null),
];

const floorDone: Work[] = [
  work(HERALD, "3 issues labelled, 1 assigned to you.", 170, 150),
  work(LEDGER, "Compared yesterday’s spend with the last 30 days.", 260, 230, { outcome: "finished" }),
];

const span = (kind: "working" | "waiting" | "background", from: number, to: number | null) => ({ kind, from: ago(from), to: to === null ? null : ago(to) });

function floorRoute(method: string, path: string, body: unknown): { answer: unknown } | null {
  const url = new URL(path, "http://preview");
  const route = `${method} ${url.pathname}`;
  if (route === "GET /api/desk/floor") {
    return {
      answer: {
        asOf: new Date().toISOString(),
        needs: floorNeeds,
        working: floorWorking,
        done: floorDone,
        lanes: [
          { who: who(WEB), spans: [span("working", 40, 6), span("waiting", 6, null)] },
          { who: who(SCOUT), spans: [span("working", 20, 3), span("waiting", 3, null)] },
          { who: who(LEDGER), spans: [span("working", 260, 230), span("working", 2, null)] },
          { who: who(OSS), spans: [span("working", 72, 6), span("background", 6, null)] },
          { who: who(E7), spans: [span("working", 28, null)] },
          { who: who(HERALD), spans: [span("working", 170, 150)] },
        ],
        counts: { working: floorWorking.length, needsYou: floorNeeds.length, doneToday: floorDone.length },
        more: { done: 0, lanes: 0 },
      },
    };
  }
  if (route === "GET /api/desk/usage") {
    const resets = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    return {
      answer: {
        asOf: new Date().toISOString(),
        logins: [
          { kind: "claude", where: "mac", signedIn: true },
          { kind: "chatgpt", where: "mac", signedIn: false },
        ],
        readings: [
          {
            kind: "claude",
            where: "mac",
            account: "preview-account",
            plan: "max",
            windows: [
              { usedPercent: 62, resetsAt: resets(148), minutes: 300 },
              { usedPercent: 38, resetsAt: resets(4 * 24 * 60), minutes: 10_080 },
            ],
            observedAt: ago(1),
          },
        ],
      },
    };
  }
  if (route === "POST /api/desk/needs/decide") {
    const at = JSON.stringify((body as { at?: unknown } | undefined)?.at);
    const i = floorNeeds.findIndex((n) => n.answer.kind === "decide" && JSON.stringify(n.answer.at) === at);
    if (i < 0) throw new HubError(409, "already_answered");
    floorNeeds.splice(i, 1);
    return { answer: undefined };
  }
  return null;
}
