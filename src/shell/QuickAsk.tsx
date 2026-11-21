import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { formerNamesOf } from "../rooms/mentions";
import { AgentMark } from "../ui/Mark";

/** `@name message`, sent as a DM (a bare name opens it). A name or id
 *  matches as typed so far; an old name only whole, while no one has it,
 *  and is said beside theirs (`formerly`). */
export const parseAsk = (
  input: string,
  roster: Agent[],
  former: (a: Agent) => readonly string[] = formerNamesOf,
): { agent: Agent | null; text: string; matches: Agent[]; formerly: Record<string, string> } => {
  const m = /^@?(\S*)\s*([\s\S]*)$/.exec(input.trim());
  const name = (m?.[1] ?? "").toLowerCase();
  const text = m?.[2] ?? "";
  const now = roster.filter((a) => a.name.toLowerCase().startsWith(name) || a.id.toLowerCase().startsWith(name));
  const held = roster.some((a) => a.name.toLowerCase() === name);
  const formerly = Object.fromEntries(
    held || !name
      ? []
      : roster.flatMap((a) => {
          const was = former(a).find((w) => w.toLowerCase() === name);
          return was && !now.includes(a) ? [[agentKey(a), was] as const] : [];
        }),
  );
  const matches = [...now, ...roster.filter((a) => agentKey(a) in formerly)];
  const exact = matches.filter((a) => a.name.toLowerCase() === name || a.id.toLowerCase() === name || agentKey(a) in formerly);
  return { agent: exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null, text, matches, formerly };
};

export function QuickAsk({ onClose }: { onClose: () => void }) {
  const { roster, hubs, openDm, send } = useChat();
  const setView = useDesk((s) => s.setView);
  const [input, setInput] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const parsed = useMemo(() => parseAsk(input, roster), [input, roster]);

  const go = (agent: Agent) => {
    const key = agentKey(agent);
    openDm(key);
    setView("rooms");
    if (parsed.text.trim()) {
      // The connection opens asynchronously; send once it is up.
      const attempt = (n: number) => {
        if (!send(key, parsed.text) && n < 40) setTimeout(() => attempt(n + 1), 150);
      };
      attempt(0);
    }
    onClose();
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="quick-ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.agent) go(parsed.agent);
        }}
      >
        <input
          ref={ref}
          value={input}
          placeholder="@allan what's left before we cut 0.9?"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Its own: not also a focused panel's or a filled grid's way back.
            e.preventDefault();
            onClose();
          }}
        />
        <div className="quick-list">
          {parsed.matches.slice(0, 6).map((a) => (
            <button key={agentKey(a)} type="button" className={`side-row ${parsed.agent === a ? "on" : ""}`} onClick={() => go(a)}>
              <AgentMark agent={agentKey(a)} name={a.name} size="sm" />
              <span className="display crew-name">
                {a.name}
                {parsed.formerly[agentKey(a)] && <span className="faint"> (formerly {parsed.formerly[agentKey(a)]})</span>}
              </span>
              <span className="faint small">{describeAgent(a, hubs.find((h) => h.id === a.hubId)?.label ?? a.hubId)}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
