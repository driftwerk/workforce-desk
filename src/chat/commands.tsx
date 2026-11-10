// The commands a hub answers itself (`/status`, `/help`, …), as its
// `/api/commands` lists them, and the menu a DM's composer shows while you
// type one: `/` at the start of the box, then the first letters of a name.
// A hub that doesn't list them (an older one) offers no menu; what you type
// still goes, and the hub answers it as it always did.

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { pairedHub } from "../hub/net";
import type { HubAccount } from "./types";

/** One command, as the hub lists it. */
export interface HubCommand {
  name: string;
  /** What it takes after its name: `[model]`. */
  args: string;
  aliases: string[];
  /** What it does, in one line. */
  summary: string;
}

/** Each hub's list, by its id and revision: read once. */
const lists = new Map<string, Promise<HubCommand[]>>();

const asCommands = (body: unknown): HubCommand[] => {
  const raw = (body as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: Record<string, unknown>) =>
    typeof c?.name === "string"
      ? [
          {
            name: c.name,
            args: typeof c.args === "string" ? c.args : "",
            aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : [],
            summary: typeof c.summary === "string" ? c.summary : "",
          },
        ]
      : [],
  );
};

/** What `hub` lists; none when it lists none, or couldn't be asked (asked
 *  again next time). */
export const fetchCommands = (hub: HubAccount): Promise<HubCommand[]> => {
  const key = `${hub.id}#${hub.revision}`;
  let list = lists.get(key);
  if (!list) {
    list = pairedHub(hub)
      .fetch("GET", "/api/commands")
      .then(async (res) => (res.ok ? asCommands(await res.json()) : []))
      .catch(() => {
        lists.delete(key);
        return [];
      });
    lists.set(key, list);
  }
  return list;
};

/** Forgets every hub's list (for tests). */
export const forgetCommands = () => lists.clear();

/** The commands `hub` lists, once read. */
export function useHubCommands(hub: HubAccount | undefined): HubCommand[] {
  const [commands, setCommands] = useState<HubCommand[]>([]);
  const id = hub?.id;
  const revision = hub?.revision;
  useEffect(() => {
    if (!hub) return setCommands([]);
    let live = true;
    void fetchCommands(hub).then((c) => live && setCommands(c));
    return () => {
      live = false;
    };
    // The hub as it is known: by its id and revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, revision]);
  return commands;
}

/** The commands `typed` (the whole box) may be the start of: while it is `/`
 *  and the start of a name, those named so first, then those an alias of
 *  which begins so. Nothing once there's anything after the name. */
export const matching = (typed: string, commands: readonly HubCommand[]): HubCommand[] => {
  const word = /^\/([a-z0-9_?-]*)$/i.exec(typed)?.[1]?.toLowerCase();
  if (word === undefined) return [];
  const named = commands.filter((c) => c.name.startsWith(word));
  return [...named, ...commands.filter((c) => !named.includes(c) && c.aliases.some((a) => a.startsWith(word)))];
};

/** A command's answer, as the hub writes it for every surface (Slack's
 *  `*bold*`, a line each), in the Markdown a DM reads: each line its own,
 *  and bold as bold. Code spans are left as they are. */
export const commandMarkdown = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      line
        .split("`")
        .map((part, i) => (i % 2 ? part : part.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=$|[^*\w])/g, "$1**$2**")))
        .join("`"),
    )
    .join("  \n");

/** What a summary says, without the hub's code marks. */
const plain = (summary: string) => summary.replace(/`/g, "");

export interface CommandMenu {
  /** Call first from the box's onKeyDown: true when it took the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  open: boolean;
  listId: string;
  activeId: string | undefined;
  menu: ReactNode;
}

/** The `/` menu of a composer whose box is `field`, holding `value`. */
export function useCommandMenu({
  field,
  value,
  setValue,
  commands,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (text: string) => void;
  commands: readonly HubCommand[];
}): CommandMenu {
  const [active, setActive] = useState(0);
  // Escape closes it until the box says something else.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const options = dismissed === value ? [] : matching(value, commands);
  const open = options.length > 0;
  const current = Math.min(active, options.length - 1);
  useEffect(() => setActive(0), [value]);

  const pick = (c: HubCommand) => {
    const next = `/${c.name}${c.args ? " " : ""}`;
    setValue(next);
    setDismissed(next);
    const el = field.current;
    if (el) {
      el.focus();
      queueMicrotask(() => el.setSelectionRange(next.length, next.length));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
      return true;
    }
    const chosen = options[current]!;
    // A command typed out whole goes with Enter, as typed.
    const whole = value.slice(1).toLowerCase() === chosen.name || chosen.aliases.includes(value.slice(1).toLowerCase());
    if ((e.key === "Enter" && !e.shiftKey && !whole) || e.key === "Tab") {
      e.preventDefault();
      pick(chosen);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(value);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <ul className="mention-menu command-menu" role="listbox" id={listId} aria-label="Commands">
      {options.map((c, i) => (
        <li
          key={c.name}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === current}
          className="mention-option"
          onMouseDown={(ev) => {
            ev.preventDefault();
            pick(c);
          }}
          onMouseEnter={() => setActive(i)}
        >
          <b className="command-name">/{c.name}</b>
          {c.args && <span className="faint small command-args">{c.args}</span>}
          <span className="muted small">{plain(c.summary)}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return { onKeyDown, open, listId, activeId: open ? `${listId}-${current}` : undefined, menu };
}
