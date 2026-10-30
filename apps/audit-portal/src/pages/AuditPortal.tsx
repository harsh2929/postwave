/**
 * AuditPortal.tsx — fail-closed, read-only audit evidence viewer.
 *
 * A 503 from either evidence endpoint is the portal's release-hold signal. The
 * hold is terminal for the mounted portal: every evidence affordance is
 * removed and late responses are ignored. Reloading the host page is the only
 * way to create a fresh portal instance after the backend hold is lifted.
 */
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  ApiResult,
  AuditRow,
  Branding,
  ListAuditResponse,
  PortalApiClient,
} from "../lib/portal-api-client";

/** Rows per request. Exported so App can prefetch page one with the same size. */
export const PORTAL_PAGE_SIZE = 50;

// One formatter for the whole table. `toLocaleString()` builds a fresh
// Intl.DateTimeFormat per call, which is the dominant cost of re-rendering an
// accumulated list; these options reproduce its default output exactly.
const timestampFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

interface Props {
  api: PortalApiClient;
  branding: Branding;
  notifyParent: (message: Record<string, unknown>) => void;
  /**
   * Page one, already fetched alongside branding so the boot is two round trips
   * rather than three. Consumed once, on mount, and only for the unfiltered
   * view it was fetched for.
   */
  initialPage?: ApiResult<ListAuditResponse>;
}

type PortalAvailability =
  | "loading"
  | "ready"
  | "release-hold"
  | "session-error"
  | "network-error"
  | "service-error";

interface SafeFailure {
  availability: Exclude<PortalAvailability, "loading" | "ready">;
  message: string;
}

function classifyFailure(status?: number): SafeFailure {
  if (status === 503) {
    return {
      availability: "release-hold",
      message: "Audit evidence is temporarily behind a release hold.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      availability: "session-error",
      message: "This portal session is no longer authorized.",
    };
  }
  if (status == null) {
    return {
      availability: "network-error",
      message: "The audit portal service could not be reached.",
    };
  }
  return {
    availability: "service-error",
    message: "The audit portal could not load this view.",
  };
}

