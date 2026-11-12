import { create } from "zustand";

/** Whether Windows' setup of Desk inside WSL is showing. */
interface SetupStore {
  open: boolean;
  /** The person chose "Not now": the Floor offers it again. */
  skipped: boolean;
  show: () => void;
  hide: () => void;
  skip: () => void;
}

export const useSetup = create<SetupStore>((set) => ({
  open: false,
  skipped: false,
  show: () => set({ open: true, skipped: false }),
  hide: () => set({ open: false }),
  skip: () => set({ open: false, skipped: true }),
}));
