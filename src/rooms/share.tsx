import { create } from "zustand";
import { useChat } from "../chat/store";
import { HubError } from "../hub/client";
import { Confirm } from "../ui/Confirm";

/** The hubs a room's conversation would go to that the person hasn't said
 *  it may, when that's what the hub refused for: a room of a group with a
 *  boss asks once per hub (hub: `room_shares`). */
export const sharesAsked = (e: unknown): string[] | null =>
  e instanceof HubError && e.status === 409 && e.hubs?.length ? e.hubs : null;

/** Thrown when the person said no: nothing was saved, and nothing more is
 *  said of it. */
export class NotShared extends Error {
  constructor() {
    super("Not shared");
  }
}

interface Ask {
  room: string;
  hubs: string[];
  answer: (yes: boolean) => void;
}

const useShareAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Asks the person, in Desk's own dialog, whether `room`'s conversation may
 *  go to `hubs`. Only the person answers: the dialog is Desk's, and no
 *  agent's message or tool reaches it. */
export const askToShare = (room: string, hubs: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    // One question at a time: one asked before it is answered no.
    useShareAsk.getState().ask?.answer(false);
    useShareAsk.setState({
      ask: {
        room,
        hubs,
        answer: (yes) => {
          useShareAsk.setState({ ask: null });
          resolve(yes);
        },
      },
    });
  });

/** Saves with `save`; when the hub asks whether the room may go to other
 *  hubs, asks the person and, on yes, saves again saying so. On no, throws
 *  `NotShared` and nothing is saved. */
export async function savingShared<T>(room: string, save: (shareWith: string[]) => Promise<T>): Promise<T> {
  try {
    return await save([]);
  } catch (e) {
    const hubs = sharesAsked(e);
    if (!hubs) throw e;
    if (!(await askToShare(room, hubs))) throw new NotShared();
    return save(hubs);
  }
}

/** The workspaces `hubs` are, by the names Desk shows them under. */
export const workspaceNames = (hubs: readonly string[]): string => {
  const known = useChat.getState().hubs;
  const names = hubs.map((h) => known.find((k) => k.id === h)?.label ?? h);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** Where the question is shown, once in the app. */
export function ShareAsk() {
  const ask = useShareAsk((s) => s.ask);
  if (!ask) return null;
  const names = workspaceNames(ask.hubs);
  return (
    <Confirm
      title={`Share ${ask.room} with ${names}?`}
      action={`Share with ${names}`}
      tone="signal"
      onConfirm={() => ask.answer(true)}
      onClose={() => ask.answer(false)}
    >
      <p>
        Agents on {names} will see this room’s conversation: what’s said in its threads goes to {ask.hubs.length === 1 ? "that workspace" : "those workspaces"}.
        You’re asked once for each workspace.
      </p>
    </Confirm>
  );
}
