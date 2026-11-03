import { useEffect, useMemo, useState } from "react";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import { useLayout } from "../groups/store";
import { useDesk } from "../hub/store";
import type { BreakerView, BudgetScope, BudgetUnit, BudgetView, NewBudget, OnExceed, SpendPeriod } from "../hub/types";
import { plainError } from "../ui/plainError";
import {
  PERIODS,
  PERIOD_LABEL,
  budgetLine,
  fillOf,
  heldFor,
  parseAmount,
  scopeLabel,
  standingText,
  type Names,
} from "../spend/budgets";
import { useBudgets } from "../spend/budgetStore";

/** What the form's "For" menu offers: a total, a default, or one item. */
type ScopeChoice = "desk" | "each_session" | "each_agent" | `session:${string}` | `agent:${string}`;

const scopeOf = (c: ScopeChoice): BudgetScope => {
  if (c.startsWith("session:")) return { kind: "session", id: c.slice(8) };
  if (c.startsWith("agent:")) return { kind: "agent", id: c.slice(6) };
  return { kind: c as "desk" | "each_session" | "each_agent" };
};

/** Whether a scope can belong to a group: an item's own budget goes with
 *  the item. */
const grouped = (c: ScopeChoice): boolean => c === "desk" || c === "each_session" || c === "each_agent";

/** The names Desk shows sessions, agents and groups by. */
const useNames = (): Names => {
  const sessions = useDesk((s) => s.sessions);
  const named = useSessionNames();
  const roster = useChat((s) => s.roster);
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const layout = useLayout();
  return useMemo(
    () => ({
      session: (id) => named[id] ?? sessions[id]?.displayName ?? sessions[id]?.name,
      agent: (id) => roster.find((a) => a.hubId === local && a.id === id)?.name,
      group: (id) => layout.groups.find((g) => g.id === id)?.name,
    }),
    [sessions, named, roster, local, layout],
  );
};

/** Settings → Budgets: what Desk keeps sessions and agents to, where each
 *  stands, what the breaker holds, and whether it watches for loops. */
export function Budgets() {
  const hub = useDesk((s) => s.hub);
  const view = useBudgets((s) => s.view);
  const supported = useBudgets((s) => s.supported);
  const failed = useBudgets((s) => s.failed);
  const load = useBudgets((s) => s.load);
  const names = useNames();
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (hub) void load();
  }, [hub, load]);
  const run = (call: Promise<unknown>) => {
    setProblem(null);
    return call.then(() => load()).catch((e: unknown) => setProblem(plainError(e)));
  };

  return (
    <section className="settings-pane" aria-label="Budgets">
      <h1 className="display-lg">Budgets</h1>
      <p className="muted">
        Nothing is limited until you set a budget. Near one, Desk tells the session or agent. Over it, the session finishes the turn it's on and
        then waits for you, and an agent's new turns wait; while a total is over, agents can't start new sessions. Your own sessions and prompts
        always go ahead.
      </p>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {supported === false ? (
        <p className="faint small">This workspace's hub doesn't keep budgets yet.</p>
      ) : !view ? (
        <p className="faint small">{failed ? "Couldn’t read the budgets just now." : "Loading…"}</p>
      ) : (
        <>
          {view.breakers.some((b) => b.level.level === "held") && (
            <section className="prov-section" aria-label="Paused now">
              <h2 className="field-label">Paused now</h2>
              <div className="hub-list">
                {view.breakers
                  .filter((b) => b.level.level === "held")
                  .map((b) => (
                    <Held key={b.subject} breaker={b} onContinue={() => void run(hub!.breakerContinue(b.subject))} />
                  ))}
              </div>
            </section>
          )}

          <section className="prov-section" aria-label="Your budgets">
            <h2 className="field-label">Your budgets</h2>
            {view.budgets.length === 0 ? (
              <p className="faint small">None yet: nothing stops for spend.</p>
            ) : (
              <div className="hub-list">
                {view.budgets.map((b) => (
                  <BudgetRow key={b.id} budget={b} names={names} onSave={(patch) => run(hub!.patchBudget(b.id, patch))} onRemove={() => void run(hub!.deleteBudget(b.id))} />
                ))}
              </div>
            )}
          </section>

          <section className="prov-section" aria-label="Add a budget">
            <h2 className="field-label">Add a budget</h2>
            <AddBudget names={names} onAdd={(b) => run(hub!.putBudget(b))} />
          </section>

          <section className="prov-section" aria-label="Loops and failures">
            <h2 className="field-label">Loops and failures</h2>
            <label className="budget-check">
              <input type="checkbox" checked={view.rules.loops} onChange={(e) => void run(hub!.setBreakerRules({ loops: e.target.checked }))} />
              <span>
                Watch sessions for loops
                <span className="faint small budget-hint">
                  When a session runs the same tool call 6 times in 10 minutes, or keeps failing, Desk tells it to stop and ask you. If it carries
                  on, it finishes that turn and waits for you.
                </span>
              </span>
            </label>
          </section>
        </>
      )}
    </section>
  );
}

