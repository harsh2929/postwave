/**
 * subscriberNotes — the wire contract and draft rules for operator notes
 * on a subscriber (SUB-097).
 *
 *   GET  /api/v1/subscribers/{id}/notes  → { notes: Note[], count }
 *   POST /api/v1/subscribers/{id}/notes  → { id }   body { markdown_body, pinned? }
 *
 * Notes are operator-only context — "met at SaaStr, wants enterprise
 * pricing" — never subscriber-visible, and the model is APPEND-ONLY by
 * design server-side: you add a new note rather than revising an old one,
 * so the trail survives. Mobile keeps that model: compose and delete, no
 * edit.
 *
 * Import-free (vitest runs in a node environment) so the parse, ordering
 * and validation rules below are directly testable.
 */
import { num } from "@/lib/format";


export interface SubscriberNote {
  id: string;
  /** Markdown source; the pane renders it as plain text on mobile. */
  body: string;
  authorEmail: string;
  pinned: boolean;
  createdAt: string;
  /** How many files hang off the note. Mobile links out rather than viewing. */
  attachmentCount: number;
}

/**
 * Mirrors `markdownBodyMax` in apps/api/internal/subscriber_notes —
 * the server rejects anything longer with a 400, so catch it here.
 */
export const NOTE_BODY_MAX = 20_000;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse the notes envelope. Accepts `{notes: []}` (what the handler
 * writes) and a bare array, and drops rows with no id or no body rather
 * than rendering a blank card that looks like data loss.
 */
export function parseSubscriberNotes(raw: unknown): SubscriberNote[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { notes?: unknown }).notes
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: SubscriberNote[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = str(row.id).trim();
    // `markdown_body` is the rich source; `body` is the server's
    // mention-stripped projection and is what an older row carries.
    const body = (str(row.markdown_body) || str(row.body)).trim();
    if (!id || !body) continue;
    out.push({
      id,
      body,
      authorEmail: str(row.author_email).trim(),
      pinned: row.pinned === true,
      createdAt: str(row.created_at),
      attachmentCount: Array.isArray(row.attachments)
        ? row.attachments.length
        : 0,
    });
  }
  return out;
}

/**
 * Pinned first, then newest first — the same order the server promises,
 * re-applied client-side so an optimistic insert or a gateway that forgets
 * to sort still reads correctly.
 */
export function orderSubscriberNotes(
  notes: readonly SubscriberNote[],
): SubscriberNote[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export type NoteDraftCode = "empty" | "too_long" | "ok";

export interface NoteDraftValidation {
  code: NoteDraftCode;
  /** Null when the draft is acceptable; otherwise the inline hint. */
  hint: string | null;
  canSave: boolean;
}

/**
 * One validator so the Save button and the hint under the box always
 * agree about why an empty or oversized note cannot be filed.
 */
export function validateNoteDraft(draft: string): NoteDraftValidation {
  const trimmed = draft.trim();
  if (!trimmed) return { code: "empty", hint: null, canSave: false };
  if (trimmed.length > NOTE_BODY_MAX) {
    return {
      code: "too_long",
      hint: `Notes are at most ${num(NOTE_BODY_MAX)} characters (this one is ${num(trimmed.length)}).`,
      canSave: false,
    };
  }
  return { code: "ok", hint: null, canSave: true };
}

/**
 * Spoken label for one note row. VoiceOver otherwise reads a body, an
 * email and a relative timestamp as three unrelated fragments, and never
 * announces that a note is pinned (which is conveyed visually only).
 *
 * `when` is the already-formatted timestamp — the caller owns locale
 * formatting via src/lib/format.ts.
 */
export function noteSpokenLabel(note: SubscriberNote, when: string): string {
  const parts: string[] = [];
  if (note.pinned) parts.push("Pinned note");
  else parts.push("Note");
  if (note.authorEmail) parts.push(`by ${note.authorEmail}`);
  if (when) parts.push(when);
  if (note.attachmentCount > 0) {
    parts.push(
      note.attachmentCount === 1
        ? "1 attachment"
        : `${note.attachmentCount} attachments`,
    );
  }
  return `${parts.join(", ")}. ${note.body}`;
}
