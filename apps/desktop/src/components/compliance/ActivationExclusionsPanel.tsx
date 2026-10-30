/**
 * ActivationExclusionsPanel — the first UI for the Consent-Safe Activation
 * Firewall's compliance list (apps/api/internal/activation_firewall). The
 * firewall partitions an activation audience into kept / excluded by consent +
 * suppression, and records every exclusion with the governing rule — the
 * compliance receipt that answers "why wasn't this person messaged?". The
 * GET /api/v1/activation-exclusions endpoint had no client. This lists the
 * receipts with their rule class and reason.
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { activationExclusionsApi } from "../../lib/api-client";
import type { ExclusionReceipt } from "../../lib/api/activation-exclusions";
import { DataTable, type DataTableColumn } from "../table/DataTable";

function ruleColor(ruleClass: string): string {
  switch (ruleClass.toLowerCase()) {
    case "consent":
      return "var(--pw-warning)";
    case "suppression":
      return "var(--pw-danger)";
    default:
      return "var(--pw-fg-muted)";
  }
}

export function ActivationExclusionsPanel(): ReactElement {
  const [items, setItems] = useState<ExclusionReceipt[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await activationExclusionsApi.list();
      if (requestId !== requestIdRef.current) return;
      if (result.error) setError(result.error.message);
      else setItems(result.data);
    } catch (requestError) {
      if (requestId !== requestIdRef.current) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected request error",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  const columns: readonly DataTableColumn<ExclusionReceipt>[] = [
    {
      id: "subscriber",
      header: "Subscriber",
      width: "240px",
      cell: (item) => item.subscriber_email,
    },
    {
      id: "rule",
      header: "Rule",
      cell: (item) => (
        <span style={{ fontWeight: 600, color: ruleColor(item.rule_class) }}>
          {item.rule_class}
        </span>
      ),
    },
    {
      id: "reason",
      header: "Reason",
      width: "260px",
      cell: (item) => <span className="muted">{item.rule_reason}</span>,
    },
    {
      id: "purpose",
      header: "Purpose",
      cell: (item) => item.purpose,
    },
    {
      id: "destination",
      header: "Destination",
      cell: (item) => <span className="muted">{item.destination_type}</span>,
    },
    {
      id: "when",
      header: "When",
      width: "180px",
      cell: (item) => (
        <span className="muted">
          {new Date(item.excluded_at).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <section
      aria-label="Activation exclusions"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      {error ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load exclusions: {error}
        </p>
      ) : null}
      <DataTable
        caption="Activation exclusions"
        description="Members withheld from activation by consent or suppression, with the governing rule."
        columns={columns}
        rows={items ?? []}
        getRowKey={(item) => String(item.id)}
        loading={loading && items === null}
        loadingLabel="Loading activation exclusions…"
        emptyState={
          error
            ? "Activation exclusions are unavailable. Retry to load them."
            : "No exclusions recorded — every activation member cleared consent and suppression."
        }
        density="compact"
        columnControls={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
    </section>
  );
}
