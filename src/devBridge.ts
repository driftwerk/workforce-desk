// Lets `vite dev` run the UI in a plain browser against a running local hub,
// for checking screens without the app: open
// http://localhost:5183/?hub=<gateway url>&admin=<gateway token>&device=<device token>
// Only reachable from development builds.

const params = (() => {
  const keys = ["hub", "admin", "device"] as const;
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
  tuple: false,
  newAgent: null as { provider: string; model?: string; effort?: string } | null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  voice: false,
  voiceEngine: "cascade",
};

export async function devInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const answer = (v: unknown) => v as T;
  switch (cmd) {
    case "hub_connection":
      return answer({ url: need("hub"), token: need("admin") });
    case "hubs_list":
      return answer([{ id: "local", label: "This Mac", url: need("hub"), local: true, token: need("device") }]);
    case "settings_load":
      return answer(settings);
    case "settings_save":
      settings = args?.settings as typeof settings;
      return answer(undefined);
    case "themes_list":
      return answer([]);
    default:
      // Voice and Tuple live in the app process; in the preview they are off.
      if (cmd === "voice_status") return answer({ state: "off" });
      if (/^(voice|tuple)_/.test(cmd)) return answer(undefined);
      throw new Error(`${cmd} is only available in the Desk app`);
  }
}

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
    connect: { kind: "login", fields: [], hint: "Sign in with your Claude account. Desk keeps the login on this Mac." },
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
    connect: { kind: "login", fields: [], hint: "Sign in with your ChatGPT account. Desk keeps the login on this Mac." },
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
    description: "Models running on this Mac",
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
      if (p.connected) p.models = [{ id: "qwen3:32b", name: "qwen3:32b", description: "On this Mac · 20 GB", default: true }];
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
