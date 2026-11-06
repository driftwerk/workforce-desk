// The DM as a hub that predates `desk.client_ids` keeps it: the live
// messages Desk showed are matched to the hub's copies by what they say and
// when, since the hub never says which kept row one became. Kept only for
// such a hub; a hub with client ids is reconciled in ./reconcile.ts by id
// alone. Delete this file once no supported hub predates client ids.
import type { Attachment, ChatMessage } from "./types";
import { LOCAL_ID } from "./history";

/** Whether a live answer can be known only by what it says: one the hub
 *  never gave an id, or one its turn's end said wasn't kept under the id
 *  it streamed with. */
const byWords = (m: ChatMessage): boolean => !!m.byWords || m.id.startsWith(LOCAL_ID);

const filesOf = (m: ChatMessage): readonly Attachment[] => m.attachments ?? [];

/** Whether the hub's `k` is the live `m`. A file's id says so whatever the
 *  words (the hub may redact them), and a copy without `m`'s files is not
 *  one: showing it would lose them. A person's message without files isn't
 *  one that has them. Anything else is known by who said what. */
const same = (k: ChatMessage, m: ChatMessage): boolean => {
  if (k.role !== m.role) return false;
  const files = filesOf(m);
  if (files.length > 0) return files.every((f) => filesOf(k).some((h) => h.artifact_id === f.artifact_id));
  if (m.role === "user" && filesOf(k).length > 0) return false;
  return k.content.trim() === m.content.trim();
};

/** How far back in what the hub kept a live message is looked for. */
const LOOK_BACK = 50;

/** How much earlier than a live message the hub's copy of it may say it
 *  was (the hub's clock and this computer's need not agree). */
const SKEW_MS = 2 * 60_000;

/** Whether `k` isn't from well before `m` was. */
const notEarlier = (k: ChatMessage, m: ChatMessage): boolean => {
  const kt = Date.parse(k.at);
  const mt = Date.parse(m.at);
  return Number.isNaN(kt) || Number.isNaN(mt) || kt >= mt - SKEW_MS;
};

/** Whether the hub's `k` is the error `m` Desk showed of a turn: the same
 *  words, not from well before it. */
const keptError = (k: ChatMessage, m: ChatMessage): boolean =>
  k.role !== "user" && m.content.trim() !== "" && k.content.trim() === m.content.trim() && notEarlier(k, m);

/** Whether the hub's `k` could be the live `m`: `m`'s files say so, or it
 *  says the same and isn't from well before `m` was. */
const copyOf = (k: ChatMessage, m: ChatMessage): boolean =>
  same(k, m) && (filesOf(m).length > 0 || notEarlier(k, m));

/** Whether the hub's `k` is the live `m` as a hub that doesn't return a
 *  person's files keeps it: the same words, without the files. */
const twinOf = (k: ChatMessage, m: ChatMessage): boolean =>
  k.role === m.role &&
  filesOf(m).length > 0 &&
  filesOf(k).length === 0 &&
  m.content.trim() !== "" &&
  k.content.trim() === m.content.trim() &&
  notEarlier(k, m);

/** Where in the hub's `kept`, from `from` back, the live `m` is: as its copy
 *  or as its twin, never as one whose words are already another's (`taken`).
 *  -1 when it isn't within {@link LOOK_BACK}. */
const look = (kept: ChatMessage[], from: number, m: ChatMessage, taken: ReadonlySet<string>): number => {
  for (let k = from; k >= Math.max(0, from - LOOK_BACK); k--) {
    if (!taken.has(kept[k]!.id) && (copyOf(kept[k]!, m) || twinOf(kept[k]!, m))) return k;
  }
  return -1;
};

/** Whether the live messages before `m` (`earlier`) that say what it says
 *  are as many as the twins free (`free`) at `kept[at]` and before it for
 *  them and `m`, each by its own time: then which of them is whose isn't
 *  known, and the next read, which may have kept `m`'s own, decides. */
const contested = (
  kept: ChatMessage[],
  at: number,
  m: ChatMessage,
  earlier: readonly ChatMessage[],
  free: (k: number) => boolean,
): boolean => {
  const rivals = earlier.filter((n) => n.role === m.role && filesOf(n).length > 0 && n.content.trim() === m.content.trim());
  if (rivals.length === 0) return false;
  let twins = 0;
  for (let k = at; k >= Math.max(0, at - LOOK_BACK); k--) {
    if (free(k) && (twinOf(kept[k]!, m) || rivals.some((n) => twinOf(kept[k]!, n)))) twins++;
  }
  return rivals.length >= twins;
};

