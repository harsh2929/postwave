/**
 * Fail-closed containment for legacy approval delegation and escalation.
 *
 * This component is intentionally static. Keep every transport, mutation,
 * draft lifecycle, and operational control out until the server-side authority
 * and delivery guarantees listed below have candidate-bound evidence.
 */

import type { ReactElement } from "react";

import "../styles-approval-settings.css";

import { Notice } from "./Notice";

export function ApprovalSettings(): ReactElement {
  return (
    <section
      className="approval-settings-release-hold"
      aria-labelledby="approval-settings-release-hold-title"
      data-testid="approval-settings-release-hold"
    >
      <header className="approval-settings-release-hold-header">
        <span className="approval-settings-release-hold-eyebrow">
          Fail-closed governance
        </span>
        <h3 id="approval-settings-release-hold-title">
          Delegation and escalation are unavailable
        </h3>
        <p>
          These settings can change who is allowed to approve customer-facing
          work and when a request is escalated. They stay inactive until those
          guarantees are enforced and verified end to end.
        </p>
      </header>

      <Notice
        tone="warning"
        title="Approval settings are on release hold"
        announcement="off"
        className="approval-settings-release-hold-notice"
      >
        <p>
          This surface performs no approval-settings reads or writes and exposes
          no configuration controls.
        </p>
        <ul className="approval-settings-release-hold-list">
          <li>
            <strong>Delegated authority</strong>
            <span>
              Current role, tenant membership, decision identity, and the exact
              approval under review have not been proven to remain bound in one
              authoritative transaction.
            </span>
          </li>
          <li>
            <strong>Escalation delivery</strong>
            <span>
              Worker access, retry durability, expiry ordering, and recipient
              delivery receipts have not been proven under production RLS.
            </span>
          </li>
        </ul>
        <p>
          Existing backend values and raw provider failures are intentionally
          withheld. No setting shown here should be treated as active policy.
        </p>
      </Notice>
    </section>
  );
}
