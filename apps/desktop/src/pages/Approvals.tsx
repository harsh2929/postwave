import { type ReactElement, useEffect } from "react";

import "../styles-approvals.css";

import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { navigateDesktopRoute, useDesktopRoute } from "../lib/desktop-router";
import { useCanAdmin } from "../lib/store";
import { ApprovalsWorkspace } from "./approvals/ApprovalsWorkspace";
import {
  approvalDetailRouteId,
  routeWithoutApprovalDetail,
} from "./approvals/approvals-route";
import { useApprovalsController } from "./approvals/useApprovalsController";

/**
 * Approval evidence is admin-scoped by the API. The privileged controller is
 * mounted only after that role check, so this boundary initiates no privileged
 * approval request and cannot retain a verified admin snapshot after downgrade.
 */
export function Approvals(): ReactElement {
  const canAdmin = useCanAdmin();
  return canAdmin ? <ApprovalsAdminRoute /> : <ApprovalsAccessBoundary />;
}

function ApprovalsAdminRoute(): ReactElement {
  return <ApprovalsWorkspace controller={useApprovalsController()} />;
}

function ApprovalsAccessBoundary(): ReactElement {
  const route = useDesktopRoute();
  useEffect(() => {
    if (!approvalDetailRouteId(route)) return;
    const safeRoute = routeWithoutApprovalDetail(route);
    navigateDesktopRoute(safeRoute, { replace: true, source: "navigation" });
  }, [route]);
  return (
    <div className="page approvals-page approvals-access-page">
      <PageHeader
        eyebrow="Governance"
        title="Approvals"
        subtitle="Approval requests and decision evidence are restricted to workspace owners and administrators."
      />
      <section className="approvals-access-boundary" role="note">
        <span className="approvals-access-icon" aria-hidden="true">
          <Icon name="lock" size={26} />
        </span>
        <div>
          <span className="approvals-context-eyebrow">
            Admin-scoped evidence
          </span>
          <h2>Your current role cannot open the approval queue</h2>
          <p>
            This surface can reveal request ownership, governance context, and
            decision history. Ask a workspace owner to grant the appropriate
            role if this is part of your responsibility.
          </p>
        </div>
        <ul
          className="approvals-access-proof"
          aria-label="Access boundary guarantees"
        >
          <li>
            <Icon name="shield-check" size={14} /> Privileged reads are stopped
            for this role
          </li>
          <li>
            <Icon name="shield-check" size={14} /> No prior admin snapshot
            remains mounted
          </li>
          <li>
            <Icon name="shield-check" size={14} /> Routed approval detail was
            cleared
          </li>
        </ul>
      </section>
    </div>
  );
}