export function AuditPortal({
  api,
  branding,
  notifyParent,
  initialPage,
}: Props): JSX.Element {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [availability, setAvailability] =
    useState<PortalAvailability>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [verifySession, setVerifySession] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const terminalRef = useRef(false);
  const listRequestRef = useRef(0);
  const proofRequestRef = useRef(0);
  const pendingInitialPage = useRef(initialPage);

  const enterFailure = useCallback(
    (status?: number) => {
      if (terminalRef.current) return;
      terminalRef.current = true;
      listRequestRef.current += 1;
      proofRequestRef.current += 1;

      const failure = classifyFailure(status);
      setRows([]);
      setCursor(null);
      setActionDraft("");
      setActionFilter("");
      setVerifySession("");
      setVerifyError(null);
      setVerifying(false);
      setLoadingMore(false);
      setAvailability(failure.availability);
      notifyParent({
        type: "postwave:error",
        message: failure.message,
        status,
      });
    },
    [notifyParent],
  );

  const load = useCallback(
    async (options: {
      replace: boolean;
      requestCursor: string | null;
      filter: string;
    }) => {
      if (terminalRef.current) return;
      const requestId = ++listRequestRef.current;

      if (options.replace) {
        setAvailability("loading");
        setRows([]);
        setCursor(null);
      } else {
        setLoadingMore(true);
      }

      const result = await api.listAudit({
        limit: PORTAL_PAGE_SIZE,
        cursor: options.requestCursor,
        action: options.filter || undefined,
      });

      if (
        terminalRef.current ||
        requestId !== listRequestRef.current
      ) {
        return;
      }

      if (!result.ok) {
        enterFailure(result.status);
        return;
      }

      setRows((previous) =>
        options.replace ? result.data.rows : [...previous, ...result.data.rows],
      );
      setCursor(result.data.nextCursor ?? null);
      setLoadingMore(false);
      setAvailability("ready");
    },
    [api, enterFailure],
  );

  useEffect(() => {
    if (terminalRef.current) return;
    // Adopt the prefetched first page instead of re-requesting it. It answers
    // exactly the unfiltered query this effect would issue, so it is consumed
    // only while no filter is applied, and only once.
    const prefetched = pendingInitialPage.current;
    pendingInitialPage.current = undefined;
    if (prefetched && actionFilter === "") {
      listRequestRef.current += 1;
      if (!prefetched.ok) {
        enterFailure(prefetched.status);
        return;
      }
      setRows(prefetched.data.rows);
      setCursor(prefetched.data.nextCursor ?? null);
      setLoadingMore(false);
      setAvailability("ready");
      return;
    }
    void load({ replace: true, requestCursor: null, filter: actionFilter });
  }, [actionFilter, enterFailure, load]);

  useEffect(
    () => () => {
      terminalRef.current = true;
      listRequestRef.current += 1;
      proofRequestRef.current += 1;
    },
    [],
  );

  const downloadBundle = useCallback(async () => {
    const sessionId = verifySession.trim();
    if (!sessionId || terminalRef.current) return;

    const requestId = ++proofRequestRef.current;
    setVerifying(true);
    setVerifyError(null);
    const result = await api.downloadAivsBundle(sessionId);

    if (
      terminalRef.current ||
      requestId !== proofRequestRef.current
    ) {
      return;
    }

    setVerifying(false);
    if (!result.ok) {
      if (result.status === 503 || result.status === 401 || result.status === 403) {
        enterFailure(result.status);
        return;
      }
      setVerifyError(
        result.status == null
          ? "The verification service could not be reached. No file was downloaded."
          : "The proof bundle could not be prepared. No file was downloaded.",
      );
      return;
    }

    // Re-check the terminal state immediately before the browser side effect.
    // A list request may have placed the portal on hold while this response was
    // being decoded.
    if (terminalRef.current || requestId !== proofRequestRef.current) return;
    const url = URL.createObjectURL(result.data.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.data.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [api, enterFailure, verifySession]);

  const applyActionFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextFilter = actionDraft.trim();
    if (nextFilter !== actionFilter) setActionFilter(nextFilter);
  };

  if (availability !== "ready") {
    return (
      <AvailabilityPanel
        availability={availability}
        brandName={branding.brand_name}
        supportEmail={branding.support_email}
      />
    );
  }

  return (
    <section
      aria-labelledby="audit-portal-title"
      style={portalShell}
    >
      <div style={portalToolbar}>
        <div style={{ minWidth: 180 }}>
          <p style={eyebrow}>Customer audit portal</p>
          <h1 id="audit-portal-title" style={portalTitle}>
            Audit activity
          </h1>
        </div>
        <form
          aria-label="Filter audit activity"
          onSubmit={applyActionFilter}
          style={filterForm}
        >
          <label htmlFor="audit-action-filter" style={fieldLabel}>
            Action
          </label>
          <div style={filterControls}>
            <input
              id="audit-action-filter"
              type="text"
              value={actionDraft}
              onChange={(event) => setActionDraft(event.target.value)}
              placeholder="e.g. user.login"
              autoComplete="off"
              maxLength={160}
              style={textInput}
            />
            <button
              type="submit"
              disabled={actionDraft.trim() === actionFilter}
              style={secondaryButton}
            >
              Apply
            </button>
          </div>
        </form>
        <span style={loadedCount} aria-live="polite">
          {rows.length === 0
            ? actionFilter
              ? "No matches"
              : "No activity returned"
            : `${rows.length.toLocaleString()} loaded`}
        </span>
      </div>

      <div style={proofPanel}>
        <div style={{ flex: "1 1 240px" }}>
          <p style={{ ...fieldLabel, margin: 0 }}>Offline verification</p>
          <p style={proofDescription}>
            Enter an agent session ID to request its signed verification bundle.
          </p>
        </div>
        <div style={proofControls}>
          <label htmlFor="audit-session-id" style={visuallyHidden}>
            Agent session ID
          </label>
          <input
            id="audit-session-id"
            type="text"
            value={verifySession}
            onChange={(event) => setVerifySession(event.target.value)}
            placeholder="Agent session ID"
            autoComplete="off"
            maxLength={256}
            style={textInput}
          />
          <button
            type="button"
            disabled={verifying || !verifySession.trim()}
            onClick={() => void downloadBundle()}
            style={primaryButton}
          >
            {verifying ? "Preparing…" : "Download proof bundle"}
          </button>
        </div>
        {verifyError ? (
          <p role="alert" style={inlineError}>
            {verifyError}
          </p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <caption style={visuallyHidden}>
              Audit events returned for this portal session
            </caption>
            <thead>
              <tr style={{ background: "var(--portal-surface-2)" }}>
                <th scope="col" style={cellHead}>When</th>
                <th scope="col" style={cellHead}>Action</th>
                <th scope="col" style={cellHead}>Actor</th>
                <th scope="col" style={cellHead}>Resource</th>
                <th scope="col" style={cellHead}>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AuditTableRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="status" style={emptyState}>
          <strong style={{ color: "var(--portal-fg)" }}>
            {actionFilter ? "No matching activity" : "No activity returned"}
          </strong>
          <span>
            {actionFilter
              ? "Try a different action value or clear the filter."
              : "The service returned no rows for this portal session."}
          </span>
        </div>
      )}

      <footer style={portalFooter}>
        <span style={{ fontSize: 12, color: "var(--portal-muted)" }}>
          {branding.support_email
            ? `Questions? Contact ${branding.support_email}`
            : "This view is read-only."}
        </span>
        {cursor != null ? (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() =>
              void load({
                replace: false,
                requestCursor: cursor,
                filter: actionFilter,
              })
            }
            style={primaryButton}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

// Rows accumulate page by page and are immutable once loaded, so "Load more"
// should reconcile only the 50 new ones. Without this memo every append
// re-renders and re-formats the whole accumulated table.
const AuditTableRow = memo(function AuditTableRow({
  row,
}: {
  row: AuditRow;
}): JSX.Element {
  return (
    <tr style={tableRow}>
      <td style={cellBody}>{timestampFormat.format(new Date(row.at))}</td>
      <td style={{ ...cellBody, fontFamily: "monospace" }}>{row.action}</td>
      <td style={cellBody}>{row.actorLabel ?? row.userId ?? row.actorType}</td>
      <td style={cellBody}>
        {row.resourceType ?? "—"}
        {row.resourceId ? ` · ${row.resourceId}` : ""}
      </td>
      <td style={cellBody}>{row.ip ?? "—"}</td>
    </tr>
  );
});

interface AvailabilityPanelProps {
  availability: Exclude<PortalAvailability, "ready">;
  brandName: string;
  supportEmail: string;
}

function AvailabilityPanel({
  availability,
  brandName,
  supportEmail,
}: AvailabilityPanelProps): JSX.Element {
  if (availability === "loading") {
    return (
      <section
        aria-busy="true"
        aria-labelledby="portal-loading-title"
        role="status"
        style={{ ...availabilityShell, minHeight: 280 }}
      >
        <div aria-hidden="true" style={loadingGlyph} />
        <p style={eyebrow}>Secure portal</p>
        <h1 id="portal-loading-title" style={availabilityTitle}>
          Checking portal availability…
        </h1>
        <p style={availabilityBody}>
          Establishing this read-only session with {brandName || "your workspace"}.
        </p>
      </section>
    );
  }

  const isHold = availability === "release-hold";
  const isSessionError = availability === "session-error";
  const isNetworkError = availability === "network-error";
  const title = isHold
    ? "Audit evidence is not available in this portal"
    : isSessionError
      ? "This portal session needs a new link"
      : isNetworkError
        ? "The portal service cannot be reached"
        : "The audit portal is unavailable";
  const body = isHold
    ? "This evidence view is intentionally unavailable while its authorization and delivery controls complete release review."
    : isSessionError
      ? "The link may have expired or the session may no longer be authorized. Request a fresh portal link from the workspace owner."
      : isNetworkError
        ? "The browser could not reach the portal service. No audit result is being represented by this screen."
        : "The service could not open this audit view. No audit result is being represented by this screen.";
  const eyebrowText = isHold
    ? "Release hold"
    : isSessionError
      ? "Session unavailable"
      : isNetworkError
        ? "Connection unavailable"
        : "Service unavailable";

  return (
    <section
      aria-labelledby="portal-availability-title"
      aria-describedby="portal-availability-description"
      role={isHold ? "status" : "alert"}
      style={availabilityShell}
    >
      <div style={availabilityGrid}>
        <div aria-hidden="true" style={shieldTile}>
          <svg width="32" height="36" viewBox="0 0 32 36" fill="none">
            <path
              d="M16 2.5 28 7v9.2c0 7.7-4.7 13.8-12 17.3C8.7 30 4 23.9 4 16.2V7l12-4.5Z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M12.2 12.5v11M19.8 12.5v11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <p style={eyebrow}>{eyebrowText}</p>
          <h1 id="portal-availability-title" style={availabilityTitle}>
            {title}
          </h1>
          <p id="portal-availability-description" style={availabilityBody}>
            {body}
          </p>
        </div>
      </div>

      {isHold ? (
        <div style={holdExplanation}>
          <div>
            <span style={explanationLabel}>What this screen means</span>
            <p style={explanationCopy}>
              No event count, completeness state, downloadable proof, or
              verification result is shown while the hold is active.
            </p>
          </div>
          <div>
            <span style={explanationLabel}>Next step</span>
            <p style={explanationCopy}>
              Contact the workspace owner or support for release status. A new
              portal session can be opened after the hold is lifted.
            </p>
          </div>
        </div>
      ) : null}

      <div style={supportPanel}>
        <span style={{ color: "var(--portal-muted)", fontSize: 12 }}>
          Need help with this portal?
        </span>
        {supportEmail ? (
          <a href={`mailto:${supportEmail}`} style={supportLink}>
            Contact {supportEmail}
          </a>
        ) : (
          <span style={{ fontWeight: 650 }}>Contact your workspace owner</span>
        )}
      </div>
    </section>
  );
}

const portalShell: CSSProperties = {
  background: "var(--portal-surface)",
  border: "1px solid var(--portal-border)",
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 14px 40px rgba(15, 15, 15, 0.06)",
};

const portalToolbar: CSSProperties = {
  padding: 20,
  display: "flex",
  gap: 18,
  alignItems: "end",
  flexWrap: "wrap",
  borderBottom: "1px solid var(--portal-border)",
};

const eyebrow: CSSProperties = {
  margin: "0 0 7px",
  color: "var(--portal-primary)",
  fontSize: 11,
  fontWeight: 750,
  letterSpacing: "0.13em",
  textTransform: "uppercase",
};

const portalTitle: CSSProperties = {
  margin: 0,
  color: "var(--portal-fg)",
  fontSize: 22,
  lineHeight: 1.15,
};

const filterForm: CSSProperties = {
  display: "grid",
  flex: "1 1 300px",
  gap: 6,
};

const filterControls: CSSProperties = {
  display: "flex",
  gap: 8,
};

const fieldLabel: CSSProperties = {
  color: "var(--portal-muted)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const textInput: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "9px 11px",
  border: "1px solid var(--portal-border)",
  borderRadius: 8,
  background: "var(--portal-surface)",
  color: "var(--portal-fg)",
  fontSize: 13,
};

const primaryButton: CSSProperties = {
  padding: "9px 13px",
  background: "var(--portal-primary)",
  color: "white",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const secondaryButton: CSSProperties = {
  ...primaryButton,
  background: "var(--portal-surface-2)",
  color: "var(--portal-fg)",
  border: "1px solid var(--portal-border)",
};

const loadedCount: CSSProperties = {
  alignSelf: "center",
  padding: "6px 9px",
  border: "1px solid var(--portal-border)",
  borderRadius: 999,
  color: "var(--portal-muted)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

const proofPanel: CSSProperties = {
  padding: "14px 20px",
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
  background: "var(--portal-surface-2)",
  borderBottom: "1px solid var(--portal-border)",
};

const proofDescription: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--portal-muted)",
  fontSize: 12,
  lineHeight: 1.45,
};

const proofControls: CSSProperties = {
  display: "flex",
  flex: "2 1 360px",
  gap: 8,
  alignItems: "center",
};

const inlineError: CSSProperties = {
  width: "100%",
  margin: 0,
  color: "var(--portal-danger)",
  fontSize: 12,
};

const tableStyle: CSSProperties = {
  width: "100%",
  minWidth: 720,
  borderCollapse: "collapse",
  fontSize: 13,
};

const tableRow: CSSProperties = {
  borderTop: "1px solid var(--portal-border)",
};

const cellHead: CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--portal-muted)",
  fontWeight: 700,
};

const cellBody: CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "top",
};

const emptyState: CSSProperties = {
  minHeight: 180,
  padding: 32,
  display: "grid",
  placeContent: "center",
  gap: 7,
  textAlign: "center",
  color: "var(--portal-muted)",
  fontSize: 13,
};

const portalFooter: CSSProperties = {
  padding: "12px 20px",
  display: "flex",
  gap: 12,
  alignItems: "center",
  justifyContent: "space-between",
  borderTop: "1px solid var(--portal-border)",
};

const availabilityShell: CSSProperties = {
  position: "relative",
  maxWidth: 820,
  minHeight: 430,
  margin: "0 auto",
  padding: "clamp(28px, 6vw, 58px)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 26,
  overflow: "hidden",
  background: "var(--portal-surface)",
  border: "1px solid var(--portal-border)",
  borderRadius: 18,
  boxShadow: "0 24px 70px rgba(15, 15, 15, 0.08)",
};

const availabilityGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: 22,
  alignItems: "start",
};

