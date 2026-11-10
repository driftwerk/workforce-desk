import { useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useNeeds } from "../floor/store";
import { HubError } from "../hub/client";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMemberRef } from "../hub/types";
import { useUi } from "../shell/ui";
import { useHubLayout } from "../groups/hubLayout";
import { askMove } from "../groups/move";
import { UNGROUPED } from "../groups/model";
import { useLayout } from "../groups/store";
import { Confirm } from "../ui/Confirm";
import { CloseButton, Dialog } from "../ui/Dialog";
import { NOTIFY_LEVELS, setLevel, useLevel } from "../unread/prefs";
import { DeleteRoom } from "./DeleteRoom";
import { removeMember } from "./engine";
import { MemberMark } from "./MemberMark";
import { MemberPicker } from "./MemberPicker";
import { useAuthor } from "./names";
import { memberKey } from "./routing";

const HINTS: Record<string, string> = {
  all: "Every answer and hand-off while Desk isn’t in front",
  mine: "What needs you, slow answers to you, reminders",
  off: "None; badges and Activity still show",
};

/** What a member is doing in the room now. */
const stateOf = (drafts: readonly RoomDraft[], asked: boolean): string => {
  if (asked || drafts.some((d) => d.prompts.length)) return "Waiting on you";
  if (drafts.some((d) => d.state === "live" || d.state === "stalled")) return "Answering";
  if (drafts.some((d) => d.state === "queued" || d.state === "busy" || d.state === "connecting")) return "Queued";
  if (drafts.some((d) => d.state === "failed" || d.state === "interrupted")) return "Failed";
  if (drafts.some((d) => d.state === "stopped")) return "Stopped";
  return "Idle";
};

const NO_DRAFTS: RoomDraft[] = [];

/** A room's settings: its name, members and their state, the lead, its
 *  group, how much it may interrupt you, and deleting it. Laid out as the
 *  Move dialog is (.move-*). */
