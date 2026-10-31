import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { readConversation, textOf, type HubMessage } from "../chat/history";
import { useChat } from "../chat/store";
import type { ChatMessage } from "../chat/types";
import { firstLine, plural } from "./rows";

// What a DM with something unread last said, for its row on the Unread
// page: a hub counts a DM's unread by ids alone. It's read from the DM's
// history where that's open, else once from its hub (the few latest
// messages), and kept by the message it is. A hub that won't say leaves
// the row saying who it's from.

/** The newest message's line, and who wrote it where the hub says. */
export interface Preview {
  line: string;
  name: string;
}

/** The latest few read for a preview: the newest of yours may follow theirs. */
export const PREVIEW_PAGE = 6;

const usePreviews = create<Record<string, Preview | null>>(() => ({}));
const asking = new Set<string>();

const lineOf = (text: string, files: number): string => firstLine(text) || (files ? `Sent ${plural(files, "file")}` : "");

const fromChat = (messages: readonly ChatMessage[], last: string | null): Preview | null => {
  const m = (last ? messages.find((x) => x.id === last) : undefined) ?? [...messages].reverse().find((x) => x.role === "assistant");
  const line = m ? lineOf(m.content, m.attachments?.length ?? 0) : "";
  return m && line ? { line, name: m.author?.name ?? "" } : null;
};

const fromHub = (messages: readonly HubMessage[], last: string | null): Preview | null => {
  const m = (last ? messages.find((x) => x.id === last) : undefined) ?? [...messages].reverse().find((x) => x.from !== "user");
  const line = m ? lineOf(textOf(m), m.attachments?.length ?? 0) : "";
  return m && line ? { line, name: m.author?.name ?? "" } : null;
};

/** DM `key`'s (`hub/agent`) newest message, `last` by its id; null until
 *  it's known, or where it can't be. */
export function useDmPreview(key: string, last: string | null): Preview | null {
  const history = useChat((s) => s.histories[key]?.messages);
  const open = useMemo(() => (history ? fromChat(history, last) : null), [history, last]);
  const id = `${key}@${last ?? ""}`;
  const kept = usePreviews((s) => s[id]);
  useEffect(() => {
    if (open || kept !== undefined || asking.has(id)) return;
    const [hubId = "", ...rest] = key.split("/");
    const hub = useChat.getState().hubs.find((h) => h.id === hubId);
    if (!hub) return;
    asking.add(id);
    readConversation(hub, rest.join("/"), { limit: PREVIEW_PAGE })
      .then((page) => usePreviews.setState({ [id]: page ? fromHub(page.messages, last) : null }))
      .catch(() => usePreviews.setState({ [id]: null }))
      .finally(() => asking.delete(id));
  }, [open, kept, id, key, last]);
  return open ?? kept ?? null;
}

/** For tests: forgets what was read. */
export const forgetPreviews = (): void => {
  asking.clear();
  usePreviews.setState({}, true);
};
