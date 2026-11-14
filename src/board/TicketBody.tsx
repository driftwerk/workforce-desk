import { RichHostProvider, RichMarkdown } from "@workforce/rich";
import { useMemo } from "react";
import { ticketImage } from "./ticketFileImage";
import { DESCRIPTION_RICH_HOST, useKeyedBody } from "./ticketKeyedRich";

/** A description someone's tool sent with its newlines written out (`\n` as
 *  two characters, one line in all): real line breaks, as the hub makes them
 *  when it syncs. Text with real line breaks is left as it is. */
export const unescapeNewlines = (text: string): string =>
  text.includes("\n") || !text.includes("\\n") ? text : text.replace(/\\r\\n|\\n/g, "\n");

/** A ticket's description as markdown, with the renderer chat uses: no raw
 *  HTML, a remote image as a link or Desk's placeholder, checklists drawn
 *  read-only, a key of a ticket on its board as that ticket's chip, what the
 *  hub writes as directives drawn, and a picture of ticket `ticket`'s own
 *  drawn from its file. Clicking text opens it for editing; a link, a chip,
 *  a picture or a collapsible's title is itself. */
export function TicketBody({ text, board, ticket, onEdit }: { text: string; board?: string; ticket?: string; onEdit: () => void }) {
  const shown = useKeyedBody(unescapeNewlines(text), board);
  const host = useMemo(() => ({ ...DESCRIPTION_RICH_HOST, image: ticketImage(ticket) }), [ticket]);
  return (
    <div
      className="ticket-text ticket-md rich"
      title="Change what it's about"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("a, button, input, summary")) return;
        if (window.getSelection()?.toString()) return;
        onEdit();
      }}
    >
      <RichHostProvider host={host}>
        <RichMarkdown text={shown} />
      </RichHostProvider>
      <button type="button" className="link ticket-md-edit" onClick={onEdit}>
        Edit description
      </button>
    </div>
  );
}
