/**
 * DSARModal — SUB-053 multi-store DSAR fan-out progress (GDPR Art. 15 /
 * CCPA §1798.100 + Art. 17 erasure).
 *
 * Two explicit operations drive this modal, both from the slideover Privacy
 * tab:
 *
 *   - operation "access": creates a read-only Subject Access Request with
 *     connected-store collection enabled. Stored auto-delete policy is never
 *     honored during access. The server returns per-store outcomes inline;
 *     the modal can re-read their persisted receipts without re-running the
 *     request.
 *
 *   - operation "erase": performs a synchronous, Moosewave-only erasure and
 *     returns a counts-only receipt. Connected providers are deliberately out
 *     of scope until durable provider erasure orchestration exists. The
 *     type-to-confirm + admin gate live in the Privacy tab.
 *
 * The backend is synchronous, so there is no long-poll loop here — the
 * single Create call returns the full per-store result. We still expose a
 * Refresh that re-reads the persisted store-responses so a retried or
 * still-settling provider receipt can be pulled without re-running the SAR.
 *
 * Backed by:
 *   POST /api/v1/sar/requests                       (required kind)
 *   GET  /api/v1/sar/requests/{id}/store-responses (access only)
 * (apps/api/internal/sar/*).
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type DSAROperation,
  type DSARRequestResult,
  type DSARStoreResponse,
  api,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { saveFile } from "../../lib/file-transfer";
import { ExternalLink } from "../ExternalLink";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

interface Props {
  open: boolean;
  operation: DSAROperation;
  /** Subscriber UUID — used for the data-export.zip helper download. */
  subscriberId: string;
  /** Subject email — the fan-out search key. */
  email: string;
  onClose: () => void;
}

/** Map the per-store status to one of the shared badge tones. */
function statusBadge(status: string): ReactElement {
  const s = status.toLowerCase();
  if (s === "returned" || s === "found")
    return <span className="badge success">{labelFor(s)}</span>;
  if (s === "ack_required")
    return <span className="badge warning">{labelFor(s)}</span>;
  if (s === "deleted" || s === "error")
    return <span className="badge danger">{labelFor(s)}</span>;
  // not_found / unknown
  return <span className="badge">{labelFor(s)}</span>;
}

function labelFor(status: string): string {
  switch (status.toLowerCase()) {
    case "found":
      return "Found";
    case "returned":
      return "Returned";
    case "deleted":
      return "Deleted";
    case "ack_required":
      return "Ack required";
    case "not_found":
      return "Not found";
    case "error":
      return "Error";
    default:
      return status;
  }
}

function providerLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case "shopify":
      return "Shopify";
    case "woocommerce":
      return "WooCommerce";
    case "stripe":
      return "Stripe";
    case "square":
      return "Square";
    default:
      return provider;
  }
}

/** A one-line per-store outcome, e.g. "Shopify: found customer #123". */
function storeLine(r: DSARStoreResponse): string {
  const who = r.customer_id ? ` customer #${r.customer_id}` : "";
  switch (r.status) {
    case "found":
      return `found${who}`;
    case "returned":
      return `returned data${who}`;
    case "deleted":
      return `deleted${who}`;
    case "ack_required":
      return `awaiting provider acknowledgement${who}`;
    case "not_found":
      return "no matching customer";
    case "error":
      return "fan-out error";
    default:
      return r.status;
  }
}

