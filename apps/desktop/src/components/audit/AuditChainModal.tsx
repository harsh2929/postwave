/**
 * AuditChainModal — "what happened when the operator clicked that", on one
 * screen. ECO-22.
 *
 * One request writes audit rows across several of the 35 audit tables: the
 * mutation, the approval decision, the entitlement check, the outbox dispatch.
 * The feed shows them as unrelated lines, newest first, so reconstructing the
 * moment meant eyeballing timestamps across screens and hoping no two operators
 * acted in the same second. The server has answered this since audit_chain.go
 * landed (GET /api/v1/audit/chain/{requestId}); on desktop nothing asked it.
 *
 * Three things a reader needs and the audit feed cannot give them:
 *   - causal ORDER. The server returns ascending; we render in the order
 *     received. Re-sorting newest-first would make the chain read backwards.
 *   - the OFFSET between entries. Absolute clock times inside one request are
 *     all the same second — which is exactly why joining these rows by
 *     timestamp failed — so the "+120ms" is what makes the sequence legible.
 *   - WHAT CHANGED, per entry, via the same AuditDiff the slideover uses.
 *
 * The empty chain is an ANSWER, not an error: a request id that audited nothing
 * comes back 200 with rows: []. Rendering that as a failure would tell the
 * operator the lookup broke when the server in fact said "nothing was audited
 * under this request".
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  api,
  type AuditChainResponse,
  type AuditChainRow,
} from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";

import { Modal } from "../Modal";
import { toast } from "../Toast";
import { AuditDiff } from "./AuditDiff";

interface Props {
  requestId: string;
  onClose: () => void;
}

/** Date + time WITH seconds, matching the audit slideover. The shared
 *  format-date helpers deliberately omit a seconds variant (see its header);
 *  audit detail surfaces keep their own. */
function fmtWhen(s: string | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}

/**
 * Offset from the first entry, in the unit the reader needs.
 *
 * Returns "" for an unparseable timestamp rather than "+NaNms" — a broken
 * clock should read as "no offset available", not as a measurement.
 */
