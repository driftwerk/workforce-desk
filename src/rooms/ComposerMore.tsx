import { useRef, useState, type CSSProperties } from "react";
import { EmojiPopover, placeBy } from "../emoji/EmojiButton";
import { Menu, type MenuEntry } from "../ui/Menu";

/** A narrow composer's one overflow button: the emoji, and whatever else
 *  its buttons do (`more`), folded into a menu. It shows only while the
 *  composer is narrow (app.css): the buttons it stands for hide then. With
 *  choices of its own (`kept`, which no button stands for) it shows at any
 *  width, and holds what's folded only while the composer is narrow. */
export function ComposerMore({
  label,
  onEmoji,
  more = [],
  kept = [],
  disabled = false,
}: {
  /** "More for Desk": what the button is called. */
  label: string;
  onEmoji: (emoji: string) => void;
  more?: MenuEntry[];
  /** Choices only this menu offers, first. */
  kept?: MenuEntry[];
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [emojiAt, setEmojiAt] = useState<CSSProperties | null>(null);
  const [folded, setFolded] = useState(true);
  const foldedEntries: MenuEntry[] = [
    {
      kind: "item",
      label: "Add an emoji",
      onSelect: () => button.current && setEmojiAt(placeBy(button.current)),
    },
    ...more,
  ];
  const entries: MenuEntry[] = !kept.length
    ? foldedEntries
    : folded
      ? [...kept, { kind: "separator" }, ...foldedEntries]
      : kept;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn-sm composer-attach composer-more${kept.length ? " composer-more-kept" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={label}
        disabled={disabled}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // The emoji button beside it shows while the composer is wide:
          // what it stands for isn't folded in then.
          const emoji = e.currentTarget.closest(".composer")?.querySelector(".composer-emoji");
          setFolded(!emoji || getComputedStyle(emoji).display === "none");
          setMenu(menu ? null : { x: r.left, y: r.top - 4 });
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="12.5" cy="8" r="1.4" />
        </svg>
      </button>
      {menu && (
        <Menu
          label={label}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) button.current?.focus();
          }}
        />
      )}
      {emojiAt && (
        <EmojiPopover
          place={emojiAt}
          onPick={onEmoji}
          onClose={(refocus) => {
            setEmojiAt(null);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}
