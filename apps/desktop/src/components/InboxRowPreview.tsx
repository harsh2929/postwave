/**
 * InboxRowPreview + readingMinutes (G9 of the campaigns 2026 pack)
 *
 * A Gmail / Apple Mail style inbox-row mock so the operator sees how the
 * sender, subject, and preview text render together in the inbox before
 * sending — the preview text is the single highest-leverage open-rate
 * lever after the subject, and it's invisible in the body editor.
 *
 * readingMinutes estimates body reading time from a word count at a
 * 230 wpm adult average, surfaced as an optional byline pill.
 */

import { type ReactElement } from "react";

const WORDS_PER_MINUTE = 230;

/** Strip HTML tags + entities to plain words and estimate reading time. */
export function readingMinutes(html: string): number {
  const text = (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

interface Props {
  sender: string;
  subject: string;
  previewText: string;
}

export function InboxRowPreview({
  sender,
  subject,
  previewText,
}: Props): ReactElement {
  const fallbackSender = sender.trim() || "you@your-domain.com";
  const fallbackSubject = subject.trim() || "(no subject)";
  // Inbox clients fall back to the start of the body when preview text is
  // empty — show that contract explicitly so operators set it on purpose.
  const snippet = previewText.trim();
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 12px",
        background: "var(--pw-bg-elev)",
        fontSize: 13,
      }}
      title="How this lands in a Gmail / Apple Mail inbox row"
    >
      <div
        style={{
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {fallbackSender}
      </div>
      <div
        style={{
          marginTop: 2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <span style={{ fontWeight: 600 }}>{fallbackSubject}</span>
        {snippet ? (
          <span className="muted"> — {snippet}</span>
        ) : (
          <span className="muted" style={{ fontStyle: "italic" }}>
            {" "}
            — inbox will show the start of your body (set preview text to
            control this)
          </span>
        )}
      </div>
    </div>
  );
}
