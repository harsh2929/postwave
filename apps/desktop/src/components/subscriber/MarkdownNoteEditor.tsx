/**
 * MarkdownNoteEditor — SUB-097 rich composer + renderer for subscriber
 * operator notes.
 *
 * Replaces the plain textarea in the Notes tab with:
 *   - a markdown source textarea (the operator types GitHub-flavoured-ish
 *     markdown; we keep the raw source so it round-trips to `markdown_body`),
 *   - an inline `@`-mention typeahead (NoteMentionMenu) that splices
 *     `@[Display](user:UUID)` tokens — the exact shape the backend's mention
 *     extractor parses out of `markdown_body`,
 *   - a live preview rendered by a small, dependency-free markdown renderer
 *     (`renderNoteMarkdown`) that also paints mention tokens as pills.
 *
 * We deliberately ship a tiny hand-rolled renderer rather than pull in
 * react-markdown / remark: the desktop app has no markdown dependency today,
 * notes are short, and the supported subset (headings, bold/italic/code,
 * links, lists, line breaks) covers the operator memo use-case while staying
 * safe (no raw HTML is ever interpreted — everything is escaped first).
 *
 * The file-drop zone + attachment chips live in the parent
 * (SubscriberDetailSlideover) because they touch the notes API and a note id;
 * this component owns the *text* surface only.
 */

import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalLink } from "../ExternalLink";

import {
  NoteMentionMenu,
  buildNoteMentionToken,
  noteMentionOptionId,
  type NoteMentionItem,
} from "./NoteMentionMenu";

/* ===================================================================== *
 *  Markdown rendering (read-only)
 * ===================================================================== */

const MENTION_RE =
  /@\[([^\]]{1,200})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

interface MentionSeg {
  kind: "mention";
  display: string;
  id: string;
}
interface TextSeg {
  kind: "text";
  text: string;
}
type Seg = MentionSeg | TextSeg;

/** Split a line into plain-text and mention segments. */
function splitMentions(line: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(line); m; m = MENTION_RE.exec(line)) {
    if (m.index > last)
      out.push({ kind: "text", text: line.slice(last, m.index) });
    out.push({ kind: "mention", display: m[1].trim(), id: m[2].toLowerCase() });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}

/** Render inline markdown spans (bold / italic / code / link) plus mention
 *  pills inside a single line, as React nodes. Order of application keeps
 *  things simple and predictable for short operator memos. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segs = splitMentions(line);
  segs.forEach((seg, si) => {
    if (seg.kind === "mention") {
      nodes.push(
        <span
          key={`${keyPrefix}-m-${si}`}
          className="note-mention-token"
          title={`user ${seg.id}`}
        >
          @{seg.display}
        </span>,
      );
      return;
    }
    nodes.push(...renderTextSpans(seg.text, `${keyPrefix}-t-${si}`));
  });
  return nodes;
}

// Inline span matcher: code, bold, italic, and [text](url) links. Code is
// matched first (and its contents are NOT further parsed) so `**x**` inside
// backticks stays literal.
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function renderTextSpans(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
    if (m.index > last) {
      // React escapes text nodes automatically — no raw HTML is ever
      // interpreted, so plain fragments are safe to push verbatim.
      nodes.push(text.slice(last, m.index));
    }
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={key} className="note-md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      // [label](url)
      const close = tok.indexOf("]");
      const label = tok.slice(1, close);
      const url = tok.slice(close + 2, -1);
      const safe = /^https?:\/\//i.test(url) ? url : undefined;
      nodes.push(
        safe ? (
          <ExternalLink key={key} href={safe}>
            {label}
          </ExternalLink>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Render a markdown note body to React nodes. Supports: ATX headings
 * (`#`..`###`), unordered (`- ` / `* `) and ordered (`1. `) lists, blank-line
 * paragraph breaks, and the inline spans handled by renderInline. Unknown
 * syntax degrades to plain text — never throws, never injects HTML.
 */
export function renderNoteMarkdown(src: string): ReactElement {
  const lines = (src ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let listBuf: ReactNode[] = [];
  let listOrdered = false;
  let key = 0;

  const flushList = () => {
    if (listBuf.length === 0) return;
    const items = listBuf;
    blocks.push(
      listOrdered ? (
        <ol key={`b-${key++}`} className="note-md-list">
          {items}
        </ol>
      ) : (
        <ul key={`b-${key++}`} className="note-md-list">
          {items}
        </ul>
      ),
    );
    listBuf = [];
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const content = renderInline(heading[2], `h-${li}`);
      blocks.push(
        level === 1 ? (
          <div key={`b-${key++}`} className="note-md-h1">
            {content}
          </div>
        ) : level === 2 ? (
          <div key={`b-${key++}`} className="note-md-h2">
            {content}
          </div>
        ) : (
          <div key={`b-${key++}`} className="note-md-h3">
            {content}
          </div>
        ),
      );
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const wantOrdered = !!ol;
      if (listBuf.length > 0 && wantOrdered !== listOrdered) flushList();
      listOrdered = wantOrdered;
      listBuf.push(
        <li key={`li-${li}`}>{renderInline((ul ?? ol)![1], `li-${li}`)}</li>,
      );
      continue;
    }
    flushList();
    blocks.push(
      <p key={`b-${key++}`} className="note-md-p">
        {renderInline(line, `p-${li}`)}
      </p>,
    );
  }
  flushList();

  return <div className="note-md">{blocks}</div>;
}

/* ===================================================================== *
 *  Composer
 * ===================================================================== */

interface EditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Workspace users this operator can @-mention (parent-derived). */
  mentionCandidates: NoteMentionItem[];
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Cmd/Ctrl+Enter handler (submit) — optional. */
  onSubmit?: () => void;
  ariaLabel?: string;
}