export function RoomDetails({ room, rename, onClose }: { room: Room; rename: boolean; onClose: () => void }) {
  const ids = useId();
  const hub = useDesk((s) => s.hub);
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const hubs = useChat((s) => s.hubs);
  const needs = useNeeds();
  const author = useAuthor();
  const level = useLevel({ kind: "room", room: room.id });
  const [name, setName] = useState(room.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<RoomMemberRef | null>(null);
  const [deleting, setDeleting] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const movable = useHubLayout((s) => s.layout !== null);
  const groups = useLayout().groups;
  const groupName = (room.group && groups.find((g) => g.id === room.group)?.name) || "Ungrouped";
  useEffect(() => {
    if (rename) field.current?.select();
  }, [rename]);

  const renamed = name.trim() !== "" && name.trim() !== room.name;
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
  const add = async () => {
    const more = (adding ?? []).map((k) => {
      const [h = "", ...rest] = k.split("/");
      return { hub: h, agent: rest.join("/") };
    });
    setAdding(null);
    if (more.length) await update({ members: [...room.members, ...more] });
  };
  const removingName = removing ? author(memberKey(removing)).name : "";

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {room.name}
            </h1>
            <p className="small">Room settings</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll move-body room-settings">
        <form
          className="move-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (renamed) void update({ name: name.trim() });
          }}
        >
          <label className="move-legend" htmlFor={`${ids}-name`}>
            Name
          </label>
          <span className="room-name">
            <input
              id={`${ids}-name`}
              ref={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // Escape puts the name back first, then closes.
                if (e.key === "Escape" && name !== room.name) {
                  e.stopPropagation();
                  setName(room.name);
                }
              }}
              aria-describedby={`${ids}-name-hint`}
              data-autofocus={rename || undefined}
            />
            {renamed && (
              <button type="submit" className="btn btn-signal">
                Save
              </button>
            )}
          </span>
          <span id={`${ids}-name-hint`} className="move-opt-sub">
            Renaming keeps every agent’s conversation here.
          </span>
        </form>
        {problem && (
          <p className="move-callout move-refused" role="alert">
            {problem}
          </p>
        )}

        <section className="move-field" aria-label="Members">
          <div className="room-section-head">
            <h2 className="move-legend">
              Members · {room.members.length}
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={!!adding} onClick={() => setAdding(adding ? null : [])}>
              {adding ? "Cancel" : "Add someone"}
            </button>
          </div>
          {adding && (
            <div className="room-adding" role="group" aria-label="Add someone">
              <MemberPicker
                picked={adding}
                leaveOut={room.members.map(memberKey)}
                onToggle={(k) => setAdding((p) => ((p ?? []).includes(k) ? (p ?? []).filter((x) => x !== k) : [...(p ?? []), k]))}
              />
              <button type="button" className="btn btn-signal btn-sm" disabled={!adding.length} onClick={() => void add()}>
                Add to the room
              </button>
            </div>
          )}
          <div className="move-opts" role="radiogroup" aria-label="Lead">
            {room.members.map((m) => {
              const key = memberKey(m);
              const a = author(key);
              const here = drafts.filter((d) => d.member === key);
              const asked = needs.some((n) => n.place.kind === "room" && n.place.room === room.id && `${n.hubId}/${n.who.id}` === key);
              const away = !hubs.some((h) => h.id === m.hub);
              const leads = room.defaultMember === key;
              return (
                <div key={key} className="move-opt room-member">
                  <label className="room-member-pick">
                    <input type="radio" name={`${ids}-lead`} aria-label={`${a.name} leads`} checked={leads} onChange={() => void update({ defaultMember: key })} />
                    <span className="move-opt-lead" aria-hidden="true">
                      <MemberMark member={key} name={a.name} size="sm" />
                    </span>
                    <span className="move-opt-main">
                      <span className="room-member-name">
                        {a.name}
                        {leads && <span className="chip chip-default">Lead</span>}
                      </span>
                      <span className="move-opt-sub">
                        {a.home} · {away ? "Workspace not connected" : stateOf(here, asked)}
                      </span>
                    </span>
                  </label>
                  <button type="button" className="icon-btn-sm room-member-remove" aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} onClick={() => setRemoving(m)}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />
                    </svg>
                  </button>
                </div>
              );
            })}
            <label className="move-opt">
              <input type="radio" name={`${ids}-lead`} checked={room.defaultMember === null} onChange={() => void update({ defaultMember: null })} />
              <span className="move-opt-lead" aria-hidden="true">
                <span className="move-opt-mark" />
              </span>
              <span className="move-opt-main">
                <span>No lead</span>
                <span className="move-opt-sub">messages must @ someone to be answered</span>
              </span>
            </label>
          </div>
          <span className="move-opt-sub">The lead answers messages that @ no one.</span>
        </section>

        {movable && (
          <section className="move-field" aria-label="Group">
            <h2 className="move-legend">
              Group
            </h2>
            <div className="move-opt room-static">
              <span className="move-opt-main">
                <span>{groupName}</span>
                <span className="move-opt-sub">Moves only between groups the same boss oversees</span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                aria-label="Move to group…"
                onClick={() => askMove({ kind: "room", id: room.id, name: room.name, from: room.group ?? UNGROUPED })}
              >
                Move…
              </button>
            </div>
          </section>
        )}

        <fieldset className="move-field">
          <legend>Notifications</legend>
          <div className="move-opts" role="radiogroup" aria-label="Notifications">
            {NOTIFY_LEVELS.map((l) => (
              <label key={l.id} className="move-opt">
                <input type="radio" name={`${ids}-notify`} checked={level === l.id} onChange={() => setLevel({ kind: "room", room: room.id }, l.id)} />
                <span className="move-opt-main">
                  <span>{l.label}</span>
                  <span className="move-opt-sub">{HINTS[l.id]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <footer className="dialog-foot move-foot">
        <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
          Delete room…
        </button>
        <span className="dialog-foot-note" />
        <button type="button" className="btn btn-signal" onClick={onClose}>
          Done
        </button>
      </footer>
      {removing && (
        <Confirm
          title={`Remove ${removingName}?`}
          action="Remove"
          onConfirm={() => removeMember(room, removing)}
          onClose={() => setRemoving(null)}
        >
          <p className="muted">
            Their answer here stops first, and what was queued for them is dropped. {removingName} stays in your crew.
          </p>
        </Confirm>
      )}
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
