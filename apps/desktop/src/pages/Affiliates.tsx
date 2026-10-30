/**
 * Affiliate-program release-qualification workspace.
 *
 * Production composition does not expose the platform-global affiliate
 * ledger, public offer, attribution accrual, or settlement operations. This
 * route therefore performs no affiliate API requests and presents only the
 * reviewed release boundary.
 */

import type { ReactElement } from "react";

import { AffiliatesQualificationWorkspace } from "../components/affiliates/AffiliatesQualificationWorkspace";
import "../styles-affiliates.css";

export function Affiliates(): ReactElement {
  return <AffiliatesQualificationWorkspace />;
}
