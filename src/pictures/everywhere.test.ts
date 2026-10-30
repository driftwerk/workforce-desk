import { describe, expect, it, vi } from "vitest";
import type { HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { spreadPicture, spreadSaid } from "./everywhere";

const hub = (id: string, label: string): HubAccount => ({ id, label, url: `https://${id}.example`, local: false, token: id });

describe("using one picture everywhere", () => {
  it("sets it on every hub that takes it, and says which one didn't", async () => {
    const image = new Blob(["png"], { type: "image/png" });
    const send = vi.fn(async (to: HubAccount, _image: Blob) => {
      if (to.id === "acme") throw new HubError(503, "Pictures need the hub's database, which isn't connected.");
      return { version: `${to.id}-v`, source: "chosen" as const, at: "now" };
    });
    const spread = await spreadPicture(image, [hub("dw", "Driftwerk"), hub("acme", "Acme"), hub("lab", "Lab")], send);
    expect(send.mock.calls.map(([to, sent]) => [to.id, sent])).toEqual([
      ["dw", image],
      ["acme", image],
      ["lab", image],
    ]);
    expect(spread.done.map((d) => [d.hub.id, d.picture?.version])).toEqual([
      ["dw", "dw-v"],
      ["lab", "lab-v"],
    ]);
    expect(spread.failed.map((f) => f.hub.id)).toEqual(["acme"]);
    expect(spreadSaid(spread)).toBe("Now your picture on Driftwerk and Lab. Couldn’t set it on Acme: Pictures need the hub's database, which isn't connected.");
  });
});
