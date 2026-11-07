import { LOCAL, type MachineId } from "../hub/machines";
import { hubOf } from "../hub/store";
import type { AccountStanding, EngineAccount, StandingElsewhere } from "../hub/types";

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);

/** Whether `a` knows something `b` doesn't: a later stop on the limit, or
 *  a later reading. */
const newer = (a: AccountStanding, b: AccountStanding | null | undefined): boolean =>
  !b || at(a.hitAt) > at(b.hitAt) || (a.windows.length > 0 && at(a.readAt) > at(b.readAt));

/** What `to`'s hub doesn't know yet of `from`'s accounts' plans: for each
 *  Claude account both have (by name, as Desk copies them), `from`'s
 *  standing where it is newer. */
export const newerFor = (from: readonly EngineAccount[], to: readonly EngineAccount[]): StandingElsewhere[] =>
  from.flatMap((a) => {
    if (a.engine !== "claude" || !a.standing) return [];
    const there = to.find((t) => t.engine === "claude" && t.name.toLowerCase() === a.name.toLowerCase());
    return there && newer(a.standing, there.standing) ? [{ engine: a.engine, name: a.name, standing: a.standing }] : [];
  });

/** Passes what each of the person's computers knows of their accounts'
 *  plans to the others, both ways between this computer and each machine,
 *  through each one's hub: a machine with copied accounts so never starts
 *  a session on one this computer knows is full, and this computer learns
 *  what the machine read. */
export const passStanding = async (accountsOf: (m: MachineId) => readonly EngineAccount[], machines: readonly MachineId[]): Promise<void> => {
  const mine = accountsOf(LOCAL);
  for (const m of machines.filter((m) => m !== LOCAL)) {
    const theirs = accountsOf(m);
    const pairs: [MachineId, StandingElsewhere[]][] = [
      [m, newerFor(mine, theirs)],
      [LOCAL, newerFor(theirs, mine)],
    ];
    for (const [to, entries] of pairs) {
      if (entries.length === 0) continue;
      try {
        await hubOf(to)?.learnStanding(entries);
      } catch {
        // Passed again with the next change.
      }
    }
  }
};
