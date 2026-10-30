import type { ReactElement } from "react";

import { HeroEmptyState } from "../components/HeroEmptyState";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { useAuditScopes } from "../lib/auditScopes";
import { AuditBlockedAccess } from "./audit/AuditAccessPanels";
import { AuditPagePresentation } from "./audit/AuditPagePresentation";
import { useAuditPageController } from "./audit/useAuditPageController";
import "../styles-audit.css";

function AuditWorkspace(): ReactElement {
  const controller = useAuditPageController();
  return <AuditPagePresentation controller={controller} />;
}

function AuditPrivacyBoundary({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  const unavailable = Boolean(error);
  return (
    <div
      className="page audit-route-boundary audit-privacy-boundary"
      data-testid="audit-pii-route-boundary"
    >
      <PageHeader
        eyebrow="Investigation workspace"
        title="Audit log"
        subtitle="Protected audit evidence stays unmounted until this identity's read and PII projection scopes are both verified."
        meta={
          <div className="audit-boundary-assurance" role="note">
            <Icon name="lock" size={15} />
            <span>
              No audit rows, statistics, live events, or evidence tools have
              loaded.
            </span>
          </div>
        }
      />
      {loading ? (
        <section
          className="card audit-boundary-card"
          aria-labelledby="audit-boundary-loading-title"
          aria-busy="true"
        >
          <span className="audit-boundary-kicker">Permission boundary</span>
          <h2 id="audit-boundary-loading-title">
            Verifying private-data access…
          </h2>
          <p className="muted">
            Moosewave is checking the active workspace identity before mounting
            any audit data client.
          </p>
          <div className="audit-boundary-skeleton" aria-hidden="true" />
        </section>
      ) : (
        <>
          <HeroEmptyState
            tone="neutral"
            eyebrow={
              unavailable ? "Access check unavailable" : "Private evidence held"
            }
            title={
              unavailable
                ? "We couldn't verify the PII projection boundary"
                : "This role cannot safely open raw audit evidence"
            }
            subtitle={
              unavailable
                ? "The permission service did not return a verified scope set. Retry before opening the investigation workspace."
                : "The current audit API includes identity, network, and metadata fields in its core response. Until the server supplies a verified masked projection, Moosewave requires audit:read_pii before mounting this workspace."
            }
          />
          <div className="audit-boundary-actions">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Check access again
            </button>
          </div>
          {error ? (
            <p className="audit-boundary-error" role="alert">
              Permission check failed. No audit evidence was requested.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function Audit(): ReactElement {
  const scopes = useAuditScopes();
  const canRead = scopes.hasScope("audit:read");
  const canReadPII = scopes.hasScope("audit:read_pii");

  if (scopes.loading) {
    return (
      <AuditPrivacyBoundary
        loading
        error={null}
        onRetry={() => void scopes.refresh()}
      />
    );
  }
  if (!canRead) {
    return (
      <AuditBlockedAccess
        error={scopes.error}
        onRetry={() => void scopes.refresh()}
      />
    );
  }
  if (!canReadPII || scopes.error) {
    return (
      <AuditPrivacyBoundary
        loading={false}
        error={scopes.error}
        onRetry={() => void scopes.refresh()}
      />
    );
  }
  return <AuditWorkspace />;
}
