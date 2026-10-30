import { describe, expect, it, vi } from "vitest";

import {
  createVerificationApi,
  MAX_SYNCHRONOUS_VERIFICATION_BATCH,
} from "../../lib/api/verification";

describe("verification API containment", () => {
  it("preserves strict no-store job envelopes", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );

    await api.listJobs(50);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v1/verification/jobs?limit=50",
      { cache: "no-store" },
    );

    await api.getJob("job/id");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/verification/jobs/job%2Fid",
      { cache: "no-store" },
    );

    await api.jobResults("job/id", {
      status: ["invalid", "spamtrap"],
      limit: 101,
      offset: 100,
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/api/v1/verification/jobs/job%2Fid/results?status=invalid%2Cspamtrap&limit=101&offset=100",
      { cache: "no-store" },
    );
  });

  it("creates async work with the caller-owned key and no transport retry", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );

    await api.createJob(
      { source: "inline", emails: ["person@example.com"] },
      "verification-attempt-1",
    );

    expect(request).toHaveBeenCalledWith(
      "/api/v1/verification/jobs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "verification-attempt-1",
        },
        body: JSON.stringify({
          source: "inline",
          emails: ["person@example.com"],
        }),
      },
      { maxAttempts: 1, requireOnline: true },
    );
  });

  it("puts synchronous billable checks behind caller-owned replay keys", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );

    await api.verify("person@example.com", "single-attempt-1");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v1/verification/verify",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "single-attempt-1",
        },
        body: JSON.stringify({ email: "person@example.com" }),
      },
      { timeoutMs: 45_000, maxAttempts: 1 },
    );

    await api.verifyBatch(["person@example.com"], "batch-attempt-1");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/verification/verify-batch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "batch-attempt-1",
        },
        body: JSON.stringify({ emails: ["person@example.com"] }),
      },
      { timeoutMs: 120_000, maxAttempts: 1, requireOnline: true },
    );

    await api.saveProvider("kickbox", {
      credential_ref: "primary",
      enabled: true,
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/api/v1/verification/providers/kickbox",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential_ref: "primary", enabled: true }),
      },
      { timeoutMs: 45_000, maxAttempts: 1, requireOnline: true },
    );
  });

  it("keeps oversized paid batches on the durable-job path", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );
    const emails = Array.from(
      { length: MAX_SYNCHRONOUS_VERIFICATION_BATCH + 1 },
      (_, index) => `person-${index}@example.com`,
    );

    const result = await api.verifyBatch(emails, "oversized-attempt");

    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: { status: 400, code: "batch_too_large" },
      retryability: "not-retryable",
      preservedDraft: { emails },
    });
  });

  it("reads canonical health without shared caching or offline mutation replay", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );

    await api.health("person+sales@example.com");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v1/verification/health?email=person%2Bsales%40example.com",
      { cache: "no-store" },
      { signal: undefined },
    );

    await api.healthBatch(["person@example.com"]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/verification/health/batch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails: ["person@example.com"] }),
        cache: "no-store",
      },
      { maxAttempts: 1, requireOnline: true },
    );
  });

  it("makes cancellation online-only, single-attempt, and non-queueable", async () => {
    const request = vi.fn().mockResolvedValue({ data: undefined });
    const api = createVerificationApi(
      request as unknown as Parameters<typeof createVerificationApi>[0],
    );

    await api.cancelJob("job/id");

    expect(request).toHaveBeenCalledWith(
      "/api/v1/verification/jobs/job%2Fid/cancel",
      { method: "POST" },
      { maxAttempts: 1, requireOnline: true },
    );
  });
});
