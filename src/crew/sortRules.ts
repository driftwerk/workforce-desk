import type { SortRule } from "../hub/client";
import { bindingOf, throughOf } from "./connectors";

/** What the person asks their agent to change a rule: left open for them
 *  to finish, so the change goes through the agent and their approval. */
export const changeRequest = (rule: Pick<SortRule, "rule_id" | "says">): string =>
  `Change my mail sorting rule "${rule.says}" (${rule.rule_id}) so that `;

/** The line under a rule other monitors' reading of the same mail concerns. */
export const alsoWatched = (rule: Pick<SortRule, "watched_by">): string | null =>
  rule.watched_by.length ? `Also watched by: ${rule.watched_by.join(", ")}` : null;

export const noRules = (name: string): string => `You have no mail sorting rules yet. Ask ${name} to set one up.`;

export const rulesAreYours = "Your rules for sorting new mail. They’re the same whichever agent you ask.";

/** Whether the email connector reaches an agent whose config is `config`:
 *  not while that config is unread. */
export const reachesEmail = (config: string | undefined): boolean => config !== undefined && throughOf(bindingOf(config), "email") !== "off";

/** One rule's identity among the person's rules. */
export const ruleKey = (r: Pick<SortRule, "rule_id" | "owner">): string => `${r.owner ?? ""}/${r.rule_id}`;

export const removeText = (rule: Pick<SortRule, "says">): string =>
  `“${rule.says}” stops sorting new mail. Mail it already sorted stays where it is.`;

/** `rules` with `rule`'s switch set to `enabled`. */
export const withEnabled = (rules: readonly SortRule[], rule: SortRule, enabled: boolean): SortRule[] =>
  rules.map((r) => (ruleKey(r) === ruleKey(rule) ? { ...r, enabled } : r));

/** `rules` without `rule`. */
export const without = (rules: readonly SortRule[], rule: SortRule): SortRule[] =>
  rules.filter((r) => ruleKey(r) !== ruleKey(rule));
