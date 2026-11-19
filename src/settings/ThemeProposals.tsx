import { useEffect, useMemo, useRef, useState } from "react";
import { uploadAll } from "../attachments/upload";
import { useChat } from "../chat/store";
import { toolNameOf } from "../chat/toolLine";
import { agentKey, DESK_DM, workspaces, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { openTarget } from "../shell/navigate";
import { useUi } from "../shell/ui";
import type { Proposal } from "../theme/proposal";
import { proposalsFrom, useProposals } from "../theme/proposals";
import { allThemes, useThemeStore } from "../theme/store";
import { TerminalSwatches, ThemePreview } from "../theme/ThemePreview";
import { derive } from "../theme/tokens";
import "../styles/settings.css";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The agent `id` on hub `hub`, as the roster has it. */
const useAgent = (hub: string, id: string): Agent | undefined => useChat((s) => s.roster.find((a) => a.hubId === hub && a.id === id));

/** What Desk sends an agent the person asks for a theme. */
export const askText = (words: string): string => `Make me a Desk theme: ${words.trim()}`;

/** What Desk sends the agent that made `p`, asked to change it. */
export const changeText = (p: Proposal, words: string): string => `About the theme “${p.spec.name}” (${p.spec.id}): ${words.trim()}`;

/** A proposal an agent made, to keep, discard or ask to change: a live
 *  preview of Desk in it, and its terminal's colours. */
export function ProposalCard({ proposal: p, inChat = false }: { proposal: Proposal; inChat?: boolean }) {
  const fail = useDesk((s) => s.fail);
  const agent = useAgent(p.hub, p.agent);
  const custom = useThemeStore((s) => s.custom);
  const theme = useMemo(() => derive(p.spec), [p.spec]);
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const who = agent?.name ?? p.agent;
  const revises = p.revises ? (allThemes(custom).find((t) => t.id === p.revises)?.name ?? p.revises) : undefined;

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const askChanges = async () => {
    if (!words.trim()) return;
    setBusy(true);
    const ok = await useChat.getState().sendTo(`${p.hub}/${p.agent}`, changeText(p, words));
    setBusy(false);
    if (!ok) return fail(`Couldn’t reach ${who}. Try again in a moment.`);
    setWords("");
    setAsking(false);
    setSent(true);
  };

  return (
    <section className={`proposal-card${inChat ? " proposal-card-chat" : ""}`} aria-label={`Theme proposal: ${p.spec.name}`}>
      <div className="proposal-head">
        <b className="display">{p.spec.name}</b>
        <span className="small muted">
          {theme.dark ? "Dark" : "Light"} · from {who}
          {revises ? ` · changes ${revises}` : ""}
        </span>
      </div>
      {p.reason && <p className="small muted proposal-reason">“{p.reason}”</p>}
      <ThemePreview theme={theme} label={`Preview of ${p.spec.name}`} />
      <TerminalSwatches theme={theme} />
      {p.changes.length > 0 ? (
        <details className="proposal-changes small">
          <summary className="muted">
            {p.changes.some((c) => c.startsWith("Still too faint"))
              ? "Some colours still read too faintly"
              : `Desk moved ${p.changes.length} colour${p.changes.length === 1 ? "" : "s"} so its text and terminal read`}
          </summary>
          <ul>
            {p.changes.map((c) => (
              <li key={c} className="muted">
                {c}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span className="small muted">Its text and terminal read as they are.</span>
      )}
      {asking ? (
        <form
          className="proposal-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void askChanges();
          }}
        >
          <textarea
            aria-label={`What to change in ${p.spec.name}`}
            placeholder="Warmer, less contrast in the sidebar…"
            rows={2}
            value={words}
            autoFocus
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="theme-actions">
            <button type="submit" className="btn btn-signal" disabled={busy || !words.trim()}>
              Send to {who}
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="theme-actions">
          <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void act(() => useProposals.getState().keep(p))}>
            {revises ? `Keep, and change ${revises}` : "Keep it"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => (setAsking(true), setSent(false))}>
            Ask for changes
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => useProposals.getState().discard(p.spec.id))}>
            Discard
          </button>
        </div>
      )}
      {sent && (
        <span className="small muted" role="status">
          Sent to {who}. Its changes show here.
        </span>
      )}
    </section>
  );
}

/** The tools that make a proposal. */
const PROPOSES = new Set(["theme.propose", "theme.revise"]);

/** How many proposals a turn's tools made. */
export const proposalsMade = (tools: readonly { name?: string; tool?: string }[] | undefined): number =>
  (tools ?? []).filter((t) => PROPOSES.has(toolNameOf(t.name ?? t.tool ?? ""))).length;

/** The proposals an agent's message made, as Desk keeps them: one card a
 *  proposal, on the newest message that made or changed it. */
export function ProposalCards({ hub, agent, since, until }: { hub: string; agent: string; since?: string; until?: string }) {
  const list = useProposals((s) => s.list);
  const loaded = useProposals((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useProposals.getState().load().catch(() => undefined);
  }, [loaded]);
  const shown = proposalsFrom(list, hub, agent, since, until);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((p) => (
        <ProposalCard key={p.spec.id} proposal={p} inChat />
      ))}
    </>
  );
}

