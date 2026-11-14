// A group's Boss sheet (remote bosses §11.1, RBD1): who runs the group (Desk,
// one of this computer's agents, or an agent on a paired hub), how much they
// may do and what they see, and, for a boss on another hub, where it is
// linked, Pause and Stop. Choosing Act fully opens its own sheet, with the
// daily budget and Sees. Every change that gives a boss more is asked
// natively by Desk's native side (src-tauri/src/bosses.rs), never here.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { agentKey, type Agent } from "../chat/types";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { thisComputerLower } from "../machines/words";
import { useOverview } from "../overview/store";
import { useHost } from "../shell/host";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";
import { AgentMark, Mark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { bossOfGroup, overseeGroup, stopOverseeing } from "./bosses";
import { sessionOf } from "./model";
import {
  BOSS_LEVELS,
  BOSS_SEES,
  doneSaid,
  engineState,
  FIRST_CHOICE,
  fullLine,
  LEVEL_NAME,
  levelSays,
  MAX_BUDGET_USD,
  notInForce,
  remoteBosses,
  SEES_NAME,
  type BossChoice,
  type BossDone,
  type BossLevel,
  type BossOffer,
  type BossSees,
  type RemoteBoss,
} from "./remoteBoss";
import { useLayout } from "./store";

/** Who runs the group, as picked. */
type Who = { kind: "desk" } | { kind: "local"; agent: Agent } | { kind: "remote"; agent: Agent };

const sameWho = (a: Who, b: Who): boolean =>
  a.kind === b.kind && (a.kind === "desk" || (b.kind !== "desk" && agentKey(a.agent) === agentKey(b.agent)));

const sameChoice = (a: BossChoice, b: BossChoice): boolean =>
  a.level === b.level && a.sees === b.sees && (a.level !== "full" || a.budgetUsdPerDay === b.budgetUsdPerDay);

/** Whether a link's failure was the agent declining boss work. */
const declined = (d: BossDone): boolean => d.failed.some((f) => f.why.includes("doesn't take boss work"));

export function BossSheet({ group, onClose }: { group: string; onClose: () => void }) {
  const ids = useId();
  const layout = useLayout();
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const manager = useOverview((s) => s.manager);
  const sessions = useDesk((s) => s.sessions);
  const hub = useDesk((s) => s.hub);
  const platform = useHost((s) => s.platform);
  const g = layout.groups.find((x) => x.id === group);
  const name = g?.name ?? "This group";

  const local = hubs.find((h) => h.local);
  const teamHubs = hubs.filter((h) => !h.local && !h.machine);
  const isLocal = (a: Agent) => a.hubId === local?.id;
  const mainBoss = manager?.agentId ?? null;
  const localBoss = bossOfGroup(manager, group);

  const [status, setStatus] = useState<RemoteBoss | null | undefined>(undefined);
  const [offers, setOffers] = useState<Record<string, BossOffer | "asking">>({});
  const [refused, setRefused] = useState<Set<string>>(() => new Set());
  const [who, setWho] = useState<Who | null>(null);
  const [choice, setChoice] = useState<BossChoice>(FIRST_CHOICE);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const s = await remoteBosses.status(group);
      setStatus(s);
      if (s) setChoice(s.choice);
      return s;
    } catch {
      setStatus(null);
      return null;
    }
  }, [group]);

  useEffect(() => {
    void read();
    for (const h of teamHubs) {
      setOffers((o) => ({ ...o, [h.id]: "asking" }));
      remoteBosses
        .offer(h.id)
        .then((r) => setOffers((o) => ({ ...o, [h.id]: r })))
        .catch((e) => setOffers((o) => ({ ...o, [h.id]: { kind: "not", why: plainError(e) } })));
    }
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const remoteAgent = status ? (roster.find((a) => a.hubId === status.hub && a.id === status.agent) ?? null) : null;
  /** Who runs it now. */
  const now: Who | null = useMemo(() => {
    if (status === undefined) return null;
    if (status) return { kind: "remote", agent: remoteAgent ?? ({ hubId: status.hub, id: status.agent, name: status.agent, model: null, provider: null, isDefault: false } as Agent) };
    const own = localBoss ? roster.find((a) => isLocal(a) && a.id === localBoss.agentId) : null;
    return own ? { kind: "local", agent: own } : { kind: "desk" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, remoteAgent, localBoss, roster]);
  const picked = who ?? now;
  const bossName = picked?.kind === "desk" ? "Desk" : (picked?.agent.name ?? "the boss");
  const remote = picked?.kind === "remote";
  const linkedHere = remote && status && now && sameWho(picked, now);

  const waits = useMemo(
    () => (g?.items ?? []).flatMap((k) => sessions[sessionOf(k) ?? ""]?.waitsOnYou ?? []).filter((w): w is string => typeof w === "string"),
    [g, sessions],
  );
  const why = remote ? notInForce(linkedHere ? (status ?? null) : null, choice, bossName, waits) : null;

  const after = async (d: BossDone, said: string) => {
    if (d.cancelled) return;
    const failed = doneSaid(d);
    setProblem(failed);
    if (!failed) setNotice(said);
    await read();
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  /** Makes `picked` the group's boss: a boss on another hub stopped first
   *  when another takes over. */
  const makeBoss = () =>
    run(async () => {
      if (!picked || !now) return;
      if (picked.kind === "remote") {
        const d = await remoteBosses.link(group, picked.agent.hubId, picked.agent.id, choice);
        if (declined(d)) setRefused((r) => new Set(r).add(agentKey(picked.agent)));
        if (!d.cancelled && d.done.length && now.kind === "local") await stopOverseeing(hub, now.agent.id, now.agent);
        return after(d, `${picked.agent.name} is ${name}’s boss.`);
      }
      if (now.kind === "remote") {
        const d = await remoteBosses.unlink(group);
        if (d.failed.length) return after(d, "");
      }
      if (picked.kind === "local") await overseeGroup(hub, picked.agent.id, group, picked.agent);
      else if (now.kind === "local") await stopOverseeing(hub, now.agent.id, now.agent);
      setNotice(picked.kind === "local" ? `${picked.agent.name} oversees ${name}.` : `The main boss runs ${name}.`);
      setWho(null);
      await read();
    });

  const save = (c: BossChoice = choice) => run(async () => after(await remoteBosses.set(group, c), "Saved."));
  const pause = () => run(async () => after(await remoteBosses.pause(group), `${bossName} is paused in ${name}.`));
  const resume = () => run(async () => after(await remoteBosses.resume(group), `${bossName} goes on in ${name}.`));
  const stop = () =>
    run(async () => {
      const d = await remoteBosses.unlink(group);
      await after(d, `${bossName} no longer bosses ${name}.`);
      setWho(null);
    });

  const pickLevel = (level: BossLevel) => {
    if (level === "full") return setFull(true);
    setChoice((c) => ({ ...c, level, budgetUsdPerDay: null }));
  };

  // ── Who runs it ──────────────────────────────────────────────────────
  const options: { who: Who; sub: string; off?: string }[] = [
    { who: { kind: "desk" }, sub: mainBoss ? "The main boss" : "No boss of its own" },
    ...roster
      .filter((a) => isLocal(a) && a.id !== mainBoss)
      .map((a) => ({ who: { kind: "local", agent: a } as Who, sub: `On ${thisComputerLower(platform)}` })),
  ];
  const hubRows: { id: string; label: string; why: string }[] = [];
  for (const h of teamHubs) {
    const o = offers[h.id];
    if (o === undefined || o === "asking") continue;
    if (o.kind === "not") {
      hubRows.push({ id: h.id, label: h.label, why: o.why });
      continue;
    }
    for (const a of roster.filter((x) => x.hubId === h.id)) {
      const off = refused.has(agentKey(a)) ? `Doesn’t take boss work from Desk: ${h.label}’s admin turns it on in ${a.name}’s settings` : undefined;
      options.push({ who: { kind: "remote", agent: a }, sub: `On ${h.label}, another hub`, off });
    }
  }
  const pickable = options.filter((o) => !o.off).map((o) => o.who);
  const at = picked ? pickable.findIndex((w) => sameWho(w, picked)) : -1;
  const changed = !!picked && !!now && !sameWho(picked, now);
  const choiceChanged = !!status && !sameChoice(choice, status.choice);

  return (
    <>
      <Dialog
        onClose={onClose}
        title={(id) => (
          <header className="dialog-head">
            <span className="dialog-title">
              <h1 id={id} className="display-lg">
                {name} · Boss
              </h1>
              <p>Who runs {name}’s sessions, and how much they may do.</p>
            </span>
            <CloseButton onClose={onClose} />
          </header>
        )}
      >
        <div className="dialog-scroll move-body">
          <fieldset className="move-field">
            <legend>Who runs {name}</legend>
            <div className="move-opts" role="radiogroup" aria-label={`Who runs ${name}`}>
              {options.map((o) => {
                const key = o.who.kind === "desk" ? "desk" : agentKey(o.who.agent);
                const agent = o.who.kind === "desk" ? null : o.who.agent;
                return (
                  <label key={key} className="move-opt">
                    <input
                      type="radio"
                      name={`${ids}-who`}
                      checked={!!picked && sameWho(picked, o.who)}
                      disabled={!!o.off || busy}
                      onChange={() => setWho(o.who)}
                      onKeyDown={(e) => radioKeys(e, pickable, at, setWho)}
                    />
                    <span className="move-opt-lead" aria-hidden="true">
                      {agent ? (
                        <AgentMark agent={`${agent.hubId}/${agent.id}`} name={agent.name} size="sm" />
                      ) : mainBoss && local ? (
                        <AgentMark agent={`${local.id}/${mainBoss}`} name="Desk" size="sm" />
                      ) : (
                        <Mark name="Desk" size="sm" />
                      )}
                    </span>
                    <span className="move-opt-main">
                      <span>{o.who.kind === "desk" ? "Desk" : o.who.agent.name}</span>
                      <span className="move-opt-sub">{o.off ?? o.sub}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {hubRows.length > 0 && (
            <div className="oversee-card">
              {hubRows.map((h) => (
                <div key={h.id} className="oversee-row">
                  <span className="dot" aria-hidden="true" />
                  <span className="oversee-check-text">
                    <b>{h.label}</b>
                    <span className="oversee-sub">{h.why}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {remote && (
            <>
              <div className="oversee-part">
                <h3>How much {bossName} may do</h3>
                <div className="oversee-levels oversee-levels-4" role="radiogroup" aria-label={`How much ${bossName} may do`}>
                  {BOSS_LEVELS.map((l, i) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      className="oversee-level"
                      aria-checked={choice.level === l}
                      tabIndex={choice.level === l ? 0 : -1}
                      disabled={busy}
                      onClick={() => pickLevel(l)}
                      onKeyDown={(e) => radioKeys(e, BOSS_LEVELS, BOSS_LEVELS.indexOf(choice.level), (x) => (x === "full" ? undefined : pickLevel(x)))}
                    >
                      <b>{LEVEL_NAME[l]}</b>
                      <span>{levelSays(l, bossName)}</span>
                      {i === 3 && choice.level === "full" && choice.budgetUsdPerDay !== null && (
                        <span className="mono">${choice.budgetUsdPerDay} a day</span>
                      )}
                    </button>
                  ))}
                </div>
                {why && (
                  <div className="oversee-why" role="status">
                    <p className="small">
                      <b className="state-blocked">Act fully isn’t in force.</b> {why}
                    </p>
                  </div>
                )}
              </div>

              <div className="oversee-part">
                <h3>What {bossName} sees</h3>
                <SeesChips value={choice.sees} disabled={busy} onChange={(sees) => setChoice((c) => ({ ...c, sees }))} />
                <span className="oversee-sub">
                  {picked.agent.hubId === status?.hub ? status.hubLabel : (hubs.find((h) => h.id === picked.agent.hubId)?.label ?? "Its hub")} receives what{" "}
                  {bossName} sees of {name}, and its model reads it.
                </span>
              </div>

              {linkedHere && status && status.engines.length > 0 && (
                <div className="oversee-part">
                  <h3>Where {bossName} is linked</h3>
                  <div className="oversee-card">
                    {status.engines.map((e) => {
                      const s = engineState(e, bossName);
                      return (
                        <div key={e.engine} className="oversee-row">
                          <span className={`dot dot-${s.dot}`} aria-hidden="true" />
                          <span className="oversee-check-text">
                            <b>{e.name === "this Mac" || e.name === "this computer" ? e.name[0]!.toUpperCase() + e.name.slice(1) : e.name}</b>
                            <span className="oversee-sub">{s.text}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {status.paused && <span className="oversee-sub">{bossName} is paused: nothing is decided or done in {name} until {bossName} goes on.</span>}
                </div>
              )}
            </>
          )}
          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}
            </p>
          )}
          {notice && !problem && (
            <p className="small state-done" role="status">
              {notice}
            </p>
          )}
        </div>
        <footer className="dialog-foot">
          {linkedHere && status && !changed && (
            <>
              {status.paused ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={resume}>
                  Let {bossName} go on
                </button>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={pause}>
                  Pause {bossName}
                </button>
              )}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={stop}>
                Stop {bossName}
              </button>
            </>
          )}
          <span className="dialog-foot-note small">{linkedHere && !changed ? `Stop ends ${bossName}’s links and grants on every engine.` : ""}</span>
          <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
            {changed || choiceChanged ? "Cancel" : "Close"}
          </button>
          {changed && picked && (
            <button type="button" className="btn btn-signal" disabled={busy} onClick={makeBoss}>
              {picked.kind === "desk" ? "Give it back to Desk" : `Make ${bossName} ${name}’s boss`}
            </button>
          )}
          {!changed && choiceChanged && (
            <button type="button" className="btn btn-signal" disabled={busy} onClick={() => save()}>
              Save
            </button>
          )}
        </footer>
      </Dialog>
      {full && remote && (
        <ActFullySheet
          group={name}
          boss={bossName}
          choice={choice}
          status={linkedHere ? (status ?? null) : null}
          waits={waits}
          busy={busy}
          linked={!!linkedHere}
          onClose={() => setFull(false)}
          onPause={linkedHere ? (status?.paused ? resume : pause) : undefined}
          paused={!!status?.paused}
          onStop={linkedHere ? () => void stop().then(() => setFull(false)) : undefined}
          onUse={(c) => {
            setChoice(c);
            setFull(false);
            if (linkedHere) void save(c);
          }}
        />
      )}
    </>
  );
}

function SeesChips({ value, disabled, onChange, needsReplies = false }: { value: BossSees; disabled: boolean; onChange: (s: BossSees) => void; needsReplies?: boolean }) {
  return (
    <div className="chip-row" role="radiogroup" aria-label="What it sees">
      {BOSS_SEES.map((s) => {
        const off = needsReplies && s === "status";
        return (
          <button
            key={s}
            type="button"
            role="radio"
            className="chip-btn"
            aria-checked={value === s}
            aria-pressed={value === s}
            aria-disabled={off || undefined}
            disabled={disabled}
            onClick={() => !off && onChange(s)}
          >
            {SEES_NAME[s]}
          </button>
        );
      })}
    </div>
  );
}

/** Act fully's own sheet: the daily budget, Sees, why it isn't in force,
 *  the one line on what still holds, and Pause and Stop. Its use is asked
 *  natively when it is saved. */
export function ActFullySheet({
  group,
  boss,
  choice,
  status,
  waits,
  busy,
  linked,
  paused,
  onClose,
  onUse,
  onPause,
  onStop,
}: {
  group: string;
  boss: string;
  choice: BossChoice;
  status: RemoteBoss | null;
  waits: readonly string[];
  busy: boolean;
  linked: boolean;
  paused: boolean;
  onClose: () => void;
  onUse: (c: BossChoice) => void;
  onPause?: () => void;
  onStop?: () => void;
}) {
  const ids = useId();
  const [budget, setBudget] = useState(choice.budgetUsdPerDay !== null ? String(choice.budgetUsdPerDay) : "");
  const [sees, setSees] = useState<BossSees>(choice.sees === "status" ? "replies" : choice.sees);
  const usd = budget.trim() === "" ? null : Number(budget);
  const bad = usd === null ? "Act fully needs a daily budget." : !Number.isFinite(usd) || usd <= 0 || usd > MAX_BUDGET_USD ? `An amount above $0 and up to $${MAX_BUDGET_USD.toLocaleString("en-US")}.` : null;
  const next: BossChoice = { level: "full", sees, budgetUsdPerDay: bad ? null : usd };
  const on = choice.level === "full";
  const why = notInForce(on ? status : null, next, boss, waits);
  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {on ? `${boss} acts fully in ${group}` : `Let ${boss} act fully in ${group}?`}
            </h1>
            <p>
              {boss} decides every request {group}’s sessions ask, on its own hub with its own model, up to a daily budget of real money.
            </p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll">
        {on && linked && (
          <div className="oversee-why" role="status">
            <p className="small">{why ? <><b className="state-blocked">Not in force.</b> {why}</> : <b className="state-done">In force.</b>}</p>
          </div>
        )}
        <div className="oversee-card">
          <div className="oversee-row">
            <span className="oversee-check-text">
              <b>Daily budget</b>
              <span className="oversee-sub">Needed. Real money a day: what API keys and Bedrock are billed for. Your Claude and ChatGPT plans aren’t counted.</span>
            </span>
            <span className="oversee-num">
              <input
                className="num"
                inputMode="decimal"
                aria-label="Daily budget in US dollars"
                aria-invalid={!!bad && budget !== ""}
                aria-describedby={bad ? `${ids}-bad` : undefined}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                data-autofocus
              />
              <span className="oversee-sub">USD a day</span>
            </span>
            {bad && budget !== "" && (
              <span id={`${ids}-bad`} className="oversee-problem small state-blocked" role="alert">
                {bad}
              </span>
            )}
          </div>
          <div className="oversee-row">
            <span className="oversee-check-text">
              <b>What {boss} sees</b>
              <span className="oversee-sub">Act fully needs replies</span>
            </span>
            <SeesChips value={sees} disabled={busy} needsReplies onChange={setSees} />
          </div>
        </div>
        <div className="oversee-never">{fullLine(boss)}</div>
      </div>
      <footer className="dialog-foot">
        {onPause && (
          <button type="button" className="link small" disabled={busy} onClick={onPause}>
            {paused ? `Let ${boss} go on` : `Pause ${boss}`}
          </button>
        )}
        {onStop && (
          <button type="button" className="link small" disabled={busy} onClick={onStop}>
            Stop {boss}
          </button>
        )}
        <span className="dialog-foot-note" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={!!bad || busy} onClick={() => onUse(next)}>
          {on ? "Save" : linked ? "Turn on Act fully" : "Use Act fully"}
        </button>
      </footer>
    </Dialog>
  );
}
