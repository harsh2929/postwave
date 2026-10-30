/**
 * DomainHealthCard — three-light SPF/DKIM/DMARC panel for the
 * Custom Domain slideover. Backed by the cached state the
 * /api/v1/dns-health worker writes to `sending_identities` every 6
 * hours. The admin "Re-check now" button forces an immediate worker
 * tick.
 */

import { type ReactElement, useState } from "react";

import { api, type DnsHealthStatus } from "../../lib/api-client";

interface Props {
  /** Cached health from the parent; null = no record for this domain. */
  status: DnsHealthStatus | null;
  /** Admin-only "Re-check now" — hidden when viewer. */
  canRunNow: boolean;
  /** Notify parent that a recheck succeeded so it can refetch. */
  onRechecked: () => void;
}

function fmtRel(iso: string | undefined | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export function DomainHealthCard({
  status,
  canRunNow,
  onRechecked,
}: Props): ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recheckedCount, setRecheckedCount] = useState<number | null>(null);

  async function runNow(): Promise<void> {
    setBusy(true);
    setErr(null);
    const r = await api.runDnsHealthNow();
    setBusy(false);
    if (r.error) {
      setErr(r.error.message);
      return;
    }
    setRecheckedCount(r.data?.rechecked ?? 0);
    onRechecked();
  }

  if (!status) {
    return (
      <div className="card" style={{ padding: 12 }}>
        <div className="section-title" style={{ marginBottom: 4 }}>
          DNS health
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          This domain isn&apos;t tracked as a sending identity yet — DNS health
          appears once you start sending from it.
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div className="section-title" style={{ marginBottom: 2 }}>
            DNS health
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Last checked {fmtRel(status.last_attempt_at)}
            {status.is_stale ? " · stale" : ""}
          </div>
        </div>
        {canRunNow ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runNow()}
            disabled={busy}
            aria-label="Run the DNS health recheck now"
          >
            {busy ? "Re-checking…" : "Re-check now"}
          </button>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 8,
        }}
      >
        <RecordPill
          label="SPF"
          verifiedAt={status.spf_verified_at}
          partOfState={status.verify_state}
        />
        <RecordPill
          label="DKIM"
          verifiedAt={status.dkim_verified_at}
          partOfState={status.verify_state}
        />
        <RecordPill
          label="DMARC"
          verifiedAt={status.dmarc_verified_at}
          partOfState={status.verify_state}
        />
      </div>

      {status.last_error ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--pw-fg-muted)",
            background: "color-mix(in srgb, var(--pw-danger) 8%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--pw-danger) 28%, transparent)",
            padding: "8px 10px",
            borderRadius: 4,
          }}
        >
          Last error: {status.last_error}
        </div>
      ) : null}

      {err ? (
        <div
          className="muted"
          style={{ fontSize: 11, color: "var(--pw-danger)" }}
        >
          {err}
        </div>
      ) : null}
      {recheckedCount != null && !err ? (
        <div className="muted" style={{ fontSize: 11 }}>
          Re-checked {recheckedCount} identit
          {recheckedCount === 1 ? "y" : "ies"}.
        </div>
      ) : null}
    </div>
  );
}

interface RecordPillProps {
  label: string;
  verifiedAt: string | undefined | null;
  partOfState: string;
}

function RecordPill({
  label,
  verifiedAt,
  partOfState,
}: RecordPillProps): ReactElement {
  const ok = !!verifiedAt;
  // When the overall state is "verified" but this leg's timestamp is
  // missing, treat it as pending rather than failing.
  const color = ok
    ? "var(--pw-accent)"
    : partOfState === "broken"
      ? "var(--pw-danger)"
      : "var(--pw-fg-muted)";
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 6,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 24%, transparent)`,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--pw-fg-muted)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
          }}
        />
        {label}
      </div>
      <div style={{ fontSize: 13, color, fontWeight: 600 }}>
        {ok ? "OK" : partOfState === "broken" ? "Fail" : "Pending"}
      </div>
      <div className="muted" style={{ fontSize: 10 }}>
        {ok ? fmtRel(verifiedAt) : "—"}
      </div>
    </div>
  );
}