const LAST_AGENT = "desk.themes.askAgent";

const remembered = (): string | null => {
  try {
    return localStorage.getItem(LAST_AGENT);
  } catch {
    return null;
  }
};

/** "Ask an agent to make one…": the person says what they want, and may
 *  add a picture to take its colours from (a screenshot, a brand palette, a
 *  photo); it goes to the agent they choose, local or on a workspace. */
export function AskForTheme() {
  const fail = useDesk((s) => s.fail);
  const hubs = useChat((s) => s.hubs);
  const roster = useChat((s) => s.roster);
  const agents = useMemo(() => {
    const ws = workspaces(hubs);
    return roster.filter((a) => ws.some((h) => h.id === a.hubId));
  }, [hubs, roster]);
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [picked, setPicked] = useState<string | null>(remembered);
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<Agent | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const local = hubs.find((h) => h.local);
  const fallback = agents.find((a) => a.hubId === local?.id && a.isDefault) ?? agents.find((a) => a.hubId === local?.id) ?? agents[0];
  const agent = agents.find((a) => agentKey(a) === picked) ?? fallback;
  const label = (a: Agent) => {
    const h = hubs.find((x) => x.id === a.hubId);
    return h?.local ? a.name : `${a.name} · ${h?.label ?? a.hubId}`;
  };

  const send = async () => {
    if (!agent || !words.trim()) return;
    const hub = hubs.find((h) => h.id === agent.hubId);
    if (!hub) return;
    setBusy(true);
    try {
      const attachments = image ? await uploadAll(hub, agent.id, DESK_DM, [image]) : undefined;
      const ok = await useChat.getState().sendTo(agentKey(agent), askText(words), attachments ? { attachments } : undefined);
      if (!ok) throw new Error(`Couldn’t reach ${agent.name}. Try again in a moment.`);
      try {
        localStorage.setItem(LAST_AGENT, agentKey(agent));
      } catch {
        // Remembered for this time only.
      }
      setSentTo(agent);
      setWords("");
      setImage(null);
      setOpen(false);
    } catch (e) {
      fail(message(e));
    } finally {
      setBusy(false);
    }
  };

  const openChat = (a: Agent) => {
    useUi.getState().closeSettings();
    openTarget({ kind: "agent", key: agentKey(a) }, { beside: true });
  };

  if (!open)
    return (
      <div className="theme-ask-row">
        <button type="button" className="btn" disabled={!agents.length} onClick={() => (setOpen(true), setSentTo(null))}>
          Ask an agent to make one…
        </button>
        {sentTo ? (
          <span className="small muted" role="status">
            Asked {sentTo.name}. Its proposal shows here, and in{" "}
            <button type="button" className="link small" onClick={() => openChat(sentTo)}>
              your chat with {sentTo.name}
            </button>
            .
          </span>
        ) : (
          !agents.length && <span className="small faint">No agent to ask yet.</span>
        )}
      </div>
    );

  return (
    <form
      className="theme-ask"
      aria-label="Ask an agent to make a theme"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onPaste={(e) => {
        const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
        if (f) {
          e.preventDefault();
          setImage(f);
        }
      }}
    >
      <label className="field">
        <span>What should it look like?</span>
        <textarea
          rows={3}
          autoFocus
          value={words}
          placeholder="A calm dark theme in sea greens, or the colours of the picture I’ve added"
          onChange={(e) => setWords(e.target.value)}
        />
      </label>
      <div className="theme-ask-row">
        <label className="field theme-ask-agent">
          <span>Ask</span>
          <select className="ability-select" value={agent ? agentKey(agent) : ""} onChange={(e) => setPicked(e.target.value)}>
            {agents.map((a) => (
              <option key={agentKey(a)} value={agentKey(a)}>
                {label(a)}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          aria-label="Picture to take colours from"
          onChange={(e) => setImage(e.target.files?.[0] ?? null)}
        />
        {image ? (
          <span className="theme-ask-image small">
            <span className="mono">{image.name}</span>
            <button type="button" className="link small" onClick={() => setImage(null)}>
              Remove
            </button>
          </span>
        ) : (
          <button type="button" className="link small" onClick={() => fileInput.current?.click()}>
            Add a picture to take colours from
          </button>
        )}
      </div>
      <div className="theme-actions">
        <button type="submit" className="btn btn-signal" disabled={busy || !agent || !words.trim()}>
          {agent ? `Ask ${agent.name}` : "Ask"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <span className="small faint">It proposes a theme here. Nothing changes until you keep it.</span>
    </form>
  );
}

/** The proposals agents made, newest first, and the way to ask for one. */
export function ThemeProposals() {
  const list = useProposals((s) => s.list);
  return (
    <section className="set-group theme-proposals" aria-label="From your agents">
      <span className="set-label">From your agents</span>
      {!list.length && <span className="small faint">Ask an agent for a theme, from words or a picture. It proposes one here, and nothing changes until you keep it.</span>}
      {list.map((p) => (
        <ProposalCard key={p.spec.id} proposal={p} />
      ))}
      <AskForTheme />
    </section>
  );
}
