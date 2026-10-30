// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the offline mutation describer (SETA-022).

import { describe, it, expect } from "vitest";

import { describeOfflineMutation } from "@/lib/offline-describe";

describe("describeOfflineMutation", () => {
  it("maps method + resource to a human label", () => {
    expect(
      describeOfflineMutation({ method: "POST", path: "/api/v1/forms" }),
    ).toBe("Create form");
    expect(
      describeOfflineMutation({ method: "PATCH", path: "/api/v1/segments/xyz" }),
    ).toBe("Update segment (xyz)");
  });

  it("singularizes known resources and truncates long ids", () => {
    expect(
      describeOfflineMutation({
        method: "PATCH",
        path: "/api/v1/subscribers/abcdef1234567890",
      }),
    ).toBe("Update subscriber (abcdef12…)");
  });

  it("ignores query strings", () => {
    expect(
      describeOfflineMutation({
        method: "PATCH",
        path: "/api/v1/forms/f1?foo=bar",
      }),
    ).toBe("Update form (f1)");
  });

  it("falls back for unknown resources", () => {
    expect(
      describeOfflineMutation({ method: "PUT", path: "/api/v1/gizmos/1" }),
    ).toBe("Update gizmos (1)");
  });

  it("falls back for a malformed path", () => {
    expect(describeOfflineMutation({ method: "POST", path: "/nope" })).toBe(
      "Create request",
    );
  });
});
