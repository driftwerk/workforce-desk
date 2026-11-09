// One section of the Floor by group (see sections.ts): its header (the group,
// who runs it and how, its spend, Message Sarah), what needs you there and
// why it reached you, its plans' progress, what's working there as tiles,
// marked whose it is, and how many are done today. Collapsed, a section
// keeps its needs in view.

import { useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import { SessionTicketChip } from "../board/TicketChip";
import { ChargeBadge } from "../crew/ChargeBadge";
import { useCharge } from "../crew/chargeStore";
import { ENGINE_TITLE } from "../engines/engines";
import { GroupDot } from "../groups/GroupChip";
import { useLayout } from "../groups/store";
import { useHubLayout } from "../groups/hubLayout";
import { askMove, sessionSubject } from "../groups/move";
import { askHandoff } from "../handoff/store";
import { SwapIcon } from "../handoff/LineageChips";
import { continuedFrom, fromShort } from "../handoff/words";
import { below, MoreIcon } from "../groups/rows";
import { Menu } from "../ui/Menu";
import type { BossView, PlanProgress } from "../hub/types";
import { localKey, openLocalDm } from "../overview/people";
import { useSessionName } from "../groups/names";
import { Mark } from "../ui/Mark";
import { openTarget } from "../shell/navigate";
import { standingText } from "../spend/budgets";
import { AgentMark } from "../ui/Mark";
import type { Target } from "../shell/navigate";
import type { FloorNeed, FloorWork } from "./merge";
import { sessionKeyOfItem } from "./needs";
import { NeedRow } from "./NeedRow";
import { FloorRow, useStaleNote, useWhoName } from "./Row";
import { useFloor, useMerged } from "./store";
import {
  doneIn,
  floorSections,
  oversightOf,
  placer,
  sectionDomId,
  sectionName,
  workingIn,
  type DeskItem,
  type FloorLayout,
  type Placer,
  type Section,
  type SealedNote,
} from "./sections";
import { besideOf } from "./target";
import { clock, durationOf } from "./time";

/** The Floor's sections now, from every hub's floor (as the header counts
 *  it), this computer's hub's word on who oversees what, and the sidebar. */
export const useSections = (desk: readonly DeskItem[] = NO_DESK): FloorLayout => {
  const merged = useMerged();
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const local = useFloor((s) => (localId ? s.hubs[localId]?.floor : null));
  const layout = useLayout();
  const day = useFloor((s) => s.day);
  return useMemo(() => floorSections(merged, oversightOf(local), layout, { day, desk, localHub: localId }), [merged, local, layout, day, desk, localId]);
};

const NO_DESK: readonly DeskItem[] = [];

/** How what's on the floor is placed among the sections now. */
export const usePlacer = (): Placer => {
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const local = useFloor((s) => (localId ? s.hubs[localId]?.floor : null));
  const layout = useLayout();
  return useMemo(() => placer(layout, oversightOf(local)), [local, layout]);
};

/** Which sections the person has folded, for as long as Desk runs: the
 *  sidebar's own groups fold apart from these. */
export const useFolded = create<{ folded: Record<string, true>; fold: (id: string, folded: boolean) => void }>((set) => ({
  folded: {},
  fold: (id, folded) =>
    set((s) => {
      const next = { ...s.folded };
      if (folded) next[id] = true;
      else delete next[id];
      return { folded: next };
    }),
}));

const LEVEL: Record<string, string> = { watch: "Watch", suggest: "Suggest", act: "Act" };

/** "working", "idle", or what holds it. */
function BossState({ boss }: { boss: BossView }) {
  if (boss.paused) return <span className="state-blocked">paused · {boss.paused}</span>;
  return boss.state === "working" ? <span className="state-working">working</span> : <span>idle</span>;
}

/** Who runs the section, how, and how far its budget has gone. */
function BossLine({ section }: { section: Section }) {
  const { boss } = section;
  if (section.kind === "sealed") return <span className="fsec-boss">No one oversees it now · what it asks comes to you</span>;
  const covers =
    section.kind === "main"
      ? [
          "ungrouped",
          section.unbossed.length ? `and ${section.unbossed.map((g) => g.name).join(", ")} (no boss of ${section.unbossed.length === 1 ? "its" : "their"} own)` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : null;
  if (!boss) return <span className="fsec-boss">No one oversees these · what they ask comes to you{covers ? ` · ${covers}` : ""}</span>;
  return (
    <span className="fsec-boss">
      {boss.name} runs it · <BossState boss={boss} /> · {LEVEL[boss.level] ?? boss.level}
      {boss.spend && (
        <>
          {" "}
          · <span className={`mono${boss.spend.status === "under" ? "" : " state-blocked"}`}>{standingText(boss.spend)}</span>
        </>
      )}
      {covers && <> · {covers}</>}
    </span>
  );
}

/** "3 of 8 done · 3 running · next ACM-16", with the plan's tickets as a
 *  segmented bar. */
export function PlanProgressCard({ plan }: { plan: PlanProgress }) {
  const p = plan.progress;
  const parts: { key: string; n: number; label: string }[] = [
    { key: "done", n: p.done, label: "done" },
    { key: "doing", n: p.doing, label: "doing" },
    { key: "review", n: p.review, label: "in review" },
    { key: "ready", n: p.ready, label: "ready" },
    { key: "blocked", n: p.blocked, label: "blocked" },
    { key: "waiting", n: p.waiting, label: "waiting" },
  ].filter((x) => x.n > 0);
  const said = parts.map((x) => `${x.n} ${x.label}`).join(", ");
  return (
    <div className="fsec-plan" role="group" aria-label={`Plan: ${plan.goal}`}>
      <div className="fsec-plan-top">
        <span className="fsec-plan-name">{plan.goal}</span>
        {plan.state === "proposed" && <span className="chip fsec-chip-waiting">Waiting for you</span>}
        <span className="muted small">
          {p.done} of {p.total} done
          {p.doing > 0 && ` · ${p.doing} running`}
          {p.next[0] && plan.state !== "paused" && (
            <>
              {" "}
              · next <span className="mono">{p.next[0]}</span>
            </>
          )}
          {plan.state === "paused" && <span className="fsec-paused"> · paused{plan.pausedWhy ? `: ${plan.pausedWhy}` : ""}</span>}
        </span>
      </div>
      <div className="fsec-segbar" role="img" aria-label={said || "No tickets yet"}>
        {parts.map((x) => (
          <i key={x.key} className={`fsec-seg fsec-seg-${x.key}`} style={{ flexGrow: x.n }} />
        ))}
      </div>
      {parts.length > 0 && (
        <div className="fsec-legend" aria-hidden="true">
          {parts.map((x) => (
            <span key={x.key}>
              <i className={`fsec-seg-${x.key}`} />
              {x.n} {x.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whose a working session is: its boss's ("Sarah's"), or yours. */
function Whose({ work }: { work: FloorWork }) {
  const key = sessionKeyOfItem(work);
  const charge = useCharge(key);
  if (work.who.kind !== "session") return null;
  if (charge && !charge.releasedAt) return <ChargeBadge charge={charge} short />;
  return <span className="charge-badge charge-you">yours</span>;
}

/** Something running in a section: who, what it's doing now, its engine, its
 *  ticket and whose it is. It opens beside the Floor. */
function WorkTile({ work, now, chip }: { work: FloorWork; now: number; chip: { id: string; name: string } | null }) {
  // One Desk can't put to anyone still shows, by what the hub calls it, so
  // what's drawn and what's counted agree.
  const name = useWhoName(work);
  const stale = useStaleNote(work);
  const target = besideOf(work);
  const key = sessionKeyOfItem(work);
  const look = work.background ? "background" : "working";
  const text = work.gist?.now ?? work.what;
  const head = (
    <>
      <span className={`dot dot-${look}`} aria-hidden="true" />
      <span className={work.who.kind === "session" ? "mono fsec-tile-title" : "fsec-tile-title"}>{name}</span>
    </>
  );
  return (
    <article className={`fsec-tile ${work.stale ? "floor-stale" : ""}`} aria-label={name} title={stale}>
      <div className="fsec-tile-top">
        {target ? (
          <button type="button" className="fsec-tile-head" onClick={() => openTarget(target, { beside: true })}>
            {head}
          </button>
        ) : (
          <div className="fsec-tile-head">{head}</div>
        )}
        {work.local && key && <TileMenu session={key} name={name} />}
      </div>
      {text && <p className="fsec-tile-gist">{text}</p>}
      <div className="fsec-tile-foot">
        {work.who.engine && work.who.kind === "session" && <span className="chip">{ENGINE_TITLE[work.who.engine]}</span>}
        {work.continued && (
          <span className="chip lineage-chip" title={`${continuedFrom(work.continued)}: the session it was handed from is folded under this one`}>
            <SwapIcon />
            {fromShort(work.continued)}
          </span>
        )}
        {key && <SessionTicketChip session={key} />}
        {chip && (
          <span className="chip chip-group" title={`In ${chip.name}`}>
            <GroupDot id={chip.id} />
            {chip.name}
          </span>
        )}
        <Whose work={work} />
        <span className="faint small">{durationOf(work.since, now)}</span>
      </div>
    </article>
  );
}

/** "Done today · 5", opening to what finished. */
function DoneToday({ done, desk }: { done: readonly FloorWork[]; desk: readonly DeskItem[] }) {
  const [open, setOpen] = useState(false);
  if (done.length + desk.length === 0) return null;
  return (
    <div className="fsec-done">
      <button type="button" className="fsec-done-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dot dot-done" aria-hidden="true" />
        Done today · {done.length + desk.length}
      </button>
      {open && (
        <div className="fsec-done-list">
          {done.map((w) => (
            <FloorRow key={w.key} item={w} look={w.outcome === "failed" ? "failed" : "done"} time={`ended ${w.endedAt ? clock(w.endedAt) : ""}`}>
              {w.gist?.now ?? w.what}
              {w.continued && <span className="faint"> · {continuedFrom(w.continued)}</span>}
            </FloorRow>
          ))}
          {desk.length > 0 && (
            <div className="fsec-tiles">
              {desk.map((d) => (
                <DeskTile key={d.key} item={d} chip={null} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DESK_STATE: Record<DeskItem["look"], { text: string; tone: string }> = {
  blocked: { text: "Blocked, nothing asked", tone: "blocked" },
  working: { text: "working", tone: "working" },
  done: { text: "done", tone: "done" },
};

/** One of this computer's sessions or agents that Desk shows needing you,
 *  working or done, with no turn on any hub's floor: drawn in its section
 *  all the same, saying so when it is blocked with nothing asked. */
export function DeskTile({ item, chip }: { item: DeskItem; chip: { id: string; name: string } | null }) {
  const named = useSessionName(item.who.kind === "session" ? item.who.id : null, item.name);
  const name = item.who.kind === "session" ? named : item.name;
  const localId = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const charge = useCharge(item.who.kind === "session" ? item.who.id : null);
  const state = DESK_STATE[item.look];
  const target: Target | null =
    item.who.kind === "session" ? { kind: "session", sessionId: item.who.id } : localId ? { kind: "agent", key: `${localId}/${item.who.id}` } : null;
  const head = (
    <>
      {item.who.kind === "agent" && localId ? (
        <AgentMark agent={`${localId}/${item.who.id}`} name={name} state={item.look} />
      ) : (
        <Mark name={name} engine={item.engine ?? undefined} state={item.look} />
      )}
      <span className={item.who.kind === "session" ? "mono fsec-tile-title" : "fsec-tile-title"}>{name}</span>
    </>
  );
  return (
    <article className={`fsec-tile fsec-tile-${item.look}`} aria-label={name}>
      <div className="fsec-tile-top">
        {target ? (
          <button type="button" className="fsec-tile-head" onClick={() => openTarget(target, { beside: true })}>
            {head}
          </button>
        ) : (
          <div className="fsec-tile-head">{head}</div>
        )}
        {item.who.kind === "session" && <TileMenu session={item.who.id} name={name} />}
      </div>
      <span className={`small state-${state.tone}`}>{state.text}</span>
      {item.text && <p className="fsec-tile-gist">{item.text}</p>}
      <div className="fsec-tile-foot">
        {item.engine && item.who.kind === "session" && <span className="chip">{ENGINE_TITLE[item.engine]}</span>}
        {item.who.kind === "session" && <SessionTicketChip session={item.who.id} />}
        {chip && (
          <span className="chip chip-group" title={`In ${chip.name}`}>
            <GroupDot id={chip.id} />
            {chip.name}
          </span>
        )}
        {item.who.kind === "session" &&
          (charge && !charge.releasedAt ? <ChargeBadge charge={charge} short /> : <span className="charge-badge charge-you">yours</span>)}
      </div>
    </article>
  );
}

/** One of a sealed group's items, by name. */
function SealedItem({ item }: { item: FloorNeed | FloorWork }) {
  const name = useWhoName(item);
  return <b className={item.who.kind === "session" ? "mono" : undefined}>{name}</b>;
}

/** With no bossed group the Floor is flat, but a sealed group's items still
 *  reach only you: said, so you can give the group a boss again. */
export function SealedNotes({ notes }: { notes: readonly SealedNote[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="fsec-sealed-notes">
      {notes.map((n) => (
        <p key={n.group.id} className="fsec-sealed-note" role="note">
          <GroupDot id={n.group.id} />
          <span>
            No one oversees {n.group.name} now ·{" "}
            {n.items.map((i, k) => (
              <span key={i.key}>
                {k > 0 && ", "}
                <SealedItem item={i} />
              </span>
            ))}{" "}
            {n.items.length === 1 ? "is" : "are"} yours alone. Give {n.group.name} a boss from its menu in the sidebar.
          </span>
        </p>
      ))}
    </div>
  );
}

const FoldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 5l4 4 4-4" />
  </svg>
);

/** A section: its header, then its needs (in view folded too), its plans,
 *  what's working and what's done today. */
export function FloorSection({ section, now }: { section: Section; now: number }) {
  const folded = useFolded((s) => !!s.folded[section.id]);
  const fold = useFolded((s) => s.fold);
  const layout = useLayout();
  const title = section.kind === "main" ? "Everything else" : (section.group?.name ?? "");
  const chipOf = (key: string) => {
    const id = section.chips[key];
    const g = id ? layout.groups.find((x) => x.id === id) : undefined;
    return g ? { id: g.id, name: g.name } : null;
  };
  const boss = section.boss;
  const bossKey = boss ? localKey(boss.agent) : null;
  return (
    <section
      id={sectionDomId(section.id)}
      className={`fsec ${section.needs.length ? "fsec-needs" : ""} ${folded ? "fsec-folded" : ""}`}
      aria-label={section.kind === "main" && boss ? `${sectionName(section)}, everything else` : title}
    >
      <div className="fsec-head">
        {boss && bossKey ? <AgentMark agent={bossKey} name={boss.name} /> : section.group && <GroupDot id={section.group.id} />}
        <div className="fsec-name">
          <h2 className="display fsec-title">
            {section.group && boss && <GroupDot id={section.group.id} />}
            {title}
          </h2>
          <BossLine section={section} />
        </div>
        <div className="fsec-tools">
          {boss && (
            <button type="button" className="btn btn-sm" onClick={() => openLocalDm(boss.agent)}>
              Message {boss.name}
            </button>
          )}
          <button
            type="button"
            className="fsec-fold"
            aria-label={`${folded ? "Expand" : "Collapse"} ${title}`}
            aria-expanded={!folded}
            onClick={() => fold(section.id, !folded)}
          >
            <FoldIcon />
          </button>
        </div>
      </div>
      <div className="fsec-body">
        {section.needs.length > 0 && <Needs needs={section.needs} now={now} title={title} chipOf={chipOf} />}
        {!folded && (
          <>
            {section.plans.length > 0 && (
              <div>
                <h3 className="ov-label">{section.plans.length === 1 ? "Plan" : `Plans · ${section.plans.length}`}</h3>
                <div className="fsec-plans">
                  {section.plans.map((p) => (
                    <PlanProgressCard key={p.id} plan={p} />
                  ))}
                </div>
              </div>
            )}
            {workingIn(section) > 0 && (
              <div>
                <h3 className="ov-label state-working">Working · {workingIn(section)}</h3>
                <div className="fsec-tiles">
                  {section.working.map((w) => (
                    <WorkTile key={w.key} work={w} now={now} chip={chipOf(w.key)} />
                  ))}
                  {section.desk
                    .filter((d) => d.look !== "done")
                    .map((d) => (
                      <DeskTile key={d.key} item={d} chip={chipOf(d.key)} />
                    ))}
                </div>
              </div>
            )}
            <DoneToday done={section.done} desk={section.desk.filter((d) => d.look === "done")} />
            {section.needs.length + section.plans.length + workingIn(section) + doneIn(section) === 0 && (
              <p className="faint small">Nothing here needs you, and nothing is running.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** A section's needs, answered in place, each saying why it reached you. */
function Needs({
  needs,
  now,
  title,
  chipOf,
}: {
  needs: readonly FloorNeed[];
  now: number;
  title: string;
  chipOf: (key: string) => { id: string; name: string } | null;
}) {
  return (
    <div className="fsec-needs-col" role="group" aria-label={`Needs you · ${needs.length}`}>
      <h3 className="ov-label state-blocked">Needs you · {needs.length}</h3>
      <div className="fsec-needs-list" role="list" aria-label={`Waiting on you in ${title}`} tabIndex={-1}>
        {needs.map((n) => {
          const chip = chipOf(n.key);
          return (
            <div key={n.key} role="listitem" className="fsec-need">
              <NeedRow need={n} now={now} actions />
              {chip && (
                <span className="chip chip-group fsec-need-chip" title={`In ${chip.name}`}>
                  <GroupDot id={chip.id} />
                  {chip.name}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A tile's options, for one of this computer's sessions: moving it to
 *  another group, as the hub previews it (where the hub keeps the groups),
 *  and continuing it in another engine. */
function TileMenu({ session, name }: { session: string; name: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const kept = useHubLayout((s) => s.layout !== null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn-sm fsec-tile-more"
        aria-label={`${name} options`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => setAt(below(e.currentTarget))}
      >
        <MoreIcon />
      </button>
      {at && (
        <Menu
          label={`${name} options`}
          at={at}
          entries={[
            ...(kept ? [{ kind: "item" as const, label: "Move to group…", onSelect: () => askMove(sessionSubject(session, name)) }] : []),
            { kind: "item", label: "Continue in…", onSelect: () => askHandoff({ id: session }) },
          ]}
          onClose={(refocus) => {
            if (refocus) button.current?.focus();
            setAt(null);
          }}
        />
      )}
    </>
  );
}
