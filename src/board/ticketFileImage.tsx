import { useState, type ReactNode } from "react";
import { FileViewer } from "./FileViewer";
import { useBoard } from "./store";
import { FileIcon } from "./ticketDirectives";
import { useFileUrl } from "./TicketFiles";
import { fileKind } from "./ticketView";

/** The id a `desk-file:` image names. */
export const deskFileId = (src: string): string | null => /^desk-file:([0-9a-f-]{1,64})$/i.exec(src.trim())?.[1]?.toLowerCase() ?? null;

/** A file of the ticket's, where its description shows it: a picture
 *  drawn from its bytes (fetched through Desk, never by the page from
 *  anywhere), or the file's chip; either opens it. Not among its files,
 *  its name. */
export function TicketFileImage({ ticket, id, alt }: { ticket: string; id: string; alt: string }) {
  const t = useBoard((s) => s.tickets[ticket]);
  const file = t?.files?.find((f) => f.id.toLowerCase() === id) ?? null;
  const picture = file && fileKind(file) === "image" ? file : null;
  const shown = useFileUrl(ticket, picture);
  const [open, setOpen] = useState(false);
  if (!t || !file) return <span className="ticket-md-file-missing">{alt || "attachment"}</span>;
  const viewer = open && (
    // The viewer is a portal: its clicks still bubble to the description,
    // which would start editing it.
    <span onClick={(e) => e.stopPropagation()}>
      <FileViewer ticket={t} files={[file]} at={0} onAt={() => {}} onClose={() => setOpen(false)} />
    </span>
  );
  const name = alt || file.name;
  return (
    <>
      {picture ? (
        <button type="button" className="ticket-md-picture" onClick={() => setOpen(true)} title={name} aria-label={`Open ${name}`}>
          {shown.url ? <img src={shown.url} alt={name} /> : <span className="ticket-md-picture-wait">{shown.problem ? name : ""}</span>}
        </button>
      ) : (
        <button type="button" className="ticket-inline-chip ticket-md-file" onClick={() => setOpen(true)} title={file.name}>
          <FileIcon />
          {name}
        </button>
      )}
      {viewer}
    </>
  );
}

/** The image hook for ticket `ticket`'s text: its own files drawn. */
export const ticketImage =
  (ticket: string | undefined) =>
  (src: string, alt: string): ReactNode => {
    const id = deskFileId(src);
    if (!id) return undefined;
    return ticket ? <TicketFileImage ticket={ticket} id={id} alt={alt} /> : <span className="ticket-md-file-missing">{alt || "attachment"}</span>;
  };
