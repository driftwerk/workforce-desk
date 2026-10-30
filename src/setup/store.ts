import { create } from "zustand";

/** Whether Windows' setup of Desk inside WSL is showing. */
interface SetupStore {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useSetup = create<SetupStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
