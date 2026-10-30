// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { formatError } from "../../src/lib/format.js";

describe("formatError", () => {
  it("preserves actionable typed SDK error context", () => {
    const error = Object.assign(new Error("Reference templates are read-only"), {
      name: "ValidationError",
      status: 422,
      code: "adaptation_required",
      requestId: "req_123",
      tool: "campaign_template_update",
      payload: {
        error: {
          code: "adaptation_required",
          message: "Reference templates are read-only",
          retryable: false,
          details: { template_id: "tpl_1" },
        },
      },
    });

    const result = formatError(error);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        name: "ValidationError",
        message: "Reference templates are read-only",
        status: 422,
        code: "adaptation_required",
        tool: "campaign_template_update",
        request_id: "req_123",
        retryable: false,
        recommended_action: "campaign_template_adapt",
        details: { template_id: "tpl_1" },
      },
    });
  });

  it("marks quota and transient server errors as retryable", () => {
    const rateLimit = Object.assign(new Error("Quota reached"), {
      status: 429,
      code: "quota_exceeded",
      retryAfterSeconds: 120,
    });

    expect(formatError(rateLimit).structuredContent).toMatchObject({
      error: {
        retryable: true,
        retry_after_seconds: 120,
        recommended_action: "retry_after_reset",
      },
    });
  });
});
