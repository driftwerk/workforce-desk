// What the person said of the Plans board: which account a hub's place is,
// the accounts they named for one, the places not to ask about, and whether
// "Not matched" is folded. Kept in Desk's own store (`ui.plans`), so every
// window and the hub have it, never in the page's storage.

import { useSyncExternalStore } from "react";
import { deskState } from "../restore/boot";
import type { DeskStateStore } from "../restore/store";
import type { PlanKind } from "../hub/types";
import type { Link, Links, Other } from "./accountCards";

export const PLANS_KEY = "ui.plans";

export interface PlansUi extends Links {
  /** "Not matched" shows as one line. */
  folded: boolean;
}

const EMPTY: PlansUi = { links: {}, others: [], folded: false };

const isKind = (k: unknown): k is PlanKind => k === "claude" || k === "chatgpt";

/** What was kept, as far as it can be read: anything else is dropped. */
export const sanitize = (raw: unknown): PlansUi => {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const links: Record<string, Link> = {};
  if (r.links && typeof r.links === "object")
    for (const [k, v] of Object.entries(r.links as Record<string, unknown>)) {
      const l = v as Record<string, unknown> | null;
      if (l && typeof l.account === "string") links[k] = { account: l.account };
      else if (l && l.hidden === true) links[k] = { hidden: true, label: typeof l.label === "string" ? l.label : k };
    }
  const others: Other[] = Array.isArray(r.others)
    ? r.others.flatMap((o: unknown) => {
        const x = o as Record<string, unknown> | null;
        return x && typeof x.key === "string" && typeof x.name === "string" && isKind(x.kind) ? [{ key: x.key, name: x.name, kind: x.kind }] : [];
      })
    : [];
  return { links, others, folded: r.folded === true };
};

let cached: { raw: unknown; value: PlansUi } = { raw: undefined, value: EMPTY };

const read = (store: DeskStateStore): PlansUi => {
  const raw = store.get(PLANS_KEY);
  if (raw !== cached.raw) cached = { raw, value: sanitize(raw) };
  return cached.value;
};

const write = (f: (p: PlansUi) => PlansUi, store: DeskStateStore = deskState) => store.set(PLANS_KEY, f(read(store)));

/** What the person said, kept. */
export const usePlansUi = (store: DeskStateStore = deskState): PlansUi =>
  useSyncExternalStore(
    (on) => store.subscribe(PLANS_KEY, on),
    () => read(store),
  );

/** `place` is the account card `account`. */
export const linkPlace = (place: string, account: string) => write((p) => ({ ...p, links: { ...p.links, [place]: { account } } }));

/** `place` is an account of the person's, named `name`: a card of its own. */
export const linkToOther = (place: string, kind: PlanKind, name: string) =>
  write((p) => {
    const key = `other:${crypto.randomUUID()}`;
    return { ...p, others: [...p.others, { key, kind, name }], links: { ...p.links, [place]: { account: key } } };
  });

/** Not asked about `place` again: off the board until shown again. */
export const hidePlace = (place: string, label: string) => write((p) => ({ ...p, links: { ...p.links, [place]: { hidden: true, label } } }));

/** Back to "Not matched": unlinked, or shown again. A named account no
 *  place is on any more goes with it. */
export const forgetPlace = (place: string) =>
  write((p) => {
    const links = { ...p.links };
    delete links[place];
    const kept = new Set(Object.values(links).flatMap((l) => ("account" in l ? [l.account] : [])));
    return { ...p, links, others: p.others.filter((o) => kept.has(o.key)) };
  });

export const setFolded = (folded: boolean) => write((p) => ({ ...p, folded }));
