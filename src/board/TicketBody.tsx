import { RichHostProvider, RichMarkdown } from "@workforce/rich";
import { DESK_RICH_HOST } from "../shell/richHost";

/** A description someone's tool sent with its newlines written out (`\n` as
 *  two characters, one line in all): real line breaks, as the hub makes them
 *  when it syncs. Text with real line breaks is left as it is. */
export const unescapeNewlines = (text: string): string =>
  text.includes("\n") || !text.includes("\\n") ? text : text.replace(/\\r\\n|\\n/g, "\n");

/** A ticket's description as markdown, with the renderer chat uses: no raw
 *  HTML, a remote image as a link or Desk's placeholder, checklists drawn
 *  read-only. Clicking text opens it for editing; a link opens as a link. */
export function TicketBody({ text, onEdit }: { text: string; onEdit: () => void }) {
  return (
    <div
      className="ticket-text ticket-md rich"
      title="Change what it's about"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("a, button, input")) return;
        if (window.getSelection()?.toString()) return;
        onEdit();
      }}
    >
      <RichHostProvider host={DESK_RICH_HOST}>
        <RichMarkdown text={unescapeNewlines(text)} />
      </RichHostProvider>
      <button type="button" className="link ticket-md-edit" onClick={onEdit}>
        Edit description
      </button>
    </div>
  );
}
