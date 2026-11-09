import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { MemoryHit, MemorySearch } from "../hub/types";
import { Composer } from "../line/Composer";
import { lined } from "../line/testing";
import { KEYWORDS_ONLY, DEBOUNCE_MS, quoteOf, recallQuery, whenOf } from "./search";
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
