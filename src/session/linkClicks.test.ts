import { describe, expect, it, vi } from "vitest";
import { linkClicks, type MouseModes } from "./linkClicks";

const PAGE = "https://example.com/page";

/** A terminal's host with xterm's own element in it, which hears what
 *  xterm would: its Linkifier's mouseup and its mouse report. */
const setUp = (mode: MouseModes["modes"]["mouseTrackingMode"]) => {
  const host = document.createElement("div");
  const xterm = host.appendChild(document.createElement("div"));
  document.body.appendChild(host);
  const term = { modes: { mouseTrackingMode: mode } };
  const open = vi.fn();
  const clicks = linkClicks(host, term, open);
  const program = vi.fn();
  // As xterm: a press and a release both reach the program while it reads
  // the mouse, and the release activates the link it was pressed on.
  let onLink = false;
  let downOnLink = false;
  xterm.addEventListener("mousedown", () => {
    downOnLink = onLink;
    if (term.modes.mouseTrackingMode !== "none") program("press");
  });
  xterm.addEventListener("mouseup", (e) => {
    if (term.modes.mouseTrackingMode !== "none") program("release");
    if (downOnLink) clicks.handler.activate(e, PAGE, null as never);
    downOnLink = false;
  });
  const click = () => {
    xterm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    xterm.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  };
  return { clicks, open, program, click, hover: () => {
      onLink = true;
      clicks.handler.hover!(new MouseEvent("mousemove"), PAGE, null as never);
    },
  };
};

describe("a link clicked in a terminal", () => {
  it("opens once, through Desk, when the program doesn't read the mouse", () => {
    const t = setUp("none");
    t.hover();
    t.click();
    expect(t.open.mock.calls).toEqual([[PAGE]]);
    expect(t.program).not.toHaveBeenCalled();
  });

  it("opens once, through Desk, and never reaches a program that reads the mouse (which would open it again)", () => {
    const t = setUp("any");
    t.hover();
    t.click();
    expect(t.open.mock.calls).toEqual([[PAGE]]);
    expect(t.program).not.toHaveBeenCalled();
  });

  it("leaves a click off any link to the program", () => {
    const t = setUp("vt200");
    t.click();
    expect(t.program.mock.calls).toEqual([["press"], ["release"]]);
    expect(t.open).not.toHaveBeenCalled();
  });

  it("opens nothing when let go off the link it was pressed on", () => {
    const t = setUp("any");
    t.hover();
    const xterm = document.body.lastElementChild!.firstElementChild!;
    xterm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    t.clicks.handler.leave!(new MouseEvent("mousemove"), PAGE, null as never);
    xterm.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(t.open).not.toHaveBeenCalled();
    expect(t.program).not.toHaveBeenCalled();
  });

  it("lets its host go", () => {
    const t = setUp("any");
    t.clicks.dispose();
    t.hover();
    t.click();
    expect(t.program.mock.calls).toEqual([["press"], ["release"]]);
  });
});
