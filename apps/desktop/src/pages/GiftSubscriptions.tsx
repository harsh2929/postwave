/**
 * Gift history is intentionally a sanitized, inspection-only route.
 *
 * Creation, cancellation, editing, payment handoff, redemption, identified
 * attribution, provider reconciliation, entitlement mutation, and export are
 * not represented as dormant controls or transport methods in this bundle.
 */

import type { ReactElement } from "react";

import { GiftHistoryWorkspace } from "../components/gifts/GiftHistoryWorkspace";
import "../styles-gift-history.css";
import "../styles-gift-history-adaptive.css";

export function GiftSubscriptions(): ReactElement {
  return <GiftHistoryWorkspace />;
}
