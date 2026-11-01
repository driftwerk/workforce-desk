import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isShown, resetShown, targetDm, useDmPresence } from "./dms";
import { toggleTalk, useMic } from "./mic";

function Dm({ agent }: { agent: string }) {
  const root = useRef<HTMLElement | null>(null);
  useDmPresence(agent, root);
  return (
    <main
      ref={(el) => {
        root.current = el;
      }}
    >
      <textarea aria-label={agent} />
    </main>
  );
}

beforeEach(() => {
  resetShown();
  useMic.setState({ talk: null, hold: null, pressed: false, replying: 0, problem: null });
});
afterEach(cleanup);

const field = (agent: string) => document.querySelector<HTMLTextAreaElement>(`[aria-label="${agent}"]`)!;

describe("which DM a DM shortcut acts on", () => {
  it("is the one with focus, else the one focused last that's still shown, else none", () => {
    const { rerender } = render(
      <>
        <Dm agent="local/atlas" />
        <Dm agent="local/scout" />
      </>,
    );
    expect(targetDm()).toBeNull();
    act(() => field("local/atlas").focus());
    expect(targetDm()).toBe("local/atlas");
    act(() => field("local/scout").focus());
    expect(targetDm()).toBe("local/scout");
    act(() => field("local/scout").blur());
    expect(targetDm()).toBe("local/scout");
    rerender(<Dm agent="local/atlas" />);
    expect(targetDm()).toBe("local/atlas");
  });

  it("lets the microphone go when the last DM showing its agent goes", async () => {
    const { rerender } = render(
      <>
        <Dm agent="local/atlas" />
        <Dm agent="local/atlas" />
      </>,
    );
    act(() => toggleTalk("local/atlas"));
    rerender(<Dm agent="local/atlas" />);
    await act(async () => undefined);
    expect(useMic.getState().talk).toBe("local/atlas");
    rerender(<></>);
    await act(async () => undefined);
    expect(isShown("local/atlas")).toBe(false);
    expect(useMic.getState().talk).toBeNull();
  });
});
