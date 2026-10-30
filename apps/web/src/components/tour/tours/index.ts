// SPDX-License-Identifier: AGPL-3.0-only
import type { Tour } from "../types";
import { dashboardTour } from "./dashboard";
import { marketingTour } from "./marketing";

export const TOURS: Record<string, Tour> = {
  marketing: marketingTour,
  dashboard: dashboardTour,
};

export type TourId = keyof typeof TOURS;

export { dashboardTour, marketingTour };
