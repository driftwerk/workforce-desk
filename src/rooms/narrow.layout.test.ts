// A conversation in a narrow grid pane, and a dialog on a short window. jsdom
// lays nothing out and has no container queries, so this reads the rules
// that do it (the screens are checked by eye, in Night and Day).
import { describe, expect, it } from "vitest";
import css from "../styles/app.css?raw";

const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

/** The body of the `@container chat (max-width: N)` block. */
const narrowerThan = (px: number): string => {
  const head = `@container chat (max-width: ${px}px) {`;
  const start = flat.indexOf(head);
  expect(start, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + head.length - 1; i < flat.length; i++) {
    if (flat[i] === "{") depth++;
    if (flat[i] === "}" && --depth === 0) return flat.slice(start + head.length, i);
  }
  throw new Error(`${head} isn't closed`);
};

const rule = (body: string, selector: string): string => {
  const at = body.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("}", at));
};

describe("a conversation in a narrow pane", () => {
  it("is laid out for its own width, wherever it shows", () => {
    expect(rule(flat, ".room, .thread-body")).toContain("container: chat / inline-size");
  });

  it("keeps the composer at the bottom: only the messages scroll", () => {
    expect(rule(flat, ".room:has(> .room-scroll), .room:has(> .timeline)")).toContain("overflow: clip");
    expect(rule(flat, ".room-scroll")).toMatch(/flex: 1 1 0px; min-height: 0;/);
    expect(rule(flat, ".room > .composer, .room > .dm-voice-bar, .thread-body > .composer")).toContain("flex: none");
  });

  it("never scrolls sideways: a long link breaks, code scrolls in its own box", () => {
    expect(rule(flat, ".msg-text")).toContain("overflow-wrap: anywhere");
    expect(rule(flat, ".msg-text.rich pre")).toContain("overflow-x: auto");
  });

  it("gives what's typed the whole width, the buttons a line below", () => {
    const narrow = narrowerThan(520);
    expect(rule(narrow, ".composer > textarea")).toMatch(/flex: 1 1 100%; order: -1;/);
    expect(rule(flat, ".composer textarea")).toContain("min-width: 0");
  });

  it("folds the emoji and voice buttons into the one menu, and drops a message's picture", () => {
    const narrow = narrowerThan(360);
    expect(rule(narrow, ".composer:has(.composer-more) .composer-emoji, .composer:has(.composer-more) > .dm-voice")).toContain("display: none");
    expect(rule(narrow, ".composer .composer-more")).toContain("display: inline-grid");
    expect(rule(flat, ".composer .composer-more")).toContain("display: none");
    expect(rule(narrow, ".msg > .mark")).toContain("display: none");
    expect(rule(narrow, ".msg-head")).toContain("white-space: nowrap");
  });
});

describe("a dialog on a short window", () => {
  it("scrolls inside, with its buttons always at its foot", () => {
    const sheet = rule(flat, ".sheet");
    expect(sheet.slice(sheet.indexOf("max-height"))).toMatch(/max-height: calc\(100vh - 12vh - 16px\); overflow-y: auto;/);
    expect(rule(flat, ".sheet .sheet-foot")).toMatch(/position: sticky; bottom: -20px;/);
    expect(rule(flat, ".sheet .sheet-foot")).toContain("background: var(--raised)");
  });
});
