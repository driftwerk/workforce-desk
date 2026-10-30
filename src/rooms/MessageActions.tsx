import { useDesk } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { requestFocus } from "../shell/focus";
import { deskLink } from "../shell/links";
import { openTarget } from "../shell/navigate";
import { useUi } from "../shell/ui";
import type { MenuEntry } from "../ui/Menu";
import { actionsFor, ON_BAR, quoteFor, type Action, type ActionId } from "./actions";
import { askAgain, postToRoom, removeMember } from "./engine";
import { memberOf } from "./routing";

const copy = (text: string, what: string) =>
  void navigator.clipboard.writeText(text).catch(() => useDesk.getState().fail(`Couldn’t copy the ${what}.`));

/** Does action `id` on room message `m`, shown in `thread` (null: the main
 *  timeline). `markUnread` is the timeline's own. */
export function runAction(id: ActionId, room: Room, m: RoomMessage, ctx: { thread: string | null; name: string; markUnread: () => void }): void {
  const fail = (e: unknown) => useDesk.getState().fail(e);
  const member = memberOf(m.author);
  switch (id) {
    case "thread":
      if (m.copyOf) return openTarget({ kind: "room", roomId: room.id, threadId: null, messageId: m.copyOf });
      return useUi.getState().setRoomThread(room.id, m.id);
    case "copyText":
      return copy(m.content, "text");
    case "copyLink":
      return copy(deskLink({ room: room.id, message: m.id }), "link");
    case "askSomeone":
      return requestFocus(ctx.thread ? `room:${room.id}/${ctx.thread}` : `room:${room.id}`, `${quoteFor(m, ctx.name)}\n\n@`);
    case "askAgain":
      return void askAgain(room, m).catch(fail);
    case "postToRoom":
      return void postToRoom(room, m).catch(fail);
    case "markUnread":
      return ctx.markUnread();
    case "dm":
      return openTarget({ kind: "agent", key: m.author });
    case "makeLead": {
      const hub = useDesk.getState().hub;
      if (!hub) return;
      return void hub
        .updateRoom(room.id, { defaultMember: m.author })
        .then((r) => useDesk.setState((s) => ({ rooms: { ...s.rooms, [r.id]: r } })))
        .catch(fail);
    }
    case "removeFromRoom":
      return void (member && removeMember(room, member).catch(fail));
  }
}

/** A message's actions as a menu's entries; More's last ones under it. */
export const menuEntries = (actions: Action[], run: (id: ActionId) => void): MenuEntry[] =>
  actions.map((a) => ({ kind: "item", label: a.label, kbd: a.key, onSelect: () => run(a.id) }));

const ICON: Partial<Record<ActionId, string>> = { thread: "↳ Thread", copyText: "Copy", askSomeone: "Ask…" };

/** The bar on a message while it's hovered or focused: its first actions,
 *  and More for the rest. */
export function MessageActions({
  room,
  m,
  thread,
  onRun,
  onMore,
}: {
  room: Room;
  m: RoomMessage;
  thread: string | null;
  onRun: (id: ActionId) => void;
  onMore: (from: HTMLElement) => void;
}) {
  const actions = actionsFor(m, { inThread: !!thread, room, name: "" }).slice(0, ON_BAR);
  return (
    <span className="msg-actions" role="toolbar" aria-label="Message actions">
      {actions.map((a) => (
        <button key={a.id} type="button" className="msg-action" title={a.key ? `${a.label} (${a.key})` : a.label} onClick={() => onRun(a.id)}>
          {ICON[a.id] ?? a.label}
        </button>
      ))}
      <button type="button" className="msg-action" aria-haspopup="menu" title="More (Shift+F10)" aria-label="More actions" onClick={(e) => onMore(e.currentTarget)}>
        ⋯
      </button>
    </span>
  );
}