/** What the hub's latest page says of the live messages. */
export interface Settled {
  /** Those it now shows, to drop. */
  ids: Set<string>;
  /** Those with files it will never show but has passed: each by the kept
   *  message it goes before, known only now, while what came after it is
   *  still live. */
  anchors: Map<string, string>;
  /** Those it kept the words of without their files: each by the kept message
   *  that says them, known only now, while it is near the end of the page. */
  twins: Map<string, string>;
}

/** A read of the hub's page, for {@link settle}: when it `began` (what was
 *  sent since, it may or may not have seen), and the kept messages an earlier
 *  read already had (`seen`), which nothing sent since can be. */
export interface Reading {
  began: string;
  seen: ReadonlySet<string>;
}

/** The live messages, finished by `before`, that `kept` (the hub's latest
 *  page, oldest first) now shows: matched in order from the end, so a reply
 *  the hub hasn't kept yet stays live, and an older one that says the same
 *  thing doesn't stand in for it. On a hub that streams answers by id
 *  (`streamed`), an answer is known by its id alone, unless it has none the
 *  hub gave or its turn's end said it wasn't kept under it; what you said,
 *  which the hub keeps under an id of its own, is still matched by its files
 *  or its text. One matched by its files or its text whose files the hub didn't
 *  return stays live, so they aren't lost.
 *
 *  One sent while the read ran (after `read.began`) is matched only as its
 *  copy, oldest first, after what was found for those before it and never as
 *  what an earlier read had: the same words further back are another
 *  message, and so are words alone without its files. */
export const settle = (kept: ChatMessage[], all: ChatMessage[], before: string, streamed = false, read?: Reading): Settled => {
  const began = read?.began ?? before;
  // Those the hub sent live by their id are known by it; on a hub that
  // streams its answers by id, every answer is.
  const keptIds = new Set(kept.map((m) => m.id));
  const taken = new Set(all.flatMap((m) => (m.keptAs ? [m.keptAs] : [])));
  const ids = new Set<string>();
  const twins = new Map<string, string>();
  // Where in `kept` each live message is, by its place in `all`.
  const found = new Map<number, number>();
  const during: number[] = [];
  const unplaced = new Set<number>();
  // One that may be the twin of what a later one is found as.
  const rival = (n: ChatMessage) => !keptIds.has(n.id) && !n.keptAs && n.status === "complete" && n.at <= began;
  let j = kept.length - 1;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (keptIds.has(m.id)) {
      ids.add(m.id);
      found.set(i, kept.findIndex((k) => k.id === m.id));
      continue;
    }
    if ((streamed && m.role === "assistant" && !byWords(m)) || m.status !== "complete" || m.at > before || m.role === "system") continue;
    if (m.at > began) {
      during.push(i);
      continue;
    }
    const at = m.keptAs ? kept.findIndex((k) => k.id === m.keptAs) : look(kept, j, m, taken);
    if (at < 0) {
      if (!m.placedBefore && !m.keptAs && filesOf(m).length > 0) unplaced.add(i);
      continue;
    }
    if (copyOf(kept[at]!, m)) ids.add(m.id);
    else if (!m.keptAs) {
      if (contested(kept, at, m, all.slice(0, i).filter(rival), (k) => !taken.has(kept[k]!.id))) continue;
      twins.set(m.id, kept[at]!.id);
    }
    found.set(i, at);
    j = Math.min(j, at - 1);
  }

  let last = -1;
  for (const i of during.reverse()) {
    const m = all[i]!;
    for (const [n, at] of found) if (n < i) last = Math.max(last, at);
    const at = kept.findIndex((k, n) => n > last && !read?.seen.has(k.id) && !taken.has(k.id) && copyOf(k, m));
    if (at < 0) continue;
    ids.add(m.id);
    found.set(i, at);
    last = at;
  }

  // Later refreshes no longer know what followed one: its place stands.
  const anchors = new Map<string, string>();
  let next: string | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    const at = found.get(i);
    if (at !== undefined) next = kept[at]!.id;
    else if (next && unplaced.has(i)) anchors.set(all[i]!.id, next);
  }
  return { ids, anchors, twins };
};

/** The live messages {@link settle} says the hub now shows. */
export const covered = (kept: ChatMessage[], all: ChatMessage[], before: string, streamed = false): Set<string> =>
  settle(kept, all, before, streamed).ids;

/** The conversation as shown: what the hub kept, then what arrived live,
 *  without the live messages the hub's copy already has. Those can only be
 *  ones that existed when the read of the history began (`loadedAt`), or
 *  answers the socket repeats before you've said anything; they're the start
 *  of the live list and the end of the history. One sent while the read ran
 *  that it has, {@link settle} drops as soon as it is read.
 *
 *  A live message matched by its files or its words isn't given up for a copy
 *  that lacks its files. Where the hub kept its words, its files show on the
 *  kept copy. Where it kept nothing, it goes where {@link settle} placed it,
 *  or, when nothing of yours came after it and the read has seen past it,
 *  before what the hub says is later by more than the clocks can differ; else
 *  it is the latest, and stays last. One the hub knows by its id is the kept
 *  message, files or not: on a hub that streams answers by id, a file delivered
 *  directly to an answer doesn't show once the kept answer does. */
