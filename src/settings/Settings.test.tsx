import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUi } from "../shell/ui";
import { Settings } from "./Settings";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  inApp: false,
}));

afterEach(cleanup);

it("keeps Settings open on Esc while a sheet is open on it, wherever focus is (back from the browser, it's on the page)", () => {
  useUi.getState().openSettings("machines");
  const onClose = vi.fn();
  render(<Settings onClose={onClose} />);
  const sheet = document.body.appendChild(Object.assign(document.createElement("div"), { className: "sheet-backdrop" }));
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  sheet.remove();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
