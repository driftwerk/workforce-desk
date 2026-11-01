import { beforeEach, describe, expect, it } from "vitest";
import { claimMode, endTalk, forget, holdDone, micFailed, owner, pressHold, releaseHold, toggleTalk, useMic, repliesOver, replyStarted } from "./mic";

beforeEach(() => useMic.setState({ talk: null, hold: null, pressed: false, replying: 0, problem: null }));

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
    micFailed("local/atlas", "microphone access was denied");
    expect(owner()).toBeNull();
    expect(useMic.getState().problem).toEqual({ agent: "local/atlas", message: "microphone access was denied" });
    toggleTalk("local/atlas");
    expect(useMic.getState().problem).toBeNull();
  });

  it("is let go by a DM that isn't shown any more", () => {
    toggleTalk("local/atlas");
    pressHold("local/atlas");
    forget("local/scout");
    expect(owner()?.agent).toBe("local/atlas");
    forget("local/atlas");
    expect(useMic.getState()).toMatchObject({ talk: null, hold: null, pressed: false });
  });
});
