/** The answers a question offers, as its terminal lists them: shown to
 *  read, since only the terminal can give them. */
export function OptionChips({ options, className = "" }: { options?: readonly string[] | null; className?: string }) {
  if (!options?.length) return null;
  return (
    <span className={`option-chips ${className}`.trim()} aria-label={`Options: ${options.join(", ")}`}>
      {options.map((o, i) => (
        <span key={`${i}:${o}`} className="chip" aria-hidden="true">
          {o}
        </span>
      ))}
    </span>
  );
}
