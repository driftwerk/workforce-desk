import { useEffect, useState } from "react";
import { Mark } from "../ui/Mark";
import type { Working } from "./conversation";
import type { ToolCall } from "./types";

const SHOW_TIMER_AFTER_S = 3;

const elapsed = (s: number): string => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** The reply-in-progress row: who, animated dots, what they're doing, and
 *  how long it's been once that's worth knowing. */
export function WorkingRow({ name, working, tools = [] }: { name: string; working: Working; tools?: ToolCall[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - working.since) / 1000));
  return (
    <article className="msg msg-working" aria-live="polite" aria-label={`${name} is ${working.step.toLowerCase()}`}>
      <Mark name={name} state="working" />
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>
        </span>
        {tools.length > 0 && (
          <span className="msg-tools">
            {tools.map((t, i) => (
              <span key={i} className={`chip ${t.done ? "" : "chip-live"}`}>
                {t.name}
              </span>
            ))}
          </span>
        )}
        <span className="working-line">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="muted">{working.step}</span>
          {secs >= SHOW_TIMER_AFTER_S && <span className="faint small">· {elapsed(secs)}</span>}
        </span>
      </div>
    </article>
  );
}
