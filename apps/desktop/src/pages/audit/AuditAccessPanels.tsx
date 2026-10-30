import { type ReactElement, useEffect, useState } from "react";

import { HeroEmptyState } from "../../components/HeroEmptyState";
import { type AuditAccessRequest, api } from "../../lib/api-client";

export function AuditAccessRequestsAdminPanel(): ReactElement | null {
  const [items, setItems] = useState<AuditAccessRequest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await api.listAuditAccessRequests({ status: "pending" });
      if (cancelled) return;
      if (response.error) {
        setLoadError(response.error.message);
        setItems(null);
        return;
      }
      setLoadError(null);
      setItems(response.data?.items ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [retryNonce]);

  if (loadError) {
    return (
      <div
        className="muted"
        style={{ fontSize: 12, marginBottom: 8 }}
        data-testid="audit-access-requests-error"
      >
        Couldn&apos;t load pending audit-access requests. No request details
        were displayed.{" "}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRetryNonce((nonce) => nonce + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <div
      className="card"
      style={{ padding: "10px 12px", marginBottom: 8 }}
      data-testid="audit-access-requests-panel"
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        Pending audit-access request{items.length === 1 ? "" : "s"} (
        {items.length})
      </div>
      <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
        {items.map((request) => (
          <li key={request.id} style={{ fontSize: 12 }}>
            <strong>
              {request.userEmail ??
                request.actorLabel ??
                request.userId ??
                "Unknown user"}
            </strong>
            {request.note ? (
              <span className="muted"> — “{request.note}”</span>
            ) : null}
            {request.createdAt ? (
              <span className="muted">
                {" "}
                · {new Date(request.createdAt).toLocaleString()}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>
        To grant access, use Settings → Team → Roles and give the requester a
        role with both audit:read and audit:read_pii. Requests can&apos;t be
        approved from this screen.
      </p>
    </div>
  );
}

export function AuditBlockedAccess({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  if (error) {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-title">Audit log</h1>
            <div className="page-subtitle">Couldn&apos;t verify access</div>
          </div>
        </div>
        <HeroEmptyState
          tone="neutral"
          eyebrow="Access check failed"
          title="We couldn't verify your audit access"
          subtitle="Loading your audit permissions failed. This is usually transient — retry to load the audit log. If it keeps failing, ask a tenant owner to confirm your audit role."
        />
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 12 }}
        >
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit log</h1>
          <div className="page-subtitle">Restricted</div>
        </div>
      </div>
      <HeroEmptyState
        tone="neutral"
        eyebrow="Restricted"
        title="You don't have access to the audit log"
        subtitle="This private evidence workspace requires both audit:read and audit:read_pii. Ask a tenant owner or admin to review your role grants in Settings → Team → Roles."
      />
    </>
  );
}
