import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PictureField, pictureNote, refusalOf } from "./PictureField";
import type { Picture } from "./pictures";

afterEach(cleanup);

const at = "2026-10-30T09:00:00Z";
const slack: Picture = { version: "s1", source: "slack", at, slack: "Acme" };
const chosen = (overriding: boolean): Picture => ({ version: "c1", source: "chosen", at, slack: overriding ? "Acme" : null });

describe("a picture's settings", () => {
  it("say where the picture came from", () => {
    expect(pictureNote(null)).toBe("No picture");
    expect(pictureNote(slack)).toBe("From Slack (Acme)");
    expect(pictureNote(chosen(true), new Date("2026-10-30T09:05:00Z"))).toBe("Chosen 5 minutes ago");
  });

  it("offer the Slack picture back while a chosen one overrides it, and Remove while there's none behind it", async () => {
    const onSet = vi.fn(() => Promise.resolve());
    const { rerender } = render(<PictureField name="Allan" picture={slack} src={null} onSet={onSet} />);
    expect(screen.getByRole("button", { name: "Choose a picture…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the Slack picture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    rerender(<PictureField name="Allan" picture={chosen(true)} src={null} onSet={onSet} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use the Slack picture" })));
    expect(onSet).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    rerender(<PictureField name="Allan" picture={{ ...chosen(true), slack: "" }} src={null} onSet={onSet} />);
    expect(screen.getByRole("button", { name: "Use the Slack picture" })).toBeTruthy();

    rerender(<PictureField name="Allan" picture={chosen(false)} src={null} onSet={onSet} />);
    expect(screen.queryByRole("button", { name: "Use the Slack picture" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(onSet).toHaveBeenCalledTimes(2);
  });

  it("can't be changed where whoever it is can't be", () => {
    render(<PictureField name="Allan" picture={slack} src="blob:allan" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("From Slack (Acme)")).toBeTruthy();
  });

  it("take only PNG, JPEG and WebP files of a sensible size", async () => {
    const file = (bytes: number[], size?: number) => {
      const f = new File([new Uint8Array(bytes)], "p");
      if (size) Object.defineProperty(f, "size", { value: size });
      return f;
    };
    expect(await refusalOf(file([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(await refusalOf(file([0x47, 0x49, 0x46, 0x38]))).toBe("Choose a PNG, JPEG or WebP picture.");
    expect(await refusalOf(file([0x89, 0x50, 0x4e, 0x47], 26 * 1024 * 1024))).toBe("That picture is too big. Choose one under 25 MB.");
  });
});
