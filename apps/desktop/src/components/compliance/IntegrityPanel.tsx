/**
 * IntegrityPanel — the "Integrity" surface for the Compliance page.
 *
 * Shows:
 *   • Current Merkle tree size + signed root hash + anchored_at.
 *   • Chain-of-custody timeline (last N checkpoints as a vertical list).
 *   • "Generate proof for event" affordance — operator pastes an audit
 *     event id, we fetch /inclusion-proof and render the proof path
 *     via the same AuditProofPath component used in the slideover.
 *   • Pointer to the offline CLI verifier + the verify-proofs.md doc.
 *
 * Wire-up: every read is best-effort. If the API call fails (no
 * checkpoints yet, no auth, etc.) the panel renders explanatory copy
 * rather than an error, so the Integrity tab is always usable.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  api,
  type CheckpointResponse,
  type InclusionProofResponse,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { AuditProofPath } from "../audit/AuditProofPath";
import { InlineHelp } from "../InlineHelp";
import { SectionHeader } from "../SectionHeader";

function shortHash(hex: string | undefined, n = 12): string {
  if (!hex) return "—";
  if (hex.length <= n * 2 + 1) return hex;
  return `${hex.slice(0, n)}…${hex.slice(-n)}`;
}

export function IntegrityPanel(): ReactElement {
  const [latest, setLatest] = useState<CheckpointResponse | null>(null);
  const [latestErr, setLatestErr] = useState<string | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);

  const [eventId, setEventId] = useState("");
  const [proof, setProof] = useState<InclusionProofResponse | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofErr, setProofErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingLatest(true);
      const r = await api.getLatestAuditCheckpoint();
      if (cancelled) return;
      setLoadingLatest(false);
      if (r.error) {
        setLatestErr(
          r.error.code === "no_checkpoint"
            ? "No Merkle root has been published yet for this workspace. The Merkle worker publishes a signed root every ~60 seconds once audit events exist."
            : r.error.message ?? "Unable to load checkpoint.",
        );
        return;
      }
      if (r.data) setLatest(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerateProof = async (): Promise<void> => {
    const id = eventId.trim();
    if (!id) {
      setProofErr("Enter an audit event id (positive integer).");
      return;
    }
    setProofLoading(true);
    setProofErr(null);
    setProof(null);
    const r = await api.getInclusionProof(id);
    setProofLoading(false);
    if (r.error) {
      setProofErr(
        r.error.code === "not_found"
          ? "No audit event with that id in this workspace."
          : r.error.code === "no_checkpoint"
            ? "The chain hasn't been rooted yet for that event. Try again in about a minute."
            : r.error.message ?? "Unable to generate proof.",
      );
      return;
    }
    if (r.data) setProof(r.data);
  };

  return (
    <div className="integrity-panel" style={{ marginTop: 24 }}>
      <SectionHeader
        title="Audit log integrity"
        description="Tamper-evident SHA-256 hash chain over every audit_log row, with periodic signed Merkle roots. Verifiable offline."
      />

      {/* ---- Current root ---- */}
      <div
        className="card"
        style={{
          padding: 16,
          marginTop: 12,
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", marginBottom: 8 }}
        >
          <strong style={{ fontSize: 13 }}>Latest signed checkpoint</strong>
          <InlineHelp
            text="Moosewave's Merkle worker publishes a signed root every ~60 seconds. The root_hash is sha256 of the audit_log chain tip; an external verifier pins this value as a trust anchor."
          />
        </div>
        {loadingLatest ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : latestErr ? (
          <div className="muted" style={{ fontSize: 12 }}>{latestErr}</div>
        ) : latest && latest.root_hash ? (
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "4px 16px",
              fontSize: 12,
              margin: 0,
            }}
          >
            <dt className="muted">Tree size</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {(latest.tree_size ?? 0).toLocaleString()} events
            </dd>
            <dt className="muted">Root hash</dt>
            <dd
              className="mono"
              style={{ margin: 0, wordBreak: "break-all" }}
            >
              {shortHash(latest.root_hash, 16)}
            </dd>
            <dt className="muted">Anchored at</dt>
            <dd style={{ margin: 0 }}>
              {latest.anchored_at ? fmtDateTime(latest.anchored_at) : "—"}
            </dd>
            {latest.root_kid ? (
              <>
                <dt className="muted">Signing key</dt>
                <dd className="mono" style={{ margin: 0 }}>
                  {latest.root_kid}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          // 200 with an empty/partial body (no root_hash) ≠ a published
          // checkpoint. Render the same explanatory empty state rather than
          // a blank card or a crash on the undefined numeric fields.
          <div className="muted" style={{ fontSize: 12 }}>
            No Merkle root has been published yet for this workspace. The
            Merkle worker publishes a signed root every ~60 seconds once audit
            events exist.
          </div>
        )}
      </div>

      {/* ---- Generate proof for event ---- */}
      <div
        className="card"
        style={{
          padding: 16,
          marginTop: 12,
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", marginBottom: 8 }}
        >
          <strong style={{ fontSize: 13 }}>Generate proof for event</strong>
          <InlineHelp text="Returns the SHA-256 audit-path from this event's row_hash to the signed Merkle root. A verifier with the CSV export can re-walk the path and confirm the row is untampered." />
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "stretch",
            flexWrap: "wrap",
          }}
        >
          <input
            type="text"
            className="input"
            placeholder="Audit event id (e.g. 12345)"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleGenerateProof();
            }}
            style={{ flex: "1 1 240px", maxWidth: 360 }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={proofLoading || !eventId.trim()}
            onClick={() => void handleGenerateProof()}
          >
            {proofLoading ? "Generating…" : "Generate proof"}
          </button>
        </div>
        {proofErr ? (
          <div
            className="notice"
            style={{ marginTop: 10, fontSize: 12 }}
            role="alert"
          >
            {proofErr}
          </div>
        ) : null}
        {proof ? <AuditProofPath proof={proof} /> : null}
      </div>

      {/* ---- Chain-of-custody timeline ---- */}
      <div
        className="card"
        style={{
          padding: 16,
          marginTop: 12,
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", marginBottom: 8 }}
        >
          <strong style={{ fontSize: 13 }}>Chain of custody</strong>
          <InlineHelp text="Every audit event is sha256(canonical_bytes ‖ prev_hash), forming an append-only chain. Tampering breaks the chain at the next signed root — visible to any external verifier." />
        </div>
        <ol
          className="custody-timeline"
          style={{
            margin: 0,
            paddingLeft: 16,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <li>
            <strong>Write.</strong> An audit row lands in{" "}
            <code>audit_log</code> with{" "}
            <code>row_hash = sha256(canonical_bytes ‖ prev_hash)</code>.
          </li>
          <li>
            <strong>Root.</strong> Every 60 s the Merkle worker snapshots
            the chain tip into <code>audit_merkle_roots</code> and (when
            KMS is configured) signs <code>root_hash</code>.
          </li>
          <li>
            <strong>Prove.</strong> A verifier calls{" "}
            <code>GET /api/v1/audit/{"{id}"}/inclusion-proof</code> for
            any event, fetches the matching CSV export, and re-walks
            the audit path with <code>postwave-verify</code>.
          </li>
          <li>
            <strong>Detect.</strong> Any tampering produces a hash
            mismatch at the tampered row and every subsequent row.
            Customers monitoring the signed roots see divergence on the
            next checkpoint.
          </li>
        </ol>
      </div>

      <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
        Offline verifier:{" "}
        <code>go run ./apps/api/cmd/postwave-verify --csv … --proof …</code>{" "}
        · full algorithm + Python reference in{" "}
        <code>docs/audit/verify-proofs.md</code>.
      </p>
    </div>
  );
}