function Held({ breaker, onContinue }: { breaker: BreakerView; onContinue: () => void }) {
  return (
    <div className="hub-row">
      <span className="hub-name">
        <b>{breaker.name}</b>
        <span className="faint small">{breaker.ask ?? `Paused · ${heldFor(breaker)}`}</span>
      </span>
      <button type="button" className="btn btn-blocked" onClick={onContinue}>
        Continue
      </button>
    </div>
  );
}

function BudgetRow({
  budget,
  names,
  onSave,
  onRemove,
}: {
  budget: BudgetView;
  names: Names;
  onSave: (patch: { amount?: number; warnAt?: number; onExceed?: OnExceed }) => Promise<unknown>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = scopeLabel(budget.scope, budget.group, names);
  const s = budget.standing;
  const pct = s ? Math.round(fillOf(s) * 100) : 0;
  return (
    <div className="hub-row budget-row">
      <span className="hub-name">
        <b>{label}</b>
        <span className="faint small">{budgetLine(budget)}</span>
        {s && (
          <>
            <span className={`small ${s.status === "under" ? "" : "state-blocked"}`}>{standingText(s)}</span>
            <span className="spend-bar" role="img" aria-label={`${pct}% of ${label}'s budget`}>
              <span className={`spend-fill ${s.status === "under" ? "" : "spend-fill-warn"}`} style={{ width: `${pct}%` }} />
            </span>
          </>
        )}
        {editing && (
          <EditBudget
            budget={budget}
            onCancel={() => setEditing(false)}
            onSave={(patch) => onSave(patch).then(() => setEditing(false))}
          />
        )}
      </span>
      {!editing && (
        <button type="button" className="btn" onClick={() => setEditing(true)} aria-label={`Change ${label}'s budget`}>
          Change
        </button>
      )}
      <button type="button" className="btn" onClick={onRemove} aria-label={`Remove ${label}'s budget`}>
        Remove
      </button>
    </div>
  );
}

function EditBudget({
  budget,
  onCancel,
  onSave,
}: {
  budget: BudgetView;
  onCancel: () => void;
  onSave: (patch: { amount: number; warnAt: number; onExceed: OnExceed }) => void;
}) {
  const [amount, setAmount] = useState(String(budget.amount));
  const [warn, setWarn] = useState(String(Math.round(budget.warnAt * 100)));
  const [over, setOver] = useState<OnExceed>(budget.onExceed);
  const value = parseAmount(amount, budget.unit);
  const warnAt = Number(warn) / 100;
  const ok = value !== null && warnAt > 0 && warnAt < 1;
  return (
    <form
      className="budget-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ amount: value, warnAt, onExceed: over });
      }}
    >
      <Amount unit={budget.unit} value={amount} onChange={setAmount} />
      <WarnAt value={warn} onChange={setWarn} />
      <WhenOver value={over} onChange={setOver} />
      <span className="budget-actions">
        <button type="submit" className="btn btn-signal" disabled={!ok}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

function AddBudget({ names, onAdd }: { names: Names; onAdd: (b: NewBudget) => Promise<unknown> }) {
  const sessions = useDesk((s) => s.sessions);
  const roster = useChat((s) => s.roster);
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const layout = useLayout();
  const [scope, setScope] = useState<ScopeChoice>("desk");
  const [group, setGroup] = useState<string>("");
  const [period, setPeriod] = useState<SpendPeriod>("day");
  const [unit, setUnit] = useState<BudgetUnit>("usd");
  const [amount, setAmount] = useState("");
  const [warn, setWarn] = useState("80");
  const [over, setOver] = useState<OnExceed>("pause");
  const [busy, setBusy] = useState(false);
  const value = parseAmount(amount, unit);
  const warnAt = Number(warn) / 100;
  const ok = value !== null && warnAt > 0 && warnAt < 1 && !busy;
  const agents = roster.filter((a) => a.hubId === local);
  const sessionList = Object.values(sessions).filter((s) => s.state !== "closed");
  return (
    <form
      className="budget-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        setBusy(true);
        void onAdd({
          scope: scopeOf(scope),
          group: grouped(scope) && group ? group : null,
          period,
          unit,
          amount: value,
          warnAt,
          onExceed: over,
        })
          .then(() => setAmount(""))
          .finally(() => setBusy(false));
      }}
    >
      <label className="budget-field">
        <span className="small">For</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as ScopeChoice)}>
          <option value="desk">Everything together</option>
          <option value="each_session">Each session</option>
          <option value="each_agent">Each agent</option>
          {sessionList.length > 0 && (
            <optgroup label="One session">
              {sessionList.map((s) => (
                <option key={s.id} value={`session:${s.id}`}>
                  {names.session(s.id) ?? s.name}
                </option>
              ))}
            </optgroup>
          )}
          {agents.length > 0 && (
            <optgroup label="One agent">
              {agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {grouped(scope) && layout.groups.length > 0 && (
        <label className="budget-field">
          <span className="small">In</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">All of Desk</option>
            {layout.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="budget-field">
        <span className="small">Each</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value as SpendPeriod)}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="budget-field">
        <span className="small">In</span>
        <select value={unit} onChange={(e) => setUnit(e.target.value as BudgetUnit)} aria-label="Unit">
          <option value="usd">Dollars</option>
          <option value="tokens">Tokens</option>
        </select>
      </label>
      <Amount unit={unit} value={amount} onChange={setAmount} />
      <WarnAt value={warn} onChange={setWarn} />
      <WhenOver value={over} onChange={setOver} />
      <span className="budget-actions">
        <button type="submit" className="btn btn-signal" disabled={!ok}>
          {busy ? "Adding…" : "Add budget"}
        </button>
      </span>
    </form>
  );
}

function Amount({ unit, value, onChange }: { unit: BudgetUnit; value: string; onChange: (v: string) => void }) {
  return (
    <label className="budget-field">
      <span className="small">{unit === "usd" ? "Up to ($)" : "Up to (tokens)"}</span>
      <input inputMode="decimal" value={value} placeholder={unit === "usd" ? "11" : "500000"} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function WarnAt({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="budget-field budget-narrow">
      <span className="small">Warn at (%)</span>
      <input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function WhenOver({ value, onChange }: { value: OnExceed; onChange: (v: OnExceed) => void }) {
  return (
    <label className="budget-field">
      <span className="small">When over</span>
      <select value={value} onChange={(e) => onChange(e.target.value as OnExceed)}>
        <option value="pause">Pause after the turn</option>
        <option value="warn">Only warn</option>
      </select>
    </label>
  );
}
