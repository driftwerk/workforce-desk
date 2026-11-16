import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { Directives } from "../hub/types";
import { OverseerBody, overseerShown } from "../rooms/Overseer";
import { BossDirectives, DirectivesCard, KEPT_MS } from "./Directives";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emitTo: vi.fn(() => Promise.resolve()),
}));

const q = (key: string, question: string, answer: string | null = null, inherited = false) => ({
  key,
  topic: key,
  question,
  answers: [
    { key: "yes", label: "Yes" },
    { key: "checks", label: "After checks pass" },
    { key: "no", label: "No, leave it to me" },
  ],
  answer,
  inherited,
  preferenceId: answer ? `p-${key}` : null,
  applied: answer ? 4 : 0,
});

let view: Directives;
let asked: { method: string; path: string; body?: unknown }[];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const transport: DeskTransport = {
  fetch: async (method, path, body) => {
    const parsed = body ? (JSON.parse(String(body.data)) as Record<string, unknown>) : undefined;
    asked.push({ method, path, body: parsed });
    if (path.endsWith("/answer")) {
      view = {
        ...view,
        questions: view.questions.map((x) =>
          x.key === parsed!.key
            ? {
                ...x,
                answer: (parsed!.answer as string) ?? null,
                inherited: false,
              }
            : x,
        ),
      };
    } else if (path.endsWith("/own")) {
      view = {
        ...view,
        own: [...view.own, { id: "o2", text: String(parsed!.text), inherited: false }],
      };
    } else if (path.endsWith("/asking")) {
      view = {
        ...view,
        stopAsking: (parsed!.stop as boolean) ?? view.stopAsking,
        skipped: (parsed!.skipped as boolean) ?? view.skipped,
      };
    }
    return json(view);
  },
  socket: () => ({}) as DeskSocket,
};

beforeEach(() => {
  asked = [];
  view = {
    bossScope: "g-acme",
    questions: [q("merge", "Can I merge pull requests?", "checks", true), q("production", "Can I deploy to production?")],
    own: [{ id: "o1", text: "Never touch billing", inherited: false }],
    stopAsking: false,
    skipped: false,
  };
  useDesk.setState({ hub: new DeskHub(transport) });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
  vi.useRealTimers();
});

const reads = () => asked.filter((a) => a.method === "GET").length;
const rowOf = (group: HTMLElement) => group.closest("li")!;

