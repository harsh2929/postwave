import { describe, expect, it } from "vitest";

import { extractWarehouseValidation } from "../../components/dataplatform/warehouse-helpers";

describe("warehouse validation presentation boundary", () => {
  it("maps reflected credentials, object names, and provider fields to local copy", () => {
    const canary = "pw-secret-validation-canary";
    const result = extractWarehouseValidation(
      JSON.stringify({
        valid: false,
        errors: [
          `raw credential config is not accepted: ${canary}`,
          `unsupported object: ${canary}`,
          `missing required provider settings: dataset_${canary}`,
          `workspace_url ${canary} must be a valid URL`,
        ],
        warnings: [`provider ${canary} is planned and not executable yet`],
      }),
    );

    expect(result?.valid).toBe(false);
    expect(result?.errors).toEqual([
      "Remove raw credential material and provide only an approved credentials reference.",
      "Choose only objects advertised by the verified warehouse catalog.",
      "Complete every required provider setting before activation.",
      "Review the workspace URL field; it does not match the provider's accepted format.",
    ]);
    expect(result?.warnings).toEqual([
      "This provider runtime is not attached for live execution yet.",
    ]);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("deduplicates and bounds arbitrary validation arrays", () => {
    const result = extractWarehouseValidation(
      JSON.stringify({
        valid: false,
        errors: Array.from(
          { length: 100 },
          (_, index) => `unknown server validation ${index}`,
        ),
        warnings: [null, 42, {}, "unknown warning"],
      }),
    );

    expect(result?.errors).toEqual([
      "The server rejected part of this connection configuration. Review the highlighted fields.",
    ]);
    expect(result?.warnings).toEqual([
      "The server reported a connection-readiness warning. Review provider availability before saving.",
    ]);
  });

  it("rejects malformed and non-validation envelopes", () => {
    expect(extractWarehouseValidation("not json")).toBeNull();
    expect(extractWarehouseValidation('{"errors":[]}')).toBeNull();
  });
});
