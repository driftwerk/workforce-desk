import { create } from "zustand";
import { invoke } from "../platform";

/** The system Desk runs on. */
export type Platform = "macos" | "linux" | "windows";

/** Where the backend (the local hub and its helper) runs: on this computer,
 *  or inside a WSL distro on Windows. */
export type BackendHost = { kind: "native" } | { kind: "wsl"; distro: string; user: string; home: string; automount: string };

export interface HostInfo {
  platform: Platform;
  /** Null on Windows until Desk is set up inside WSL. */
  host: BackendHost | null;
  /** What the person calls this computer; null when the system won't say. */
  computerName: string | null;
  /** Where the backend keeps its secrets, as Help names it ("the keychain",
   *  "Credential Manager", "your keyring", "Desk's private file"). */
  keys: string;
}

/** Until the app answers, and in tests: macOS, as Desk was first. */
export const DEFAULT_HOST: HostInfo = { platform: "macos", host: { kind: "native" }, computerName: null, keys: "the keychain" };

/** This computer, read once before the shell first renders. */
export const useHost = create<HostInfo>(() => DEFAULT_HOST);

/** Reads it, and marks the page with the platform for what only its
 *  styles differ in (`:root[data-platform="macos"]`). */
export const loadHost = async (): Promise<void> => {
  const info = await invoke<HostInfo>("host_info");
  useHost.setState(info);
  document.documentElement.dataset.platform = info.platform;
};

/** Text that differs by platform, chosen for `platform`. */
export const perPlatform = <T>(platform: Platform, texts: Record<Platform, T>): T => texts[platform];
