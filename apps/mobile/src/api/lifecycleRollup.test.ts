/**
 * The transport seam: given exactly what `rawRequest` really resolves to —
 * the `{data, error}` envelope — does a row come out, and does a failure
 * surface as a throw rather than as an empty card?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorPresentation } from "@/lib/errorCopy";

import {
  fetchLifecycleDistribution,
  fetchLifecycleStages,
  isLifecycleUnavailable,
} from "./lifecycleRollup";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("lifecycle rollup reads unwrap the response envelope", () => {
  it("returns histogram rows from the envelope rawRequest resolves to", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [{ stage: "lead", count: 4 }] },
      error: null,
    });
    await expect(fetchLifecycleDistribution()).resolves.toEqual([
      { stage: "lead", count: 4 },
    ]);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/lifecycle/distribution",
    );
  });

  it("returns the stage catalog from its envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { stages: ["subscriber", "lead"] },
      error: null,
    });
    await expect(fetchLifecycleStages()).resolves.toEqual([
      "subscriber",
      "lead",
    ]);
  });

  it("surfaces a failed read as a throw carrying the status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "boom" },
    });
    await expect(fetchLifecycleDistribution()).rejects.toMatchObject({
      status: 500,
      message: "boom",
    });
  });

  it("classifies 404 — routes not mounted — as unavailable, and only 404", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 404, message: "" },
    });
    const err = await fetchLifecycleDistribution().catch((e: unknown) => e);
    expect(isLifecycleUnavailable(err)).toBe(true);

    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "" },
    });
    const other = await fetchLifecycleDistribution().catch((e: unknown) => e);
    expect(isLifecycleUnavailable(other)).toBe(false);
    expect(isLifecycleUnavailable(new Error("plain"))).toBe(false);
  });

  it("keeps the server's plan denial, so the card says upgrade rather than retry", async () => {
    // LifecycleReadError kept only `status`, so a 402 plan ceiling fell past
    // every errorCopy arm into "Something went wrong loading this" with Retry.
    // This file mocks @/api/request with a bare factory: a base class exported
    // from request.ts would be undefined here and fail this suite at import.
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 402,
        message: "x",
        code: "plan_limit_exceeded",
        denial: {
          subject: "lifecycle",
          reason: "plan",
          code: "plan_limit_exceeded",
          remedy: "upgrade_plan",
        },
      },
    });
    const err = await fetchLifecycleStages().catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "LifecycleReadError",
      status: 402,
      code: "plan_limit_exceeded",
      denial: { reason: "plan", remedy: "upgrade_plan" },
    });
    expect(errorPresentation(err)).toEqual({
      message: "Your plan doesn't include this. Upgrade or reduce usage to continue.",
      retryable: false,
    });
  });
});
