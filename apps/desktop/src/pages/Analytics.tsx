import type { ReactElement } from "react";

import { AnalyticsDashboardPresentation } from "./analytics/AnalyticsDashboardPresentation";
import { useAnalyticsDashboardController } from "./analytics/useAnalyticsDashboardController";
import { useAnalyticsDashboardViewModel } from "./analytics/useAnalyticsDashboardViewModel";
import "../styles-analytics.css";
import "../styles-analytics-focus.css";

export function Analytics(): ReactElement {
  const controller = useAnalyticsDashboardController();
  const view = useAnalyticsDashboardViewModel(controller);
  return <AnalyticsDashboardPresentation dashboard={{ controller, view }} />;
}
