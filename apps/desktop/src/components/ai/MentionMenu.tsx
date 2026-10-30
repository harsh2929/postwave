/**
 * MentionMenu — typeahead popover that surfaces resource matches when
 * the user types `@` followed by a query in the chat composer.
 *
 * Selecting a row inserts a styled `@[Name](type:id)` token into the
 * textarea and (via the parent) attaches an AIContextRef to the next
 * request. The corresponding contextRefs grounding transport is already
 * wired in lib/ai-client; this menu is the dark UI we're lighting up.
 *
 * The menu is purely presentational: open/close, filtering, debounced
 * fetches, and selection live on PostwaveAI so we can reuse the same
 * absolute-anchored popover slot the slash-command menu uses.
 *
 * `MentionPreview` (also exported from this module) renders a string
 * with the same `@[Name](type:id)` tokens as styled pill spans inline
 * with the surrounding text. PostwaveAI uses it as a backdrop behind
 * the textarea and AIMessage uses it inside user bubbles so picked
 * mentions round-trip after a turn lands in history.
 */

import { type ReactElement, useEffect, useMemo, useRef } from "react";

import { parseMentionSegments } from "../../lib/ai-client";
import type { AIContextRef } from "../../lib/api-client";

/**
 * The mention-able resource kinds. Each value lines up 1:1 with one of
 * AIContextRef's `type` strings so the eventual contextRef payload is a
 * straight passthrough.
 */
export type MentionKind =
  | "campaign"
  | "subscriber"
  | "sequence"
  | "template"
  | "form";

export interface MentionItem {
  kind: MentionKind;
  /** Stable id used to build the AIContextRef. */
  id: string;
  /** Primary label rendered in the row + the resulting `@[Name]` token. */
  label: string;
  /** Optional secondary hint (status, slug, etc.) rendered muted. */
  hint?: string;
}

export const AI_MENTION_LISTBOX_ID = "postwave-ai-mention-options";

/** Stable DOM id used by the composer's active-descendant relationship. */
export function mentionOptionId(item: MentionItem): string {
  return `${AI_MENTION_LISTBOX_ID}-${encodeURIComponent(item.kind)}-${encodeURIComponent(item.id)}`;
}

/**
 * Build the textarea-visible token for a chosen mention. The
 * `@[Name](type:id)` shape mirrors a markdown link so it round-trips
 * through plain-text storage AND is parseable back into a pill + ref.
 */
export function buildMentionToken(item: MentionItem): string {
  // Brackets in the label would corrupt the parse, so strip them — the
  // alternative (escaping) would also need to be reversed at render time
  // and isn't worth the complexity for resource names.
  const safe = item.label.replace(/[\[\]()]/g, "").trim() || item.kind;
  return `@[${safe}](${item.kind}:${item.id})`;
}

/**
 * Convert an item into the AIContextRef shape consumed by the voice
 * service. Centralised here so callers don't repeat the field mapping.
 */
export function mentionToContextRef(item: MentionItem): AIContextRef {
  return { type: item.kind, id: item.id };
}

interface Props {
  open: boolean;
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
  query: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}

const KIND_LABEL: Record<MentionKind, string> = {
  campaign: "Campaign",
  subscriber: "Subscriber",
  sequence: "Sequence",
  template: "Template",
  form: "Form",
};

export function MentionMenu({
  open,
  items,
  activeIndex,
  loading,
  query,
  onSelect,
  onHover,
}: Props): ReactElement | null {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Mirror SlashCommandMenu: keep the highlighted row visible as the
  // user arrow-navigates through a list longer than the popover height.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLButtonElement>(
      `[data-mention-idx="${activeIndex}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const resultStatus = loading
    ? query
      ? `Searching for ${query}`
      : "Searching for resources"
    : items.length > 0
      ? `${items.length} ${items.length === 1 ? "result" : "results"} available`
      : query
        ? `No matches for ${query}`
        : "Type to search campaigns, subscribers, sequences, templates, and forms";

  return (
    <div ref={listRef} className="ai-slash-menu ai-mention-menu">
      <div
        id={AI_MENTION_LISTBOX_ID}
        className="ai-autocomplete-options"
        role="listbox"
        aria-label="Mention picker"
        aria-busy={loading}
      >
        {items.map((item, i) => {
          const on = i === activeIndex;
          return (
            <button
              key={`${item.kind}:${item.id}`}
              id={mentionOptionId(item)}
              type="button"
              role="option"
              aria-selected={on}
              aria-label={`${KIND_LABEL[item.kind]}: ${item.label}${item.hint ? `. ${item.hint}` : ""}`}
              tabIndex={-1}
              data-mention-idx={i}
              className="ai-slash-item ai-mention-item"
              data-active={on ? "true" : undefined}
              onPointerDown={(e) => {
                // Mouse presses retain the textarea's focus. Touch and
                // pen keep their native gesture lifecycle so scrolling
                // the bounded result list never commits an option.
                if (e.pointerType === "mouse") e.preventDefault();
              }}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(i)}
            >
              <span className="ai-mention-kind">{KIND_LABEL[item.kind]}</span>
              <span className="ai-slash-item-label ai-mention-label">
                {item.label}
              </span>
              {item.hint ? (
                <span className="ai-slash-item-hint">{item.hint}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        className={
          loading || items.length === 0
            ? "ai-mention-status"
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

/**
 * Render a string with `@[Name](type:id)` tokens as styled pill spans
 * inline with the surrounding text. Used as a paint-only backdrop
 * behind the composer textarea AND inside user message bubbles so the
 * picked mentions round-trip after the turn lands in chat history.
 */
export function MentionPreview({ text }: { text: string }): ReactElement {
  const segments = useMemo(() => parseMentionSegments(text), [text]);
  if (segments.length === 0) {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          // Preserve whitespace verbatim (including leading/trailing
          // spaces) so the backdrop layer lines up with the textarea
          // character-by-character.
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <span
            key={i}
            className="ai-mention-token"
            data-mention-type={seg.type}
            title={`${seg.type} ${seg.id}`}
          >
            @{seg.label}
          </span>
        );
      })}
    </>
  );
}
