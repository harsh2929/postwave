/**
 * NoteMentionMenu — SUB-097 @-mention typeahead for the subscriber-notes
 * markdown composer.
 *
 * Mirrors the AI-composer MentionMenu pattern (an absolute-anchored popover
 * that opens when the operator types `@` followed by a query) but is scoped
 * to *workspace users* rather than campaign/subscriber/etc. resources, since
 * note mentions are stored as `@[Display](user:UUID)` tokens that the backend
 * parses out of `markdown_body`.
 *
 * It's purely presentational: the open/close/filter/keyboard state lives on
 * the parent MarkdownNoteEditor, which owns the textarea. Selecting a row
 * splices a styled token into the draft.
 *
 * NOTE on the user directory: the desktop API does not (yet) expose a
 * workspace-user *search* endpoint, so the candidate set is derived by the
 * parent from identities we already have in hand — the note authors /
 * mentioned teammates already loaded for this subscriber, plus the current
 * signed-in user. That keeps the feature honest (no fabricated endpoint)
 * while still letting an operator @-mention anyone who has touched the
 * thread or themselves.
 */

import { type ReactElement, useEffect, useRef } from "react";

/** One mention candidate: a workspace user the operator can @-mention. */
export interface NoteMentionItem {
  /** Canonical (lower-cased) user UUID — becomes the `user:<id>` token. */
  id: string;
  /** Primary label rendered in the row + the resulting `@[Display]` token. */
  display: string;
  /** Optional secondary hint (email / role) rendered muted. */
  hint?: string;
}

/** Stable option id scoped to one editor/listbox instance. */
export function noteMentionOptionId(
  listboxId: string,
  item: NoteMentionItem,
): string {
  return `${listboxId}-${encodeURIComponent(item.id)}`;
}

/**
 * Build the textarea-visible token for a chosen mention. The
 * `@[Display](user:id)` shape mirrors a markdown link so it round-trips
 * through storage AND is parseable back into a pill by the backend's
 * mention extractor.
 */
export function buildNoteMentionToken(item: NoteMentionItem): string {
  // Brackets/parens in the display would corrupt the token parse, so strip
  // them rather than escape (the backend regex forbids a literal ']').
  const safe = item.display.replace(/[[\]()]/g, "").trim() || "user";
  return `@[${safe}](user:${item.id})`;
}

interface Props {
  open: boolean;
  listboxId: string;
  items: NoteMentionItem[];
  activeIndex: number;
  query: string;
  onSelect: (item: NoteMentionItem) => void;
  onHover: (index: number) => void;
}

export function NoteMentionMenu({
  open,
  listboxId,
  items,
  activeIndex,
  query,
  onSelect,
  onHover,
}: Props): ReactElement | null {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the highlighted row visible as the operator arrow-navigates a list
  // taller than the popover.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLButtonElement>(
      `[data-note-mention-idx="${activeIndex}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const resultStatus =
    items.length > 0
      ? `${items.length} ${items.length === 1 ? "teammate" : "teammates"} available`
      : query
        ? `No teammates match ${query}`
        : "Type a name to mention a teammate";

  return (
    <div ref={listRef} className="note-mention-menu">
      <div
        id={listboxId}
        className="note-mention-options"
        role="listbox"
        aria-label="Mention a teammate"
      >
        {items.map((item, i) => {
          const on = i === activeIndex;
          return (
            <button
              key={item.id}
              id={noteMentionOptionId(listboxId, item)}
              type="button"
              role="option"
              aria-selected={on}
              aria-label={`${item.display}${item.hint ? `. ${item.hint}` : ""}`}
              tabIndex={-1}
              data-note-mention-idx={i}
              className="note-mention-item"
              data-active={on ? "true" : undefined}
              onPointerDown={(e) => {
                // Mouse presses retain the textarea's focus. Touch and
                // pen remain scroll-safe and commit through click only.
                if (e.pointerType === "mouse") e.preventDefault();
              }}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(i)}
            >
              <span className="note-mention-label">{item.display}</span>
              {item.hint ? (
                <span className="note-mention-hint muted">{item.hint}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        className={
          items.length === 0
            ? "note-mention-status muted"
            : "visually-hidden"
        }
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {resultStatus}
      </div>
    </div>
  );
}
