import { LOCAL, type MachineId } from "../hub/machines";
import { hubOf } from "../hub/store";
import type { AccountStanding, EngineAccount, StandingElsewhere } from "../hub/types";

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

/** Whether `a` knows something `b` doesn't: a later stop on the limit, or
 *  a later reading. */
const newer = (a: AccountStanding, b: AccountStanding | null | undefined): boolean =>
  !b || at(a.hitAt) > at(b.hitAt) || (a.windows.length > 0 && at(a.readAt) > at(b.readAt));

/** The account in `among` that is `a` on another computer: by identity
 *  key when both know it, never one known as another identity, else by name
 *  (as Desk copies them). Of the same engine only. */
export const sameAccountIn = (a: EngineAccount, among: readonly EngineAccount[]): EngineAccount | null => {
  const key = a.identity?.key ?? null;
  const sameName = (t: EngineAccount) => t.name.trim().toLowerCase() === a.name.trim().toLowerCase();
  return (
    among.find((t) => t.engine === a.engine && key !== null && t.identity?.key === key) ??
    among.find((t) => t.engine === a.engine && sameName(t) && (!key || !t.identity?.key || t.identity.key === key)) ??
    null
  );
};

/** What a machine's hub doesn't know yet of this computer's accounts'
 *  plans: for each Claude account both have ([`sameAccountIn`]), this
 *  computer's standing where it is newer. */
export const newerFor = (from: readonly EngineAccount[], to: readonly EngineAccount[]): StandingElsewhere[] =>
  from.flatMap((a) => {
    if (a.engine !== "claude" || !a.standing) return [];
    const there = sameAccountIn(a, to);
    return there && newer(a.standing, there.standing) ? [{ engine: a.engine, name: a.name, identity: a.identity?.key ?? null, standing: a.standing }] : [];
  });

/** Passes what this computer knows of the person's accounts' plans to each
 *  machine's hub, one way: a machine with copied accounts never starts a
 *  session on one this computer knows is full. Nothing a machine reports
 *  ever changes this computer's. */
export const passStanding = async (accountsOf: (m: MachineId) => readonly EngineAccount[], machines: readonly MachineId[]): Promise<void> => {
  const mine = accountsOf(LOCAL);
  for (const m of machines.filter((m) => m !== LOCAL)) {
    const entries = newerFor(mine, accountsOf(m));
    if (entries.length === 0) continue;
    try {
      // Its hub reads the times on its own clock, by when this was sent.
      await hubOf(m)?.learnStanding(entries, new Date().toISOString());
    } catch {
      // Passed again with the next change.
    }
  }
};
