import { HubError } from "../hub/client";

/** Whether a failed create may still have happened: the answer never came
 *  (a timeout, a 5xx, the connection dropping), so the thing may exist. */
export const mayHaveHappened = (e: unknown): boolean => e instanceof TypeError || (e instanceof HubError && (e.status === 408 || e.status >= 500));

/** What a create that may have happened turned out to be. */
export type Reconciled<T> = { kind: "made"; made: T } | { kind: "absent" } | { kind: "unknown" };

/** After a create that may have happened: look for what it would have made
 *  (not among `before`). `before` null means the list couldn't be read first,
 *  so nothing can be told. */
export async function reconcile<T extends { id: string }>(list: () => Promise<T[]>, before: ReadonlySet<string> | null, mine: (x: T) => boolean): Promise<Reconciled<T>> {
  if (!before) return { kind: "unknown" };
  try {
    const made = (await list()).find((x) => !before.has(x.id) && mine(x));
    return made ? { kind: "made", made } : { kind: "absent" };
  } catch {
    return { kind: "unknown" };
  }
}

/** The ids `list` has now, or null when it can't be read. */
export const idsNow = async (list: () => Promise<{ id: string }[]>): Promise<Set<string> | null> => {
  try {
    return new Set((await list()).map((x) => x.id));
  } catch {
    return null;
  }
};
