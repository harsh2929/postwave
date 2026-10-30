/**
 * AIMessage — single chat bubble for the Moosewave AI panel.
 *
 * Renders one user or assistant message: role label, timestamp, body
 * text, and (for assistant messages that contain a campaign-shaped
 * draft) a "Use as draft" CTA. While the assistant is still streaming,
 * a thin pulsing teal bar runs along the bottom edge of the bubble.
 *
 * Body rendering: plain whitespace-pre-wrap. The server prompt explicitly
 * requests plain text so content is predictable, selectable, and safe without
 * an HTML or Markdown rendering surface.
 */

import { type ReactElement, useMemo } from "react";

import {
  extractDraftHeuristic,
  looksLikeCampaignDraft,
} from "../lib/ai-client";
import type { AIGenerateDraft } from "../lib/api-client";
import { useClipboardCopy } from "../hooks/useClipboardCopy";
import { MentionPreview } from "./ai/MentionMenu";

export type AIMessageRole = "user" | "assistant";

/**
 * One context pill rendered under an assistant message — lets the user see
 * which workspace refs (campaigns, sequences, voice version) were requested.
 * It is not a resolution receipt; the current stream contract does not report
 * which individual refs the model ultimately received.
 */
export interface AIGroundingChip {
  id: string;
  label: string;
  /** Optional sidebar section to jump to on click. */
  target?: string;
  /** Tooltip / aria-label. */
  title?: string;
}

export interface AIMessageData {
  id: string;
  role: AIMessageRole;
  /** Plain text. Pre-wrap; no HTML. */
  content: string;
  /** Wall-clock millisecond timestamp when the message was created. */
  createdAt: number;
  /**
   * When true, the bubble shows the streaming progress bar at the
   * bottom edge. Only meaningful on assistant messages.
   */
  streaming?: boolean;
  /**
   * Set when the server returned a structured campaign draft. When
   * absent we still try `extractDraftHeuristic(content)` so a "Use as
   * draft" CTA can show up for plain-text Subject:/body responses.
   */
  draft?: AIGenerateDraft;
  /**
   * Set when the assistant message represents an error (e.g. AI service
   * unreachable). Renders in muted red and suppresses draft CTAs.
   */
  errored?: boolean;
  /** Safe terminal detail; partial generated content remains in `content`. */
  errorMessage?: string;
  /** The prompt the user typed — kept so Regenerate/Retry can replay. */
  sourcePrompt?: string;
  /** Tone selected at send-time. Free-form string (Tone type lives in PostwaveAI). */
  sourceTone?: string;
  /** Optional requested-context chip strip to render under the bubble. */
  groundingChips?: AIGroundingChip[];
}

interface Props {
  msg: AIMessageData;
  /**
   * Click handler for "Use as draft". Receives the draft skeleton; the
   * The page stages a reviewed handoff and asks the desktop router to move to
   * Campaigns. It never creates or sends a campaign directly.
   */
  onUseDraft?: (draft: AIGenerateDraft) => void;
  /** Replay this assistant turn with the same prompt + tone. */
  onRegenerate?: (msg: AIMessageData) => void;
  /** Same as regenerate, exposed separately for error states. */
  onRetry?: (msg: AIMessageData) => void;
}

/* ---------- helpers ------------------------------------------------- */

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/* ---------- component ---------------------------------------------- */