describe("the directives card", () => {
  it("shows in the boss's DM from its extras, read live", async () => {
    expect(overseerShown({ directives: { bossScope: "g-acme" } })).toBe(true);
    render(<OverseerBody extras={{ directives: { bossScope: "g-acme" } }} content="Before I run on my own…" />);
    await screen.findByText("Before I run on my own");
    expect(asked[0]).toEqual({
      method: "GET",
      path: "/api/desk/directives?boss=g-acme",
      body: undefined,
    });
    // The main boss's answer is already chosen, and says so.
    const merge = screen.getByRole("radiogroup", {
      name: "Can I merge pull requests?",
    });
    expect(within(merge).getByRole("radio", { name: "After checks pass" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("From Desk’s main boss")).toBeTruthy();
  });

  it("keeps an answer with one tap, and says Kept. a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DirectivesCard boss="g-acme" />);
    const prod = await screen.findByRole("radiogroup", {
      name: "Can I deploy to production?",
    });
    fireEvent.click(within(prod).getByRole("radio", { name: "No, leave it to me" }));
    // Chosen at once, before the hub says so.
    expect(within(prod).getByRole("radio", { name: "No, leave it to me" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(within(rowOf(prod)).getByRole("status").textContent).toBe("Kept."));
    expect(asked.at(-1)).toEqual({
      method: "POST",
      path: "/api/desk/directives/answer",
      body: { boss: "g-acme", key: "production", answer: "no" },
    });
    expect(within(prod).getByRole("radio", { name: "No, leave it to me" }).getAttribute("aria-checked")).toBe("true");
    act(() => void vi.advanceTimersByTime(KEPT_MS));
    expect(within(rowOf(prod)).getByRole("status").textContent).toBe("");
  });

  it("is a radio group: arrows move and choose, and the chip keeps focus while it saves", async () => {
    render(<DirectivesCard boss="g-acme" />);
    const prod = await screen.findByRole("radiogroup", {
      name: "Can I deploy to production?",
    });
    const [yes, checks, no] = within(prod).getAllByRole("radio");
    // Nothing chosen: the first is the tab stop.
    expect(yes!.tabIndex).toBe(0);
    expect(checks!.tabIndex).toBe(-1);
    yes!.focus();
    fireEvent.keyDown(yes!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(checks);
    expect(checks!.getAttribute("aria-checked")).toBe("true");
    // Another before the first is saved: only the latest is sent after it.
    fireEvent.keyDown(checks!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(no);
    await waitFor(() => expect(within(rowOf(prod)).getByRole("status").textContent).toBe("Kept."));
    const answers = asked.filter((a) => a.path.endsWith("/answer")).map((a) => (a.body as { answer: string }).answer);
    expect(answers).toEqual(["checks", "no"]);
    expect(no!.getAttribute("aria-checked")).toBe("true");
    expect(no!.tabIndex).toBe(0);
    expect(document.activeElement).toBe(no);
    expect(no!.hasAttribute("disabled")).toBe(false);
    // Arrows wrap; Home and End go to the ends.
    fireEvent.keyDown(no!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(yes);
    fireEvent.keyDown(yes!, { key: "End" });
    expect(document.activeElement).toBe(no);
    await waitFor(() => expect(asked.at(-1)?.body).toEqual({ boss: "g-acme", key: "production", answer: "no" }));
  });

  it("reads a boss's directives once for all that show them, and once more on focus", async () => {
    render(
      <>
        <DirectivesCard boss="g-acme" message={{ id: "m1", at: "2026-11-16T09:00:00Z" }} />
        <DirectivesCard boss="g-acme" message={{ id: "m2", at: "2026-11-16T10:00:00Z" }} />
        <OverseerBody extras={{ update: { headline: "Quiet.", brief: [] }, directivesOpen: { bossScope: "g-acme", open: 1 } }} content="" />
      </>,
    );
    await screen.findByText("Before I run on my own");
    expect(reads()).toBe(1);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(reads()).toBe(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(reads()).toBe(2);
  });

  it("asks in the newest card only: an older one folds", async () => {
    render(
      <>
        <OverseerBody extras={{ directives: { bossScope: "g-acme" } }} content="" message={{ id: "m1", at: "2026-11-16T09:00:00Z" }} />
        <OverseerBody extras={{ directives: { bossScope: "g-acme" } }} content="" message={{ id: "m2", at: "2026-11-16T10:00:00Z" }} />
      </>,
    );
    await screen.findByText("Asked again further down.");
    expect(screen.getAllByText("Before I run on my own")).toHaveLength(1);
    expect(screen.getAllByRole("radiogroup", { name: "Can I deploy to production?" })).toHaveLength(1);
  });

  it("adds one of your own, skips, and stops asking", async () => {
    render(<DirectivesCard boss="g-acme" />);
    const field = await screen.findByLabelText("Add a directive of your own");
    fireEvent.change(field, { target: { value: "Keep PRs small" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(asked.at(-1)?.path).toBe("/api/desk/directives/own"));
    fireEvent.click(screen.getByRole("button", { name: "Stop asking" }));
    await waitFor(() => expect(asked.at(-1)?.body).toEqual({ boss: "g-acme", stop: true }));
    await screen.findByText(/I won’t ask again/);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByText(/Skipped\. I’ll ask again another day/);
    fireEvent.click(screen.getByRole("button", { name: "Answer now" }));
    await screen.findByRole("radiogroup", {
      name: "Can I merge pull requests?",
    });
  });

  it("is one faint line in a quiet update, its Answer unfolding the card", async () => {
    render(
      <OverseerBody
        extras={{
          update: { headline: "Two PRs merged.", brief: [] },
          directivesOpen: {
            bossScope: "g-acme",
            open: 1,
            topics: ["production"],
          },
        }}
        content=""
      />,
    );
    // What the update said, until they're read.
    expect(screen.getByText(/1 directive still open: production\./)).toBeTruthy();
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await screen.findByRole("radiogroup", {
      name: "Can I deploy to production?",
    });
  });

  it("says what is open now, and nothing once all are answered", async () => {
    view = { ...view, questions: [...view.questions, q("spend", "Can I spend money?")] };
    const { container } = render(
      <OverseerBody extras={{ update: { headline: "Quiet.", brief: [] }, directivesOpen: { bossScope: "g-acme", open: 3, topics: ["a", "b", "c"] } }} content="" />,
    );
    await screen.findByText(/2 directives still open: production, spend\./);
    view = { ...view, questions: view.questions.map((x) => ({ ...x, answer: x.answer ?? "no" })) };
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(container.querySelector(".dir-open")).toBeNull());
    expect(container.textContent).not.toMatch(/directive/);
  });

  it("unfolded under the line, shows those open, with Show all", async () => {
    view = { ...view, questions: [...view.questions, q("spend", "Can I spend money?")] };
    render(<OverseerBody extras={{ update: { headline: "Quiet.", brief: [] }, directivesOpen: { bossScope: "g-acme", open: 2 } }} content="" />);
    await screen.findByText(/2 directives still open/);
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const prod = await screen.findByRole("radiogroup", { name: "Can I deploy to production?" });
    expect(screen.queryByRole("radiogroup", { name: "Can I merge pull requests?" })).toBeNull();
    // One answered here stays, so the keyboard keeps its place.
    fireEvent.click(within(prod).getByRole("radio", { name: "Yes" }));
    await waitFor(() => expect(within(rowOf(prod)).getByRole("status").textContent).toBe("Kept."));
    expect(screen.getByRole("radiogroup", { name: "Can I deploy to production?" })).toBe(prod);
    expect(screen.getByText(/1 directive still open: spend\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 3" }));
    expect(screen.getByRole("radiogroup", { name: "Can I merge pull requests?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all 3" })).toBeNull();
  });
});

describe("the Boss sheet's directives", () => {
  it("lists each with how it's used, clears one, forgets your own, and says whether it asks", async () => {
    view = {
      ...view,
      questions: [q("merge", "Can I merge pull requests?", "checks"), q("production", "Can I deploy to production?")],
    };
    render(<BossDirectives boss="g-acme" name="Astra" />);
    await screen.findByText("Directives");
    expect(screen.getByText(/Used 4 times/)).toBeTruthy();
    expect(screen.getByText(/Unanswered ones it decides itself/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear: Can I merge pull requests?" }));
    await waitFor(() =>
      expect(asked.at(-1)?.body).toEqual({
        boss: "g-acme",
        key: "merge",
        answer: null,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Forget: Never touch billing" }));
    await waitFor(() => expect(asked.some((a) => a.path === "/api/desk/preferences/o1/retire")).toBe(true));
    const ask = screen.getByRole("radiogroup", {
      name: "Ask me about unanswered ones",
    });
    expect(within(ask).getByRole("radio", { name: "Once a day" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(ask).getByRole("radio", { name: "Stop asking" }));
    await waitFor(() => expect(asked.at(-1)?.body).toEqual({ boss: "g-acme", stop: true }));
    // And by keyboard: an arrow moves and chooses, keeping focus.
    const stop = within(ask).getByRole("radio", { name: "Stop asking" });
    await waitFor(() => expect(stop.getAttribute("aria-checked")).toBe("true"));
    expect(stop.tabIndex).toBe(0);
    stop.focus();
    fireEvent.keyDown(stop, { key: "ArrowLeft" });
    const daily = within(ask).getByRole("radio", { name: "Once a day" });
    expect(document.activeElement).toBe(daily);
    expect(daily.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(asked.at(-1)?.body).toEqual({ boss: "g-acme", stop: false }));
    await waitFor(() => expect(daily.getAttribute("aria-checked")).toBe("true"));
    expect(document.activeElement).toBe(daily);
  });

  it("shows nothing on a hub without them", async () => {
    useDesk.setState({
      hub: {
        ...new DeskHub(transport),
        directives: undefined,
      } as unknown as DeskHub,
    });
    const { container } = render(<BossDirectives boss="main" name="Desk" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });
});
