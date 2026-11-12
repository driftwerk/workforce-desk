import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketBody, unescapeNewlines } from "./TicketBody";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const ESCAPED = "**Overview:**\\nDocument the core purpose.\\n\\n**Business Reason:**\\nWhy.\\n\\n* [ ] `README.md` contains it.\\n* [x] Reviewed.";

describe("a ticket's description", () => {
  it("an escaped Linear body round-trips to real newlines", () => {
    expect(unescapeNewlines(ESCAPED)).toBe("**Overview:**\nDocument the core purpose.\n\n**Business Reason:**\nWhy.\n\n* [ ] `README.md` contains it.\n* [x] Reviewed.");
    expect(unescapeNewlines("a\nb \\n c")).toBe("a\nb \\n c");
  });

  it("renders headings, lists, checklists and code, with no literal backslash-n", () => {
    const { container } = render(<TicketBody text={`## Why\n\nBecause.\n\n* one\n* two\n\n- [ ] open\n- [x] shut\n\nUse \`code\` and **bold**.\n\n\`\`\`\nlet x = 1;\n\`\`\``} onEdit={() => {}} />);
    expect(container.querySelector("h2")?.textContent).toBe("Why");
    expect(container.querySelectorAll("li").length).toBe(4);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelector("pre")).not.toBeNull();
    const boxes = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[false, true], [true, true]]);
  });

  it("shows an escaped body as paragraphs and a checklist", () => {
    const { container } = render(<TicketBody text={ESCAPED} onEdit={() => {}} />);
    expect(container.textContent).not.toContain("\\n");
    expect(container.textContent).not.toContain("**");
    expect(container.querySelectorAll("input[type=checkbox]").length).toBe(2);
  });

  it("draws no raw HTML: a script and a handler are gone", () => {
    const { container } = render(<TicketBody text={'Hi <script>alert(1)</script><img src=x onerror="alert(2)"> <b onclick="x()">bold</b>'} onEdit={() => {}} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick/);
  });

  it("a remote image is a placeholder, never an img the page fetches", () => {
    const { container } = render(<TicketBody text="![chart](https://images.example/c.png)" onEdit={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("clicking text edits; clicking a link does not", () => {
    const onEdit = vi.fn();
    render(<TicketBody text={"Plain words and [a link](https://example.com/x)"} onEdit={onEdit} />);
    fireEvent.click(screen.getByText(/Plain words/));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("link", { name: "a link" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    expect(onEdit).toHaveBeenCalledTimes(2);
  });
});
