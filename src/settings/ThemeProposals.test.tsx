import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { removeProposal, writeTheme } from "../platform";
import { NIGHT } from "../theme/builtin";
import { parsePropose, propose, type Proposal } from "../theme/proposal";
import { useProposals } from "../theme/proposals";
import { useThemeStore } from "../theme/store";
import { askText, changeText, ProposalCards, proposalsMade, ThemeProposals } from "./ThemeProposals";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  proposalFiles: vi.fn(() => Promise.resolve([])),
  writeProposal: vi.fn(() => Promise.resolve()),
  removeProposal: vi.fn(() => Promise.resolve()),
  writeTheme: vi.fn(() => Promise.resolve()),
}));

const made = (name: string, at = new Date().toISOString()): Proposal => {
  const { spec, changes, nudged } = propose(parsePropose({ name, dark: true, background: "#2A2A2A", signal: "#3355AA", text: "#8A8A8A" }), NIGHT, []);
  return { spec, changes, nudged, hub: "local", agent: "atlas", session: "s1", reason: "something murky", at };
};

const sendTo = vi.fn(async () => true);

beforeEach(() => {
  useThemeStore.setState({ choice: "night", custom: [], systemDark: true });
  useProposals.setState({ list: [made("Murk")], loaded: true });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://x", local: true, revision: "1" }],
    roster: [{ hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: true }],
    sendTo,
  });
  sendTo.mockClear();
  vi.mocked(writeTheme).mockClear();
});

afterEach(cleanup);

describe("an agent's theme proposal", () => {
  it("shows Desk in it, its terminal's colours, and what Desk moved", () => {
    render(<ThemeProposals />);
    const card = screen.getByRole("region", { name: "Theme proposal: Murk" });
    expect(card.textContent).toContain("Dark · from Atlas");
    expect(card.textContent).toContain("“something murky”");
    expect(screen.getByLabelText("Preview of Murk")).toBeTruthy();
    expect(screen.getByLabelText("Terminal colours").querySelectorAll(".term-swatch")).toHaveLength(16);
    expect(card.textContent).toMatch(/Desk moved \d+ colours so its text and terminal read/);
  });

  it("is kept as the person's theme, and put on", async () => {
    render(<ThemeProposals />);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(writeTheme).toHaveBeenCalledWith("murk", expect.stringContaining('name = "Murk"')));
    expect(removeProposal).toHaveBeenCalledWith("murk");
    expect(useThemeStore.getState().choice).toBe("murk");
    expect(useProposals.getState().list).toEqual([]);
  });

  it("is discarded, and nothing else changes", async () => {
    render(<ThemeProposals />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useProposals.getState().list).toEqual([]));
    expect(writeTheme).not.toHaveBeenCalled();
    expect(useThemeStore.getState().choice).toBe("night");
  });

  it("asks the agent that made it for changes", async () => {
    render(<ThemeProposals />);
    fireEvent.click(screen.getByRole("button", { name: "Ask for changes" }));
    fireEvent.change(screen.getByLabelText("What to change in Murk"), { target: { value: "warmer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Atlas" }));
    await waitFor(() => expect(sendTo).toHaveBeenCalledWith("local/atlas", changeText(useProposals.getState().list[0]!, "warmer")));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});

it("asks the chosen agent to make one", async () => {
  useProposals.setState({ list: [] });
  render(<ThemeProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Ask an agent to make one…" }));
  fireEvent.change(screen.getByLabelText("What should it look like?"), { target: { value: "sea greens" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask Atlas" }));
  await waitFor(() => expect(sendTo).toHaveBeenCalledWith("local/atlas", askText("sea greens"), undefined));
  expect((await screen.findByRole("status")).textContent).toContain("Asked Atlas");
});

it("a chat's card is the proposal its agent made in that turn", () => {
  const at = new Date().toISOString();
  render(<ProposalCards hub="local" agent="atlas" since={new Date(Date.now() - 60_000).toISOString()} until={at} />);
  expect(screen.getByRole("region", { name: "Theme proposal: Murk" })).toBeTruthy();
  cleanup();
  render(<ProposalCards hub="local" agent="allan" />);
  expect(screen.queryByRole("region")).toBeNull();
  expect(proposalsMade([{ name: "theme.propose: Moss" }, { name: "theme.current" }, { tool: "theme.revise" }])).toBe(2);
});
