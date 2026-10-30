/**
 * InlineEmailEdit (SUB-087)
 *
 * The canonical email cell in the Subscribers list. Click (the pencil
 * affordance, or the address itself) to turn the cell into an inline text
 * field; Enter commits, Escape cancels, blur commits. Follows the same
 * lightweight inline-edit pattern as `AddTagButton` in InlineTagChip.tsx.
 *
 * The component is presentation + local edit state only. The actual
 * optimistic PATCH, row mutation, error rollback, and the undo toast all
 * live in the parent (Subscribers.tsx `renameEmailWithUndo`) — this
 * component just hands the trimmed new address up via `onCommit` when it
 * differs from the current one and passes a syntax check.
 */

import { type ReactElement, useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  /** The current canonical email for this row. */
  email: string;
  /** Whether the operator may edit (write permission + a real row id). */
  canEdit: boolean;
  /** Commit a new, syntactically-valid, changed address. */
  onCommit: (next: string) => void;
}

export function InlineEmailEdit({
  email,
  canEdit,
  onCommit,
}: Props): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email);
  const [invalid, setInvalid] = useState(false);

  const begin = (): void => {
    setValue(email);
    setInvalid(false);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setInvalid(false);
    setValue(email);
  };

  const commit = (): void => {
    const next = value.trim();
    if (next === "" || next === email) {
      cancel();
      return;
    }
    if (!EMAIL_RE.test(next)) {
      // Keep the field open so the operator can fix it; flag visually.
      setInvalid(true);
      return;
    }
    setEditing(false);
    setInvalid(false);
    onCommit(next);
  };

  if (editing) {
    return (
      <input
        type="email"
        value={value}
        aria-label="Edit email address"
        aria-invalid={invalid || undefined}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={commit}
        className="input"
        style={{
          fontSize: 12,
          padding: "1px 4px",
          height: 22,
          width: "100%",
          minWidth: 0,
          borderColor: invalid ? "var(--pw-danger)" : undefined,
        }}
      />
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {email}
      </span>
      {canEdit ? (
        <button
          type="button"
          className="btn-icon-ghost sub-email-edit-btn"
          aria-label={`Edit email ${email}`}
          onClick={(e) => {
            e.stopPropagation();
            begin();
          }}
          style={{
            flexShrink: 0,
            background: "transparent",
            border: 0,
            padding: 0,
            cursor: "pointer",
            color: "var(--pw-fg-subtle)",
            display: "inline-flex",
            opacity: 0.65,
          }}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}
