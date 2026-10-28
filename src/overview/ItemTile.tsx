import { useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Engine, OverviewItem, OverviewState, SessionState } from "../hub/types";
import { Mark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { since } from "./overview";
import { localKey, openLocalDm, openSession, useKnownSession, useLocalAgent } from "./people";
import { useOverview } from "./store";

const ENGINE: Record<Engine, string> = { claude: "Claude Code", codex: "Codex" };

const RING: Partial<Record<OverviewState, SessionState>> = {
  needs_you: "blocked",
  working: "working",
  quiet: "working",
  done: "done",
};

/** "needs you · Claude Code · 6 min", "working · quiet 40 min", "working · other terminal" */
export const stateLine = (item: OverviewItem, now = Date.now()): string => {
  const parts: (string | null | undefined)[] =
    item.state === "needs_you"
      ? [
          item.question && !item.approval ? "asked you a question" : "needs you",
          item.kind === "session" && item.engine ? ENGINE[item.engine] : null,
          since(item.since, now),
        ]
      : item.state === "quiet"
        ? ["working", `quiet ${since(item.lastActivity ?? item.since, now)}`]
        : item.state === "working"
          ? ["working", item.origin === "external" ? "other terminal" : since(item.since, now)]
          : [item.state === "done" ? "done" : item.state, since(item.since, now) && `${since(item.since, now)} ago`];
  return parts.filter(Boolean).join(" · ");
};

/** Opens what an item is about: a session's card, or your DM with an agent. */
const openItem = (item: OverviewItem) => (item.kind === "session" ? openSession(item.id) : openLocalDm(item.id));

/** Whether the item opens: a session Desk lists, an agent in the roster. */
const useOpens = (item: OverviewItem): boolean => {
  const session = useKnownSession(item.kind === "session" ? item.id : null);
  const agent = useLocalAgent(item.kind === "agent" ? item.id : null);
  return item.kind === "session" ? session : !!agent;
};

/** An agent or a session on the Floor: who, what they're doing, and what
 *  they need from you, answered in place. */
export function ItemTile({ item }: { item: OverviewItem }) {
  const session = useDesk((s) => (item.kind === "session" ? s.sessions[item.id] : undefined));
  const tone = item.state === "quiet" ? "working" : item.state;
  const opens = useOpens(item);
  if (item.state === "done") return <DoneTile item={item} opens={opens} />;
  return (
    <article className={`tile ov-tile ov-tile-${tone}`}>
      <TileHead item={item} tone={tone} opens={opens} />
      {item.task && <span className="ov-task">{item.task}</span>}
      {item.state !== "needs_you" && item.detail && <span className="mono ov-detail">{item.detail}</span>}
      {item.state === "needs_you" &&
        (item.kind === "session" ? (
          <SessionAsk item={item} pending={session?.pending ?? null} opens={opens} />
        ) : item.question ? (
          <QuestionAsk item={item} question={item.question} />
        ) : (
          <div className="ov-ask">
            <span className="ov-ask-text">{item.detail ?? `${item.name} is waiting on you.`}</span>
            <span className="ov-ask-actions">
              {opens && (
                <button type="button" className="btn btn-ghost" onClick={() => openItem(item)}>
                  Reply…
                </button>
              )}
            </span>
          </div>
        ))}
    </article>
  );
}

function TileHead({ item, tone, opens }: { item: OverviewItem; tone: string; opens: boolean }) {
  const inner = (
    <>
      <Mark name={item.name} engine={item.kind === "session" ? (item.engine ?? undefined) : undefined} state={RING[item.state]} />
      <span className="tile-name">
        <span className={item.kind === "session" ? "mono tile-title" : "display tile-title"}>{item.name}</span>
        <span className={`tile-state ov-state-${tone}`}>{stateLine(item)}</span>
      </span>
    </>
  );
  return opens ? (
    <button type="button" className="tile-open" onClick={() => openItem(item)}>
      {inner}
    </button>
  ) : (
    <div className="tile-open">{inner}</div>
  );
}

function DoneTile({ item, opens }: { item: OverviewItem; opens: boolean }) {
  const title = item.kind === "agent" && item.task ? `${item.name} · ${item.task}` : item.name;
  const text = item.detail ?? (item.kind === "session" ? item.task : null);
  const inner = (
    <>
      <span className={item.kind === "session" ? "mono tile-title" : "display tile-title"}>{title}</span>
      {text && <span className="ov-task">{text}</span>}
    </>
  );
  return (
    <article className="tile ov-tile ov-tile-done">
      {opens ? (
        <button type="button" className="ov-done-open" onClick={() => openItem(item)}>
          {inner}
        </button>
      ) : (
        <div className="ov-done-open">{inner}</div>
      )}
    </article>
  );
}

/** A session's tool request: Allow, Deny, or open it to see more. */
function SessionAsk({
  item,
  pending,
  opens,
}: {
  item: OverviewItem;
  pending: { id: string; tool: string; detail: string; answerable: boolean } | null;
  opens: boolean;
}) {
  const decide = useOverview((s) => s.decide);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const approvalId = pending?.id ?? item.approval?.id;
  const summary = item.approval?.summary ?? (pending ? [pending.tool, pending.detail].filter(Boolean).join(" ") : "Waiting on you");
  const open = () => openSession(item.id);
  if (pending && !pending.answerable) {
    return (
      <div className="ov-ask">
        <span className="ov-ask-text">
          <b>Needs you in the terminal</b> · {summary}
        </span>
        {opens && (
          <span className="ov-ask-actions">
            <button type="button" className="btn btn-ghost" onClick={open}>
              Open
            </button>
          </span>
        )}
      </div>
    );
  }
  const answer = async (d: "allow" | "deny") => {
    if (!approvalId) return;
    setBusy(true);
    setProblem(null);
    try {
      await decide(item.id, approvalId, d);
    } catch (e) {
      setProblem(plainError(e));
      setBusy(false);
    }
  };
  return (
    <div className="ov-ask">
      <span className="ov-ask-text">{summary}</span>
      <span className="ov-ask-actions">
        {approvalId && (
          <>
            <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void answer("allow")}>
              Allow
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void answer("deny")}>
              Deny
            </button>
          </>
        )}
        {opens && (
          <button type="button" className="btn btn-ghost" onClick={open}>
            Open
          </button>
        )}
      </span>
      {problem && <span className="small state-blocked">{problem}</span>}
    </div>
  );
}

