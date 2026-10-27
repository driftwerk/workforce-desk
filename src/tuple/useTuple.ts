import { useEffect, useRef } from "react";
import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { disableTuple, enableTuple, onTupleRequest, replyOnTuple, subscribe } from "../platform";
import { callPrompt, pickAgent } from "./route";

/** While enabled, follows Tuple calls: requests go to the named agent on a
 *  `desk:tuple` conversation of its own, and the answer goes back over the call. */
export function useTuple(enabled: boolean) {
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const fail = useDesk((s) => s.fail);
  const conversations = useRef(new Map<string, Conversation>());
  const last = useRef<Agent | null>(null);
  const names = roster.map((a) => a.name);
  const key = names.join("\u0000");

  useEffect(() => {
    if (!enabled) {
      void disableTuple();
      return;
    }
    enableTuple(names).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- names are tracked through `key`
  }, [enabled, key, fail]);

  useEffect(() => {
    if (!enabled) return;
    const pending = onTupleRequest((r) => {
      const agent = pickAgent(r.agent, useChat.getState().roster, last.current);
      if (!agent) return;
      last.current = agent;
      const k = agentKey(agent);
      let c = conversations.current.get(k);
      if (!c) {
        const hub = useChat.getState().hubs.find((h) => h.id === agent.hubId);
        if (!hub) return;
        c = new Conversation(hub, agent.id, () => {}, "desk:tuple", (answer) => {
          replyOnTuple(agent.name, answer).catch(fail);
        });
        conversations.current.set(k, c);
      }
      const prompt = callPrompt(r.text, r.context);
      const attempt = (n: number) => {
        if (!c.send(prompt) && n < 60) setTimeout(() => attempt(n + 1), 250);
      };
      attempt(0);
    });
    return subscribe(pending);
  }, [enabled, fail]);

  useEffect(
    () => () => {
      for (const c of conversations.current.values()) c.close();
      conversations.current.clear();
    },
    [hubs],
  );
}
