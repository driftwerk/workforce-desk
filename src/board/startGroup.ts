import { UNGROUPED, type Layout } from "../groups/model";

// The group a board's Start a session last put a session in, kept in this
// window's storage (it may be blocked: then it is only not remembered).
const KEY = "desk.board.lastGroup";

export const lastBoardGroup = (): string | null => {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const rememberBoardGroup = (group: string): void => {
  try {
    window.localStorage.setItem(KEY, group);
  } catch {
    /* not remembered */
  }
};

const exists = (layout: Layout, id: string | null | undefined): id is string => !!id && (id === UNGROUPED || layout.groups.some((g) => g.id === id));

/** Where a session started on a board shows unless another is chosen: the
 *  board's group, else the last one chosen from a board, else Ungrouped. */
export const boardStartGroup = (layout: Layout, boardGroup: string | null | undefined, last: string | null): string =>
  exists(layout, boardGroup) ? boardGroup : exists(layout, last) ? last : UNGROUPED;

// What a board's last Start a session used, kept per board in this window's
// storage (not remembered if it is blocked).
export interface StartDefault {
  cwd: string;
  engine: string;
}
const startKey = (board: string) => `desk.board.start.${board}`;

export const lastBoardStart = (board: string): StartDefault | null => {
  try {
    const v = JSON.parse(window.localStorage.getItem(startKey(board)) ?? "null") as Partial<StartDefault> | null;
    return v && typeof v.cwd === "string" && typeof v.engine === "string" ? { cwd: v.cwd, engine: v.engine } : null;
  } catch {
    return null;
  }
};

export const rememberBoardStart = (board: string, d: StartDefault): void => {
  try {
    window.localStorage.setItem(startKey(board), JSON.stringify(d));
  } catch {
    /* not remembered */
  }
};
