/**
 * api/productEventsExport.ts — the raw product-event feed as CSV TEXT.
 *
 *   GET /api/v1/track/events.csv   viewer (routeauth manifest.json)
 *
 * Mounted on `readRawEvents` — `RequireAllScopes(ScopeReadReports,
 * ScopeReadSubscribers)` (apps/api/internal/track/handlers.go:97) — the same
 * pair the sample read already uses, so any session role that can open the
 * Track screen's drill-down can also export it. An API-KEY caller holding only
 * `read:reports` is the one case that 403s where the catalogue succeeded; that
 * surfaces as the export's own error, never as a blanked screen.
 *
 * `asText` is required: the endpoint answers `text/csv`, and without it the
 * SDK would only return a string by accident of content-type sniffing. Going
 * through `sdkResource` rather than `getClient` keeps react-native out of this
 * module's import graph.
 */
import { checkedApiResult, sdkResource } from "./request";

import { productEventsExportPath } from "@/lib/productEventsExport";

/**
 * Fetch the newest events for one window as CSV text. Bounding, re-emission
 * and the truncation claim all belong to lib/productEventsExport — this
 * function only transports the bytes.
 */
export async function fetchProductEventsCsv(input: {
  days: number;
  eventName?: string | undefined;
}): Promise<string> {
  const res = await checkedApiResult(
    sdkResource<string>((client) =>
      client.request<string>("GET", productEventsExportPath(input), {
        asText: true,
      }),
    ),
  );
  return res.data ?? "";
}
