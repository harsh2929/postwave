/**
 * AuditRequestChain — the way into the chain from a single audit row. ECO-22.
 *
 * The link was already in the data and no desktop surface read it: audit rows
 * have carried `metadata.context.correlation_id` since emit.go started stamping
 * it, so the row an operator is already looking at knows which other rows the
 * same request wrote.
 *
 * Renders NOTHING when the row carries no correlation id. Background work —
 * workers, queue consumers, the retention trimmer — writes no request context
 * at all, and the endpoint refuses the "-" sentinel outright; offering "view the
 * chain" there would open an empty view every single time and teach the
 * operator the feature is broken.
 */

import { useState, type ReactElement } from "react";

import { auditCorrelationId } from "../../lib/api/audit-operations";

import { AuditChainModal } from "./AuditChainModal";

interface Props {
  /** Any audit row shape carrying the emit-time metadata blob. */
  row: { metadata?: Record<string, unknown> | null };
}

export function AuditRequestChain({ row }: Props): ReactElement | null {
  const [open, setOpen] = useState(false);
  const requestId = auditCorrelationId(row);
  if (!requestId) return null;

  return (
    <div data-testid="audit-request-chain">
      <div className="label">Request</div>
      <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
        {requestId}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        style={{ marginTop: 6 }}
        onClick={() => setOpen(true)}
        aria-describedby="audit-request-chain-description"
        data-testid="audit-request-chain-open"
      >
        View request chain
      </button>
      <div
        id="audit-request-chain-description"
        className="muted"
        style={{ fontSize: 11, marginTop: 6 }}
      >
        Shows every audit entry this one request wrote — the mutation, any
        approval decision, and the side effects — in the order they happened.
      </div>
      {open ? (
        <AuditChainModal requestId={requestId} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
