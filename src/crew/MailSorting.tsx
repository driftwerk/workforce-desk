import { useCallback, useEffect, useRef, useState } from "react";
import { agentKey, type Agent, type HubAccount } from "../chat/types";
import { HubError, sortRulesOf, type SortRule } from "../hub/client";
import { requestFocus } from "../shell/focus";
import { openTarget } from "../shell/navigate";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";
import { SwitchRow } from "../ui/SwitchRow";
import { alsoWatched, changeRequest, noRules, removeText, withEnabled, without } from "./sortRules";

type Load = "loading" | "missing" | { problem: string } | { rules: SortRule[] };

const ruleKey = (r: SortRule): string => `${r.owner ?? ""}/${r.rule_id}`;

/** Asks the agent, in their chat, to change `rule`: the request is typed
 *  for the person to finish and send. */
const askToChange = (agent: Agent, rule: SortRule): void => {
  const key = agentKey(agent);
  openTarget({ kind: "agent", key }, { beside: true });
  requestFocus(`agent:${key}`, changeRequest(rule));
};

/** An agent's "Mail sorting": the person's standing rules for sorting new
 *  mail, which the agent proposes and the person approves in chat. Each can
 *  be switched off, changed by asking the agent, or removed. Nothing shows
 *  on a hub that doesn't have them. */
export function MailSorting({ agent, hub }: { agent: Agent; hub: HubAccount | undefined }) {
  const [load, setLoad] = useState<Load>("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<SortRule | null>(null);
  const shown = useRef(0);

  const rulesOf = (l: Load): SortRule[] | null => (typeof l === "object" && "rules" in l ? l.rules : null);
  const edit = (f: (rules: SortRule[]) => SortRule[]) => setLoad((l) => (rulesOf(l) ? { rules: f(rulesOf(l)!) } : l));

  useEffect(() => {
    const n = ++shown.current;
    setLoad("loading");
    setProblem(null);
    setSaving(new Set());
    if (!hub) return void setLoad("missing");
    sortRulesOf(hub)
      .list()
      .then(
        (rules) => n === shown.current && setLoad({ rules }),
        (e: unknown) => n === shown.current && setLoad(e instanceof HubError && (e.status === 404 || e.status === 405) ? "missing" : { problem: plainError(e) }),
      );
    return () => {
      shown.current++;
    };
  }, [hub]);

  const toggle = useCallback(
    async (rule: SortRule, enabled: boolean) => {
      if (!hub) return;
      const n = shown.current;
      const k = ruleKey(rule);
      setProblem(null);
      setSaving((s) => new Set(s).add(k));
      edit((rules) => withEnabled(rules, rule, enabled));
      try {
        await sortRulesOf(hub).setEnabled(rule, enabled);
      } catch (e) {
        if (n !== shown.current) return;
        edit((rules) => withEnabled(rules, rule, !enabled));
        setProblem(plainError(e));
      } finally {
        if (n === shown.current)
          setSaving((s) => {
            const next = new Set(s);
            next.delete(k);
            return next;
          });
      }
    },
    [hub],
  );

  if (load === "loading" || load === "missing" || !hub) return null;
  return (
    <section id="mail" className="agent-section" aria-labelledby="mail-head">
      <h2 id="mail-head">Mail sorting</h2>
      {"problem" in load ? (
        <p className="small state-blocked" role="alert">
          {load.problem}
        </p>
      ) : load.rules.length === 0 ? (
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
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {removing && (
        <Confirm
          title="Remove this rule?"
          action="Remove rule"
          onConfirm={async () => {
            await sortRulesOf(hub).remove(removing);
            edit((all) => without(all, removing));
          }}
          onClose={() => setRemoving(null)}
        >
          <p>{removeText(removing)}</p>
        </Confirm>
      )}
    </section>
  );
}
