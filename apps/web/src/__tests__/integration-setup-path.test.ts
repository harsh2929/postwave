import { describe, expect, it } from "vitest";

import { resolveSetupPath } from "@/lib/integration-setup-path";

describe("resolveSetupPath", () => {
  it("hands the desktop-only API playground off to the web API reference", () => {
    expect(resolveSetupPath("/api-playground")).toEqual({
      href: "/docs/api",
      label: "API reference",
    });
  });
});
