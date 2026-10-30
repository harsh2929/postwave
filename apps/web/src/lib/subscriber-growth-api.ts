// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber growth trend. Backend: apps/api/internal/subscribers/growth.go.

import { api } from "./api";

export interface GrowthPoint {
  date: string; // YYYY-MM-DD
  total: number;
  added: number;
  unsubbed: number;
  lapsed: number;
}

export interface GrowthResponse {
  days: number;
  series: GrowthPoint[];
  total_added: number;
  total_unsubbed: number;
  delta: number;
  delta_pct: number;
  unavailable_metrics: string[];
  partial_metrics: string[];
  note?: string;
}

/** `days` is clamped 1–365 by the server (400 otherwise). */
export function getSubscriberGrowth(days = 90): Promise<GrowthResponse> {
  return api.get<GrowthResponse>("/api/v1/subscribers/growth", {
    query: { days },
  });
}