/** Internal @-trigger state. start = index of the `@` in the source. */
interface TriggerState {
  start: number;
  query: string;
}

function detectTrigger(value: string, caret: number): TriggerState | null {
  // Walk backwards from the caret to the nearest `@` not preceded by a
  // word char (so "email@x" doesn't trigger). Abort on whitespace/newline.
  let i = caret - 1;
  let query = "";
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const before = i > 0 ? value[i - 1] : " ";
      if (/\s|[([{]/.test(before) || i === 0) {
        return { start: i, query };
      }
      return null;
    }
    if (/\s/.test(ch) || ch === "]" || ch === ")") return null;
    query = ch + query;
    if (query.length > 60) return null;
    i--;
  }
  return null;
}

function triggerFingerprint(value: string, caret: number): string {
  return `${caret}\u0000${value}`;
}

export function MarkdownNoteEditor({
  value,
  onChange,
  mentionCandidates,
  disabled,
  placeholder,
  maxLength,
  onSubmit,
  ariaLabel,
}: EditorProps): ReactElement {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionListboxId = `${useId()}-note-mention-options`;
  const previewGuidanceId = useId();
  const composingRef = useRef(false);
  const dismissedTriggerRef = useRef<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo<NoteMentionItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    const matches = q
      ? mentionCandidates.filter(
          (c) =>
            c.display.toLowerCase().includes(q) ||
            (c.hint ?? "").toLowerCase().includes(q) ||
            c.id.toLowerCase().startsWith(q),
        )
      : mentionCandidates;
    return matches.slice(0, 8);
  }, [trigger, mentionCandidates]);

  const menuOpen = trigger != null && !disabled && !preview;
  const boundedActiveIndex =
    filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);
  const activeMention = menuOpen ? filtered[boundedActiveIndex] : undefined;

  const recomputeTrigger = (next: string, caret: number) => {
    const fingerprint = triggerFingerprint(next, caret);
    if (dismissedTriggerRef.current === fingerprint) {
      setTrigger(null);
      return;
    }
    dismissedTriggerRef.current = null;
    const t = detectTrigger(next, caret);
    setTrigger(t);
    setActiveIndex(0);
  };

  const commitMention = (item: NoteMentionItem) => {
    if (!trigger) return;
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : value.length;
    const token = buildNoteMentionToken(item);
    const next =
      value.slice(0, trigger.start) + token + " " + value.slice(caret);
    onChange(next);
    dismissedTriggerRef.current = null;
    setTrigger(null);
    // Restore caret just past the inserted token + trailing space.
    const pos = trigger.start + token.length + 1;
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      composingRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229
    ) {
      return;
    }
    const isPlainCommitKey = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (menuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedTriggerRef.current = triggerFingerprint(
          e.currentTarget.value,
          e.currentTarget.selectionStart,
        );
        setTrigger(null);
        setActiveIndex(0);
        return;
      }
      if (filtered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
          return;
        }
        if (e.key === "Enter" && isPlainCommitKey) {
          e.preventDefault();
          const item = filtered[boundedActiveIndex];
          if (item) commitMention(item);
          return;
        }
        if (e.key === "Tab" && !e.shiftKey && isPlainCommitKey) {
          e.preventDefault();
          const item = filtered[boundedActiveIndex];
          if (item) commitMention(item);
          return;
        }
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="note-editor">
      <div className="note-editor-toolbar">
        <button
          type="button"
          className={`btn btn-xs ${preview ? "btn-ghost" : "btn-primary"}`}
          onClick={() => setPreview(false)}
          aria-pressed={!preview}
        >
          Write
        </button>
        <button
          type="button"
          className={`btn btn-xs ${preview ? "btn-primary" : "btn-ghost"}`}
          onClick={() => {
            if (value.trim()) setPreview(true);
          }}
          aria-pressed={preview}
          aria-disabled={!value.trim() || undefined}
          aria-describedby={previewGuidanceId}
        >
          Preview
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <span id={previewGuidanceId} className="note-editor-hint muted">
          {value.trim()
            ? "Preview renders the current Markdown · type @ to mention"
            : "Add note text to enable Preview · type @ to mention"}
        </span>
      </div>

      {preview ? (
        <div className="note-editor-preview">
          {value.trim() ? (
            renderNoteMarkdown(value)
          ) : (
            <span className="muted">Nothing to preview.</span>
          )}
        </div>
      ) : (
        <div className="note-editor-input-wrap">
          <textarea
            ref={taRef}
            className="input note-editor-textarea"
            rows={4}
            maxLength={maxLength}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            aria-label={ariaLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? mentionListboxId : undefined}
            aria-activedescendant={
              activeMention
                ? noteMentionOptionId(mentionListboxId, activeMention)
                : undefined
            }
            onChange={(e) => {
              onChange(e.target.value);
              recomputeTrigger(e.target.value, e.target.selectionStart);
            }}
            onKeyUp={(e) => {
              if (composingRef.current || e.nativeEvent.isComposing) return;
              if (
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "Home" ||
                e.key === "End"
              ) {
                recomputeTrigger(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                );
              }
            }}
            onClick={(e) =>
              recomputeTrigger(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
              )
            }
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              recomputeTrigger(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
              );
            }}
            onBlur={() => {
              // Defer so a pointer row-select can land first.
              requestAnimationFrame(() => setTrigger(null));
            }}
          />
          <NoteMentionMenu
            open={menuOpen}
            listboxId={mentionListboxId}
            items={filtered}
            activeIndex={boundedActiveIndex}
            query={trigger?.query ?? ""}
            onSelect={commitMention}
            onHover={setActiveIndex}
          />
        </div>
      )}
    </div>
  );
}
