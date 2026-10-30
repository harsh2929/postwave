/**
 * SubjectLineSuggestions — inline AI panel that streams 3 subject-line
 * variants from the voice service while the user types. Mounts when the
 * subject input has ≥ 10 characters; the parent decides when to show it.
 *
 * Endpoint: POST /api/v1/voice/generate (kind: "subject_line"). The
 * voice handler asks the AI model for a numbered list (1-5 by default, see
 * services/voice/internal/handlers/chat.go promptForKind) — we parse
 * the streamed text into the first 3 enumerated lines so the UI can
 * present 3 stable slots.
 *
 * Honest-fallback policy: if the SSE stream errors or the voice
 * service is not configured (HTTP 503 / 404), we surface a muted
 * "AI service unavailable" message rather than fabricating variants.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { streamAIGenerate, type AIStreamHandle } from "../lib/ai-client";

interface Props {
  /** The subject the user has typed so far. Used as the prompt brief. */
  currentSubject: string;
  /** Optional voice profile id — passed through as a context ref so the
   *  voice service can apply tenant-specific tone. The chat handler
   *  doesn't yet have a typed "voice_profile" ref kind, but the desktop
   *  forwards it as a generic ref so it lights up automatically. */
  voiceProfileId?: string | null;
  /** Called when the user clicks "Use this" on a variant. */
  onPickVariant: (text: string) => void;
  /** Optional callback for the "A/B test all three" button. When
   *  omitted, the button is hidden. */
  onTestAll?: (variants: string[]) => void;
  /** G11: optional callback for the "Open Subject Lab" header button.
   *  When omitted, the button is hidden (older callers stay
   *  backwards-compatible). */
  onOpenLab?: () => void;
}

/** Strip leading list markers ("1.", "1)", "- ", "• ") + surrounding
 *  quotes / asterisks from a single line. */
function cleanVariant(line: string): string {
  let s = line.trim();
  // List prefix: "1." / "1)" / "(1)" / "1 -" / "- " / "• "
  s = s.replace(/^(?:\(?\d+\)?[.):\-]\s*|[-•*]\s+)/, "");
  // Strip wrapping quotes or surrounding bold/italic markers.
  s = s.replace(/^["'“‘*_]+|["'”’*_]+$/g, "");
  return s.trim();
}

/**
 * Pull up to 3 subject-line variants out of the streamed-so-far text.
 * Tolerates the model emitting more than 5 (we take the first 3) or
 * fewer than 3 (we surface skeleton placeholders for the rest while
 * the stream finishes).
 */
function parseVariants(text: string): string[] {
  if (!text) return [];
  // Prefer numbered-list lines because the system prompt asks for
  // "Number them 1–5". Fall back to non-empty lines.
  const lines = text.split(/\r?\n/);
  const numbered: string[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*\(?(\d+)\)?[.):\-]\s*(.+)$/);
    if (m && m[2]) {
      numbered.push(cleanVariant(m[2]));
      if (numbered.length >= 3) break;
    }
  }
  if (numbered.length > 0) return numbered;
  // Fallback: any non-empty trimmed line.
  return lines
    .map((l) => cleanVariant(l))
    .filter(Boolean)
    .slice(0, 3);
}