const shieldTile: CSSProperties = {
  width: 68,
  height: 68,
  display: "grid",
  placeItems: "center",
  borderRadius: 18,
  background: "var(--portal-surface-2)",
  border: "1px solid var(--portal-border)",
  color: "var(--portal-primary)",
  boxShadow: "inset 0 0 0 5px var(--portal-surface)",
};

const loadingGlyph: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: "50%",
  border: "3px solid var(--portal-border)",
  borderTopColor: "var(--portal-primary)",
};

const availabilityTitle: CSSProperties = {
  maxWidth: 620,
  margin: 0,
  color: "var(--portal-fg)",
  fontSize: "clamp(24px, 4vw, 38px)",
  lineHeight: 1.12,
  letterSpacing: "-0.025em",
};

const availabilityBody: CSSProperties = {
  maxWidth: 620,
  margin: "13px 0 0",
  color: "var(--portal-muted)",
  fontSize: 15,
  lineHeight: 1.65,
};

const holdExplanation: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  padding: 14,
  border: "1px solid var(--portal-border)",
  borderRadius: 12,
  background: "var(--portal-surface-2)",
};

const explanationLabel: CSSProperties = {
  color: "var(--portal-fg)",
  fontSize: 12,
  fontWeight: 750,
};

const explanationCopy: CSSProperties = {
  margin: "6px 0 0",
  color: "var(--portal-muted)",
  fontSize: 12,
  lineHeight: 1.55,
};

const supportPanel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  flexWrap: "wrap",
  paddingTop: 18,
  borderTop: "1px solid var(--portal-border)",
};

const supportLink: CSSProperties = {
  color: "var(--portal-primary)",
  fontSize: 13,
  fontWeight: 700,
  textDecoration: "none",
};

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
