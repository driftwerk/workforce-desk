import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const advanced = vi.hoisted(() => [] as { place: unknown; point: unknown }[]);
vi.mock("./reads", () => ({ advance: vi.fn(async (place: unknown, point: unknown) => void advanced.push({ place, point })) }));
vi.mock("./summary", () => ({ useUnread: () => undefined }));

const { SEEN_MS, useSeen, useSeenWhole } = await import("./seen");

/** An IntersectionObserver Desk drives: `show(el, bottomIn, ratio)` says how much of it is on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  observed: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.observed = [];
  }
  show(el: Element, bottomIn: boolean, ratio = bottomIn ? 1 : 0.3) {
    const entry = {
      target: el,
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      boundingClientRect: { bottom: bottomIn ? 100 : 300 },
      rootBounds: { bottom: 200 },
    } as unknown as IntersectionObserverEntry;
    this.cb([entry], this as unknown as IntersectionObserver);
  }
}

const items = [
  { id: "m1", at: "2026-10-27T09:00:01Z" },
  { id: "m2", at: "2026-10-27T09:00:02Z" },
  { id: "m3", at: "2026-10-27T09:00:03Z" },
];

function List({ enabled = true, room = "r1" }: { enabled?: boolean; room?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useSeen({ kind: "room", room }, root, items, { enabled });
  return (
    <div ref={root}>
      {items.map((it) => (
        <article key={it.id} data-message-id={it.id} />
      ))}
    </div>
  );
}

function Card() {
  const ref = useRef<HTMLDivElement>(null);
  useSeenWhole({ kind: "brief" }, { at: "2026-10-30T08:00:00Z", message: null }, ref, { enabled: true });
  return <div ref={ref} />;
}

let focused = true;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  FakeObserver.all = [];
  advanced.length = 0;
  focused = true;
  visibility = "visible";
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const observer = () => FakeObserver.all.at(-1)!;
const el = (id: string) => observer().observed.find((e) => (e as HTMLElement).dataset.messageId === id)!;

describe("what's on screen is read", () => {
  it("through the newest row whose bottom showed, after half a second", () => {
    render(<List />);
    act(() => {
      observer().show(el("m1"), true);
      observer().show(el("m2"), true);
      observer().show(el("m3"), false);
    });
    act(() => void vi.advanceTimersByTime(SEEN_MS - 1));
    expect(advanced).toEqual([]);
    act(() => void vi.advanceTimersByTime(1));
    expect(advanced).toEqual([{ place: { kind: "room", room: "r1" }, point: { at: items[1]!.at, message: "m2" } }]);
  });

  it("not while Desk hasn't focus or is hidden", () => {
    render(<List />);
    focused = false;
    act(() => observer().show(el("m1"), true));
    act(() => void vi.advanceTimersByTime(SEEN_MS * 2));
    focused = true;
    visibility = "hidden";
    act(() => observer().show(el("m2"), true));
    act(() => void vi.advanceTimersByTime(SEEN_MS * 2));
    expect(advanced).toEqual([]);
    visibility = "visible";
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toHaveLength(1);
  });

  it("not when it scrolled off before half a second", () => {
    render(<List />);
    act(() => observer().show(el("m1"), true));
    act(() => void vi.advanceTimersByTime(SEEN_MS / 2));
    act(() => observer().show(el("m1"), false, 0));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([]);
  });

  it("by the place it showed in: one shown next isn't read through what the last showed", () => {
    const { rerender } = render(<List />);
    act(() => observer().show(el("m2"), true));
    act(() => void vi.advanceTimersByTime(SEEN_MS / 2));
    rerender(<List room="r2" />);
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([]);
  });

  it("through a row taller than the pane once scrolling brings its bottom into sight", () => {
    const { container } = render(<List />);
    act(() => observer().show(el("m3"), false, 0.3));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([]);
    const pane = container.firstElementChild as HTMLElement;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ bottom: 200 } as DOMRect);
    vi.spyOn(el("m3"), "getBoundingClientRect").mockReturnValue({ bottom: 190 } as DOMRect);
    act(() => void pane.dispatchEvent(new Event("scroll")));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([{ place: { kind: "room", room: "r1" }, point: { at: items[2]!.at, message: "m3" } }]);
  });

  it("not in a stowed pane", () => {
    render(<List enabled={false} />);
    expect(FakeObserver.all).toEqual([]);
  });

  it("a whole thing once half of it showed", () => {
    render(<Card />);
    act(() => observer().show(observer().observed[0]!, false, 0.3));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([]);
    act(() => observer().show(observer().observed[0]!, false, 0.6));
    act(() => void vi.advanceTimersByTime(SEEN_MS));
    expect(advanced).toEqual([{ place: { kind: "brief" }, point: { at: "2026-10-30T08:00:00Z", message: null } }]);
  });
});
