import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { MemoryHit, MemorySearch } from "../hub/types";
import { Composer, NO_MACHINE_RECALL } from "../line/Composer";
import { allowedFromComposers } from "../shortcuts/manager";
import { lined } from "../line/testing";
import { KEYWORDS_ONLY, DEBOUNCE_MS, putQuote, quoteOf, recallAt, recallQuery, whenOf } from "./search";
import { SearchMemory } from "./SearchMemory";
import { settingsOf } from "./testing";
import { clock } from "./words";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const NOW = new Date("2026-11-08T12:00:00");
/** 10:12 as this machine's locale writes it. */
const AT = clock(new Date("2026-11-08T10:12:00").toISOString(), NOW);

const hit = (more: Partial<MemoryHit> = {}): MemoryHit => ({
  session: "s1",
  group: "g-acme",
  project: "/work/acme-web",
  at: new Date("2026-11-08T10:12:00").toISOString(),
  asker: "person",
  ask: "",
  answer: "Keep the session token in a secure cookie, not browser storage.",
  compaction: false,
  kind: "decision",
  notedByDesk: true,
  confirmed: false,
  superseded: false,
  name: "acme-web",
  engine: "claude",
  groupName: "Acme",
  ...more,
});

const exchange = hit({
  session: "s2",
  at: new Date("2026-11-07T16:00:00").toISOString(),
  kind: "exchange",
  ask: "Why does logout leave the cookie?",
  answer: "It cleared the server session only.",
  notedByDesk: false,
  name: "acme-api",
  engine: "codex",
});

let answer: MemorySearch = { hits: [], keywordOnly: false, notice: null };
const hub = {
  searchMemory: vi.fn(async () => answer),
  memorySettings: vi.fn(async () =>
    settingsOf({
      groups: [
        { id: "g-acme", name: "Acme", harvest: true, derive: true, handoffAsk: true, deriveDecided: true },
        { id: "g-globex", name: "Globex", harvest: true, derive: false, handoffAsk: true, deriveDecided: true },
      ],
    }),
  ),
  sessionMemory: vi.fn(async () => null),
  postLine: vi.fn(),
};

const settle = async (ms = DEBOUNCE_MS) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {});
};

