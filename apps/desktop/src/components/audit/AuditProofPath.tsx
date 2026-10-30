/**
 * AuditProofPath — visualises a Merkle inclusion proof returned by
 * GET /api/v1/audit/{id}/inclusion-proof.
 *
 * The audit log is a linear hash chain (sha256(row || prev)); the
 * "audit path" is the ordered list of intermediate row_hashes between
 * the leaf (the row of interest) and the signed checkpoint root.
 *
 * Surface:
 *   • Status line (green checkmark on success, amber on "not yet rooted").
 *   • Leaf hash + tree size + anchored_at + KID.
 *   • Collapsible list of path hashes with copy-to-clipboard.
 *   • Footer pointing to the Python CLI verifier docs.
 *
 * This component is render-only — the API call lives in the parent
 * (AuditEventSlideover) so loading + error state stays close to the
 * user action that triggered it.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import type { InclusionProofResponse } from "../../lib/api-client";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { clipboardAnnouncement, writeClipboardText } from "../../lib/clipboard";
import { fmtDateTime } from "../../lib/format-date";
import { toast } from "../Toast";

interface Props {
  proof: InclusionProofResponse;
}

function shortHash(hex: string, n = 10): string {
  if (!hex) return "";
  if (hex.length <= n * 2 + 1) return hex;
  return `${hex.slice(0, n)}…${hex.slice(-n)}`;
}

export function AuditProofPath({ proof }: Props): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyAnnouncement, setCopyAnnouncement] = useState("");
  const [copyTarget, setCopyTarget] = useState<string | null>(null);
  const pathId = useId();
  const copyStatusId = useId();
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);
  const operation = useSingleFlightOperation();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const copy = async (
    target: string,
    value: string,
    label: string,
  ): Promise<void> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      await pending;
      return;
    }
    setCopyTarget(target);
    setCopyAnnouncement(`Copying ${label.toLowerCase()}…`);
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await writeClipboardText(value, {
          contentClass: "public",
          label,
        });
        if (!mountedRef.current) return;
        setCopyAnnouncement(clipboardAnnouncement(result, label));
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setCopied(target);
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(() => {
          if (!mountedRef.current) return;
          setCopied(null);
          resetTimerRef.current = null;
        }, 1200);
      } catch (error) {
        if (!mountedRef.current) return;
        const message = lifecycleOperationError(
          error,
          `${label} couldn't be copied. Try again.`,
        );
        setCopyAnnouncement(`${label} wasn't copied. ${message}`);
        toast.error(message);
      } finally {
        if (mountedRef.current) setCopyTarget(null);
      }
    });
    if (request) await request;
  };

  return (
    <div
      className="audit-proof-path"
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 12,
        marginTop: 8,
        background: "var(--pw-bg-elev-2)",
      }}
    >
      <p
        id={copyStatusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="muted audit-proof-copy-status"
      >
        {copyAnnouncement ||
          "Each shortened hash can be copied in full for offline verification."}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            width: 18,
            height: 18,
            borderRadius: 9,
            background: "var(--pw-success)",
            color: "white",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          ✓
        </span>
        <strong style={{ fontSize: 13 }}>Inclusion proof verified</strong>
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          tree_size {proof.tree_size.toLocaleString()}
        </span>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Anchored {fmtDateTime(proof.anchored_at)}
        {proof.root_kid ? ` · key ${proof.root_kid}` : ""}
      </div>

      <dl
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontSize: 12,
        }}
      >
        <dt className="muted">Leaf hash</dt>
        <dd className="mono" style={{ margin: 0, wordBreak: "break-all" }}>
          <button
            type="button"
            className="btn btn-link audit-proof-copy"
            onClick={() =>
              void copy("leaf", proof.leaf_hash, "Audit proof leaf hash")
            }
            disabled={operation.active}
            aria-describedby={copyStatusId}
          >
            <span>{shortHash(proof.leaf_hash, 12)}</span>
            <span className="audit-proof-copy-action">
              {copyTarget === "leaf"
                ? "Copying…"
                : copied === "leaf"
                  ? "Copied"
                  : "Copy full hash"}
            </span>
          </button>
        </dd>
        <dt className="muted">Root hash</dt>
        <dd className="mono" style={{ margin: 0, wordBreak: "break-all" }}>
          <button
            type="button"
            className="btn btn-link audit-proof-copy"
            onClick={() =>
              void copy("root", proof.root_hash, "Audit proof root hash")
            }
            disabled={operation.active}
            aria-describedby={copyStatusId}
          >
            <span>{shortHash(proof.root_hash, 12)}</span>
            <span className="audit-proof-copy-action">
              {copyTarget === "root"
                ? "Copying…"
                : copied === "root"
                  ? "Copied"
                  : "Copy full hash"}
            </span>
          </button>
        </dd>
      </dl>

      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ marginTop: 8 }}
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        aria-controls={pathId}
      >
        {expanded ? "Hide" : "Show"} audit path
        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
          ({proof.audit_path.length}{" "}
          {proof.audit_path.length === 1 ? "hash" : "hashes"})
        </span>
      </button>

      {expanded ? (
        <ol
          id={pathId}
          className="mono"
          style={{
            marginTop: 8,
            paddingLeft: 24,
            fontSize: 11,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {proof.audit_path.length === 0 ? (
            <li className="muted">
              Empty path — this leaf is itself the checkpoint tip.
            </li>
          ) : (
            proof.audit_path.map((h, i) => (
              <li
                key={`${i}-${h}`}
                style={{ wordBreak: "break-all", marginBottom: 2 }}
              >
                <button
                  type="button"
                  className="btn btn-link audit-proof-copy"
                  onClick={() =>
                    void copy(`path-${i}`, h, `Audit path hash ${i + 1}`)
                  }
                  disabled={operation.active}
                  aria-describedby={copyStatusId}
                >
                  <span>{shortHash(h, 16)}</span>
                  <span className="audit-proof-copy-action">
                    {copyTarget === `path-${i}`
                      ? "Copying…"
                      : copied === `path-${i}`
                        ? "Copied"
                        : "Copy full hash"}
                  </span>
                </button>
              </li>
            ))
          )}
        </ol>
      ) : null}

      <p
        className="muted"
        style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}
      >
        Re-verify offline: export the audit log to CSV and run{" "}
        <code>postwave-verify --csv … --proof …</code>. See{" "}
        <code>docs/audit/verify-proofs.md</code>.
      </p>
    </div>
  );
}
