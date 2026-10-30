/**
 * SuppressionDetailSlideover — per-row drill-down for a single
 * suppressed address (GAP-LS-007 + 024).
 *
 * Renders source attribution (campaign/message/bounce code/provider
 * event), expiry status, channel + scope, and a PAGED audit-log
 * timeline pulled from GET /api/v1/suppressions/{email}/audit via
 * `suppressionsApi.audit`. The audit endpoint is live now — errors
 * surface honestly (no more degrade-to-empty); only a 404/501 from an
 * older build renders the "endpoint missing" note.
 *
 * Un-suppress (Remove) action is admin-gated by the parent — when
 * passed, we render the button; otherwise it stays hidden.
 */

import { type ReactElement, useEffect, useState } from "react";

import "../../styles-suppressions-popovers.css";

import {
  type SuppressionAuditEntry,
  type SuppressionEntry,
  type SuppressionRow,
  suppressionsApi,
  suppressionsConvergedApi,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { SlideoverShell } from "../SlideoverShell";

/**
 * Canonical X1 reason labels — duplicated across the suppressions UI
 * surfaces (page, stat strip, slideover) to keep each file self-
 * contained. Keep in sync with SUPPRESSION_REASONS_X1 in api-client.ts.
 */
export const CANONICAL_REASON_LABELS: Readonly<Record<string, string>> = {
  hard_bounce: "Hard bounce",
  spam_complaint: "Spam complaint",
  manual_unsubscribe: "Manual unsubscribe",
  list_manual: "List manual",
  global_unsubscribe: "Global unsubscribe",
  soft_bounce_threshold: "Soft-bounce threshold",
  dsar_deletion: "DSAR deletion",
  role_address: "Role address",
  invalid_email: "Invalid email",
  blocklist_auto: "Auto blocklist",
  spam_trap: "Spam trap",
  // SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy (store.go).
  soft_bounce: "Soft bounce",
  complaint: "Complaint",
  list_unsub_header: "List-unsubscribe header",
  spamtrap: "Spam trap",
  role_account: "Role account",
  dns_failure: "DNS failure",
  invalid_address: "Invalid address",
  // Legacy / pre-canonical values still surface from old rows.
  manual: "Manual",
  unsubscribe: "Unsubscribed",
  imported: "Imported",
};

/**
 * Canonical danger / warning / info / neutral classification for badge
 * styling. SUB-047 / SUB-048 extended this with the rich taxonomy:
 *   danger  → permanent / abuse signals (hard bounce, complaint, spam
 *             trap, DNS failure, invalid address, auto-blocklist)
 *   warning → transient / address-quality signals (soft bounce,
 *             unsubscribes, role account)
 *   info    → RFC 8058 one-click list-unsubscribe header
 *   muted   → operator / compliance reasons (manual unsub, DSAR)
 */
function badgeTone(
  r: string,
): "danger" | "warning" | "info" | "muted" | "neutral" {
  switch (r) {
    case "hard_bounce":
    case "spam_complaint":
    case "spam_trap":
    case "spamtrap":
    case "blocklist_auto":
    case "dns_failure":
    case "invalid_address":
    case "invalid_email":
      return "danger";
    case "complaint":
    case "soft_bounce":
    case "soft_bounce_threshold":
    case "role_account":
    case "role_address":
    case "manual_unsubscribe":
    case "global_unsubscribe":
    case "unsubscribe":
    case "list_manual":
      return "warning";
    case "list_unsub_header":
      return "info";
    case "dsar_deletion":
      return "muted";
    default:
      return "neutral";
  }
}

export function reasonLabel(reason: string | undefined): string {
  const r = (reason ?? "").toLowerCase();
  return CANONICAL_REASON_LABELS[r] ?? reason ?? "—";
}

export function reasonBadge(reason: string | undefined): ReactElement {
  const r = (reason ?? "").toLowerCase();
  const tone = badgeTone(r);
  const cls =
    tone === "danger"
      ? "badge danger suppression-reason-badge"
      : tone === "warning"
        ? "badge warning suppression-reason-badge"
        : tone === "info"
          ? "badge info suppression-reason-badge"
          : "badge suppression-reason-badge";
  return <span className={cls}>{reasonLabel(reason)}</span>;
}

interface Props {
  row: SuppressionRow;
  /** Admin-only remove action. Hidden when undefined. */
  onRemove?: () => void;
  onClose: () => void;
}

/** Page size of the audit timeline inside the slideover. */
const AUDIT_PAGE_SIZE = 10;

interface SuppressionAuditTimelineProps {
  items: SuppressionAuditEntry[];
  total: number | null;
  page: number;
  pages: number | null;
  loading: boolean;
  unavailable: boolean;
  error: string | null;
  onPrevious: () => void;
  onNext: () => void;
}

function SuppressionAuditTimeline({
  items,
  total,
  page,
  pages,
  loading,
  unavailable,
  error,
  onPrevious,
  onNext,
}: SuppressionAuditTimelineProps): ReactElement {
  return (
    <div>
      <div className="label">Audit timeline</div>
      {loading ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : unavailable ? (
        <div className="muted" style={{ fontSize: 12 }}>
          This server build doesn&apos;t expose the suppression audit endpoint
          yet.
        </div>
      ) : error ? (
        <div className="field-error" style={{ fontSize: 12 }}>
          Couldn&apos;t load the audit trail: {error}
        </div>
      ) : items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No audit entries for this address yet.
        </div>
      ) : (
        <>
          <div
            style={{
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {items.map((entry, index) => (
              <AuditRow
                key={entry.id ?? `${entry.created_at}-${index}`}
                entry={entry}
              />
            ))}
          </div>
          {pages != null && pages > 1 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                fontSize: 12,
              }}
            >
              <button
                type="button"
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={onPrevious}
              >
                Prev
              </button>
              <span className="muted">
                Page {page} of {pages} · {total?.toLocaleString()} event
                {total === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={page >= pages}
                onClick={onNext}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function SuppressionDetailSlideoverBody({
  row,
  onRemove,
  onClose,
}: Props): ReactElement {
  const [entry, setEntry] = useState<SuppressionEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  /* Audit timeline — real paged rows from suppressionsApi.audit. */
  const [auditItems, setAuditItems] = useState<SuppressionAuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState<number | null>(null);
  const [auditPage, setAuditPage] = useState<number>(1);
  const [auditLoading, setAuditLoading] = useState<boolean>(true);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  /** True when an older server build never mounted the audit route. */
  const [auditUnavailable, setAuditUnavailable] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      setLoading(true);
      setErr(null);
      // Fetch the X1 converged entry. The call falls back to 404
      // cleanly when the legacy row has not been promoted to X1 yet —
      // we still render the basic row we already have in that case.
      const entryRes = await suppressionsConvergedApi.get(row.email);
      if (cancelled) return;
      if (entryRes.error) {
        setEntry(null);
        const ea = entryRes.error;
        const isMissing =
          ea.kind === "http" && (ea.status === 404 || ea.status === 501);
        if (!isMissing) setErr(ea.message);
      } else {
        setEntry(entryRes.data);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row.email]);

  // Reset paging when the slideover is reused for another address.
  useEffect(() => {
    setAuditPage(1);
  }, [row.email]);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      setAuditLoading(true);
      setAuditErr(null);
      const res = await suppressionsApi.audit(row.email, {
        page: auditPage,
        size: AUDIT_PAGE_SIZE,
      });
      if (cancelled) return;
      if (res.error) {
        const status = res.error.status ?? 0;
        if (res.error.kind === "http" && (status === 404 || status === 501)) {
          // Older build without the route — informational, not an error.
          setAuditUnavailable(true);
        } else {
          setAuditErr(res.error.message);
        }
        setAuditItems([]);
        setAuditTotal(null);
      } else {
        setAuditUnavailable(false);
        setAuditItems(res.data.items ?? []);
        setAuditTotal(
          typeof res.data.total === "number" ? res.data.total : null,
        );
      }
      setAuditLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row.email, auditPage]);

  const auditPages =
    auditTotal != null
      ? Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE))
      : null;

  const reason = entry?.reason ?? row.reason;

  // Permanent vs reversible suppression — null/absent expires_at means
  // the row never auto-expires. Surface this prominently because some
  // reasons (hard_bounce, spam_complaint) are non-reversible per ESP
  // policy (GAP-LS-037).
  //
  // D05-consent-suppressions#17: `entry` is null both for legacy-only
  // rows (converged get → honest 404) and for genuine lookup errors, so
  // only assert "Permanent" when the converged entry actually loaded and
  // carries no expiry. When the entry is absent the expiry is UNKNOWN,
  // not permanent — fabricating certainty here misreports a compliance
  // drill-down. (The legacy list row's own expires_at isn't exposed on
  // the desktop SuppressionRow type, so we can't surface it here without
  // a list-shape change.)
  const hasEntry = entry != null;
  const expiresLabel = !hasEntry
    ? "Unknown"
    : entry?.expires_at
      ? fmtDateTime(entry.expires_at)
      : "Permanent";

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="md"
      eyebrow="Suppression"
      title={row.email}
      subtitle={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {reasonBadge(reason)}
          <span className="muted" style={{ fontSize: 11 }}>
            Added {fmtDateTime(entry?.created_at ?? row.created_at)}
          </span>
        </span>
      }
      footer={
        onRemove ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onRemove}
              aria-label={`Remove suppression for ${row.email}`}
            >
              Remove suppression
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {err ? <div className="field-error">{err}</div> : null}

      <div>
        <div className="label">Reason</div>
        <div style={{ fontSize: 13 }}>{reasonLabel(reason)}</div>
        {entry?.reason && entry.reason !== row.reason ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Legacy row reason: {row.reason ?? "—"}
          </div>
        ) : null}
      </div>

      <div>
        <div className="label">Expires</div>
        <div style={{ fontSize: 13 }}>
          {loading ? "Loading…" : expiresLabel}
        </div>
        {!loading && hasEntry && !entry?.expires_at ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            This address never auto-expires. Hard bounces and spam complaints
            stay suppressed unless an admin removes them.
          </div>
        ) : null}
        {!loading && !hasEntry ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {err
              ? "Couldn't load the full suppression record — expiry unknown."
              : "Expiry isn't available for this legacy record."}
          </div>
        ) : null}
      </div>

      <div>
        <div className="label">Channel · Purpose</div>
        <div style={{ fontSize: 13 }}>
          {entry?.channel ?? "Unknown"} · {entry?.scope ?? "Unknown"}
        </div>
        {!entry?.channel || !entry?.scope ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {!hasEntry
              ? "Channel and purpose were not captured for this compatibility record."
              : "The current API did not return a complete channel and purpose. No broader scope is assumed."}
          </div>
        ) : null}
      </div>

      <div>
        <div className="label">Source</div>
        <div style={{ fontSize: 13 }}>{entry?.source ?? "—"}</div>
        {entry?.source_event_id ? (
          <div
            className="mono muted"
            style={{ fontSize: 11, marginTop: 2, wordBreak: "break-all" }}
          >
            event {entry.source_event_id}
          </div>
        ) : null}
        {entry?.source_table ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            stored in <code>{entry.source_table}</code>
          </div>
        ) : null}
      </div>

      {entry?.campaign_id ? (
        <div>
          <div className="label">Campaign</div>
          <div
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            {entry.campaign_id}
          </div>
        </div>
      ) : null}

      {entry?.message_id ? (
        <div>
          <div className="label">Message</div>
          <div
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            {entry.message_id}
          </div>
        </div>
      ) : null}

      {entry?.bounce_code ? (
        <div>
          <div className="label">Bounce code</div>
          <div
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            {entry.bounce_code}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Raw SMTP / provider code. See your ESP's bounce reference for the
            human description.
          </div>
        </div>
      ) : null}

      {entry?.provider_event_id ? (
        <div>
          <div className="label">Provider event</div>
          <div
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            {entry.provider_event_id}
          </div>
        </div>
      ) : null}

      {/* SUB-048 — the durable raw classification the ingest receiver
          derived from provider codes + metadata. Surfaced separately
          from Reason because an operator may later reclassify the
          suppression while this preserves the original ingest signal. */}
      {entry?.bounce_category ? (
        <div>
          <div className="label">Bounce category</div>
          <div style={{ fontSize: 13 }}>
            {reasonLabel(entry.bounce_category)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Raw classification at ingest (spamtrap / role account / DNS failure
            / invalid address). Preserved even if the reason is later changed.
          </div>
        </div>
      ) : null}

      <SuppressionAuditTimeline
        items={auditItems}
        total={auditTotal}
        page={auditPage}
        pages={auditPages}
        loading={auditLoading}
        unavailable={auditUnavailable}
        error={auditErr}
        onPrevious={() => setAuditPage((page) => Math.max(1, page - 1))}
        onNext={() =>
          setAuditPage((page) =>
            auditPages == null ? page : Math.min(auditPages, page + 1),
          )
        }
      />
    </SlideoverShell>
  );
}

