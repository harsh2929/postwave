// SPDX-License-Identifier: AGPL-3.0-only
//
// Marketing-side helper (MKTC-019): submit a structured roadmap-feedback
// signal through the existing public-forms submit endpoint. The form is a
// double-opt-in Moosewave form in the marketing tenant, so a submission both
// records the qualification requirement (custom field) and subscribes the
// person to updates (confirmation email). No auth — credentials omitted.

const ROADMAP_FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * "received" is the answer for a form whose consent checkbox was left
 * unticked: the feedback is recorded and nobody is subscribed.
 */
export type RoadmapFeedbackState =
  | "subscribed"
  | "pending-confirmation"
  | "received";

function acceptedState(payload: unknown): RoadmapFeedbackState | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as { ok?: unknown; state?: unknown };
  if (response.ok !== true) return null;
  return response.state === "subscribed" ||
    response.state === "pending-confirmation" ||
    response.state === "received"
    ? response.state
    : null;
}

export async function submitRoadmapFeedback(
  slug: string,
  email: string,
  requirement: string,
): Promise<RoadmapFeedbackState | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROADMAP_FEEDBACK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `/api/public/forms/${encodeURIComponent(slug)}/submit`,
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          email,
          customFields: { cf_requirement: requirement },
        }),
      },
    );
    if (!res.ok) return null;
    return acceptedState(await res.json().catch(() => null));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
