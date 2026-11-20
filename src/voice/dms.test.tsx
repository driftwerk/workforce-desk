import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isShown, resetShown, targetDm, useDmPresence, useDmShown } from "./dms";
import { QUIET, toggleTalk, useMic } from "./mic";

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
  useMic.setState(QUIET);
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

  it("keeps the spoken conversation when the last DM showing its agent goes", async () => {
    const { rerender } = render(
      <>
        <Dm agent="local/atlas" />
        <Dm agent="local/atlas" />
      </>,
    );
    act(() => toggleTalk("local/atlas"));
    rerender(<></>);
    await act(async () => undefined);
    expect(isShown("local/atlas")).toBe(false);
    expect(useMic.getState().talk).toBe("local/atlas");
  });

  it("says whether an agent's DM is shown, as it changes", () => {
    function Shown({ agent }: { agent: string }) {
      return <output aria-label={`shown ${agent}`}>{String(useDmShown(agent))}</output>;
    }
    const shown = () => document.querySelector('[aria-label="shown local/atlas"]')!.textContent;
    const { rerender } = render(<Shown agent="local/atlas" />);
    expect(shown()).toBe("false");
    rerender(
      <>
        <Shown agent="local/atlas" />
        <Dm agent="local/atlas" />
        <Dm agent="local/atlas" />
      </>,
    );
    expect(shown()).toBe("true");
    rerender(
      <>
        <Shown agent="local/atlas" />
        <Dm agent="local/atlas" />
      </>,
    );
    expect(shown()).toBe("true");
    rerender(<Shown agent="local/atlas" />);
    expect(shown()).toBe("false");
  });
});