export function DSARModal({
  open,
  operation,
  subscriberId,
  email,
  onClose,
}: Props): ReactElement | null {
  const [phase, setPhase] = useState<"running" | "done" | "error">("running");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [responses, setResponses] = useState<DSARStoreResponse[]>([]);
  const [result, setResult] = useState<DSARRequestResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const refreshRef = useRef(false);
  const createRef = useRef<{
    key: string;
    promise: ReturnType<typeof api.createSarRequest>;
  } | null>(null);
  const refreshHelpId = useId();

  // Keep one in-flight request per operation/subject. Reusing the promise is
  // important in React StrictMode: its development effect replay must never
  // create a second regulated operation.
  useEffect(() => {
    if (!open) {
      createRef.current = null;
      return;
    }
    let cancelled = false;
    setPhase("running");
    setRequestId(null);
    setResponses([]);
    setResult(null);
    setErrMsg(null);
    const key = `${operation}:${subscriberId}:${email.trim().toLowerCase()}`;
    let promise =
      createRef.current?.key === key ? createRef.current.promise : null;
    if (!promise) {
      promise = api.createSarRequest({
        kind: operation,
        email,
        fanout_enabled: operation === "access",
      });
      createRef.current = { key, promise };
    }
    void (async () => {
      try {
        const res = await promise;
        if (cancelled) return;
        if (res.error) {
          setErrMsg(redact(res.error.message));
          setPhase("error");
          return;
        }
        if (res.data.kind !== operation) {
          setErrMsg("The server returned a different privacy operation.");
          setPhase("error");
          return;
        }
        if (
          res.data.kind === "access" &&
          (res.data.store_responses ?? []).some(
            (response) =>
              response.status === "deleted" ||
              response.action_taken === "auto_delete",
          )
        ) {
          setErrMsg(
            "The server reported a destructive provider action for a read-only access request.",
          );
          setPhase("error");
          return;
        }
        applyResult(res.data);
        setPhase("done");
      } catch {
        if (cancelled) return;
        setErrMsg("The privacy request failed before a receipt was returned.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, open, operation, subscriberId]);

  function applyResult(data: DSARRequestResult): void {
    setResult(data);
    setRequestId(data.id);
    setResponses(data.kind === "access" ? (data.store_responses ?? []) : []);
  }

  // Re-read the persisted per-store receipts (compliance receipt URLs may
  // settle slightly after the synchronous Create returns).
  const refresh = async (): Promise<void> => {
    if (!requestId || refreshRef.current) return;
    refreshRef.current = true;
    setRefreshing(true);
    try {
      const res = await api.listDsarStoreResponses(requestId);
      if (res.error) {
        toast.error(
          `Couldn't refresh store receipts: ${redact(res.error.message)}`,
        );
        return;
      }
      setResponses(res.data.store_responses ?? []);
    } catch {
      toast.error("Couldn't refresh store receipts. Try again.");
    } finally {
      refreshRef.current = false;
      setRefreshing(false);
    }
  };

  // Download the Moosewave access export for the operator's records. Erasure
  // deliberately has no disclosure-ZIP action.
  const downloadZip = async (): Promise<void> => {
    if (operation !== "access") return;
    setDownloading(true);
    try {
      const res = await api.getDsarExport(subscriberId);
      if (res.error) {
        toast.error(`Couldn't download export: ${redact(res.error.message)}`);
        return;
      }
      const { blob, filename } = res.data;
      const saved = await saveFile({
        data: blob,
        suggestedName: filename,
        label: "Data subject access export",
        privacy: "confidential",
        mimeType: "application/zip",
      });
      if (!saved.ok) {
        if (saved.code !== "cancelled") toast.error(saved.message);
        return;
      }
      if (saved.status === "download_started") {
        toast.info(
          "Access export download started. Check your browser's downloads for completion.",
        );
      } else if (saved.status !== "cancelled") {
        toast.success("Access export saved.");
      }
    } catch {
      toast.error("Couldn't save the access export. Try again.");
    } finally {
      setDownloading(false);
    }
  };

  if (!open) return null;

  const title =
    operation === "erase"
      ? "Erase Moosewave-managed subscriber data"
      : "Create a read-only subject access request";
  const description =
    operation === "erase"
      ? `Permanently anonymize or delete Moosewave-managed data for ${email}. Connected stores are not changed.`
      : `Collect Moosewave data and read-only connected-store results for ${email}. This operation cannot delete provider records.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      closeDisabled={phase === "running"}
      closeOnBackdrop={phase !== "running"}
      closeOnEscape={phase !== "running"}
    >
      {phase === "running" ? (
        <div style={{ padding: "8px 0" }} role="status" aria-live="polite">
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            {operation === "erase"
              ? "Erasing Moosewave-managed subscriber data… Keep this window open."
              : "Building the Moosewave access bundle and reading connected stores…"}
          </div>
          <div className="skel" style={{ height: 48 }} />
        </div>
      ) : phase === "error" ? (
        <p
          style={{
            fontSize: 13,
            color: "var(--pw-danger)",
            margin: "8px 0",
          }}
          role="alert"
        >
          {operation === "erase"
            ? "Couldn't erase Moosewave-managed data"
            : "Couldn't create the subject access request"}
          {errMsg ? `: ${errMsg}` : "."}
        </p>
      ) : result?.kind === "erase" ? (
        <div role="status" aria-live="polite" style={{ padding: "8px 0" }}>
          <div style={{ fontSize: 14, fontWeight: 650 }}>
            Moosewave erasure completed
          </div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0" }}>
            {result.rows_deleted.toLocaleString()} Moosewave-managed record
            {result.rows_deleted === 1 ? " was" : "s were"} affected. Personal
            identifiers were anonymized or deleted, and a non-deliverable
            suppression tombstone prevents re-import resurrection. Connected
            commerce stores were not changed.
          </p>
          <p className="muted" style={{ fontSize: 11, margin: 0 }}>
            Counts-only receipt: {result.id}. No subject-access ZIP was created.
          </p>
        </div>
      ) : (
        <>
          {responses.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
              No connected commerce stores to search — the subject&apos;s
              Moosewave access bundle is ready.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: "8px 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {responses.map((r, i) => (
                <li
                  key={r.id ?? `${r.provider}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    border: "1px solid var(--pw-border)",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600, minWidth: 96 }}>
                    {providerLabel(r.provider)}
                  </span>
                  {statusBadge(r.status)}
                  <span className="muted" style={{ flex: 1, minWidth: 0 }}>
                    {storeLine(r)}
                  </span>
                  {r.receipt_url ? (
                    <ExternalLink
                      href={r.receipt_url}
                      className="btn btn-xs btn-ghost"
                      style={{ fontSize: 11 }}
                    >
                      Receipt
                    </ExternalLink>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p
            id={refreshHelpId}
            className="muted"
            style={{ fontSize: 11, margin: "8px 0 0" }}
          >
            This access request is read-only. Legacy provider auto-delete
            policies are ignored. Refresh re-reads persisted receipts without
            starting another request.
          </p>
        </>
      )}
      <ModalFooter>
        {phase === "done" && result?.kind === "access" ? (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-disabled={!requestId || undefined}
              aria-describedby={refreshHelpId}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void downloadZip()}
              disabled={downloading}
            >
              {downloading
                ? "Downloading…"
                : "Download Moosewave access export (.zip)"}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={onClose}
          disabled={phase === "running"}
        >
          {phase === "running" ? "Processing…" : "Close"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
