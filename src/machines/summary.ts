// What a machine's row says of its engines: whether Claude can start
// sessions there, and who each engine is signed in as.

import { useEffect, useState } from "react";
import { accountsOn } from "../engines/accounts";
import { useHubOf } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import type { MachineId } from "./engines";

export interface EngineSummary {
  /** Claude can start sessions there: an account, or its CLI's own sign-in.
   *  Null until read. */
  claudeIn: boolean | null;
  /** "Claude signed in as kings@starmoire.dev · Codex signed in". */
  line: string | null;
}

/** "Claude signed in as x · Codex signed in", from what its hub says. */
export const summaryLine = (engines: readonly EngineInfo[], accounts: number): string | null => {
  const said = (e: EngineInfo | undefined, title: string): string | null => {
    if (!e || e.signIn.state !== "in") return null;
    return e.signIn.who ? `${title} signed in as ${e.signIn.who}` : `${title} signed in`;
  };
  const claude = engines.find((e) => e.engine === "claude");
  const parts = [
    said(claude, "Claude") ?? (accounts > 0 ? `Claude on ${accounts === 1 ? "1 account" : `${accounts} accounts`}` : null),
    said(
      engines.find((e) => e.engine === "codex"),
      "Codex",
    ),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
};

/** Machine `machine`'s engines, as its row shows them; read while it is
 *  connected. */
export function useEngineSummary(machine: MachineId, ready: boolean): EngineSummary {
  const hub = useHubOf(machine);
  const accounts = accountsOn(machine)((s) => s.accounts.filter((a) => a.engine === "claude" && a.signedIn).length);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  useEffect(() => {
    if (!hub || !ready) return;
    let live = true;
    void accountsOn(machine).getState().load();
    hub
      .engines()
      .then((e) => live && setEngines(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hub, ready, machine]);
  if (!engines) return { claudeIn: null, line: null };
  const claude = engines.find((e) => e.engine === "claude");
  const claudeIn = !!claude && (claude.signIn.state === "in" || accounts > 0);
  return { claudeIn: claude?.installed ? claudeIn : null, line: summaryLine(engines, accounts) };
}
