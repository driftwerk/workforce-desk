// Agents' `[oversight]` configs as the hub keeps them, for tests: saving one
// that makes a boss of a group switches off, and takes the group's name off,
// every other config naming that group (`one_overseer`); a group any config
// names is closed, and sealed while no boss oversees it.

import { parse, stringify } from "smol-toml";
import type { GroupBoss, Manager } from "../hub/types";
import type { Handover, MoveChoices, MoveCommit, MoveDone, MoveEffect, MoveItem, MovePreview } from "../hub/moves";

type Oversight = { enabled?: boolean; group?: string; [k: string]: unknown };

const oversightIn = (toml: string): Oversight | undefined => (parse(toml) as { oversight?: Oversight }).oversight;

export const nameOf = (id: string): string => id[0]!.toUpperCase() + id.slice(1);

/** The configs, by agent id, and what the hub says of them. */
export function oversightHub(configs: Record<string, string>, main = "desk") {
  return {
    configs,
    /** Saves `toml` for `id`, as the hub does. */
    save(id: string, toml: string) {
      configs[id] = toml;
      const o = oversightIn(toml);
      if (!o?.enabled || !o.group) return;
      for (const [other, body] of Object.entries(configs)) {
        const theirs = oversightIn(body);
        if (other === id || theirs?.group !== o.group) continue;
        const { group: _gone, ...rest } = theirs;
        configs[other] = stringify({ ...(parse(body) as object), oversight: { ...rest, enabled: false } });
      }
    },
    /** The manager route's answer, over the sidebar's `groups`. */
    manager(groups: readonly string[]): Manager {
      const bosses: GroupBoss[] = [];
      const named = new Set<string>();
      for (const [id, body] of Object.entries(configs)) {
        const o = oversightIn(body);
        if (!o?.group || !groups.includes(o.group)) continue;
        named.add(o.group);
        if (o.enabled) bosses.push({ agentId: id, name: nameOf(id), group: o.group, level: "act" });
      }
      const sealed = [...named].filter((g) => !bosses.some((b) => b.group === g)).sort();
      return { agentId: main, level: "act", bosses, sealed };
    },
  };
}

// ── Moves, as the hub's holder-only routes answer them ────────────────────


/** What the person asked to preview. */
export interface MoveAskBody {
  item: MoveItem;
  to: string | null;
  choices: MoveChoices;
}

/** What a preview says, by what was asked: its effects, its notes (without
 *  ids; each preview gives them new ones), and why not. */
export type MoveAnswer = (ask: MoveAskBody) => {
  effects: MoveEffect[];
  handovers?: Omit<Handover, "id">[];
  blocked?: string | null;
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The hub's move routes over `fetch`, as the person who holds the hub
 *  (bearer `token`) reaches them; anyone else gets 401. */
export function movesHub(answer: MoveAnswer, token = "holder") {
  let n = 0;
  const hub = {
    asked: [] as MoveAskBody[],
    commits: [] as MoveCommit[],
    previews: new Map<string, MovePreview>(),
    handovers: new Map<string, Handover>(),
    used: new Set<string>(),
    /** The next commit is refused: what it does changed. */
    stale: false,
    /** The next commit is refused with this, as the hub refuses a note. */
    refuse: null as string | null,
    /** Called once a move is made. */
    made: (_p: MovePreview, _c: MoveCommit) => {},
    /** Answers a move route, or null for any other. */
    fetch: async (url: URL, init?: RequestInit): Promise<Response | null> => {
      const route = `${init?.method ?? "GET"} ${url.pathname}`;
      const isMove = route === "POST /api/desk/moves/preview" || route === "POST /api/desk/moves" || url.pathname.startsWith("/api/desk/handovers/");
      if (!isMove) return null;
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${token}`) return reply({ error: "not allowed" }, 401);
      if (route === "POST /api/desk/moves/preview") {
        const ask = JSON.parse(String(init?.body)) as MoveAskBody;
        hub.asked.push(ask);
        const a = answer(ask);
        const id = `p${++n}`;
        const handovers = (a.handovers ?? []).map((h, i) => ({ ...h, id: `${id}-h${i}` }));
        for (const h of handovers) hub.handovers.set(h.id, h);
        const p: MovePreview = {
          id,
          item: ask.item,
          from: null,
          to: ask.to,
          choices: ask.choices,
          effects: a.effects,
          blocked: a.blocked ?? null,
          handover: handovers.find((h) => h.item === `${ask.item.kind}:${ask.item.id}`) ?? null,
          handovers,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
        hub.previews.set(id, p);
        return reply(p);
      }
      if (route === "POST /api/desk/moves") {
        const c = JSON.parse(String(init?.body)) as MoveCommit;
        const p = hub.previews.get(c.preview);
        if (!p || hub.used.has(c.preview)) return reply({ error: "This move was made already or has run out; look at it again." }, 409);
        if (hub.stale || JSON.stringify(c.choices) !== JSON.stringify(p.choices)) {
          hub.stale = false;
          return reply({ error: "What this move does has changed since you looked; look at it again." }, 409);
        }
        for (const h of p.handovers) {
          const text = c.notes.find((x) => x.id === h.id)?.note ?? (h === p.handover ? c.note : undefined);
          if (text === undefined) return reply({ error: "Send each handover note as you read it." }, 400);
          if (!text.trim()) return reply({ error: "The handover note is empty; say something for the new boss to go on." }, 400);
        }
        if (hub.refuse) {
          const why = hub.refuse;
          hub.refuse = null;
          return reply({ error: why }, 400);
        }
        hub.used.add(c.preview);
        hub.commits.push(c);
        hub.made(p, c);
        const done: MoveDone = { effects: p.effects, delivered: p.handovers, problems: [] };
        return reply(done);
      }
      const h = hub.handovers.get(decodeURIComponent(url.pathname.split("/").pop()!));
      return h ? reply(h) : reply({ error: "not found" }, 404);
    },
  };
  return hub;
}

/** A note as a preview drafts it: from `from` to `to`, Desk's facts. */
export const draftNote = (item: string, from: string | null, to: string, note: string, more: Partial<Handover> = {}): Omit<Handover, "id"> => ({
  item,
  fromGroup: null,
  toGroup: null,
  fromBoss: from,
  toBoss: to,
  note,
  draftedBy: { kind: "desk", id: "desk", name: "Desk" },
  edited: false,
  state: "draft",
  drafting: false,
  ...more,
});
