// The toolbar popup: whether Chrome is connected to Desk, what Desk is
// doing here now, and Stop.

import type { LinkState } from "./link";

const $ = (id: string) => document.getElementById(id)!;

const SAID: Record<LinkState["state"], string> = {
  connecting: "Connecting to Desk…",
  "no-desk": "Desk isn't running on this computer.",
  waiting: "Waiting for you to confirm this Chrome in Desk.",
  ready: "Connected to Desk.",
  refused: "Desk isn't using this Chrome.",
};

export const show = (s: LinkState): void => {
  const state = $("state");
  state.textContent = SAID[s.state];
  state.className = s.state;
  $("why").textContent = s.state === "ready" ? "" : (s.why ?? "");
  $("label").textContent = s.label ?? "…";
  const now = $("now");
  now.hidden = !s.activity;
  if (s.activity) $("where").textContent = `${s.activity.agent} · ${s.activity.host ?? s.activity.url}`;
};

const ask = (what: string) => chrome.runtime.sendMessage({ ask: what }) as Promise<LinkState>;

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  $("stop").addEventListener("click", () => void ask("stop").then(show));
  void ask("state").then(show);
  setInterval(() => void ask("state").then(show), 1500);
}
