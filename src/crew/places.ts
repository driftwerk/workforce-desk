// The places a rule of "What they see" names (Sees K6), in the hub's scope
// grammar (`knows.rs`): `all`, `group:<id>`, `board:<id>`, `grid:<id>`,
// `session:<id>` or `session:<machine>/<id>`, `agent:<hub>/<agent>`. None is
// the agent's own work alone.

/** Which of the three a rule is. */
export type SeesMode = "all" | "chosen" | "own";

export const modeOf = (places: readonly string[]): SeesMode => (places.includes("all") ? "all" : places.length === 0 ? "own" : "chosen");

/** What a picker lists, by kind, in the order it shows them. */
export type PlaceKind = "group" | "board" | "grid" | "session" | "agent";

export const PLACE_KINDS: { kind: PlaceKind; title: string }[] = [
  { kind: "group", title: "Groups" },
  { kind: "board", title: "Boards" },
  { kind: "grid", title: "Grids" },
  { kind: "session", title: "Sessions" },
  { kind: "agent", title: "Agents" },
];

/** One place a person can pick: its key in the grammar and its name. */
export interface Place {
  place: string;
  kind: PlaceKind;
  name: string;
  sub?: string;
}

export const kindOf = (place: string): PlaceKind | null => {
  const at = place.indexOf(":");
  const kind = at > 0 ? place.slice(0, at) : "";
  return PLACE_KINDS.some((k) => k.kind === kind) ? (kind as PlaceKind) : null;
};

const NOUN: Record<PlaceKind, [string, string]> = {
  group: ["group", "groups"],
  board: ["board", "boards"],
  grid: ["grid", "grids"],
  session: ["session", "sessions"],
  agent: ["agent", "agents"],
};

const gone: Record<PlaceKind, string> = {
  group: "a group that’s gone",
  board: "a board that’s gone",
  grid: "a grid that’s gone",
  session: "a session that’s gone",
  agent: "an agent that’s gone",
};

/** A chosen rule in a line: groups, boards and grids by name, sessions and
 *  agents by name while there are two or fewer of them, else counted. */
export const placesSaid = (places: readonly string[], known: ReadonlyMap<string, Place>): string => {
  const parts: string[] = [];
  for (const { kind } of PLACE_KINDS) {
    const these = places.filter((p) => kindOf(p) === kind);
    if (these.length === 0) continue;
    if ((kind === "session" || kind === "agent") && these.length > 2) {
      parts.push(`${these.length} ${NOUN[kind][1]}`);
      continue;
    }
    for (const p of these) {
      const name = known.get(p)?.name;
      parts.push(!name ? gone[kind] : kind === "board" || kind === "grid" ? `${name} ${NOUN[kind][0]}` : name);
    }
  }
  return parts.join(" · ");
};

/** What was shared, by the hub's kinds, in words. */
const SHARED_NOUN: Record<string, [string, string]> = {
  account: ["session update", "session updates"],
  decision: ["decision", "decisions"],
  need: ["need", "needs"],
  board: ["board change", "board changes"],
  transcript: ["exchange", "exchanges"],
};

export const countSaid = (n: number, kind: string): string => {
  const [one, many] = SHARED_NOUN[kind] ?? ["item", "items"];
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
};

/** A list in words: "a, b and c". */
export const andSaid = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
