import { beforeEach, describe, expect, it } from "vitest";
import {
  claimMode,
  dismissProblem,
  endTalk,
  forget,
  holdDone,
  micFailed,
  owner,
  pressHold,
  QUIET,
  releaseHold,
  switchTalk,
  toggleMute,
  toggleTalk,
  useMic,
  repliesOver,
  replyStarted,
} from "./mic";

beforeEach(() => useMic.setState(QUIET));

describe("the microphone's owner", () => {
  it("is voice by name until a DM takes it", () => {
    expect(owner()).toBeNull();
    expect(claimMode()).toBeNull();
    toggleTalk("local/atlas");
    expect(owner()).toEqual({ agent: "local/atlas", mode: "talk" });
    expect(claimMode()).toBe("open");
  });

  it("is one DM's at a time: talking in another moves it, talking again ends it", () => {
    toggleTalk("local/atlas");
    toggleTalk("local/scout");
    expect(useMic.getState().talk).toBe("local/scout");
    toggleTalk("local/scout");
    expect(owner()).toBeNull();
    toggleTalk("local/atlas");
    endTalk("local/scout");
    expect(useMic.getState().talk).toBe("local/atlas");
    endTalk("local/atlas");
    expect(owner()).toBeNull();
  });

  it("is borrowed by a hold, which hears only what's held, and given back once it's sent", () => {
    toggleTalk("local/atlas");
    pressHold("local/scout");
    expect(owner()).toEqual({ agent: "local/scout", mode: "hold" });
    expect(claimMode()).toBe("held");
    holdDone();
    expect(owner()?.agent).toBe("local/scout");
    releaseHold();
    expect(claimMode()).toBe("held");
    holdDone();
    expect(owner()).toEqual({ agent: "local/atlas", mode: "talk" });
  });

  it("stays up to say an answer once nobody has it, hearing only what talks over it", () => {
    expect(claimMode()).toBeNull();
    replyStarted();
    expect(claimMode()).toBe("held");
    toggleTalk("local/atlas");
    expect(claimMode()).toBe("open");
    toggleTalk("local/atlas");
    expect(claimMode()).toBe("held");
    repliesOver();
    expect(claimMode()).toBeNull();
  });

  it("stays open for a hold in the DM that's talking", () => {
    toggleTalk("local/atlas");
    pressHold("local/atlas");
    expect(claimMode()).toBe("open");
  });

  it("goes back to voice by name when it can't be had, saying why in that DM", () => {
    toggleTalk("local/atlas");
    micFailed({ agent: "local/atlas", mode: "talk" }, "microphone access was denied");
    expect(owner()).toBeNull();
    expect(useMic.getState().problem).toEqual({ agent: "local/atlas", mode: "talk", message: "microphone access was denied" });
    toggleTalk("local/atlas");
    expect(useMic.getState().problem).toBeNull();
  });

  it("is let go by an agent that's gone from the roster", () => {
    toggleTalk("local/atlas");
    pressHold("local/atlas");
    forget("local/scout");
    expect(owner()?.agent).toBe("local/atlas");
    forget("local/atlas");
    expect(useMic.getState()).toMatchObject({ talk: null, hold: null, pressed: false, muted: false, since: null });
    micFailed({ agent: "local/atlas", mode: "talk" }, "no input device");
    forget("local/atlas");
    expect(useMic.getState().problem).toBeNull();
  });
});

describe("a spoken conversation", () => {
  it("knows when it started, and in whose DM", () => {
    toggleTalk("local/atlas");
    const { since, from } = useMic.getState();
    expect(since).toBeTypeOf("number");
    expect(from).toBeNull();
    toggleTalk("local/atlas");
    expect(useMic.getState()).toMatchObject({ talk: null, since: null, from: null });
  });

  it("moves to another agent in one step, never back to voice by name between", () => {
    const modes: (string | null)[] = [];
    toggleTalk("local/atlas");
    const unsubscribe = useMic.subscribe((s) => modes.push(claimMode(s)));
    switchTalk("local/scout");
    unsubscribe();
    expect(modes).toEqual(["open"]);
    expect(useMic.getState()).toMatchObject({ talk: "local/scout", from: "local/atlas" });
    switchTalk("local/scout");
    expect(useMic.getState().from).toBe("local/atlas");
    useMic.setState(QUIET);
    switchTalk("local/scout");
    expect(useMic.getState().talk).toBeNull();
  });

  it("mutes to hear only what's held, voice by name still paused, without ending", () => {
    toggleMute();
    expect(useMic.getState().muted).toBe(false);
    toggleTalk("local/atlas");
    toggleMute();
    expect(useMic.getState()).toMatchObject({ talk: "local/atlas", muted: true });
    expect(owner()).toEqual({ agent: "local/atlas", mode: "talk" });
    expect(claimMode()).toBe("held");
    pressHold("local/atlas");
    expect(claimMode()).toBe("held");
    releaseHold();
    holdDone();
    toggleMute();
    expect(claimMode()).toBe("open");
  });

  it("unmutes whenever it ends, moves or fails", () => {
    const muted = () => {
      toggleTalk("local/atlas");
      toggleMute();
    };
    muted();
    toggleTalk("local/atlas");
    expect(useMic.getState().muted).toBe(false);
    muted();
    switchTalk("local/scout");
    expect(useMic.getState().muted).toBe(false);
    useMic.setState(QUIET);
    muted();
    endTalk("local/atlas");
    expect(useMic.getState().muted).toBe(false);
    muted();
    micFailed({ agent: "local/atlas", mode: "talk" }, "no input device");
    expect(useMic.getState()).toMatchObject({ muted: false, since: null });
    dismissProblem();
    expect(useMic.getState().problem).toBeNull();
  });
});
