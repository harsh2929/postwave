/**
 * api/subscribersProfileData.ts — the profile Data-cluster reads, one seam:
 *
 *   GET /api/v1/subscribers/{id}/gpp                    viewer (SUB-120)
 *   GET /api/v1/subscribers/{id}/custom-objects         viewer (SUB-011)
 *   GET /api/v1/subscribers/{id}/catalog-attributes     viewer
 *   GET /api/v1/subscribers/{id}/segment-membership     viewer (SUB-070)
 *   GET /api/v1/subscribers/{id}/decision-explanations  viewer (SUB-070)
 *
 * All five are lazy, disclosure-card reads — parsing lives in the lib
 * siblings (subscriberGpp / subscriberCustomObjects /
 * subscriberSegmentDecisions). Kept react-native-free so the node vitest run
 * pins the envelope unwrap with `rawRequest` mocked: `rawRequest` resolves
 * to the {data, error} ENVELOPE, and error becomes a THROW so a failed read
 * can never render as an empty-but-healthy card.
 */
import { rawRequest } from "@/api/request";

function base(id: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(id)}`;
}

async function get(path: string, fallback: string): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) {
    throw Object.assign(new Error(res.error.message || fallback), res.error);
  }
  return res.data;
}

export function fetchSubscriberGpp(id: string): Promise<unknown> {
  return get(`${base(id)}/gpp`, "Couldn't load GPP consent sections.");
}

export function fetchSubscriberCustomObjectLinks(id: string): Promise<unknown> {
  return get(`${base(id)}/custom-objects`, "Couldn't load linked records.");
}

export function fetchSubscriberCatalogAttributes(id: string): Promise<unknown> {
  return get(
    `${base(id)}/catalog-attributes`,
    "Couldn't load catalog attributes.",
  );
}

export function fetchSubscriberSegmentMembership(id: string): Promise<unknown> {
  return get(
    `${base(id)}/segment-membership`,
    "Couldn't load segment membership.",
  );
}

export function fetchSubscriberDecisionExplanations(
  id: string,
): Promise<unknown> {
  return get(
    `${base(id)}/decision-explanations`,
    "Couldn't load decision explanations.",
  );
}