/** Reset all fetched detail and paging state when the selected row changes. */
export function SuppressionDetailSlideover(props: Props): ReactElement {
  return <SuppressionDetailSlideoverBody key={props.row.email} {...props} />;
}

function AuditRow({ entry }: { entry: SuppressionAuditEntry }): ReactElement {
  // Prefer the server's display label ("Jane D.", "API key pw_ab…");
  // fall back to the raw ids on rows written before it existed.
  const actor =
    entry.actor ||
    entry.actor_user_id ||
    (entry.actor_api_key_id ? `api_key ${entry.actor_api_key_id}` : "system");
  return (
    <div
      style={{
        padding: "8px 10px",
        borderBottom: "1px solid var(--pw-border)",
        display: "flex",
        gap: 8,
        alignItems: "baseline",
        fontSize: 12,
      }}
    >
      <span
        className="badge"
        style={{ textTransform: "uppercase", fontSize: 10 }}
      >
        {entry.action}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="muted">{actor}</span>
        {entry.reason ? <span className="muted"> · {entry.reason}</span> : null}
        {entry.source_table ? (
          <span className="muted"> · {entry.source_table}</span>
        ) : null}
      </span>
      <span className="muted tabular" style={{ fontSize: 11 }}>
        {fmtDateTime(entry.created_at)}
      </span>
    </div>
  );
}
