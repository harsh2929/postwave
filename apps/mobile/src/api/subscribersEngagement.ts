/**
 * api/subscribersEngagement.ts — the engagement-score explorer transport.
 *
 *   GET /api/v1/engagement-scores/distribution               viewer
 *   GET /api/v1/engagement-scores/subscribers?min=&max=&page=&per_page=  viewer
 *   GET /api/v1/scoring/rules                                viewer
 *   PUT /api/v1/scoring/rules                                admin
 *
 * (POST /scoring/recompute is deliberately absent — the server holds it
 * behind a 409 until it is a durable job; see lib/subscriberEngagement.)
 * Envelope errors become THROWS.
 */
import { rawRequest } from "@/api/request";

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export async function fetchScoreDistribution(): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/engagement-scores/distribution",
  );
  if (res.error) surface(res.error, "Couldn't load the score distribution.");
  return res.data;
}

export const SCORE_PAGE_SIZE = 50;

export async function fetchScoredSubscribers(input: {
  min: number | null;
  max: number | null;
  page: number;
}): Promise<unknown> {
  const params = new URLSearchParams();
  if (input.min !== null) params.set("min", String(input.min));
  if (input.max !== null) params.set("max", String(input.max));
  params.set("page", String(Math.max(1, input.page)));
  params.set("per_page", String(SCORE_PAGE_SIZE));
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/engagement-scores/subscribers?${params.toString()}`,
  );
  if (res.error) surface(res.error, "Couldn't load the scored subscribers.");
  return res.data;
}

export async function fetchScoringRules(): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", "/api/v1/scoring/rules");
  if (res.error) surface(res.error, "Couldn't load the scoring rules.");
  return res.data;
}

export async function putScoringRules(
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await rawRequest<unknown>("PUT", "/api/v1/scoring/rules", body);
  if (res.error) surface(res.error, "The scoring rules were not saved.");
  return res.data;
}
