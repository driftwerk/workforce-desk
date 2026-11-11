import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { plainError } from "./plainError";
import { explain, readable, setStarter } from "./problem";

const INTERNAL = /\bhub\b|desk-hubd|\b[45]\d\d\b|\[[a-z_.]+\]|[{}`]/i;

beforeEach(() => {
  useUi.setState({ settings: null });
  setStarter(null);
});
afterEach(() => setStarter(null));

describe("explain: hub refusals", () => {
  it("401 asks to sign in again, at the workspaces", () => {
    const p = explain(new HubError(401, "unauthorized"));
    expect(p.plain).toBe("You’re signed out of this workspace.");
    expect(p.fix?.label).toBe("Sign in again");
    p.fix?.run?.();
    expect(useUi.getState().settings).toBe("hubs");
    expect(p.details).toBe("unauthorized");
  });

  it("403 is no dead end: it hands the problem to Desk", () => {
    const p = explain(new HubError(403, "forbidden: browser.use"));
    expect(p.plain).toBe("Desk wasn’t allowed to do that.");
    expect(p.fix).toEqual({ label: "Ask Desk to fix it", ask: true });
    expect(p.details).toBe("forbidden: browser.use");
  });

  it("5xx offers Retry when the caller can, else Ask Desk", () => {
    const retry = vi.fn();
    const p = explain(new HubError(500, "pg: connection reset"), { retry });
    expect(p.plain).toBe("Something broke while Desk was doing that.");
    expect(p.fix?.label).toBe("Retry");
    p.fix?.run?.();
    expect(retry).toHaveBeenCalled();
    expect(explain(new HubError(503, "x")).fix?.ask).toBe(true);
  });

  it("429 and 408 say Desk was asked for too much, and offer Retry", () => {
    expect(explain(new HubError(429, "slow down"), { retry: () => {} }).fix?.label).toBe("Retry");
  });

  it("404 says it's gone, with the raw text under details", () => {
    const p = explain(new HubError(404, "no such session s-1"));
    expect(p.plain).toBe("That isn’t there any more.");
    expect(p.details).toBe("no such session s-1");
  });

  it("keeps a readable 4xx as the headline", () => {
    expect(explain(new HubError(409, "That ticket changed while this was being done; look at it again.")).plain).toBe(
      "That ticket changed while this was being done; look at it again.",
    );
  });

  it("never shows the hub's developer text as the headline", () => {
    const p = explain(new HubError(400, 'the body is {"fields": {name: value}}'));
    expect(p.plain).toBe("Desk couldn’t do that.");
    expect(p.details).toBe('the body is {"fields": {name: value}}');
    expect(p.fix?.ask).toBe(true);
  });

  it("calls the hub Desk when only the word is internal", () => {
    const p = explain(new HubError(400, "The hub is busy."));
    expect(p.plain).toBe("Desk is busy.");
    expect(p.details).toBe("The hub is busy.");
  });
});

describe("explain: reaching Desk's own helper", () => {
  it("offers Start it when this computer's helper is down and the app can start it", () => {
    const start = vi.fn();
    setStarter(start);
    const p = explain(new TypeError("Failed to fetch"), { localDown: true });
    expect(p.plain).toBe("Desk can’t reach your agents right now.");
    expect(p.fix?.label).toBe("Start it");
    p.fix?.run?.();
    expect(start).toHaveBeenCalled();
  });

  it("falls back to Ask Desk where nothing can start it (a grid window)", () => {
    expect(explain(new TypeError("x"), { localDown: true }).fix?.ask).toBe(true);
  });

  it("offers Retry when the helper is up", () => {
    expect(explain(new TypeError("x"), { retry: () => {} }).fix?.label).toBe("Retry");
  });

  it("knows the broker's and the helper's own words", () => {
    setStarter(() => {});
    const p = explain("This computer's hub isn't running yet.");
    expect(p.plain).toBe("Desk’s helper on this computer isn’t running.");
    expect(p.fix?.label).toBe("Start it");
  });
});

describe("explain: the app's own texts", () => {
  it("sign-in that ended without a token: Sign in again at Providers, the CLI tail in details", () => {
    const raw = "Claude sign-in ended without a token. Error: browser closed\nTry again";
    const p = explain(raw);
    expect(p.plain).toBe("Claude sign-in didn’t finish.");
    expect(p.fix?.label).toBe("Sign in again");
    p.fix?.run?.();
    expect(useUi.getState().settings).toBe("providers");
    expect(p.details).toBe(raw);
  });

  it("ChatGPT sign-in", () => {
    expect(explain("ChatGPT sign-in didn't finish.").plain).toBe("ChatGPT sign-in didn’t finish.");
  });

  it("session start: not a folder, branch taken, git's stderr", () => {
    expect(explain(new HubError(400, "/Users/me/x is not a folder")).plain).toBe("/Users/me/x isn’t a folder Desk can open.");
    expect(explain(new HubError(409, "a branch called fix-1 already exists")).plain).toBe("A branch called fix-1 already exists. Pick another name.");
    const git = explain(new HubError(500, "git worktree add /tmp/w: fatal: 'main' is already checked out"));
    expect(git.details).toContain("fatal:");
    const plain = explain(new Error("git worktree add /tmp/w: fatal: 'main' is already checked out"));
    expect(plain.plain).toBe("Desk couldn’t set up a separate copy of the project to work in.");
    expect(plain.fix?.ask).toBe(true);
  });

  it("an unknown multi-line error is a generic headline with the text in details", () => {
    const p = explain(new Error("boom\n  at x (a.js:1:2)"), { retry: () => {} });
    expect(p.plain).toBe("Desk couldn’t finish that.");
    expect(p.fix?.label).toBe("Retry");
    expect(p.details).toBe("boom\n  at x (a.js:1:2)");
  });

  it("carries what Desk was doing, for the agent", () => {
    expect(explain(new HubError(500, "x"), { what: "starting a session" }).what).toBe("starting a session");
  });
});

describe("no internal term reaches a headline", () => {
  const samples: unknown[] = [
    new HubError(400, "desk-hubd: bad [desk.memory] key"),
    new HubError(502, "upstream 502"),
    new HubError(400, "unknown field `name`"),
    "This computer's hub isn't running yet.",
    "This hub doesn’t have that yet.",
    new Error("request failed with status 418"),
    new Error("invalid_request_error"),
    new TypeError("x"),
  ];
  it.each(samples.map((s, i) => [i, s] as const))("sample %i", (_i, e) => {
    expect(explain(e).plain).not.toMatch(INTERNAL);
  });
  it("plainError is the headline", () => {
    expect(plainError(new HubError(403, "x"))).toBe("Desk wasn’t allowed to do that.");
  });
  it("readable rejects machinery", () => {
    expect(readable("Desk is busy.")).toBe(true);
    expect(readable("the hub said 500")).toBe(false);
  });
});

describe("the store's fail", () => {
  it("keeps a Problem, marking the helper down when it is", () => {
    useDesk.setState({ connected: false, error: null });
    setStarter(() => {});
    useDesk.getState().fail(new TypeError("Failed to fetch"));
    expect(useDesk.getState().error?.fix?.label).toBe("Start it");
    useDesk.getState().clearError();
    expect(useDesk.getState().error).toBeNull();
  });
});

describe("plainError keeps the raw text where there is no Details", () => {
  it("appends it, on one line, to the generic headline", () => {
    expect(plainError(new Error("boom\n  at x"))).toBe("Desk couldn’t finish that. (boom at x)");
    expect(plainError(new HubError(400, "the body is {x}"))).toBe("Desk couldn’t do that. (the body is {x})");
  });
  it("leaves a specific headline alone", () => {
    expect(plainError(new HubError(404, "no such session"))).toBe("That isn’t there any more.");
  });
});