/** An agent's question to you, with its answers to pick from when the hub
 *  offers them; Reply… opens the DM. */
function QuestionAsk({ item, question }: { item: OverviewItem; question: { text: string; options?: string[] | null } }) {
  const sendTo = useChat((s) => s.sendTo);
  const [sent, setSent] = useState<{ question: string; answer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const answered = sent?.question === question.text ? sent.answer : null;
  const reply = async (answer: string) => {
    const key = localKey(item.id);
    setBusy(true);
    setProblem(null);
    const ok = key ? await sendTo(key, answer) : false;
    setBusy(false);
    if (ok) setSent({ question: question.text, answer });
    else setProblem(`Couldn’t reach ${item.name}. Try again, or reply in your DM.`);
  };
  return (
    <div className="ov-ask">
      <span className="ov-ask-text">“{question.text}”</span>
      {answered ? (
        <span className="small state-done" role="status">
          You answered “{answered}”.
        </span>
      ) : (
        <span className="ov-ask-actions">
          {(question.options ?? []).map((o) => (
            <button key={o} type="button" className="btn" disabled={busy} onClick={() => void reply(o)}>
              {o}
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => openItem(item)}>
            Reply…
          </button>
        </span>
      )}
      {problem && <span className="small state-blocked">{problem}</span>}
    </div>
  );
}
