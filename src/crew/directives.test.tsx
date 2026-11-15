import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { Directives } from "../hub/types";
import { OverseerBody, overseerShown } from "../rooms/Overseer";
import { BossDirectives, DirectivesCard } from "./Directives";

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
});

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

  it("keeps an answer with one tap", async () => {
    render(<DirectivesCard boss="g-acme" />);
    const prod = await screen.findByRole("radiogroup", {
      name: "Can I deploy to production?",
    });
    fireEvent.click(within(prod).getByRole("radio", { name: "No, leave it to me" }));
    await waitFor(() => expect(within(prod).getByRole("radio", { name: "No, leave it to me" }).getAttribute("aria-checked")).toBe("true"));
    expect(asked.at(-1)).toEqual({
      method: "POST",
      path: "/api/desk/directives/answer",
      body: { boss: "g-acme", key: "production", answer: "no" },
    });
    expect(screen.getByRole("status").textContent).toBe("Kept.");
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
    expect(screen.getByText(/1 directive still open: production\./)).toBeTruthy();
    expect(asked).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await screen.findByRole("radiogroup", {
      name: "Can I deploy to production?",
    });
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
