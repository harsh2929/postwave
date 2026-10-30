import type { ReactElement } from "react";

import {
  DELIVERABILITY_HUB_TAB_VALUES,
  DeliverabilityHubWorkspace,
  type DeliverabilityHubTab,
} from "../components/deliverability/DeliverabilityHubWorkspace";
import { useDesktopRouteTab } from "../lib/desktop-router";
import { useDeliverabilityHubData } from "./useDeliverabilityHubData";

import "../styles-deliverability-hub.css";
import "../styles-deliverability-hub-adaptive.css";
import "../styles-deliverability-feedback.css";
import "../styles-deliverability-score.css";
import "../styles-deliverability-actions.css";
import "../styles-deliverability-recovery.css";
import "../styles-deliverability-diagnostics.css";
import "../styles-deliverability-controls.css";

export function DeliverabilityHub(): ReactElement {
  const [tab, setTab] = useDesktopRouteTab<DeliverabilityHubTab>(
    "deliverabilityHub",
    DELIVERABILITY_HUB_TAB_VALUES,
    "overview",
  );
  const data = useDeliverabilityHubData();

  return (
    <DeliverabilityHubWorkspace data={data} tab={tab} onTabChange={setTab} />
  );
}
