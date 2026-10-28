import { beforeEach, describe, expect, it } from "vitest";
import { ago, dirtyFiles, discarded, draftStatus, edited, isDirty, opened, restored, saved, useDrafts } from "./files";

const NOW = new Date("2026-10-28T12:00:00Z");

describe("a file being edited", () => {
  it("is dirty once typed in, and clean again after discarding", () => {
    const d = opened("# Soul\n", "2026-10-26T12:00:00Z");
    expect(isDirty(d)).toBe(false);
    const typed = edited(d, "# Soul\n\nMore.\n");
    expect(isDirty(typed)).toBe(true);
    expect(draftStatus(typed, NOW)).toEqual({ text: "Unsaved changes", tone: "dirty" });
    const back = discarded(typed);
    expect(back.text).toBe("# Soul\n");
    expect(isDirty(back)).toBe(false);
  });

  it("is saved after saving, and says when it was saved later", () => {
    const typed = edited(opened("a", null), "b");
    const done = saved(typed, "b", "2026-10-28T11:59:30Z");
    expect(isDirty(done)).toBe(false);
    expect(draftStatus(done, NOW)).toEqual({ text: "Saved", tone: "saved" });
    expect(draftStatus(opened("a", "2026-10-26T12:00:00Z"), NOW)).toEqual({ text: "Saved 2 days ago", tone: "quiet" });
    expect(draftStatus(opened("a", null), NOW).text).toBe("Saved");
  });

  it("keeps what was typed while a save was in flight", () => {
    const sent = edited(opened("a", null), "b");
    const more = edited(sent, "bc");
    const done = saved(more, "b", "2026-10-28T12:00:00Z");
    expect(done.saved).toBe("b");
    expect(isDirty(done)).toBe(true);
    expect(done.justSaved).toBe(false);
  });

  it("takes a restored version as both saved and shown", () => {
    const r = restored("old", "2026-10-28T12:00:00Z");
    expect(isDirty(r)).toBe(false);
    expect(r.text).toBe("old");
  });

  it("says how long ago in words", () => {
    expect(ago("2026-10-27T12:00:00Z", NOW)).toBe("yesterday");
    expect(ago("2026-10-28T11:55:00Z", NOW)).toBe("5 minutes ago");
    expect(ago("2026-10-28T11:59:50Z", NOW)).toBe("just now");
  });
});

describe("drafts across files", () => {
  beforeEach(() => useDrafts.setState({ drafts: {} }));

  it("lists the files with unsaved changes and keeps them when refreshed", () => {
    const { put } = useDrafts.getState();
    put("local/ledger", "SOUL.md", edited(opened("a", null), "b"));
    put("local/ledger", "AGENTS.md", opened("rules", null));
    put("local/scout", "SOUL.md", edited(opened("a", null), "c"));
    expect(dirtyFiles(useDrafts.getState().drafts, "local/ledger")).toEqual(["SOUL.md"]);
    useDrafts.getState().refresh("local/ledger");
    expect(Object.keys(useDrafts.getState().drafts).sort()).toEqual(["local/ledger/SOUL.md", "local/scout/SOUL.md"]);
    useDrafts.getState().drop("local/ledger");
    expect(Object.keys(useDrafts.getState().drafts)).toEqual(["local/scout/SOUL.md"]);
  });
});
