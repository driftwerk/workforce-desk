import type { SortRule } from "../hub/client";

/** What the person asks their agent to change a rule: left open for them
 *  to finish, so the change goes through the agent and their approval. */
export const changeRequest = (rule: Pick<SortRule, "rule_id" | "says">): string =>
  `Change my mail sorting rule "${rule.says}" (${rule.rule_id}) so that `;

/** The line under a rule other monitors' reading of the same mail concerns. */
export const alsoWatched = (rule: Pick<SortRule, "watched_by">): string | null =>
  rule.watched_by.length ? `Also watched by: ${rule.watched_by.join(", ")}` : null;

export const noRules = (name: string): string => `${name} can sort new mail for you. Ask ${name} to set up a rule.`;

export const removeText = (rule: Pick<SortRule, "says">): string =>
  `“${rule.says}” stops sorting new mail. Mail it already sorted stays where it is.`;

const same = (a: SortRule, b: SortRule): boolean => a.rule_id === b.rule_id && a.owner === b.owner;

/** `rules` with `rule`'s switch set to `enabled`. */
export const withEnabled = (rules: readonly SortRule[], rule: SortRule, enabled: boolean): SortRule[] =>
  rules.map((r) => (same(r, rule) ? { ...r, enabled } : r));

/** `rules` without `rule`. */
export const without = (rules: readonly SortRule[], rule: SortRule): SortRule[] =>
  rules.filter((r) => !same(r, rule));
