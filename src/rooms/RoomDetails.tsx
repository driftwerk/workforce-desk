import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useNeeds } from "../floor/store";
import { HubError } from "../hub/client";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMemberRef } from "../hub/types";
import { useUi } from "../shell/ui";
import { CloseButton, Dialog } from "../ui/Dialog";
import { NOTIFY_LEVELS, setLevel, useLevel } from "../unread/prefs";
import { DeleteRoom } from "./DeleteRoom";
import { removeMember } from "./engine";
import { MemberMark } from "./MemberMark";
import { MemberPicker } from "./MemberPicker";
import { useAuthor } from "./names";
import { memberKey } from "./routing";

const HINTS: Record<string, string> = {
  all: "Every answer and hand-off, while Desk isn’t in front.",
  mine: "What needs you, answers to you that took a while, reminders.",
  off: "Nothing; badges and Activity still show.",
};

/** What a member is doing in the room now. */
const stateOf = (drafts: readonly RoomDraft[], asked: boolean): string => {
  if (asked || drafts.some((d) => d.prompts.length)) return "Waiting on you";
  if (drafts.some((d) => d.state === "live" || d.state === "stalled")) return "Answering";
  if (drafts.some((d) => d.state === "queued" || d.state === "busy" || d.state === "connecting")) return "Queued";
  if (drafts.some((d) => d.state === "failed" || d.state === "stopped" || d.state === "interrupted")) return "Failed";
  return "Idle";
};

const NO_DRAFTS: RoomDraft[] = [];

/** A room's details: its name, members and their state, the lead, how much
 *  it may interrupt you, and deleting it. */
export function RoomDetails({ room, rename, onClose }: { room: Room; rename: boolean; onClose: () => void }) {
  const hub = useDesk((s) => s.hub);
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const hubs = useChat((s) => s.hubs);
  const needs = useNeeds();
  const author = useAuthor();
  const level = useLevel({ kind: "room", room: room.id });
  const [name, setName] = useState(room.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rename) field.current?.select();
  }, [rename]);

  const kept = (r: Room) => useDesk.setState((s) => ({ rooms: { ...s.rooms, [r.id]: r } }));
  const update = async (patch: { name?: string; members?: RoomMemberRef[]; defaultMember?: string | null }) => {
    if (!hub) return;
    setProblem(null);
    try {
      kept(await hub.updateRoom(room.id, patch));
    } catch (e) {
      setProblem(e instanceof HubError && e.status === 409 ? `There’s already a room called ${patch.name ?? name}.` : e instanceof Error ? e.message : String(e));
    }
  };
  const remove = (m: RoomMemberRef) => void removeMember(room, m).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  const add = async () => {
    const more = (adding ?? []).map((k) => {
      const [h = "", ...rest] = k.split("/");
      return { hub: h, agent: rest.join("/") };
    });
    setAdding(null);
    if (more.length) await update({ members: [...room.members, ...more] });
  };

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <h2 id={id} className="display-md">
            {room.name}
          </h2>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== room.name) void update({ name: name.trim() });
        }}
      >
        <label htmlFor={`room-name-${room.id}`}>Name</label>
        <span className="details-row">
          <input id={`room-name-${room.id}`} ref={field} value={name} onChange={(e) => setName(e.target.value)} data-autofocus={rename || undefined} />
          <button type="submit" className="btn btn-signal" disabled={!name.trim() || name.trim() === room.name}>
            Save
          </button>
        </span>
        <span className="faint small">Renaming keeps every agent’s conversation for this room.</span>
      </form>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}

      <section className="field" aria-label="Members">
        <span className="details-row">
          <span>Members · {room.members.length}</span>
          <button type="button" className="btn" onClick={() => setAdding(adding ? null : [])}>
            Add someone
          </button>
        </span>
        {adding && (
          <>
            <MemberPicker
              picked={adding}
              leaveOut={room.members.map(memberKey)}
              onToggle={(k) => setAdding((p) => (p ?? []).includes(k) ? (p ?? []).filter((x) => x !== k) : [...(p ?? []), k])}
            />
            <button type="button" className="btn btn-signal" disabled={!adding.length} onClick={() => void add()}>
              Add to the room
            </button>
          </>
        )}
        <div role="radiogroup" aria-label="Lead" className="details-members">
          {room.members.map((m) => {
            const key = memberKey(m);
            const a = author(key);
            const here = drafts.filter((d) => d.member === key);
            const asked = needs.some((n) => n.place.kind === "room" && n.place.room === room.id && `${n.hubId}/${n.who.id}` === key);
            const away = !hubs.some((h) => h.id === m.hub);
            return (
              <div key={key} className="details-member">
                <MemberMark member={key} name={a.name} size="sm" />
                <span className="details-member-name">
                  <b>{a.name}</b>
                  <span className="faint small">
                    {a.home} · {away ? "Workspace not connected" : stateOf(here, asked)}
                  </span>
                </span>
                <label className="small">
                  <input type="radio" name={`lead-${room.id}`} checked={room.defaultMember === key} onChange={() => void update({ defaultMember: key })} /> Lead
                </label>
                <button type="button" className="btn btn-danger" onClick={() => remove(m)}>
                  Remove
                </button>
              </div>
            );
          })}
          <label className="details-member small">
            <input type="radio" name={`lead-${room.id}`} checked={room.defaultMember === null} onChange={() => void update({ defaultMember: null })} /> No lead —
            messages must @ someone to be answered
          </label>
        </div>
        <span className="faint small">Removing someone stops their answer first, and drops what was queued for them. They stay in your crew.</span>
      </section>

      <section className="field" role="radiogroup" aria-label="Notifications">
        <span>Notifications</span>
        {NOTIFY_LEVELS.map((l) => (
          <label key={l.id} className="details-level">
            <input type="radio" name={`notify-${room.id}`} checked={level === l.id} onChange={() => setLevel({ kind: "room", room: room.id }, l.id)} />
            <span>
              {l.label}
              <span className="faint small"> · {HINTS[l.id]}</span>
            </span>
          </label>
        ))}
      </section>

      <footer className="sheet-foot">
        <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
          Delete room…
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </footer>
      {deleting && <DeleteRoom room={room} onClose={() => setDeleting(false)} onDeleted={onClose} />}
    </Dialog>
  );
}

/** The details open for a room, from its header or its menu in the sidebar. */
export function OpenRoomDetails() {
  const open = useUi((u) => u.roomDetails);
  const room = useDesk((s) => (open ? s.rooms[open.room] : undefined));
  if (!open || !room) return null;
  return <RoomDetails key={room.id} room={room} rename={open.rename} onClose={() => useUi.getState().setRoomDetails(null)} />;
}
