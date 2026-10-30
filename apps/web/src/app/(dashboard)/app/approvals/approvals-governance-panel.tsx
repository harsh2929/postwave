// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldAlert } from "lucide-react";

import { OperationsSection } from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Fail-closed parity with desktop approval governance.
 *
 * Keep this surface transport-free until every routing and external-decision
 * path has candidate-bound server evidence. Rendering backend rows or editable
 * drafts here would imply that they are enforceable policy.
 */
export function ApprovalsGovernancePanel() {
  return (
    <OperationsSection
      id="approval-governance"
      title="Approval routing and external decisions"
      description="Delegation, escalation, staged chains, and signed external decisions remain unavailable until their authority and delivery guarantees are verified end to end."
    >
      <Alert>
        <ShieldAlert aria-hidden />
        <AlertTitle>Approval governance is on release hold</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            This page performs no delegation or escalation-policy reads or
            writes, no staged-chain or signed-link transport, and exposes no
            configuration or external-decision controls.
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="font-medium text-foreground">
                Delegated authority:
              </span>{" "}
              current workspace membership, reviewer role, and the exact
              approval have not been proven to remain bound in one authoritative
              transaction.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Staged approval chains:
              </span>{" "}
              stage eligibility, exact resource revision binding, concurrency,
              and final-effect receipts have not been proven as one atomic
              contract.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Signed links and Slack decisions:
              </span>{" "}
              recipient identity, current workspace authority, one-time token
              use, and the stored decision are not yet proven together across
              every external surface.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Escalation delivery:
              </span>{" "}
              worker access, retry durability, expiry ordering, and recipient
              delivery receipts have not been proven in production.
            </li>
          </ul>
          <p>
            Existing backend values are intentionally withheld and must not be
            treated as active approval policy.
          </p>
        </AlertDescription>
      </Alert>
    </OperationsSection>
  );
}
