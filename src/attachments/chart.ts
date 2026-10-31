// A chart an agent drew, delivered as its spec: fetched as text with the
// hub's token in the header, never parsed here. The chart block validates it
// before anything is drawn, so a spec is only ever data.

import type { HubAccount } from "../chat/types";
import { hubFetch } from "../hub/net";

/** The most a chart's spec may be: eight series of a thousand points, with
 *  room to spare. Anything bigger is not a chart the hub made. */
export const MAX_CHART_BYTES = 1024 * 1024;

const fetched = new Map<string, Promise<string>>();

const read = async (hub: HubAccount, agent: string, artifact: string): Promise<string> => {
  const path = `/api/agents/${encodeURIComponent(agent)}/attachments/${encodeURIComponent(artifact)}`;
  const res = await hubFetch(new URL(path, hub.url), { headers: { authorization: `Bearer ${hub.token}` } });
  if (!res.ok) throw new Error(`the workspace answered ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_CHART_BYTES) throw new Error("the chart is too big");
  const text = await res.text();
  if (text.length > MAX_CHART_BYTES) throw new Error("the chart is too big");
  return text;
};

/** The text of chart `artifact` of `agent` on `hub`, read once while Desk
 *  runs; a read that failed is tried again next time. */
export const chartText = (hub: HubAccount, agent: string, artifact: string): Promise<string> => {
  const key = [hub.id, agent, artifact].join("\u0000");
  const kept = fetched.get(key);
  if (kept) return kept;
  const reading = read(hub, agent, artifact);
  fetched.set(key, reading);
  reading.catch(() => fetched.delete(key));
  return reading;
};
