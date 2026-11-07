import { LOCAL, type MachineId } from "../hub/machines";
import { hubOf } from "../hub/store";
import type { AccountStanding, EngineAccount, StandingElsewhere } from "../hub/types";

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

/** Whether `a` knows something `b` doesn't: a later stop on the limit, or
 *  a later reading. */
const newer = (a: AccountStanding, b: AccountStanding | null | undefined): boolean =>
  !b || at(a.hitAt) > at(b.hitAt) || (a.windows.length > 0 && at(a.readAt) > at(b.readAt));

/** What a machine's hub doesn't know yet of this computer's accounts'
 *  plans: for each Claude account both have, this computer's standing
 *  where it is newer. Matched by identity key when both know it, never
 *  onto an account the machine knows as another identity, else by name (as
 *  Desk copies them). */
export const newerFor = (from: readonly EngineAccount[], to: readonly EngineAccount[]): StandingElsewhere[] =>
  from.flatMap((a) => {
    if (a.engine !== "claude" || !a.standing) return [];
    const key = a.identity?.key ?? null;
    const sameName = (t: EngineAccount) => t.name.trim().toLowerCase() === a.name.trim().toLowerCase();
    const there =
      to.find((t) => t.engine === "claude" && key !== null && t.identity?.key === key) ??
      to.find((t) => t.engine === "claude" && sameName(t) && (!key || !t.identity?.key || t.identity.key === key));
    return there && newer(a.standing, there.standing) ? [{ engine: a.engine, name: a.name, identity: key, standing: a.standing }] : [];
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
