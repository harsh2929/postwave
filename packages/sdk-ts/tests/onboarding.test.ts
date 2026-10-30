import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type FetchOption = NonNullable<
  ConstructorParameters<typeof PostwaveClient>[0]["fetch"]
>;

function client(fetch: FetchOption): PostwaveClient {
  return new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
}

describe("OnboardingResource", () => {
  it("listStepDecisions() reads GET /api/v1/onboarding/steps", async () => {
    const fetch = vi.fn(async () =>
      json({ steps: { dashboard_checklist: { state: "dismissed" } } }),
    );

    const res = await client(fetch).onboarding.listStepDecisions();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/onboarding/steps",
      expect.objectContaining({ method: "GET" }),
    );
    expect(res.steps.dashboard_checklist?.state).toBe("dismissed");
  });

  it("setStepDecision() PUTs the server's snake_case body", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ ok: true }),
    );

    await client(fetch).onboarding.setStepDecision(
      "dashboard_checklist",
      "skipped",
      "we use Salesforce for this",
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/onboarding/steps",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      step_key: "dashboard_checklist",
      state: "skipped",
      reason: "we use Salesforce for this",
    });
  });

  it("omits reason when none is given", async () => {
    // `reason` is nullable server-side and NULLIF'd on write; sending "" would
    // store an empty string where the absence of a reason is meant.
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ ok: true }),
    );

    await client(fetch).onboarding.setStepDecision(
      "dashboard_checklist",
      "dismissed",
    );

    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)),
    ).not.toHaveProperty("reason");
  });

  it("returns the ack the handler actually sends", async () => {
    // Regression: this method declared `Promise<OnboardingStepDecision>`, a
    // shape the endpoint has never sent — it replies `{"ok": true}`. Nothing
    // broke only because the one caller ignored the value; a caller that
    // trusted the type would have read `undefined` off every field.
    const fetch = vi.fn(async () => json({ ok: true }));

    const res = await client(fetch).onboarding.setStepDecision(
      "dashboard_checklist",
      "dismissed",
    );

    expect(res).toEqual({ ok: true });
    expect(res).not.toHaveProperty("state");
  });
});
