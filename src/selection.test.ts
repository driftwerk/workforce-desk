// Desk's chrome isn't text to select: a drag across the sidebar, a double-click
// on a group's name or a select-all picks nothing. What a person reads or
// copies (messages, code, answers, tickets, copyable values, errors) and every
// field stays selectable. jsdom doesn't cascade user-select, so this reads the
// styles' rules and resolves an element as the browser would: its own rule,
// else its nearest ancestor's, else the body's.
import { afterEach, describe, expect, it } from "vitest";
import xterm from "@xterm/xterm/css/xterm.css?raw";
import app from "./styles/app.css?raw";
import crew from "./styles/crew.css?raw";
import grids from "./styles/grids.css?raw";
import panels from "./styles/panels.css?raw";
import problem from "./styles/problem.css?raw";
import settings from "./styles/settings.css?raw";

const OURS = [app, crew, grids, panels, problem, settings];
const SHEETS = [xterm, ...OURS];
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; value: string };

/** Every top-level rule that sets user-select, in file order. */
const rules: Rule[] = SHEETS.flatMap((css) =>
  [...strip(css).matchAll(/(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g)].flatMap((m) => {
    const value = /(?:^|;|\s)user-select:\s*(\w+)/.exec(m[2]!)?.[1];
    return value ? m[1]!.split(",").map((s) => ({ selector: s.trim(), value })) : [];
  }),
);

const own = (el: Element): string | undefined => {
  let value: string | undefined;
  for (const r of rules) {
    try {
      if (el.matches(r.selector)) value = r.value;
    } catch {
      // A selector jsdom can't parse never sets user-select for these cases.
    }
  }
  return value;
};

/** What the browser lets a person select at `el`: `auto` takes the parent's. */
const selectable = (el: Element): boolean => {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const v = own(e);
    if (v === "text" || v === "all") return true;
    if (v === "none") return false;
  }
  return true;
};

const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};
afterEach(() => {
  document.body.innerHTML = "";
});
const q = (sel: string) => document.querySelector(sel)!;

describe("what a person can select", () => {
  it("makes the app root unselectable, with the prefix Safari's engine needs", () => {
    const body = /(^|\})\s*body\s*\{([^}]*)\}/.exec(strip(app))![2]!;
    expect(body).toContain("-webkit-user-select: none");
    expect(body).toMatch(/(^|[\s;])user-select: none/);
  });

  it("selects nothing in the chrome", () => {
    mount(`
      <aside class="side"><div class="side-section"><button class="side-row"><span class="grp-name">Driftwerk</span><span class="num">3</span><span class="chip">Claude</span></button></div></aside>
      <div class="gpane"><div class="gpane-head"><span class="gpane-title">Pane</span></div></div>
      <div class="dialog"><h2 class="display">Hand off</h2><button class="btn">Send</button></div>
      <div class="settings"><nav class="settings-nav"><button class="side-row">Accounts</button></nav></div>`);
    for (const sel of [".side-row", ".grp-name", ".num", ".chip", ".gpane-title", ".dialog .display", ".btn", ".settings-nav .side-row"]) {
      expect(selectable(q(sel)), sel).toBe(false);
    }
  });

  it("selects what is read or copied", () => {
    mount(`
      <div class="room"><div class="msg"><div class="msg-body">
        <p class="msg-text rich"><strong>Hello</strong> <code>x</code></p>
        <pre><code>let a = 1</code></pre>
      </div></div></div>
      <div class="brief"><div class="brief-text rich"><p>While you were away</p></div></div>
      <div class="line-answer"><div class="line-answer-ask">Which one?</div></div>
      <div class="ticket-popup"><div class="ticket-text ticket-md rich"><p>Description</p></div></div>
      <div class="settings"><div class="settings-main"><span class="mono">/Users/me/project</span><code>id-123</code></div></div>
      <p class="small state-blocked pending-problem">It failed</p>
      <div class="toast toast-error">Nope</div>
      <pre class="problem-raw mono">trace</pre>`);
    for (const sel of [".msg-text", ".msg-text strong", ".msg-text code", "pre code", ".brief-text p", ".line-answer-ask", ".ticket-text p", ".settings-main .mono", ".settings-main code", ".pending-problem", ".toast-error", ".problem-raw"]) {
      expect(selectable(q(sel)), sel).toBe(true);
    }
    // ...while the rows and labels around them stay chrome.
    for (const sel of [".msg", ".msg-body", ".brief", ".line-answer"]) expect(selectable(q(sel)), sel).toBe(false);
  });

  it("keeps every field typable and selectable, inside chrome too", () => {
    mount(`<div class="side"><input class="side-search"><textarea></textarea><select><option>a</option></select><div contenteditable="true"><span>typed</span></div></div>`);
    for (const sel of ["input", "textarea", "select", "[contenteditable]", "[contenteditable] span"]) {
      expect(selectable(q(sel)), sel).toBe(true);
    }
  });

  it("leaves the terminal to xterm, which sets its own selection", () => {
    mount(`<div class="terminal"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>`);
    // Nothing of ours makes the terminal's text selectable by the DOM: xterm
    // paints and selects it itself (its stylesheet sets .xterm to none).
    expect(selectable(q(".xterm"))).toBe(false);
    // Its input stays a real field, so typing and paste reach it.
    expect(selectable(q(".xterm-helper-textarea"))).toBe(true);
  });

  it("gives every user-select its -webkit- twin", () => {
    for (const css of OURS) {
      const lines = strip(css).split("\n");
      lines.forEach((l, i) => {
        const m = /^\s*user-select:\s*(\w+)/.exec(l);
        if (m) expect(lines[i - 1], l).toMatch(new RegExp(`-webkit-user-select:\\s*${m[1]}`));
      });
    }
  });
});
