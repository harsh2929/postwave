import type { AnalyticsDashboardController } from "./useAnalyticsDashboardController";
import type { AnalyticsDashboardViewModel } from "./useAnalyticsDashboardViewModel";

export interface AnalyticsDashboardModel {
  controller: AnalyticsDashboardController;
  view: AnalyticsDashboardViewModel;
}

export interface AnalyticsDashboardProps {
  dashboard: AnalyticsDashboardModel;
}
