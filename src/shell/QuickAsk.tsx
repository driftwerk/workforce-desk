import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { Mark } from "../ui/Mark";

/** `@name message` — resolves the name against everyone on every hub and
 *  sends the message as a DM. A bare name just opens the DM. */
export const parseAsk = (input: string, roster: Agent[]): { agent: Agent | null; text: string; matches: Agent[] } => {
  const m = /^@?(\S*)\s*([\s\S]*)$/.exec(input.trim());
  const name = (m?.[1] ?? "").toLowerCase();
  const text = m?.[2] ?? "";
  const matches = roster.filter((a) => a.name.toLowerCase().startsWith(name) || a.id.toLowerCase().startsWith(name));
  const exact = roster.filter((a) => a.name.toLowerCase() === name || a.id.toLowerCase() === name);
  return { agent: exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null, text, matches };
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
          onKeyDown={(e) => e.key === "Escape" && onClose()}
        />
        <div className="quick-list">
          {parsed.matches.slice(0, 6).map((a) => (
            <button key={agentKey(a)} type="button" className={`side-row ${parsed.agent === a ? "on" : ""}`} onClick={() => go(a)}>
              <Mark name={a.name} size="sm" />
              <span className="display crew-name">{a.name}</span>
              <span className="faint small">{describeAgent(a, hubs.find((h) => h.id === a.hubId)?.label ?? a.hubId)}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
