import { type ReactElement, useEffect, useId, useRef, useState } from "react";

interface InlineTagChipProps {
  tag: string;
  onRemove?: () => void | Promise<void>;
  removable?: boolean;
}

export function InlineTagChip({
  tag,
  onRemove,
  removable = true,
}: InlineTagChipProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const remove = async (): Promise<void> => {
    if (!onRemove || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRemoveError(null);
    try {
      await onRemove();
    } catch (error) {
      if (activeRef.current) {
        setRemoveError(
          error instanceof Error && error.message
            ? error.message
            : "Tag could not be removed.",
        );
      }
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  };

  return (
    <span
      className="chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        fontSize: 11,
        lineHeight: 1.4,
        background: "color-mix(in srgb, var(--pw-accent) 12%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--pw-accent) 22%, transparent)",
        borderRadius: 10,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>{tag}</span>
      {removable && onRemove ? (
        <button
          type="button"
          aria-label={`Remove tag ${tag}`}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={(e) => {
            e.stopPropagation();
            void remove();
          }}
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            margin: 0,
            cursor: busy ? "wait" : "pointer",
            color: "inherit",
            fontSize: 12,
            lineHeight: 1,
            minWidth: 24,
            minHeight: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.7,
          }}
        >
          {busy ? "…" : "×"}
        </button>
      ) : null}
      {removeError ? (
        <span className="muted small" role="alert">
          Remove failed: {removeError}
        </span>
      ) : null}
    </span>
  );
}

interface AddTagButtonProps {
  onAdd: (tag: string) => void | Promise<void>;
}

/**
 * SUB-090 — split a raw tag input into individual tags. Operators routinely
 * paste a comma- or newline-separated list ("vip, churned, q3" or one per
 * line) and expect each to land as its own chip. Splitting on comma /
 * newline / tab / semicolon covers the common clipboard shapes; each tag is
 * trimmed, blanks dropped, and duplicates within the paste de-duped (the
 * caller's onAdd already no-ops tags already on the row).
 */
function parsePastedTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n\r\t;]+/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function AddTagButton({ onAdd }: AddTagButtonProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(true);
  const composingRef = useRef(false);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      return;
    }
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  const closeEditor = (restoreFocus: boolean): void => {
    restoreFocusRef.current = restoreFocus;
    setEditing(false);
    setValue("");
    setError(null);
  };

  /**
   * SUB-090 — commit one or many tags. A single token takes the original
   * single-tag path; a comma/newline-separated list is split and each tag is
   * committed in turn via the same single-tag onAdd handler (so the parent's
   * per-tag bulk endpoint + de-dupe stay authoritative). The input stays
   * disabled while the batch commits.
   */
  const commit = async (restoreFocus: boolean): Promise<void> => {
    if (busyRef.current) return;
    const tags = parsePastedTags(value);
    if (tags.length === 0) {
      closeEditor(restoreFocus);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const t of tags) {
        await onAdd(t);
      }
      if (activeRef.current) closeEditor(restoreFocus);
    } catch (commitError) {
      if (activeRef.current) {
        setError(
          commitError instanceof Error && commitError.message
            ? commitError.message
            : "Tags could not be added.",
        );
      }
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setEditing(true);
        }}
        style={{
          fontSize: 11,
          padding: "0 4px",
          minHeight: 24,
          color: "var(--pw-fg-muted)",
        }}
      >
        + Tag
      </button>
    );
  }
  return (
    <span
      style={{
        display: "inline-grid",
        gap: 4,
        maxWidth: "min(260px, 100%)",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        readOnly={busy}
        aria-busy={busy || undefined}
        aria-describedby={helpId}
        aria-label="Tags to add"
        onChange={(e) => setValue(e.target.value)}
        onClick={(event) => event.stopPropagation()}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (
            composingRef.current ||
            e.nativeEvent.isComposing ||
            e.nativeEvent.keyCode === 229
          ) {
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void commit(true);
          } else if (e.key === "Escape" && !busyRef.current) {
            e.preventDefault();
            closeEditor(true);
          }
        }}
        onBlur={() => {
          if (!composingRef.current) void commit(false);
        }}
        placeholder="tag… (comma or paste list)"
        style={{
          fontSize: 11,
          padding: "1px 4px",
          width: 160,
          maxWidth: "100%",
          border: "1px solid var(--pw-border)",
          borderRadius: 3,
          background: "var(--pw-bg)",
        }}
      />
      <span
        id={helpId}
        className="muted small"
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {busy
          ? "Adding tags…"
          : error
            ? `Add failed: ${error}. Some tags may already be present; retrying is safe.`
            : "Enter one tag, or paste a comma/newline-separated list. Enter saves; Escape cancels."}
      </span>
    </span>
  );
}
