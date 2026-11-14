import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket, TicketFile } from "../hub/types";
import { ticket, YOU } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const hub = vi.hoisted(() => ({ fileBlob: vi.fn() }));
vi.mock("./ticketView", async (real) => ({ ...(await real<typeof import("./ticketView")>()), localTicketView: () => hub }));
const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../platform", async (real) => ({ ...(await real<typeof import("../platform")>()), openUrl: (u: string) => void opened.urls.push(u) }));

import { useBoard } from "./store";
import { TicketBody } from "./TicketBody";
import { forgetFetchedFiles } from "./TicketFiles";
import { dateWords, toneOf } from "./ticketDirectives";
import { deskFileId } from "./ticketFileImage";
import { descriptionLink, issueAddress, TICKET_RICH_HOST } from "./ticketKeyedRich";
import { firstParagraph, foldSections, unfenced } from "./ticketRich";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_ID = "6b1f0c2e-3d4a-4b5c-9d8e-0123456789ab";

const file = (over: Partial<TicketFile> = {}): TicketFile => ({
  id: FILE_ID,
  source: "jira",
  name: "boot.png",
  mediaType: "image/png",
  size: 1024,
  url: null,
  thumb: false,
  addedBy: YOU,
  addedAt: "2026-11-10T09:00:00Z",
  ...over,
});

const EPIC_ID = "0f3c2a9e-1b2c-4d5e-8f90-123456789abc";
const epic = (): Ticket =>
  ticket(2, {
    id: EPIC_ID,
    key: "ACME-875",
    title: "Unified login",
    external: { system: "jira", key: "ACME-875", url: "https://acme.example/browse/ACME-875", remoteUpdatedAt: "2026-11-10T09:00:00Z", synced: true, link: "l1", details: { kind: "Epic", kindLevel: 1, remoteState: "Done" } } as never,
  });

const own = (files: TicketFile[] = [file()]): Ticket => ticket(1, { key: "ACME-1", files });

beforeEach(() => {
  hub.fileBlob.mockReset();
  hub.fileBlob.mockImplementation(async () => new Blob([PNG], { type: "image/png" }));
  forgetFetchedFiles();
  opened.urls.length = 0;
  const t = own();
  useBoard.setState({ tickets: { [t.id]: t, [EPIC_ID]: epic() }, open: null });
});

afterEach(() => {
  cleanup();
  useBoard.setState({ tickets: {}, open: null });
});

const body = (text: string, onEdit = vi.fn()) => {
  const t = own();
  return { onEdit, ...render(<TicketBody text={text} board={t.board} ticket={t.id} onEdit={onEdit} />) };
};

