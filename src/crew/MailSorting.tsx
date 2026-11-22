import { useCallback, useEffect, useRef, useState } from "react";
import { agentKey, type Agent, type HubAccount } from "../chat/types";
import { HubError, sortRulesOf, type SortRule } from "../hub/client";
import { requestFocus } from "../shell/focus";
import { openTarget } from "../shell/navigate";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";
import { SwitchRow } from "../ui/SwitchRow";
import { alsoWatched, changeRequest, noRules, removeText, ruleKey, rulesAreYours, withEnabled, without } from "./sortRules";

type Load = "loading" | "missing" | { problem: string } | { rules: SortRule[] };

export interface MailRules {
  load: Load;
  problem: string | null;
  saving: ReadonlySet<string>;
  toggle: (rule: SortRule, enabled: boolean) => Promise<void>;
  remove: (rule: SortRule) => Promise<void>;
}

const rulesOf = (l: Load): SortRule[] | null => (typeof l === "object" && "rules" in l ? l.rules : null);

/** `f` applied to the rules `l` holds; anything else stays as it is. */
const edited =
  (f: (rules: SortRule[]) => SortRule[]) =>
  (l: Load): Load => {
    const rules = rulesOf(l);
    return rules ? { rules: f(rules) } : l;
  };

const unavailable = (e: unknown): boolean => e instanceof HubError && (e.status === 404 || e.status === 405);

/** Asks the agent, in their chat, to change `rule`: the request is typed
 *  for the person to finish and send. */
const askToChange = (agent: Agent, rule: SortRule): void => {
  const key = agentKey(agent);
  openTarget({ kind: "agent", key }, { beside: true });
  requestFocus(`agent:${key}`, changeRequest(rule));
};

/** The person's mail sorting rules on `hub`, read when `on` and read again
 *  whenever Desk comes back into view, as a rule changed in chat shows
 *  there. Their load is "missing" when `on` is off or the hub has none. */
export function useMailSorting(hub: HubAccount | undefined, on: boolean): MailRules {
  const [load, setLoad] = useState<Load>("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const shown = useRef(0);
  const writing = useRef(0);

  useEffect(() => {
    const n = ++shown.current;
    writing.current = 0;
    setProblem(null);
    setSaving(new Set());
    if (!hub || !on) return void setLoad("missing");
    setLoad("loading");
    const read = (quiet: boolean) =>
      sortRulesOf(hub)
        .list()
        .then(
          (rules) => n === shown.current && writing.current === 0 && setLoad({ rules }),
          (e: unknown) => n === shown.current && !quiet && setLoad(unavailable(e) ? "missing" : { problem: plainError(e) }),
        );
    const again = () => {
      if (document.visibilityState === "visible" && writing.current === 0) void read(true);
    };
    void read(false);
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      shown.current++;
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [hub, on]);

  const toggle = useCallback(
    async (rule: SortRule, enabled: boolean) => {
      if (!hub) return;
      const n = shown.current;
      const k = ruleKey(rule);
      setProblem(null);
      setSaving((s) => new Set(s).add(k));
      writing.current++;
      setLoad(edited((rules) => withEnabled(rules, rule, enabled)));
      try {
        await sortRulesOf(hub).setEnabled(rule, enabled);
      } catch (e) {
        if (n !== shown.current) return;
        setLoad(edited((rules) => withEnabled(rules, rule, !enabled)));
        setProblem(plainError(e));
      } finally {
        if (n === shown.current) {
          writing.current--;
          setSaving((s) => {
            const next = new Set(s);
            next.delete(k);
            return next;
          });
        }
      }
    },
    [hub],
  );

  const remove = useCallback(
    async (rule: SortRule) => {
      if (!hub) return;
      const n = shown.current;
      writing.current++;
      try {
        await sortRulesOf(hub).remove(rule);
        if (n === shown.current) setLoad(edited((rules) => without(rules, rule)));
      } finally {
        if (n === shown.current) writing.current--;
      }
    },
    [hub],
  );

  return { load, problem, saving, toggle, remove };
}

/** An agent's "Mail sorting": the person's standing rules for sorting new
 *  mail, which the agent proposes and the person approves in chat. Each can
 *  be switched off, changed by asking the agent, or removed. Nothing shows
 *  on a hub that doesn't have them. */
export function MailSorting({ agent, mail }: { agent: Agent; mail: MailRules }) {
  const { load, problem, saving, toggle, remove } = mail;
  const [removing, setRemoving] = useState<SortRule | null>(null);

  if (load === "missing") return null;
  return (
    <section id="mail" className="agent-section" aria-labelledby="mail-head">
      <h2 id="mail-head">Mail sorting</h2>
      {load === "loading" ? (
        <p className="small faint" role="status">
          Reading your mail sorting rules…
        </p>
      ) : "problem" in load ? (
        <p className="small state-blocked" role="alert">
          {load.problem}
        </p>
      ) : (
        <>
          <p className="small faint">{rulesAreYours}</p>
          {load.rules.length === 0 ? (
            <p className="small faint">{noRules(agent.name)}</p>
          ) : (
            <div className="ability-card">
              {load.rules.map((rule) => (
                <SwitchRow
                  key={ruleKey(rule)}
                  label={rule.says}
                  sub={alsoWatched(rule)}
                  on={rule.enabled}
                  saving={saving.has(ruleKey(rule))}
                  onChange={(on) => void toggle(rule, on)}
                >
                  <button type="button" className="btn btn-ghost" onClick={() => askToChange(agent, rule)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setRemoving(rule)}>
                    Remove
                  </button>
                </SwitchRow>
              ))}
            </div>
          )}
        </>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {removing && (
        <Confirm title="Remove this rule?" action="Remove rule" onConfirm={() => remove(removing)} onClose={() => setRemoving(null)}>
          <p>{removeText(removing)}</p>
        </Confirm>
      )}
    </section>
  );
}
