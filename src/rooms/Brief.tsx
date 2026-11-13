import { useId, useState } from "react";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import type { BriefGroup, BriefItem } from "../hub/types";
import { plainError } from "../ui/plainError";
import { UNDO_LABEL, useUndo } from "./Overseer";
import { useSettled } from "./settled";

// The boss's update said briefly: the sessions it touched, each a small
// label with its items under it, one line an item. A green ✓ is done, an
// amber ● is for you; why follows a dash, quieter. What's longer waits
// behind "more", Undo is faint until the line is hovered or focused, and
// what was settled since folds into one faint line.

/** Items you marked Done here, for as long as Desk runs. */
const doneHere = new Set<string>();

/** Its words without a closing period: the line reads on after a dash. */
const clause = (s: string): string => s.trim().replace(/[.;:]+$/, "");

export function Brief({ groups }: { groups: readonly BriefGroup[] }) {
  return (
    <>
      {groups
        .filter((g) => g.items.length > 0)
        .map((g, i) => (
          <Group key={g.sessionId ?? `g${i}`} group={g} />
        ))}
    </>
  );
}

function Group({ group }: { group: BriefGroup }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  // Settled as heard since it was posted: its ids, joined, so the line
  // draws again only when one of its own is settled.
  const heard = useSettled((s) =>
    group.items
      .filter((i) => !i.settledBy && s.by[i.id])
      .map((i) => `${i.id}:${s.by[i.id]}`)
      .join(","),
  );
  const heardBy = new Map(heard ? heard.split(",").map((p) => p.split(":") as [string, string]) : []);
  const byOf = (i: BriefItem) => i.settledBy ?? heardBy.get(i.id) ?? null;
  const live = group.items.filter((i) => !byOf(i));
  const settled = group.items.filter((i) => !!byOf(i));
  const bySession = settled.every((i) => byOf(i) === "session");
  const alone = group.leftAlone ?? 0;
  return (
    <section className="brief-group" aria-label={group.label}>
      <span className="brief-label">{group.label}</span>
      <ul className="brief-items">
        {live.map((i) => (
          <Row key={i.id} item={i} />
        ))}
        {settled.length > 0 && (
          <li className="brief-row brief-settled">
            <span className="brief-mark" aria-hidden>
              ✓
            </span>
            <button type="button" className="link brief-fold" aria-expanded={open} aria-controls={list} onClick={() => setOpen((o) => !o)}>
              {bySession ? "Settled in the session" : "Settled"}
              {settled.length > 1 ? ` · ${settled.length}` : ""}
            </button>
          </li>
        )}
        {open && settled.length > 0 && (
          <li className="brief-settled-list" id={list}>
            <ul className="brief-items">
              {settled.map((i) => (
                <Row key={i.id} item={i} quiet />
              ))}
            </ul>
          </li>
        )}
        {alone > 0 && (
          <li className="brief-row brief-settled">
            <span className="brief-mark" aria-hidden />
            <span>{alone === 1 ? "Left it alone once" : `Left it alone ${alone} times`}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

function Row({ item, quiet = false }: { item: BriefItem; quiet?: boolean }) {
  const connected = useDesk((s) => !!s.hub);
  const [more, setMore] = useState(false);
  const panel = useId();
  const what = clause(item.action);
  const forYou = item.kind === "forYou";
  const { undone, isUndone, fixed, busy, problem, undo } = useUndo(item.id, false);
  const [marked, setMarked] = useState(doneHere.has(item.id));
  const [marking, setMarking] = useState(false);
  const [markProblem, setMarkProblem] = useState<string | null>(null);
  const markDone = async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    setMarking(true);
    setMarkProblem(null);
    try {
      await hub.doneItem(item.id);
      doneHere.add(item.id);
      setMarked(true);
    } catch (e) {
      // Settled already, or gone: it is off your list either way.
      if (e instanceof HubError && (e.status === 404 || e.status === 409)) {
        doneHere.add(item.id);
        setMarked(true);
      } else setMarkProblem(plainError(e));
    }
    setMarking(false);
  };
  const settledNow = forYou && marked;
  const mark = forYou && !settledNow ? "●" : "✓";
  const tone = quiet || settledNow ? "faint" : forYou ? "for-you" : "done";
  const said = problem ?? markProblem;
  return (
    <li className={`brief-row${quiet || settledNow ? " is-quiet" : ""}`}>
      <span className={`brief-mark ${tone}`} aria-label={forYou && !settledNow ? "For you" : "Done"} role="img">
        {mark}
      </span>
      <span className="brief-text">
        <span className={`brief-action${isUndone ? " dec-undone" : ""}`}>{what}</span>
        {item.why && <span className="brief-why"> — {clause(item.why)}</span>}
        {item.detail && (
          <button type="button" className="link brief-more" aria-expanded={more} aria-controls={panel} aria-label={`${more ? "Less" : "More"}: ${what}`} onClick={() => setMore((m) => !m)}>
            {more ? "less" : "more"}
          </button>
        )}
        {isUndone && (
          <span className="faint small" role="status">
            {" "}
            {undone ? `Undone: ${undone}.` : "Undone."}
          </span>
        )}
        {settledNow && (
          <span className="faint small" role="status">
            {" "}
            Done.
          </span>
        )}
        {said && (
          <span className="small state-blocked" role="alert">
            {" "}
            {said}
          </span>
        )}
      </span>
      <span className="brief-tools">
        {!forYou && !quiet && !isUndone && item.undo && !fixed && (
          <button type="button" className="link" aria-label={`${UNDO_LABEL[item.undo]}: ${what}`} disabled={busy || !connected} onClick={() => void undo()}>
            {UNDO_LABEL[item.undo]}
          </button>
        )}
        {forYou && !settledNow && !quiet && (
          <button type="button" className="link brief-done" aria-label={`Done: ${what}`} disabled={marking || !connected} onClick={() => void markDone()}>
            Done
          </button>
        )}
      </span>
      {more && item.detail && (
        <p className="brief-detail" id={panel}>
          {item.detail}
        </p>
      )}
    </li>
  );
}