describe("a synced description's directives", () => {
  it("draws a mention as @Name", () => {
    const { container } = body("Repro from :mention[Richard Lucas].");
    expect(container.querySelector(".ticket-mention")?.textContent).toBe("@Richard Lucas");
  });

  it("draws a status as a lozenge in its tone, an unknown tone neutral", () => {
    const { container } = body(":status[In progress]{tone=info} :status[Done]{tone=success} :status[Odd]{tone=chartreuse}");
    const lozenges = [...container.querySelectorAll(".ticket-lozenge")];
    expect(lozenges.map((l) => [l.textContent, l.className])).toEqual([
      ["In progress", "ticket-lozenge tone-info"],
      ["Done", "ticket-lozenge tone-success"],
      ["Odd", "ticket-lozenge tone-neutral"],
    ]);
    expect(toneOf("danger")).toBe("danger");
    expect(toneOf(undefined)).toBe("neutral");
  });

  it("draws a date as a chip in words, the day as written whatever the zone", () => {
    const { container } = body("Due :date[2026-11-28].");
    const chip = container.querySelector(".ticket-date");
    expect(chip?.textContent).toBe("Nov 28, 2026");
    expect(chip?.querySelector("svg")).not.toBeNull();
    expect(dateWords("2026-01-01")).toBe("Jan 1, 2026");
    expect(dateWords("soon")).toBe("soon");
  });

  it("draws each panel as a rule in its tone with an icon, its words inside", () => {
    const text = ["info", "warning", "purple", "success", "danger"].map((t) => `:::panel{tone=${t}}\n**${t}.** Words.\n:::`).join("\n\n");
    const { container } = body(text);
    const panels = [...container.querySelectorAll(".ticket-panel-note")];
    expect(panels.map((p) => p.className)).toEqual(["info", "warning", "purple", "success", "danger"].map((t) => `ticket-panel-note tone-${t}`));
    expect(panels.every((p) => p.querySelector("svg.ticket-panel-icon"))).toBe(true);
    expect(panels[0]!.querySelector(".ticket-panel-body strong")?.textContent).toBe("info.");
    expect(screen.getByRole("note", { name: "Note" })).toBe(panels[2]);
  });

  it("keeps a collapsible closed until its title is clicked, which doesn't start editing", () => {
    const { container, onEdit } = body("::::details[Rollout notes]\n:::panel{tone=info}\nInside.\n:::\n::::\n\nAfter.");
    const details = container.querySelector<HTMLDetailsElement>("details.ticket-expand")!;
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary")!;
    expect(summary.textContent).toBe("▸ Rollout notes");
    expect(details.querySelector(".ticket-expand-body .ticket-panel-note")?.textContent).toBe("Inside.");
    fireEvent.click(summary);
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("After."));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("reads prose with colons, unknown directives and escapes as written", () => {
    const { container } = body("At 12:30, Note:this, :::nope stays, and \\{x\\} \\:mention[y].");
    expect(container.querySelector(".ticket-md p")?.textContent).toBe("At 12:30, Note:this, :::nope stays, and {x} :mention[y].");
    expect(container.querySelector(".ticket-mention")).toBeNull();
  });
});

describe("every name the hub writes is drawn, whatever its form", () => {
  it("never shows a hub directive's syntax", () => {
    const { container } = body(":mention[] and :panel[a note] and :details[more]\n\n::status[Done]{tone=success}\n\n:::date\nInside.\n:::");
    expect(container.textContent).not.toMatch(/:(mention|panel|details|status|date)/);
    expect(container.querySelector(".ticket-mention")?.textContent).toBe("@someone");
    expect(container.querySelector(".ticket-lozenge")?.textContent).toBe("Done");
    expect(container.textContent).toContain("a note");
    expect(container.textContent).toContain("Inside.");
  });

  it("leaves addresses after a colon linked as before", () => {
    const { container } = body("Write to mailto:a@b.c or user:name@example.com at 10:30.");
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["mailto:a@b.c", "mailto:name@example.com"]);
    expect(container.textContent).toBe("Write to mailto:a@b.c or user:name@example.com at 10:30.Edit description");
  });
});

