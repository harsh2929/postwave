/**
 * Admin-only, read-only retention evidence route.
 *
 * Operational authoring, portal acceptance, event ingestion, Stripe
 * application, and automated win-back delivery are intentionally absent. The
 * workspace renders only the four historical/configuration GET boundaries that
 * can be inspected without implying those dormant capabilities are mounted.
 */

import { type ReactElement } from "react";

import { RetentionHistoryWorkspace } from "../components/retention/RetentionHistoryWorkspace";
import "../styles-retention-offers.css";
import "../styles-retention-offers-detail.css";
import "../styles-retention-offers-adaptive.css";

export default function RetentionOffersPage(): ReactElement {
  return <RetentionHistoryWorkspace />;
}