export const withHistory = (history: ChatMessage[], all: ChatMessage[], loadedAt: string | null): ChatMessage[] => {
  if (history.length === 0) return all;
  // A message the hub sent live by its id (the overseer's) is the kept one.
  const kept = new Set(history.map((m) => m.id));
  const live = all.some((m) => kept.has(m.id)) ? all.filter((m) => !kept.has(m.id)) : all;
  const held = new Set(live.filter((m) => (filesOf(m).length > 0 && !history.some((h) => same(h, m))) || m.placedBefore));
  const gone = new Set<ChatMessage>();

  const shownFiles = new Map<number, Attachment[]>();
  const showOn = (k: number, m: ChatMessage) => {
    shownFiles.set(k, filesOf(m) as Attachment[]);
    gone.add(m);
  };
  // Those settled on a copy first, however far back it now is.
  const unsettled = [...held].filter((m) => {
    if (!m.keptAs) return true;
    const k = history.findIndex((h) => h.id === m.keptAs);
    if (k >= 0) showOn(k, m);
    return false;
  });
  // One sent since that read began may not be in it: an earlier message that
  // says the same is another message.
  const seen = unsettled.filter((m) => loadedAt !== null && m.at <= loadedAt);
  const free = (k: number) => !shownFiles.has(k);
  let j = history.length - 1;
  for (let u = seen.length - 1; u >= 0; u--) {
    const m = seen[u]!;
    for (let k = j; k >= Math.max(0, j - LOOK_BACK); k--) {
      if (!free(k) || !twinOf(history[k]!, m)) continue;
      if (!contested(history, k, m, seen.slice(0, u), free)) {
        showOn(k, m);
        j = k - 1;
      }
      break;
    }
  }

  const placed = new Map<number, ChatMessage[]>();
  for (const m of held) {
    if (gone.has(m)) continue;
    let at = m.placedBefore ? history.findIndex((h) => h.id === m.placedBefore) : -1;
    // By time only what the read has seen past: one sent since is the latest,
    // whatever this computer's clock says of it against the hub's.
    if (at < 0 && loadedAt !== null && m.at <= loadedAt) {
      const t = Date.parse(m.at);
      at = Number.isNaN(t) ? -1 : history.findIndex((h) => Date.parse(h.at) > t + SKEW_MS);
    }
    if (at < 0) continue;
    placed.set(at, [...(placed.get(at) ?? []), m]);
    gone.add(m);
  }

  // A held message still to come after the history is something you said, as
  // much as any other; one shown within it isn't after it.
  const after = live.filter((m) => !gone.has(m));
  const firstSaid = after.findIndex((m) => m.role === "user");
  const rest = live.filter((m) => !held.has(m));
  // An error Desk shows of a turn is no message of the transcript: the tail
  // the hub kept is matched against what was said around it.
  const said = rest.filter((m) => m.status !== "error");
  let candidates = 0;
  while (candidates < said.length) {
    const m = said[candidates]!;
    const known = loadedAt !== null && m.at <= loadedAt && m.status === "complete";
    const echo = m.role === "assistant" && m.status === "complete" && (firstSaid < 0 || after.indexOf(m) < firstSaid);
    if (!known && !echo) break;
    candidates++;
  }
  for (let k = Math.min(candidates, history.length); k > 0; k--) {
    const tail = history.slice(-k);
    if (tail.every((m, i) => same(m, said[i]!))) {
      said.slice(0, k).forEach((m) => gone.add(m));
      break;
    }
  }

  // An error the hub kept too shows once, as it kept it.
  for (const m of rest) {
    if (m.status === "error" && history.some((h) => keptError(h, m))) gone.add(m);
  }

  // What the read has seen past that the hub kept no copy of goes by its own
  // time, as a held message does, never after everything said since: an
  // error Desk showed as much as an answer.
  for (const m of rest) {
    if (gone.has(m) || m.status === "streaming" || loadedAt === null || m.at > loadedAt) continue;
    const t = Date.parse(m.at);
    const at = Number.isNaN(t) ? -1 : history.findIndex((h) => Date.parse(h.at) > t + SKEW_MS);
    if (at < 0) continue;
    placed.set(at, [...(placed.get(at) ?? []), m]);
    gone.add(m);
  }

  const merged = history.flatMap((h, i) => {
    const files = shownFiles.get(i);
    return [...(placed.get(i) ?? []), files ? { ...h, attachments: files } : h];
  });
  return [...merged, ...live.filter((m) => !gone.has(m))];
};