export function AIMessage({
  msg,
  onUseDraft,
  onRegenerate,
  onRetry,
}: Props): ReactElement {
  const isUser = msg.role === "user";
  const clipboard = useClipboardCopy();

  // Resolve the draft we may surface a CTA for. Server-supplied wins;
  // otherwise run the text-shape heuristic. We compute this once per
  // content change (the streaming case appends to `content`, so the
  // memo recomputes — that's fine, it's cheap regex work).
  const draft = useMemo<AIGenerateDraft | null>(() => {
    if (isUser) return null;
    if (msg.errored) return null;
    if (msg.streaming) return null; // wait until streaming completes
    if (msg.draft) return msg.draft;
    return extractDraftHeuristic(msg.content) ?? null;
  }, [isUser, msg.errored, msg.streaming, msg.draft, msg.content]);

  // Show the CTA only when (a) we have a draft, (b) the server said it's
  // a campaign_draft kind OR the content matches our heuristic.
  const showDraftCta =
    !isUser &&
    !msg.errored &&
    !msg.streaming &&
    draft !== null &&
    (msg.draft !== undefined || looksLikeCampaignDraft(msg.content));

  const cls = isUser
    ? "ai-msg ai-msg-user"
    : msg.errored
      ? "ai-msg ai-msg-assistant ai-msg-errored"
      : "ai-msg ai-msg-assistant";

  const handleUse = (): void => {
    if (draft && onUseDraft) onUseDraft(draft);
  };

  // GAP-2#6: these callbacks + groundingChips were declared on Props and
  // passed by PostwaveAI, but the component rendered none of them. Wire them:
  //   - Regenerate: replay a completed (non-errored) assistant turn.
  //   - Retry: same replay path, surfaced when the turn errored.
  //     (both need the original prompt, which lives on msg.sourcePrompt).
  //   - context chips: the refs requested for this answer. The wire contract
  //     does not yet expose per-ref resolution receipts, so copy stays honest.
  const canRegenerate =
    !isUser &&
    !msg.streaming &&
    !msg.errored &&
    !!msg.sourcePrompt &&
    !!onRegenerate;
  const canRetry =
    !isUser &&
    !msg.streaming &&
    !!msg.errored &&
    !!msg.sourcePrompt &&
    !!onRetry;
  const canCopy = !isUser && !msg.streaming && Boolean(msg.content);
  const chips = !isUser && msg.groundingChips ? msg.groundingChips : [];
  const hasFooter = Boolean(
    (showDraftCta && draft) || canRegenerate || canRetry || canCopy,
  );

  return (
    <article className={cls} aria-busy={msg.streaming || undefined}>
      {!isUser ? (
        <span className="sr-only" role="status" aria-live="polite">
          {msg.streaming
            ? "Moosewave AI is generating a response."
            : msg.errored
              ? "Moosewave AI generation stopped before completion."
              : "Moosewave AI response complete."}
        </span>
      ) : null}
      <header className="ai-msg-head">
        <span className="ai-msg-role">{isUser ? "You" : "Moosewave AI"}</span>
        <span className="ai-msg-time tabular">{fmtTime(msg.createdAt)}</span>
      </header>
      <div className="ai-msg-body">
        {msg.content ? (
          // GAP-2#6: round-trip @[Name](type:id) mention tokens as styled
          // pills in user bubbles instead of leaving them as raw text.
          isUser ? (
            <MentionPreview text={msg.content} />
          ) : (
            msg.content
          )
        ) : msg.streaming ? (
          "​"
        ) : !isUser && !msg.errored ? (
          <span className="muted ai-msg-empty">
            AI service did not return a response. Check that the assistant is
            reachable, then retry.
          </span>
        ) : (
          ""
        )}
      </div>
      {msg.errored ? (
        <div className="ai-msg-error-note" role="alert">
          <strong>
            {msg.content ? "Response interrupted" : "Generation failed"}
          </strong>
          <span>
            {msg.errorMessage ??
              "The response did not complete. Retry when you are ready."}
          </span>
          {msg.content ? (
            <small>
              The partial response above was preserved and was not retried.
            </small>
          ) : null}
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div
          className="ai-msg-grounding"
          aria-label="Context requested for this answer"
        >
          <span className="muted ai-msg-grounding-label">
            Context requested
          </span>
          {chips.map((c) => (
            <span key={c.id} className="badge" title={c.title ?? c.label}>
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {hasFooter ? (
        <footer className="ai-msg-actions">
          {canCopy ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={clipboard.status === "copying"}
              onClick={() =>
                void clipboard.copy(
                  msg.content,
                  { contentClass: "personal", label: "AI response" },
                  "AI response",
                )
              }
            >
              {clipboard.copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {showDraftCta && draft ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleUse}
              >
                Use as draft
              </button>
              {draft.subject ? (
                <span className="ai-msg-action-hint">
                  Subject: {truncate(draft.subject, 56)}
                </span>
              ) : null}
            </>
          ) : null}
          {canRetry ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRetry?.(msg)}
            >
              Retry
            </button>
          ) : null}
          {canRegenerate ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onRegenerate?.(msg)}
            >
              Regenerate
            </button>
          ) : null}
        </footer>
      ) : null}
      <span className="sr-only" {...clipboard.liveRegionProps}>
        {clipboard.announcement}
      </span>
      {msg.streaming ? (
        <div className="ai-streaming-bar" aria-hidden="true" />
      ) : null}
    </article>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