export function chainOffsetLabel(iso: string, startIso: string): string {
  const at = Date.parse(iso);
  const start = Date.parse(startIso);
  if (Number.isNaN(at) || Number.isNaN(start)) return "";
  const ms = at - start;
  if (Math.abs(ms) < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(Math.abs(ms) < 10_000 ? 2 : 1)}s`;
}

/**
 * The part of the payload that describes a CHANGE.
 *
 * `context` is stripped: audit.Emit writes it to record how the row got here
 * (correlation id, route, method) — it is not something the action changed, and
 * it is byte-identical on every entry in the chain. Leaving it in would repeat
 * the same block under every step and bury the one line that differs.
 *
 * Returns null when nothing but context remains, so the caller can say so
 * plainly instead of rendering an empty diff.
 */
export function chainChangePayload(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "context") continue;
    rest[key] = value;
  }
  return Object.keys(rest).length > 0 ? rest : null;
}

/** "by whom", from the row's actor columns. Both are `omitempty` server-side. */
export function chainActorLabel(row: AuditChainRow): string {
  const type = row.actorType || "unknown";
  return row.actorLabel ? `${type} · ${row.actorLabel}` : type;
}

function ChainEntry({
  row,
  step,
  startIso,
}: {
  row: AuditChainRow;
  step: number;
  startIso: string;
}): ReactElement {
  const change = chainChangePayload(row.metadata);
  const offset = chainOffsetLabel(row.at, startIso);
  return (
    <li
      className="audit-chain-entry"
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 10,
        paddingBottom: 14,
      }}
    >
      <span
        className="muted tabular"
        aria-hidden="true"
        style={{
          alignSelf: "start",
          minWidth: 20,
          textAlign: "right",
          fontSize: 11,
          lineHeight: "18px",
        }}
      >
        {step}.
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
            {row.action || "—"}
          </span>
          <span
            className="muted tabular"
            style={{ fontSize: 11, whiteSpace: "nowrap" }}
            title={fmtWhen(row.at)}
          >
            {offset}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {chainActorLabel(row)}
          {row.resourceType ? ` · ${row.resourceType}` : ""}
          {row.resourceId ? (
            <span className="mono" style={{ marginLeft: 4 }}>
              {row.resourceId}
            </span>
          ) : null}
        </div>
        <div style={{ marginTop: 6 }}>
          {change ? (
            <AuditDiff metadata={change} />
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              No change payload was recorded for this action.
            </span>
          )}
        </div>
        {row.metadata && Object.keys(row.metadata).length > 0 ? (
          <details style={{ marginTop: 6 }}>
            <summary
              className="muted"
              style={{ fontSize: 11, cursor: "pointer" }}
            >
              Raw payload
            </summary>
            <pre
              className="mono pw-pre"
              style={{
                fontSize: 11,
                marginTop: 4,
                padding: 8,
                background: "var(--pw-bg-elev-2)",
                border: "1px solid var(--pw-border)",
                borderRadius: 4,
                maxHeight: 240,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function AuditChainModal({ requestId, onClose }: Props): ReactElement {
  const [chain, setChain] = useState<AuditChainResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A REAL ABORT, not just a discarded result.
    //
    // The client accepts a signal and nothing passed one, so closing the modal
    // or hitting "Try again" cancelled only the state WRITE — the HTTP read kept
    // going. Two consequences, and the second is the one that bites: a chain can
    // be 500 rows, so a closed modal went on paying for a read nobody would see;
    // and because "Try again" bumps `attempt` and re-fires this effect, a slow
    // FIRST response could land after the retry's and overwrite the newer answer
    // with the older one.
    //
    // The `cancelled` flag stays as well. Abort races the network; the flag is
    // what guarantees no setState runs after cleanup even if the request had
    // already resolved.
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await api.getAuditChain(requestId, {
        signal: controller.signal,
      });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message ?? "Couldn't load this request chain.");
        setLoading(false);
        return;
      }
      setChain(res.data ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [requestId, attempt]);

  const copyRequestId = useCallback(async (): Promise<void> => {
    const result = await writeClipboardText(requestId, {
      contentClass: "public",
      label: "Audit request id",
    });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success("Request id copied.");
  }, [requestId]);

  const rows = chain?.rows ?? [];
  const startIso = rows[0]?.at ?? "";

  return (
    <Modal
      open
      onClose={onClose}
      title="Request chain"
      description="Every audit entry written by one request, in the order it happened."
      size="lg"
    >
      <div
        className="row"
        style={{
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <span className="label">Request id</span>
        <code
          className="mono"
          style={{ fontSize: 12, wordBreak: "break-all" }}
          data-testid="audit-chain-request-id"
        >
          {requestId}
        </code>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => void copyRequestId()}
        >
          Copy
        </button>
      </div>

      {loading ? (
        <div className="muted" style={{ padding: 16 }} role="status">
          Loading the request chain…
        </div>
      ) : err ? (
        <div style={{ padding: 16 }} data-testid="audit-chain-error">
          <div className="notice" role="alert" style={{ fontSize: 12 }}>
            {err}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            style={{ marginTop: 8 }}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        // Not an error, and not "no results". The server answered: no audit row
        // in this workspace carries this request id. Saying "not found" would
        // imply the request never happened, which is a different claim.
        <div
          className="muted"
          style={{ padding: 16, fontSize: 13 }}
          data-testid="audit-chain-empty"
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Nothing was audited under this request
          </div>
          No entries were returned for this identifier. The request may not have
          produced an audited change, its entries may fall outside this
          workspace, or the identifier may not match a recorded request.
        </div>
      ) : (
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {rows.length} {rows.length === 1 ? "entry" : "entries"}, in the
            order they happened, starting {fmtWhen(startIso)}.
          </div>
          {chain?.truncated ? (
            <div
              className="notice"
              role="status"
              style={{ fontSize: 12, marginBottom: 10 }}
              data-testid="audit-chain-truncated"
            >
              This chain hit the server&apos;s 500-entry cap, so it is not the
              whole request. Treat this sequence as capped and incomplete.
            </div>
          ) : null}
          <ol
            className="audit-chain"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
            data-testid="audit-chain-entries"
          >
            {rows.map((row, index) => (
              <ChainEntry
                key={row.id}
                row={row}
                step={index + 1}
                startIso={startIso}
              />
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
