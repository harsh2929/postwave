// SPDX-License-Identifier: AGPL-3.0-only
//
// What a refused retention-activity read SAYS. ComplianceEvidenceError kept
// only status and code, so a classified role refusal from the route gate
// (`denial.reason: "role"`, with the role that CAN read it) fell to the bare
// 403 sentence and lost the "ask a workspace admin" half. Built on
// ApiRequestError it keeps the denial, the same way every rebased class does.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorPresentation } from "@/lib/errorCopy";

import { ApiRequestError } from "./apiRequestError";
import {
  ComplianceEvidenceError,
  fetchRetentionActivity,
} from "./complianceEvidence";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("@/store/auth", () => ({ useAuthStore: { getState: vi.fn() } }));
vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: async (res: unknown) => res,
}));

beforeEach(() => rawRequest.mockReset());

describe("ComplianceEvidenceError keeps the server's refusal", () => {
  it("a classified role refusal names the role that can read the trail", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        message: "You do not have permission to read retention activity.",
        code: "insufficient_permission",
        requestId: "req-7",
        denial: {
          subject: "audit_retention",
          reason: "role",
          code: "insufficient_permission",
          requiredRole: "admin",
        },
      },
    });
    const err = await fetchRetentionActivity().catch((e: unknown) => e);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit/retention-activity?limit=100",
      undefined,
    );
    expect(errorPresentation(err)).toEqual({
      message:
        "Your role can't do this. Ask a workspace admin to do it for you.",
      retryable: false,
    });
    expect(err).toMatchObject({
      name: "ComplianceEvidenceError",
      status: 403,
      code: "insufficient_permission",
      requestId: "req-7",
      denial: { reason: "role", requiredRole: "admin" },
    });
    expect(err).toBeInstanceOf(ComplianceEvidenceError);
    expect(err).toBeInstanceOf(ApiRequestError);
  });

  it("an unclassified refusal keeps its status and falls back to the label", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "" },
    });
    const err = await fetchRetentionActivity().catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "ComplianceEvidenceError",
      status: 500,
      message: "Loading retention activity",
    });
    expect(err).not.toHaveProperty("denial");
    expect(errorPresentation(err)).toEqual({
      message: "The server had a problem with this request. Please try again.",
      retryable: true,
    });
  });
});