describe("a synced description's links", () => {
  it("draws an issue link to a ticket here as its chip: the key alone, or the link's words as its title", () => {
    const { container } = body("After [ACME-875](https://acme.example/browse/ACME-875) and [Patchwork login](https://ACME.example/browse/ACME-875/).");
    const chips = [...container.querySelectorAll(".ticket-issue-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector(".ticket-issue-chip-text")).toBeNull();
    expect(chips[1]!.querySelector(".ticket-issue-chip-text")?.textContent).toBe("Patchwork login");
    expect(chips[1]!.querySelector(".ticket-issue-chip-state")?.textContent).toBe("Done");
    fireEvent.click(chips[0]!);
    expect(useBoard.getState().open).toBe(EPIC_ID);
  });

  it("leaves a link to an issue on another site, or not here, a link", () => {
    const { container } = body("[ACME-875](https://other.example/browse/ACME-875) [ACME-9](https://acme.example/browse/ACME-9)");
    expect(container.querySelector(".ticket-issue-chip")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
  });

  it("names an issue by its site and key: Jira's browse address, Linear's with or without its slug", () => {
    expect(issueAddress("https://acme.atlassian.net/browse/PLT-875")).toBe("acme.atlassian.net|PLT-875");
    expect(issueAddress("https://linear.app/acme/issue/MAN-611/rate-limit-pairing")).toBe("linear.app|MAN-611");
    expect(issueAddress("https://linear.app/acme/issue/MAN-611")).toBe("linear.app|MAN-611");
    expect(issueAddress("http://acme.atlassian.net/browse/PLT-875")).toBeNull();
    expect(issueAddress("https://acme.atlassian.net/browse/PLT-875x")).toBeNull();
    const id = "0f3c2a9e-1b2c-4d5e-8f90-123456789abd";
    const linear = ticket(3, { id, key: "MAN-611", title: "Rate-limit pairing", external: { system: "linear", key: "MAN-611", url: "https://linear.app/acme/issue/MAN-611/rate-limit-pairing", remoteUpdatedAt: "2026-11-10T09:00:00Z", synced: true, link: "l2", details: { stateKind: "started", remoteState: "In Review" } } as never });
    useBoard.setState({ tickets: { ...useBoard.getState().tickets, [id]: linear } });
    const { container } = body("Same week as [rate-limit pairing](https://linear.app/acme/issue/MAN-611).");
    expect(container.querySelector(".ticket-issue-chip .ticket-issue-chip-text")?.textContent).toBe("rate-limit pairing");
  });

  it("draws a bare address as a link chip that opens it, and a worded link as a link", async () => {
    const { container, onEdit } = body("See <https://wiki.example/pages/42/> and [the doc](https://wiki.example/doc).");
    const chip = container.querySelector<HTMLAnchorElement>("a.ticket-smart-link")!;
    expect(chip.textContent).toBe("wiki.example/pages/42");
    expect(container.querySelectorAll("a.ticket-smart-link")).toHaveLength(1);
    fireEvent.click(chip);
    await waitFor(() => expect(opened.urls).toEqual(["https://wiki.example/pages/42/"]));
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("a bare address outside a description", () => {
  it("stays a link: only a description draws it as a chip", () => {
    expect(TICKET_RICH_HOST.link("https://wiki.example/x", "https://wiki.example/x")).toBeUndefined();
    expect(descriptionLink("https://wiki.example/x", "https://wiki.example/x")).toBeTruthy();
  });
});

describe("a picture of the ticket's own", () => {
  it("is drawn from its file's bytes, fetched through Desk", async () => {
    const { container } = body(`Boot log:\n\n![boot.png](desk-file:${FILE_ID})`);
    await waitFor(() => expect(container.querySelector(".ticket-md-picture img")?.getAttribute("src")).toMatch(/^blob:/));
    expect(hub.fileBlob).toHaveBeenCalledWith(own().id, FILE_ID, false);
    expect(container.querySelector(".ticket-md-picture img")?.getAttribute("alt")).toBe("boot.png");
  });

  it("opens in the file viewer, not the editor", async () => {
    const { container, onEdit } = body(`![boot.png](desk-file:${FILE_ID})`);
    fireEvent.click(container.querySelector(".ticket-md-picture")!);
    expect(await screen.findByRole("dialog", { name: "boot.png" })).not.toBeNull();
    fireEvent.click(screen.getByRole("dialog", { name: "boot.png" }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("is a file chip when the file isn't a picture, and its name when it isn't among its files", () => {
    const t = own([file({ name: "spec.pdf", mediaType: "application/pdf" })]);
    useBoard.setState({ tickets: { [t.id]: t } });
    const { container } = render(<TicketBody text={`![spec.pdf](desk-file:${FILE_ID}) ![gone.png](desk-file:00000000-0000-0000-0000-000000000000)`} ticket={t.id} onEdit={() => {}} />);
    expect(container.querySelector(".ticket-md-file")?.textContent).toBe("spec.pdf");
    expect(container.querySelector(".ticket-md-file-missing")?.textContent).toBe("gone.png");
    expect(container.querySelector("img")).toBeNull();
    expect(hub.fileBlob).not.toHaveBeenCalled();
  });

  it("is the link's content, not a button, inside a link", async () => {
    const { container } = body(`[![boot.png](desk-file:${FILE_ID})](https://example.com/x)`);
    await waitFor(() => expect(container.querySelector("a img.ticket-md-picture-plain")?.getAttribute("src")).toMatch(/^blob:/));
    expect(container.querySelector("a button")).toBeNull();
  });

  it("names only a file id", () => {
    expect(deskFileId(`desk-file:${FILE_ID.toUpperCase()}`)).toBe(FILE_ID);
    expect(deskFileId("desk-file:../x")).toBeNull();
  });
});

describe("folding a description with panels and collapsibles", () => {
  it("never cuts inside a panel or a collapsible", () => {
    const text = "Intro.\n\n## One\n\nA.\n\n::::details[More]\n## Inside\n\n:::panel{tone=info}\n## Deeper\n:::\n::::\n\n## Two\n\nB.\n\n## Three\n\nC.";
    const { shown, more } = foldSections(text);
    expect(more).toBe(2);
    expect(shown.endsWith("::::")).toBe(true);
  });

  it("reads a panel's words as the first paragraph, never a collapsible's", () => {
    expect(firstParagraph(":::panel{tone=info}\nSummaries go out weekly.\n:::\n\nMore.")).toBe("Summaries go out weekly.");
    expect(firstParagraph(":::details[Notes]\nHidden.\n:::\n\nShown.")).toBe("Shown.");
    expect(unfenced("```\n:::panel\n```")).toBe("```\n:::panel\n```");
  });
});
