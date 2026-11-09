import type { KeptExchange, MemoryHit, MemoryNote, MemoryNotes, ReplacedNote, SessionMemory } from "../hub/types";

/** `n` with a space between each three digits, as Desk writes numbers. */
export const thousands = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** "1 exchange", "48 exchanges". */
export const count = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "10:41" today, "3 Nov" before; "" for no time. */
export const clock = (iso: string | null | undefined, now = new Date()): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return sameDay(d, now) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** Whose model a provider's name is, as the person knows it. */
export const providerName = (p: string | null | undefined): string | null => {
  if (!p) return null;
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    "claude-code": "Anthropic",
    claude: "Anthropic",
    openai: "OpenAI",
    codex: "OpenAI",
    google: "Google",
    gemini: "Google",
    bedrock: "Amazon Bedrock",
    vertex: "Google Cloud",
    azure: "Microsoft Azure",
    mistral: "Mistral",
    groq: "Groq",
    ollama: "a model on this computer",
  };
  return known[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1);
};

/** Said wherever the person agrees to the model reading, when the hub may
 *  write on another provider. */
export const fallbackText = "If that can't answer, the hub may send it to another provider it's set up with instead.";

/** What the "noted by Desk" mark explains. */
export const notedByDeskText = (notes: Pick<MemoryNotes, "provider" | "fallbackProviders">): string => {
  const who = providerName(notes.provider);
  return [
    "Desk's model wrote these from what the session said, so they may be wrong: confirm the ones that are right, correct or drop the rest.",
    who ? `To write them, what the session said is sent to ${who}, under the hub's own account.` : "To write them, what the session said is sent to the model the hub notes with.",
    notes.fallbackProviders ? fallbackText : null,
  ]
    .filter(Boolean)
    .join(" ");
};

/** The files a session's exchanges changed, the latest first, each once. */
export const changedFiles = (exchanges: readonly KeptExchange[]): string[] => {
  const seen = new Set<string>();
  for (const x of [...exchanges].reverse()) for (const f of x.files) seen.add(f);
  return [...seen];
};

/** A file as the panel names it: its last two parts. */
export const shortFile = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** "Remembered: 48 exchanges · 2 secrets hidden · last read 10:41". */
export const rememberedLine = (m: SessionMemory, now = new Date()): string => {
  const read = clock(m.lastRead ?? m.exchanges.at(-1)?.ended ?? m.exchanges.at(-1)?.at, now);
  return [
    `Remembered: ${count(m.counts.exchanges, "exchange")}`,
    m.counts.secretsHidden > 0 ? `${count(m.counts.secretsHidden, "secret")} hidden` : null,
    read ? `last read ${read}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

/** How many notes a session holds in all. */
export const noteCount = (n: MemoryNotes): number => n.counts.decisions + n.counts.facts + n.counts.todos;

/** A kind's notes another replaced, latest first. */
export const replacedOf = (n: MemoryNotes, kind: MemoryNote["kind"]): ReplacedNote[] => (n.replaced ?? []).filter((r) => r.kind === kind);

/** What each kind of search hit is called. */
export const HIT_KIND: Record<MemoryHit["kind"], string> = {
  exchange: "Conversation",
  compaction: "Summary",
  decision: "Decision",
  fact: "Fact",
  todo: "To do",
};
