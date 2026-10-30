/**
 * Discount history is intentionally an inspection-only route.
 *
 * Provider-backed authoring, mutation, live validation, redemption and
 * personally identified export are not represented as dormant controls. The
 * workspace renders only evidence that the mounted historical read surface can
 * support, with the provider/checkout boundary visible at every decision point.
 */

import type { ReactElement } from "react";

import { DiscountHistoryWorkspace } from "../components/discounts/DiscountHistoryWorkspace";
import "../styles-discount-history.css";
import "../styles-discount-history-adaptive.css";

export function Discounts(): ReactElement {
  return <DiscountHistoryWorkspace />;
}
