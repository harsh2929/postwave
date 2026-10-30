import { describe, expect, it } from "vitest";

import { FRAMEWORK_META } from "../../components/compliance/FrameworkMeta";

describe("HIPAA compliance policy", () => {
  it("presents HIPAA as unavailable instead of an attestable workflow", () => {
    const hipaa = FRAMEWORK_META.find(
      (framework) => framework.slug === "hipaa",
    );

    expect(hipaa).toBeDefined();
    expect(hipaa?.blurb).toContain("Not supported by Moosewave");
    expect(hipaa?.blurb).toContain("No BAA");
    expect(hipaa?.blurb).toContain("do not use the service for PHI");
    expect(hipaa?.renewalCadenceMonths).toBeNull();
    expect(hipaa?.gates).toEqual([]);
  });
});
