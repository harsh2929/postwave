/**
 * Static approval-chain release hold.
 *
 * Keep this section free of approval-chain transport and mutation controls
 * until role enforcement, base-approval binding, and transactional completion
 * have candidate-bound evidence. The Settings heading and anchor remain
 * available so operators reach an honest explanation instead of a dead link.
 */

import type { ReactElement } from "react";

import "../../styles-approval-settings.css";

import { Notice } from "../Notice";
import { SettingsSectionHeader } from "./SettingsNav";

export function ApprovalChainSection(): ReactElement {
  return (
    <section className="settings-section" data-settings-anchor="approval-chain">
      <SettingsSectionHeader
        title="Approval chain"
        description="Multi-stage campaign approvals remain unavailable until their authorization and completion guarantees are verified end to end."
      />
      <div className="settings-section-body">
        <Notice
          tone="warning"
          title="Multi-stage approvals are on release hold"
          announcement="off"
          className="approval-chain-release-hold"
          data-testid="approval-chain-release-hold"
        >
          <p>
            Moosewave has not yet verified the safety properties required to
            treat an approval chain as an authorization control:
          </p>
          <ul>
            <li>
              <strong>Role enforcement:</strong> each decision has not been
              proven to re-check the acting user&apos;s current workspace role
              at every stage.
            </li>
            <li>
              <strong>Base approval binding:</strong> chain progress has not
              been proven to stay bound to the exact approval, campaign, and
              revision under review.
            </li>
            <li>
              <strong>Transactional completion:</strong> final-stage completion
              has not been proven to update approval state and send eligibility
              in one atomic transaction.
            </li>
          </ul>
          <p>
            To avoid implying those guarantees exist, this desktop section
            performs no approval-chain reads or writes and exposes no
            configuration controls. Existing server data and raw backend failure
            details are intentionally not displayed.
          </p>
        </Notice>
      </div>
    </section>
  );
}
