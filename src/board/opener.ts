// Where a ticket opens: the side panel beside the main window's view, unless
// what it's opened from says otherwise (a board in a grid's pane opens it
// as a popup over the grid, and a ticket open in that popup opens another
// there too).

import { createContext, useContext } from "react";
import { useBoard } from "./store";

/** Opens a ticket where this part of Desk shows one. */
export const TicketOpener = createContext<(id: string) => void>((id) => useBoard.getState().openTicket(id));

export const useOpenTicket = (): ((id: string) => void) => useContext(TicketOpener);

/** A ticket shown as a popup over a grid, rather than in the side panel:
 *  how it closes, and how it moves to the side panel. */
export interface TicketPopupFrame {
  close: () => void;
  toSidePanel: () => void;
}

export const TicketPopupContext = createContext<TicketPopupFrame | null>(null);

/** The popup a ticket is shown in; null in the side panel. */
export const useTicketPopup = (): TicketPopupFrame | null => useContext(TicketPopupContext);
