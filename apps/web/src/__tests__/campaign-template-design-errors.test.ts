// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { campaignTemplateDesignMutationErrorMessage } from "@/app/(dashboard)/app/templates/_components/use-campaign-template-design-workflow";
import { ApiError } from "@/lib/api";

describe("campaign template design edge-case copy", () => {
  it("makes offline non-queueing explicit", () => {
    expect(
      campaignTemplateDesignMutationErrorMessage(
        new ApiError("offline", 0, undefined, {
          code: "offline",
          kind: "offline",
        }),
        "fallback",
      ),
    ).toMatch(/not queued/i);
  });

  it("turns revision/hash conflicts into a refresh-and-review instruction", () => {
    expect(
      campaignTemplateDesignMutationErrorMessage(
        new ApiError("conflict", 409, undefined, {
          code: "design_revision_conflict",
        }),
        "fallback",
      ),
    ).toMatch(/refreshed.*latest immutable revision/i);
  });

  it("explains idempotency-key request mismatches", () => {
    expect(
      campaignTemplateDesignMutationErrorMessage(
        new ApiError("mismatch", 422, undefined, {
          code: "idempotency_key_request_mismatch",
        }),
        "fallback",
      ),
    ).toMatch(/different request/i);
  });
});

