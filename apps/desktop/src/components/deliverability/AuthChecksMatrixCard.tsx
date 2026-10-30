/**
 * AuthChecksMatrixCard — #43 of the 2026-06-11 wiring backlog.
 *
 * SPF / DKIM / DMARC / BIMI / PTR validation matrix per sending
 * domain, served by the deliverability service through the gateway
 * proxy (GET /api/v1/auth-checks → BARE ARRAY of rows). Each cell is
 * a pass/warn/fail badge; clicking a domain row expands the five
 * check details.
 *
 * Honest 503 handling: the proxy answers 503 when the deliverability
 * service isn't configured on this deployment — that renders as an
 * explicit "service not configured" notice, NOT an empty state.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { type AuthCheckMatrixRow, authChecksApi } from "../../lib/api-client";
import {
  AUTH_CHECK_KEYS,
  AUTH_CHECK_LABELS,
  authCheckCell,
  authStatusBadgeClass,
  authStatusLabel,
  domainWorstStatus,
  parseAuthCheckMatrix,
} from "./auth-matrix-helpers";
import { describeServiceError, type ServiceErrorView } from "./service-status";
import { DataTable, type DataTableColumn } from "../table/DataTable";

function authDetailsId(domain: string): string {
  return `auth-check-details-${domain.replace(/[^a-z0-9_-]+/gi, "-")}`;
}

export function AuthChecksMatrixCard(): ReactElement {
  const [rows, setRows] = useState<AuthCheckMatrixRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errView, setErrView] = useState<ServiceErrorView | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErrView(null);
    try {
      const res = await authChecksApi.matrix();
      if (requestId !== requestIdRef.current) return;
      if (res.error) {
        setErrView(describeServiceError(res.error));
      } else {
        const parsed = parseAuthCheckMatrix(res.data);
        if (parsed) {
          setRows(parsed);
        } else {
          setErrView({
            kind: "error",
            message:
              "Authentication checks service returned a malformed response.",
          });
        }
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setErrView({
          kind: "error",
          message: "Moosewave couldn't load authentication checks.",
        });
      }
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

  const columns: readonly DataTableColumn<AuthCheckMatrixRow>[] = [
    {
      id: "domain",
      header: "Domain",
      width: "260px",
      cell: (row) => {
        const isOpen = expanded === row.domain;
        const rollup = domainWorstStatus(row);
        return (
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-table-truncate"
            onClick={() => setExpanded(isOpen ? null : row.domain)}
            aria-expanded={isOpen}
            aria-controls={authDetailsId(row.domain)}
            aria-label={`${isOpen ? "Collapse" : "Expand"} authentication details for ${row.domain}`}
          >
            <span className="pw-table-truncate" style={{ fontWeight: 500 }}>
              {row.domain}
            </span>
            {rollup !== "ok" ? (
              <span
                className={authStatusBadgeClass(
                  rollup === "unknown" ? "" : rollup,
                )}
              >
                {rollup === "unknown" ? "?" : rollup}
              </span>
            ) : null}
          </button>
        );
      },
    },
    ...AUTH_CHECK_KEYS.map((key) => ({
      id: key,
      header: AUTH_CHECK_LABELS[key],
      width: "90px",
      cell: (row: AuthCheckMatrixRow) => {
        const cell = authCheckCell(row, key);
        return (
          <span
            className={authStatusBadgeClass(cell?.status ?? "")}
            title={cell?.detail || undefined}
          >
            {authStatusLabel(cell?.status ?? "")}
          </span>
        );
      },
    })),
  ];

  return (
    <div className="card" style={{ padding: 16 }}>
      {errView ? (
        <div className="notice" role="alert" style={{ marginBottom: 10 }}>
          <span>{errView.message}</span>
          {errView.kind === "error" || errView.kind === "rate_limited" ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => void load()}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <DataTable
        caption="Authentication checks"
        description="SPF · DKIM · DMARC · BIMI · PTR per sending domain (live DNS)"
        columns={columns}
        rows={rows ?? []}
        getRowKey={(row) => row.domain}
        loading={loading && rows === null}
        loadingLabel="Checking domain authentication…"
        emptyState={
          errView
            ? "Authentication checks are unavailable. Retry to load them."
            : "No sending domains resolved to check yet."
        }
        density="compact"
        expansion={{
          isExpanded: (row) => expanded === row.domain,
          regionId: (row) => authDetailsId(row.domain),
          label: (row) => `${row.domain} authentication check details`,
          render: (row) => <AuthCheckDetails row={row} />,
        }}
        columnControls={
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Checking…" : "Re-check"}
          </button>
        }
      />
    </div>
  );
}

function AuthCheckDetails({ row }: { row: AuthCheckMatrixRow }): ReactElement {
  return (
    <dl
      style={{
        padding: "8px 12px 12px",
        display: "grid",
        gap: 6,
        fontSize: 12,
      }}
    >
      {AUTH_CHECK_KEYS.map((key) => {
        const cell = authCheckCell(row, key);
        return (
          <div key={key} style={{ display: "flex", gap: 8 }}>
            <dt style={{ fontWeight: 600, minWidth: 52 }}>
              {AUTH_CHECK_LABELS[key]}
            </dt>
            <dd style={{ display: "contents" }}>
              <span className={authStatusBadgeClass(cell?.status ?? "")}>
                {authStatusLabel(cell?.status ?? "")}
              </span>
              <span className="muted">
                {cell?.detail || "No detail returned."}
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