export function SubjectLineSuggestions({
  currentSubject,
  voiceProfileId,
  onPickVariant,
  onTestAll,
  onOpenLab,
}: Props): ReactElement {
  const [streamText, setStreamText] = useState<string>("");
  const [done, setDone] = useState<boolean>(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const handleRef = useRef<AIStreamHandle | null>(null);
  const requestRef = useRef(0);
  const statusId = useId();
  const labHelpId = useId();

  // Debounce the stream against subject changes so we don't kick off
  // a new generation on every keystroke. 500ms is short enough to feel
  // live, long enough to avoid spamming Claude.
  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!currentSubject || currentSubject.trim().length < 10) {
      handleRef.current?.abort();
      handleRef.current = null;
      setStreamText("");
      setDone(false);
      setErrMsg(null);
      return;
    }
    const t = window.setTimeout(() => {
      // Cancel any in-flight stream before starting a new one.
      handleRef.current?.abort();
      handleRef.current = null;
      setStreamText("");
      setDone(false);
      setErrMsg(null);
      const prompt =
        `Generate 3 high-performing subject-line alternatives for the ` +
        `following draft. Match the user's tone and intent. Return them ` +
        `as a numbered list (1., 2., 3.) — one subject per line, no ` +
        `commentary.\n\nDraft subject: ${currentSubject.trim()}`;
      try {
        const handle = streamAIGenerate(
          {
            prompt,
            kind: "subject_line",
            contextRefs: voiceProfileId
              ? [{ type: "voice_profile", id: voiceProfileId }]
              : [],
          },
          {
            onDelta: (chunk) => {
              if (requestRef.current !== requestId) return;
              setStreamText((prev) => prev + chunk);
            },
            onDone: () => {
              if (requestRef.current !== requestId) return;
              setDone(true);
            },
            onError: (msg) => {
              if (requestRef.current !== requestId) return;
              setErrMsg(msg || "The generation stream ended unexpectedly.");
              setDone(true);
            },
          },
        );
        if (requestRef.current === requestId) handleRef.current = handle;
        else handle.abort();
      } catch (error) {
        if (requestRef.current !== requestId) return;
        setErrMsg(
          error instanceof Error && error.message.trim()
            ? error.message
            : "The generation stream couldn't be started.",
        );
        setDone(true);
      }
    }, 500);
    return () => {
      window.clearTimeout(t);
      if (requestRef.current === requestId) {
        requestRef.current += 1;
        handleRef.current?.abort();
        handleRef.current = null;
      }
    };
  }, [currentSubject, retryNonce, voiceProfileId]);

  // Cleanup the in-flight stream on unmount.
  useEffect(() => {
    return () => {
      requestRef.current += 1;
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  const variants = parseVariants(streamText);
  const slots: Array<string | null> = [
    variants[0] ?? null,
    variants[1] ?? null,
    variants[2] ?? null,
  ];

  if (errMsg) {
    return (
      <div className="ai-banner ai-banner-muted" role="alert">
        <span className="ai-banner-icon" aria-hidden="true">
          ◐
        </span>
        <div className="ai-banner-body">
          <span className="muted" style={{ fontSize: 12 }}>
            AI subject-line suggestions unavailable: {errMsg}
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Your current subject is unchanged. Retry when the voice service is
            available.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRetryNonce((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="ai-suggestions"
      role="region"
      aria-label="AI subject-line suggestions"
      aria-busy={!done}
      aria-describedby={statusId}
    >
      <div className="ai-suggestions-header">
        <span className="ai-banner-icon" aria-hidden="true">
          ✦
        </span>
        <span className="ai-suggestions-title">
          AI proposed 3 variants based on your voice profile
        </span>
        {onTestAll && done && variants.length === 3 ? (
          <>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onTestAll(variants)}
            >
              A/B test all three
            </button>
          </>
        ) : null}
        {onOpenLab ? (
          <>
            {!(onTestAll && done && variants.length === 3) ? (
              <span className="spacer" />
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              onClick={onOpenLab}
              aria-describedby={labHelpId}
            >
              Open Subject Lab
            </button>
          </>
        ) : null}
      </div>
      {onOpenLab ? (
        <p id={labHelpId} className="ai-suggestions-guidance muted">
          Subject Lab generates 5–8 axis-conditioned variants with confidence
          scores.
        </p>
      ) : null}
      <ul className="ai-suggestions-list">
        {slots.map((text, idx) => (
          <li key={idx} className="ai-suggestion-row">
            <span className="ai-suggestion-index">{idx + 1}.</span>
            {text ? (
              <span className="ai-suggestion-text">{text}</span>
            ) : done ? (
              <span
                id={`${statusId}-missing-${idx}`}
                className="ai-suggestion-text muted"
              >
                No variant returned for this slot.
              </span>
            ) : (
              <span
                className="skel"
                style={{ flex: 1, height: 12 }}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => text && onPickVariant(text)}
              disabled={!text && !done}
              aria-disabled={!text && done ? true : undefined}
              aria-describedby={
                !text && done ? `${statusId}-missing-${idx}` : undefined
              }
            >
              Use this
            </button>
          </li>
        ))}
      </ul>
      <div
        id={statusId}
        className="ai-suggestions-footer muted"
        style={{ fontSize: 11 }}
        role="status"
        aria-live="polite"
      >
        {!done
          ? "Generating three variants…"
          : `${variants.length} of 3 variants ready.`}
      </div>
    </div>
  );
}
