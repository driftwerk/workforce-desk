import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposalFiles, removeProposal, writeProposal, writeTheme } from "../platform";
import { allChecks } from "./proposal";
import { answerJob, proposalsFrom, useProposals, type ThemeJob } from "./proposals";
import { useThemeStore } from "./store";
import { derive } from "./tokens";

const files = new Map<string, string>();
const themes = new Map<string, string>();

vi.mock("../platform", () => ({
  proposalFiles: vi.fn(async () => [...files].map(([id, source]) => ({ id, source }))),
  writeProposal: vi.fn(async (id: string, source: string) => void files.set(id, source)),
  removeProposal: vi.fn(async (id: string) => void files.delete(id)),
  writeTheme: vi.fn(async (id: string, source: string) => void themes.set(id, source)),
}));

const job = (kind: ThemeJob["kind"], input: unknown): ThemeJob => ({ id: "j1", kind, agent: "atlas", session: "s1", input, at: new Date().toISOString() });

beforeEach(() => {
  files.clear();
  themes.clear();
  vi.mocked(writeTheme).mockClear();
  vi.mocked(writeProposal).mockClear();
  useProposals.setState({ list: [], loaded: false });
  useThemeStore.setState({ choice: "night", custom: [], systemDark: true });
});

describe("an agent's theme calls", () => {
  it("propose saves a proposal only: no theme is written, none is applied", async () => {
    const a = await answerJob("local", job("propose", { name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A", reason: "mossy" }));
    expect(a.ok).toBe(true);
    expect(a.body).toMatchObject({ id: "moss", name: "Moss", dark: true, moved: "nothing: every pair reads" });
    expect([...files.keys()]).toEqual(["moss"]);
    expect(writeTheme).not.toHaveBeenCalled();
    expect(useThemeStore.getState().choice).toBe("night");
    const [p] = useProposals.getState().list;
    expect(p).toMatchObject({ hub: "local", agent: "atlas", session: "s1", reason: "mossy" });
  });

  it("says what Desk moved", async () => {
    const a = await answerJob("local", job("propose", { name: "Murk", dark: true, background: "#2A2A2A", signal: "#3355AA", text: "#8A8A8A" }));
    expect(Array.isArray((a.body as { moved: unknown }).moved)).toBe(true);
    const [p] = useProposals.getState().list;
    expect(allChecks(derive(p!.spec)).filter((c) => !c.pass)).toEqual([]);
  });

  it("refuses what isn't a theme, and saves nothing", async () => {
    const a = await answerJob("local", job("propose", { name: "Moss", dark: true, background: "green", signal: "#9BE38A" }));
    expect(a).toEqual({ ok: false, body: { error: expect.stringMatching(/background/) } });
    expect(files.size).toBe(0);
  });

  it("never takes a built-in's id, nor another's", async () => {
    await answerJob("local", job("propose", { name: "Night", dark: true, background: "#13201A", signal: "#9BE38A" }));
    await answerJob("local", job("propose", { name: "Night", dark: true, background: "#13201A", signal: "#9BE38A" }));
    expect([...files.keys()].sort()).toEqual(["night-2", "night-3"]);
  });

  it("revise changes a proposal in place", async () => {
    await answerJob("local", job("propose", { name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A" }));
    const a = await answerJob("local", job("revise", { theme: "moss", signal: "#FFB070" }));
    expect(a.ok).toBe(true);
    expect([...files.keys()]).toEqual(["moss"]);
    expect(useProposals.getState().list[0]!.spec.signal).toBe("#FFB070");
  });

  it("revise of the person's own theme is a proposal beside it, kept only by them", async () => {
    const fern = { ...derive(useThemeStore.getState().custom[0] ?? (await import("./builtin")).NIGHT).spec, id: "fern", name: "Fern", overrides: {} };
    useThemeStore.setState({ custom: [fern], choice: "fern" });
    const a = await answerJob("local", job("revise", { theme: "fern", background: "#102018" }));
    expect(a.body).toMatchObject({ revises: "fern" });
    expect(writeTheme).not.toHaveBeenCalled();
    const [p] = useProposals.getState().list;
    expect(p!.revises).toBe("fern");
    await useProposals.getState().keep(p!);
    expect(writeTheme).toHaveBeenCalledWith("fern", expect.stringContaining("#102018"));
    expect(removeProposal).toHaveBeenCalledWith(p!.spec.id);
    expect(useThemeStore.getState().choice).toBe("fern");
  });

  it("revise refuses Desk's own themes", async () => {
    const a = await answerJob("local", job("revise", { theme: "harbour", signal: "#FFB070" }));
    expect(a.ok).toBe(false);
    expect((a.body as { error: string }).error).toMatch(/Desk's own/);
    expect(files.size).toBe(0);
  });

  it("current says every colour of the theme on, and what the person has", async () => {
    await answerJob("local", job("propose", { name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A" }));
    const a = await answerJob("local", job("current", {}));
    const body = a.body as { id: string; builtin: boolean; colors: Record<string, string>; themes: { id: string }[]; proposals: { id: string }[] };
    expect(body.id).toBe("night");
    expect(body.builtin).toBe(true);
    expect(body.colors.ansiBrightCyan).toMatch(/^#/);
    expect(body.colors.termCursor).toMatch(/^#/);
    expect(body.themes.map((t) => t.id)).toContain("harbour");
    expect(body.proposals).toEqual([{ id: "moss", name: "Moss" }]);
    expect(proposalFiles).toHaveBeenCalled();
  });
});

it("a chat shows the proposals its agent made in its turn", async () => {
  await answerJob("local", job("propose", { name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A" }));
  const list = useProposals.getState().list;
  const now = Date.now();
  expect(proposalsFrom(list, "local", "atlas", new Date(now - 60_000).toISOString(), new Date(now + 60_000).toISOString())).toHaveLength(1);
  expect(proposalsFrom(list, "local", "allan")).toHaveLength(0);
  expect(proposalsFrom(list, "other", "atlas")).toHaveLength(0);
  expect(proposalsFrom(list, "local", "atlas", new Date(now + 60_000).toISOString())).toHaveLength(0);
});
