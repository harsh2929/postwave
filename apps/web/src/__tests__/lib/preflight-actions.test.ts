// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: mocks.post },
}));

import {
  checkEmailBatch,
  checkSendWindow,
  generateSubjectVariants,
  scoreSubjectVariants,
} from "@/lib/preflight-api";

beforeEach(() => mocks.post.mockReset());

describe("preflight action contracts", () => {
  it("sends the real Subject Lab generation contract with bounded context", async () => {
    mocks.post.mockResolvedValue({
      variants: [" First idea ", "Second idea"],
      axis: "question",
      generated_at: "2026-08-29T00:00:00Z",
    });
    await expect(
      generateSubjectVariants({
        seedSubject: " A sufficiently long seed ",
        axis: "question",
        count: 6,
        bodyExcerpt: "x".repeat(3_000),
      }),
    ).resolves.toMatchObject({ variants: ["First idea", "Second idea"] });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/subject-lab/variants",
      expect.objectContaining({
        seed_subject: "A sufficiently long seed",
        axis: "question",
        count: 6,
        body_excerpt: "x".repeat(2_000),
      }),
    );
  });

  it("parses the server's variants score envelope instead of a nonexistent scores field", async () => {
    mocks.post.mockResolvedValue({
      baseline_open: 0.2,
      window_days: 180,
      variants: [
        {
          text: "One subject",
          predicted_open: 0.3,
          ci_low: 0.2,
          ci_high: 0.4,
          matched_n: 7,
          low_confidence: false,
          below_baseline: false,
        },
      ],
    });
    await expect(scoreSubjectVariants(["One subject"])).resolves.toMatchObject({
      variants: [{ text: "One subject", matched_n: 7 }],
    });
  });

  it("deduplicates bounded batch addresses and rejects oversized UI input before transport", async () => {
    mocks.post.mockResolvedValue({ results: [] });
    await checkEmailBatch(["a@example.test", " a@example.test "]);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/email-validation/check-batch",
      { emails: ["a@example.test"] },
    );
    await expect(checkEmailBatch(Array.from({ length: 1_001 }, (_, index) => `a${index}@example.test`))).rejects.toThrow(
      "1,000",
    );
  });

  it("rejects an invalid send time before transport", async () => {
    await expect(checkSendWindow("not-a-time")).rejects.toThrow("valid date");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
