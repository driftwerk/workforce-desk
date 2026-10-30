import { useEffect, useState } from "react";
import { Mark } from "../ui/Mark";
import { statusOf, type Working } from "./conversation";
import type { ToolCall } from "./types";

/** Now, a second at a time: what a status line's timer counts from. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** What an answer on its way is doing: animated dots, and the status line,
 *  "Thinking · 12s", a tool's line or a rate limit's wait. */
export function StatusLine({ working }: { working: Working }) {
  const now = useNow();
  return (
    <span className="working-line">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="muted">{statusOf(working, now)}</span>
    </span>
  );
}

export function ToolChips({ tools }: { tools: ToolCall[] }) {
  if (!tools.length) return null;
  return (
    <span className="msg-tools">
      {tools.map((t, i) => (
        <span key={i} className={`chip ${t.done ? "" : "chip-live"}`}>
          {t.name}
        </span>
      ))}
    </span>
  );
}

/** The reply-in-progress row: who, what they've run, and what they're doing. */
export function WorkingRow({ name, working, tools = [] }: { name: string; working: Working; tools?: ToolCall[] }) {
  return (
    <article className="msg msg-working" aria-live="polite" aria-label={`${name} is ${working.step.toLowerCase()}`}>
      <Mark name={name} state="working" />
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>
        </span>
        <ToolChips tools={tools} />
        <StatusLine working={working} />
      </div>
    </article>
  );
}
