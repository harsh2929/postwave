/**
 * Per-failure-mode error banners shown by the migration UI.
 *
 *   - <AuthFailedBanner />        — invalid credential / OAuth refresh failed
 *   - <SourceUnavailableBanner /> — provider 5xx or network blackhole
 *   - <PartialImportBanner />     — some resources OK, others failed
 *   - <CancelledBanner />         — operator stopped mid-import
 *
 * They compose the canonical Banner shell so domain recovery logic does not
 * fork announcement, forced-colour, border, or radius behavior.
 */

import { type ReactElement } from "react";

import { Banner } from "../Banner";

interface ActionButton {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}

function ActionRow({ actions }: { actions: ActionButton[] }): ReactElement {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      {actions.map((a, i) => (
        <button
          key={i}
          type="button"
          className={
            a.variant === "primary"
              ? "btn btn-primary btn-sm"
              : a.variant === "danger"
                ? "btn btn-danger btn-sm"
                : "btn btn-sm"
          }
          onClick={a.onClick}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

export function AuthFailedBanner({
  onReenter,
  message,
  credentialLabel = "API key",
}: {
  onReenter: () => void;
  message?: string;
  credentialLabel?: string;
}): ReactElement {
  return (
    <Banner
      tone="danger"
      title="Authentication failed"
      action={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onReenter}
        >
          Re-enter {credentialLabel}
        </button>
      }
    >
      <span>{message ?? authFailedDefaultMessage(credentialLabel)}</span>
      <p style={{ margin: "4px 0 0", fontSize: 12 }}>
        If this happened during commit, review the migration&apos;s tracked
        partial writes and rollback availability before retrying.
      </p>
    </Banner>
  );
}

export function authFailedDefaultMessage(credentialLabel = "API key"): string {
  return `Re-enter your ${credentialLabel} — it might have expired or been revoked.`;
}

export function SourceUnavailableBanner({
  sourceLabel,
}: {
  sourceLabel: string;
}): ReactElement {
  return (
    <Banner
      tone="warning"
      announcement="polite"
      title={`${sourceLabel} is unreachable right now`}
    >
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        We can&apos;t reach {sourceLabel} from this region. The current run has
        stopped. When the API is back, reopen the migration and follow its
        available resume, retry, or rollback action; inspect tracked partial
        writes first.
      </p>
    </Banner>
  );
}

export interface PartialImportFailure {
  resource: string;
  /** "1500 subscribers imported" / "Segments couldn't be created" */
  message: string;
}

export function PartialImportBanner({
  failures,
  onRetry,
  onSkip,
}: {
  failures: PartialImportFailure[];
  onRetry: (resource: string) => void;
  onSkip: () => void;
}): ReactElement {
  return (
    <Banner tone="warning" announcement="assertive" title="Partial import">
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {failures.map((f, i) => (
          <li key={i} style={{ fontSize: 12 }}>
            {f.message}
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => onRetry(f.resource)}
            >
              Retry {f.resource}
            </button>
          </li>
        ))}
      </ul>
      <ActionRow actions={[{ label: "Skip and continue", onClick: onSkip }]} />
    </Banner>
  );
}

export function CancelledBanner({
  importedSubscribers,
  onView,
  onRollback,
  onResume,
}: {
  importedSubscribers: number;
  onView: () => void;
  onRollback: () => void;
  /**
   * Wires POST /migrations/{id}/resume (restart from the last
   * checkpoint). Optional so call sites that haven't plumbed the
   * confirm flow yet simply don't render the button.
   */
  onResume?: () => void;
}): ReactElement {
  const actions: ActionButton[] = [];
  if (onResume) {
    actions.push({ label: "Resume", onClick: onResume, variant: "primary" });
  }
  actions.push({
    label: "View imported subscribers",
    onClick: onView,
    variant: onResume ? "secondary" : "primary",
  });
  actions.push({ label: "Roll back", onClick: onRollback, variant: "danger" });
  return (
    <Banner tone="neutral" announcement="polite" title="Import cancelled">
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        We&apos;ve kept the {importedSubscribers.toLocaleString()} subscriber
        {importedSubscribers === 1 ? "" : "s"} we imported so far.{" "}
        {onResume
          ? "Resume to continue from the last checkpoint, or roll back to undo what we committed."
          : "To finish the rest, start a fresh migration. Or roll back to undo what we committed."}
      </p>
      <ActionRow actions={actions} />
    </Banner>
  );
}
