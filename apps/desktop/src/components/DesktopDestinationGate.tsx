import { type ReactElement, type ReactNode, useMemo } from "react";

import { useAuditScopes } from "../lib/auditScopes";
import {
  resolveCapabilityAccess,
  type CapabilityAccessDecision,
} from "../lib/capability-access";
import {
  clearCapabilityObservation,
  useCapabilityObservation,
} from "../lib/capability-observations";
import { capabilityForSection } from "../lib/desktop-capabilities";
import { routeMetaForSection } from "../lib/desktop-routes";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import { probeOnline, useOnline } from "../lib/online-manager";
import {
  loadMe,
  setSection,
  useMe,
  useRole,
  useRoleStatus,
  type Section,
} from "../lib/store";

interface Props {
  section: Section;
  children: ReactNode;
}

function canRetryAccess(decision: CapabilityAccessDecision): boolean {
  return (
    decision.state === "denied" ||
    decision.state === "not-configured" ||
    decision.state === "plan-required"
  );
}

/**
 * Route-level truth boundary. It never hides a destination from discovery;
 * it prevents protected/online-only content from mounting until the same
 * typed decision used by navigation and the palette permits entry.
 */
export function DesktopDestinationGate({
  section,
  children,
}: Props): ReactElement {
  const meta = routeMetaForSection(section);
  const capability = capabilityForSection(section);
  const role = useRole();
  const roleStatus = useRoleStatus();
  const online = useOnline();
  const audit = useAuditScopes();
  const observation = useCapabilityObservation(section);
  const me = useMe();
  const scope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const decision = useMemo(
    () =>
      resolveCapabilityAccess(section, {
        role,
        roleStatus,
        online,
        audit: {
          loading: audit.loading,
          isAdmin: audit.isAdmin,
          scopes: audit.scopes,
          error: audit.error,
        },
        observation,
      }),
    [
      audit.error,
      audit.isAdmin,
      audit.loading,
      audit.scopes,
      observation,
      online,
      role,
      roleStatus,
      section,
    ],
  );

  if (decision.state === "loading") {
    return (
      <section
        className="capability-gate capability-gate-loading"
        aria-labelledby="capability-gate-title"
        aria-busy="true"
      >
        <span className="capability-gate-eyebrow">{meta.title}</span>
        <h1 id="capability-gate-title">Checking access…</h1>
        <p>{decision.reason}</p>
        <div className="capability-gate-skeleton" aria-hidden="true" />
      </section>
    );
  }

  if (!decision.canEnter) {
    return (
      <section
        className={`capability-gate capability-gate-${decision.state}`}
        aria-labelledby="capability-gate-title"
      >
        <span className="capability-gate-eyebrow">{meta.title}</span>
        <h1 id="capability-gate-title">{decision.label}</h1>
        <p>{decision.reason}</p>
        <p className="capability-gate-assurance">
          Moosewave has not loaded this destination&apos;s remote content or
          represented inaccessible data as empty.
        </p>
        <div className="capability-gate-actions">
          {decision.state === "offline" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void probeOnline()}
            >
              Retry connection
            </button>
          ) : null}
          {canRetryAccess(decision) ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                clearCapabilityObservation(scope, section);
                if (capability.auditScope) void audit.refresh();
                if (capability.entryRole) void loadMe();
              }}
            >
              Check again
            </button>
          ) : null}
          {decision.recoverySection && decision.recoverySection !== section ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSection(decision.recoverySection!)}
            >
              Open {routeMetaForSection(decision.recoverySection).title}
            </button>
          ) : null}
          {section !== "dashboard" ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSection("dashboard")}
            >
              Go to Dashboard
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <>
      {decision.label ? (
        <div
          className={`capability-disclosure capability-disclosure-${decision.state}`}
          role="status"
        >
          <div>
            <strong>{decision.label}</strong>
            {decision.reason ? <span>{decision.reason}</span> : null}
          </div>
          {decision.recoverySection && decision.recoverySection !== section ? (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setSection(decision.recoverySection!)}
            >
              {decision.state === "limited-offline"
                ? "View recovery"
                : "Review setup"}
            </button>
          ) : null}
        </div>
      ) : null}
      {children}
    </>
  );
}
