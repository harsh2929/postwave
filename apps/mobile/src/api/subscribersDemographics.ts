/**
 * api/subscribersDemographics.ts — SUB-063 inferred-demographics read.
 *
 *   GET /api/v1/subscribers/{id}/demographics   viewer (routeauth manifest)
 *
 * Read-only on the phone: the PUT trait routes exist but are the model
 * pipeline's write path, not an operator verb — desktop's DemographicsPanel
 * is read-only too. Kept react-native-free so the node vitest run pins the
 * envelope unwrap with `rawRequest` mocked.
 */
import { rawRequest } from "@/api/request";

export async function fetchSubscriberDemographics(
  id: string,
): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/subscribers/${encodeURIComponent(id)}/demographics`,
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't load demographics."),
      res.error,
    );
  }
  return res.data;
}
