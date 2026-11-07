// Agents' `[oversight]` configs as the hub keeps them, for tests: saving one
// that makes a boss of a group switches off, and takes the group's name off,
// every other config naming that group (`one_overseer`); a group any config
// names is closed, and sealed while no boss oversees it.

import { parse, stringify } from "smol-toml";
import type { GroupBoss, Manager } from "../hub/types";

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