/** The hits listed (the filters' options aside). */
const found = () => within(screen.getByRole("listbox", { name: "What Desk remembers" })).getAllByRole("option");

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  answer = { hits: [hit(), exchange], keywordOnly: false, notice: null };
  vi.clearAllMocks();
  useDesk.setState({ hub: hub as never, sessions: { s1: lined({ group: { id: "g-acme", name: "Acme" } }) } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const palette = async () => {
  const onClose = vi.fn();
  render(<SearchMemory onClose={onClose} />);
  await act(async () => {});
  return { box: screen.getByRole("combobox", { name: "Search what Desk remembers" }), onClose };
};

describe("Search what Desk remembers (⌘K)", () => {
  it("searches once typing stops, never under two characters", async () => {
    const { box } = await palette();
    type(box, "c");
    await settle();
    expect(hub.searchMemory).not.toHaveBeenCalled();
    type(box, "co");
    await settle(DEBOUNCE_MS / 2);
    type(box, "cookie");
    await settle(DEBOUNCE_MS - 1);
    expect(hub.searchMemory).not.toHaveBeenCalled();
    await settle(1);
    expect(hub.searchMemory).toHaveBeenCalledTimes(1);
    expect(hub.searchMemory).toHaveBeenCalledWith({ q: "cookie", group: undefined, kind: undefined, limit: 20 });
  });

  it("shows each hit's kind, session, group, when and what it says", async () => {
    const { box } = await palette();
    type(box, "cookie");
    await settle();
    const [first, second] = found();
    expect(within(first!).getByText(`Decision · acme-web (Claude Code) · Acme · today ${AT}`)).toBeTruthy();
    expect(within(first!).getByText("Keep the session token in a secure cookie, not browser storage.")).toBeTruthy();
    expect(within(second!).getByText("Conversation · acme-api (Codex) · Acme · yesterday")).toBeTruthy();
    expect(within(second!).getByText("“Why does logout leave the cookie?” … It cleared the server session only.")).toBeTruthy();
    expect(screen.queryByText(KEYWORDS_ONLY)).toBeNull();
  });

  it("narrows by group and kind, the hub's own filters", async () => {
    const { box } = await palette();
    const group = screen.getByRole("combobox", { name: "Group" }) as HTMLSelectElement;
    expect([...group.options].map((o) => o.text)).toEqual(["All", "Acme", "Globex", "Ungrouped"]);
    expect([...(screen.getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "All",
      "Decisions",
      "To-dos",
      "Facts",
      "Conversations",
    ]);
    type(box, "cookie");
    fireEvent.change(group, { target: { value: "g-globex" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "decisions" } });
    await settle();
    expect(hub.searchMemory).toHaveBeenLastCalledWith({ q: "cookie", group: "g-globex", kind: "decisions", limit: 20 });
    expect(screen.queryByRole("combobox", { name: /time|when/i })).toBeNull();
  });

  it("says when it finds by keywords only, and nothing else of it", async () => {
    answer = { hits: [hit()], keywordOnly: true, notice: "Searching by keyword only until Desk Memory is ready." };
    const { box } = await palette();
    type(box, "cookie");
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Searching by keywords only right now.");
    expect(screen.queryByText("Searching by keyword only until Desk Memory is ready.")).toBeNull();
  });

  it("says what else the hub says of a search, such as its index catching up", async () => {
    answer = { hits: [hit()], keywordOnly: false, notice: "Desk Memory is still catching up." };
    const { box } = await palette();
    type(box, "cookie");
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Desk Memory is still catching up.");
  });

  it("uses only the latest answer", async () => {
    let first!: (v: MemorySearch) => void;
    hub.searchMemory.mockImplementationOnce(() => new Promise<MemorySearch>((r) => (first = r)));
    const { box } = await palette();
    type(box, "cookie");
    await settle();
    answer = { hits: [exchange], keywordOnly: false, notice: null };
    type(box, "logout");
    await settle();
    await act(async () => first({ hits: [hit()], keywordOnly: false, notice: null }));
    expect(found()).toHaveLength(1);
    expect(screen.getByText(/Why does logout leave the cookie/)).toBeTruthy();
  });

  it("opens a hit to read, then its session", async () => {
    const { box, onClose } = await palette();
    type(box, "cookie");
    await settle();
    fireEvent.keyDown(box, { key: "Enter" });
    const read = screen.getByRole("article");
    expect(within(read).getByText("Keep the session token in a secure cookie, not browser storage.")).toBeTruthy();
    expect(within(read).getByText(/noted by Desk, may be wrong/)).toBeTruthy();
    fireEvent.click(within(read).getByRole("button", { name: "Open acme-web" }));
    expect(useDesk.getState().openId).toBe("s1");
    expect(onClose).toHaveBeenCalled();
  });

  it("reads a conversation in full from the session's memory, and says when Desk no longer has its session", async () => {
    hub.sessionMemory.mockResolvedValueOnce({
      exchanges: [
        {
          seq: 3,
          at: exchange.at,
          ended: null,
          asker: "person",
          ask: "Why does logout leave the cookie?",
          answer: "It cleared the server session only. The cookie is now cleared too.",
          files: ["/work/acme-api/src/auth/logout.ts"],
          commands: [],
          errors: [],
          compaction: false,
          redacted: 0,
        },
      ],
    } as never);
    const { box } = await palette();
    type(box, "cookie");
    await settle();
    fireEvent.click(found()[1]!);
    await act(async () => {});
    expect(hub.sessionMemory).toHaveBeenCalledWith("s2");
    expect(screen.getByText("It cleared the server session only. The cookie is now cleared too.")).toBeTruthy();
    expect(screen.getByText("auth/logout.ts")).toBeTruthy();
    expect(screen.getByText("Desk no longer has this session; this is what it kept.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Back to results" }));
    expect(found()).toHaveLength(2);
  });
});

describe("the composer's /recall", () => {
  const composer = async () => {
    render(<Composer session={useDesk.getState().sessions.s1!} />);
    await act(async () => {});
    return screen.getByRole("textbox", { name: "Message acme-web" }) as HTMLTextAreaElement;
  };

  it("reads /recall and its words", () => {
    expect(recallQuery("/recall the cookie")).toBe("the cookie");
    expect(recallQuery("/recall")).toBe("");
    expect(recallQuery("/recalled")).toBeNull();
    expect(recallQuery("please /recall it")).toBeNull();
  });

  it("finds /recall on the caret's line anywhere in the draft, and puts the quote in its place", () => {
    const draft = "Before you merge:\n/recall cookie\nthen tidy up.";
    expect(recallAt(draft, draft.indexOf("cookie"))).toEqual({ q: "cookie", from: 18, to: 32 });
    expect(recallAt(draft, 3)).toBeNull();
    expect(recallAt(draft, draft.length)).toBeNull();
    const put = putQuote(draft, recallAt(draft, 20)!, "> A quote");
    expect(put.text).toBe("Before you merge:\n> A quote\n\nthen tidy up.");
    expect(put.text.slice(put.caret)).toBe("then tidy up.");
  });

  it("quotes a hit at the /recall line and keeps the rest of the draft", async () => {
    const box = await composer();
    const draft = "Before you merge:\n/recall cookie\nthen tidy up.";
    fireEvent.change(box, { target: { value: draft } });
    box.setSelectionRange(25, 25);
    fireEvent.select(box);
    await settle();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe(`Before you merge:\n${quoteOf(hit())}\n\nthen tidy up.`);
    expect(hub.postLine).not.toHaveBeenCalled();
  });

  it("marks hits from another group, names that group in their quote, and says where a quote goes once widened", async () => {
    answer = { hits: [hit({ session: "s3", name: "globex-billing", group: "g-globex", groupName: "Globex", kind: "fact", answer: "Invoices use the v2 API key." })], keywordOnly: false, notice: null };
    const box = await composer();
    type(box, "/recall invoices");
    await settle();
    expect(screen.queryByText(/Quoting sends it to/)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Group" }), { target: { value: "" } });
    await settle();
    expect(screen.getByText("Quoting sends it to acme-web in Acme.")).toBeTruthy();
    expect(within(found()[0]!).getByText("Globex · another group")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value.split("\n")[0]).toBe(`> Fact from globex-billing (Claude Code) in Globex, today ${AT} (noted by Desk, may be wrong):`);
  });

  it("doesn't mark hits from the session's own group", async () => {
    const box = await composer();
    type(box, "/recall cookie");
    await settle();
    expect(screen.queryByText(/another group/)).toBeNull();
  });

  it("isn't offered on a machine's session, and says why when typed there", async () => {
    useDesk.setState({ sessions: { s1: lined({ machine: "devbox", group: { id: "g-acme", name: "Acme" } }) } });
    const box = await composer();
    expect(box.placeholder).toBe("Message acme-web");
    type(box, "/recall cookie");
    await settle();
    expect(screen.getByText(NO_MACHINE_RECALL)).toBeTruthy();
    expect(hub.searchMemory).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("shows the same hits inline, in the session's own group to begin with", async () => {
    const box = await composer();
    type(box, "/recall cookie");
    await settle();
    expect(hub.searchMemory).toHaveBeenCalledWith({ q: "cookie", group: "g-acme", kind: undefined, limit: 20 });
    expect(found()).toHaveLength(2);
    expect(screen.getByText(`Decision · acme-web (Claude Code) · Acme · today ${AT}`)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Group" }) as HTMLSelectElement).value).toBe("g-acme");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("names the session's own group even when the hub lists none", async () => {
    hub.memorySettings.mockResolvedValueOnce(null as never);
    const box = await composer();
    type(box, "/recall cookie");
    await settle();
    const group = screen.getByRole("combobox", { name: "Group" }) as HTMLSelectElement;
    expect(group.value).toBe("g-acme");
    expect(group.selectedOptions[0]!.text).toBe("Acme");
  });

  it("quotes the hit chosen into the message, never sending /recall", async () => {
    const box = await composer();
    type(box, "/recall cookie");
    await settle();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(hub.postLine).not.toHaveBeenCalled();
    expect(box.value).toBe(`${quoteOf(exchange)}\n\n`);
    expect(box.value).toBe(
      "> Conversation from acme-api (Codex), yesterday:\n> Asked: Why does logout leave the cookie?\n> Answered: It cleared the server session only.\n\n",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says when it finds by keywords only", async () => {
    answer = { hits: [hit()], keywordOnly: true, notice: null };
    const box = await composer();
    type(box, "/recall cookie");
    await settle();
    expect(screen.getByText(KEYWORDS_ONLY)).toBeTruthy();
  });

  it("marks a note Desk wrote as one that may be wrong, with no ids", () => {
    const q = quoteOf(hit(), NOW);
    expect(q).toBe(
      `> Decision from acme-web (Claude Code), today ${AT} (noted by Desk, may be wrong):\n> Keep the session token in a secure cookie, not browser storage.`,
    );
    expect(q).not.toMatch(/s1|g-acme/);
    expect(whenOf("2026-11-01T09:00:00", NOW)).toBe(clock("2026-11-01T09:00:00", NOW));
    expect(whenOf("2026-11-07T09:00:00", NOW)).toBe("yesterday");
  });
});

describe("⌘K's reach", () => {
  it("opens from any composer, never from other fields or a terminal", () => {
    const html = (h: string) => {
      const d = document.createElement("div");
      d.innerHTML = h;
      document.body.append(d);
      return d;
    };
    const line = html('<form data-line-composer=""><textarea></textarea></form>');
    const room = html('<form data-composer=""><textarea></textarea></form>');
    const other = html("<input />");
    const term = html('<div data-terminal=""><textarea></textarea></div>');
    expect(allowedFromComposers(line.querySelector("textarea"))).toBe(true);
    expect(allowedFromComposers(room.querySelector("textarea"))).toBe(true);
    expect(allowedFromComposers(other.querySelector("input"))).toBe(false);
    expect(allowedFromComposers(term.querySelector("textarea"))).toBe(false);
    expect(allowedFromComposers(document.body)).toBe(true);
  });
});
