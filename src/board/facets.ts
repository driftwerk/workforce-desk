import type { SyncSystem, Ticket } from "../hub/types";

/** A synced board's own filters, beside Everyone, Mine and the rest: on a
 *  Jira board its issues' epic, type and sprint, on a Linear board their
 *  cycle, project and label. Each is a name to match, or none for all. */
export interface Facets {
  epic?: string;
  type?: string;
  sprint?: string;
  project?: string;
  label?: string;
}

export type FacetId = keyof Facets;

/** The facets a board of `system` filters by, in the order its head shows
 *  them, each with the word its chip says. */
export const FACETS: Record<SyncSystem, { id: FacetId; word: string }[]> = {
  jira: [
    { id: "epic", word: "Epic" },
    { id: "type", word: "Type" },
    { id: "sprint", word: "Sprint" },
  ],
  linear: [
    { id: "sprint", word: "Cycle" },
    { id: "project", word: "Project" },
    { id: "label", word: "Label" },
  ],
};

/** What `t`'s issue says it is, for facet `id`: none when it doesn't. */
export const facetOf = (t: Ticket, id: FacetId): string[] => {
  const d = t.external?.details;
  if (!d) return [];
  switch (id) {
    case "epic":
      return d.epic ? [d.epic.title || d.epic.key] : [];
    case "type":
      return d.kind ? [d.kind] : [];
    case "sprint":
      return d.sprint ? [sprintName(d.sprint)] : [];
    case "project":
      return d.project ? [d.project] : [];
    case "label":
      return d.labels ?? [];
  }
};

/** A sprint's or cycle's name: a Linear cycle without one by its number. */
export const sprintName = (s: { name?: string; number?: number }): string =>
  s.name ?? (s.number !== undefined ? `Cycle ${s.number}` : "");

/** Whether `t` is shown by `f`: each facet set must be one it has. */
export const shownByFacets = (t: Ticket, f: Facets | undefined): boolean =>
  !f || (Object.entries(f) as [FacetId, string | undefined][]).every(([id, want]) => !want || facetOf(t, id).includes(want));

/** Each facet's choices among `tickets`, by name, most used first. */
export const facetChoices = (tickets: readonly Ticket[], id: FacetId): string[] => {
  const n = new Map<string, number>();
  for (const t of tickets) for (const v of facetOf(t, id)) if (v) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
};

/** A column's points: its cards' story points or estimates added up. */
export const pointsOf = (cards: readonly Ticket[]): number =>
  cards.reduce((n, t) => n + (t.external?.details?.points ?? 0), 0);
