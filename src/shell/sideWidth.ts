import { create } from "zustand";
import { thisWindow } from "../grids/windows";

/** How wide the sidebar is until you drag it, and the least and most it takes. */
export const SIDE_WIDTH = 288;
export const SIDE_MIN = 220;
export const SIDE_MAX = 480;
/** What an arrow key moves it by (Shift: the bigger step). */
export const SIDE_STEP = 16;
export const SIDE_BIG_STEP = 48;

export const clampSide = (px: number): number => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(px)));

/** Kept per window, in this computer's storage; if that can't be read or
 *  written (a private window, blocked site data) it just isn't remembered. */
const keyOf = () => {
  try {
    return `desk.sidebar.width.${thisWindow()}`;
  } catch {
    return "desk.sidebar.width.main";
  }
};

const read = (): number => {
  try {
    const n = Number(localStorage.getItem(keyOf()));
    return Number.isFinite(n) && n >= SIDE_MIN && n <= SIDE_MAX ? n : SIDE_WIDTH;
  } catch {
    return SIDE_WIDTH;
  }
};

const write = (px: number) => {
  try {
    if (px === SIDE_WIDTH) localStorage.removeItem(keyOf());
    else localStorage.setItem(keyOf(), String(px));
  } catch {
    // Not kept: it opens at its usual width next time.
  }
};

interface SideWidth {
  width: number;
  setWidth: (px: number) => void;
  reset: () => void;
}

export const useSideWidth = create<SideWidth>((set) => ({
  width: read(),
  setWidth: (px) => {
    const width = clampSide(px);
    write(width);
    set({ width });
  },
  reset: () => {
    write(SIDE_WIDTH);
    set({ width: SIDE_WIDTH });
  },
}));

// ── The bottom block (New session down to the themes): folded to a row of
// icons unless opened, per window, kept the same way. ──

const footKey = () => {
  try {
    return `desk.sidebar.foot.${thisWindow()}`;
  } catch {
    return "desk.sidebar.foot.main";
  }
};
const readFoot = (): boolean => {
  try {
    return localStorage.getItem(footKey()) === "open";
  } catch {
    return false;
  }
};

interface SideFoot {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSideFoot = create<SideFoot>((set) => ({
  open: readFoot(),
  setOpen: (open) => {
    try {
      if (open) localStorage.setItem(footKey(), "open");
      else localStorage.removeItem(footKey());
    } catch {
      // Not kept: it opens folded next time.
    }
    set({ open });
  },
}));
