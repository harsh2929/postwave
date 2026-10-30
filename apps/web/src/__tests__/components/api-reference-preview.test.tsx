// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { ApiReferencePreview } from "@/app/(marketing)/api-docs/_components/api-reference-preview";
import { renderPage, unmount } from "../pages/_harness";

describe("ApiReferencePreview", () => {
  it("links lightweight API groups, the full reference, and raw spec", async () => {
    const { container, text, root } = await renderPage(() => (
      <ApiReferencePreview
        groups={[
          { tag: "Subscribers", slug: "subscribers", operationCount: 166 },
          {
            tag: "Outbound Webhooks",
            slug: "outbound-webhooks",
            operationCount: 17,
          },
        ]}
        operationCount={1955}
        specUrl="/api/openapi.json"
      />
    ));
    try {
      expect(text).toMatch(/all 1955\s*operations/);
      expect(
        Array.from(container.querySelectorAll("a")).map((link) =>
          link.getAttribute("href"),
        ),
      ).toEqual([
        "/docs/api?tag=subscribers",
        "/docs/api?tag=outbound-webhooks",
        "/docs/api",
        "/api/openapi.json",
      ]);
      expect(container.querySelectorAll("a")).toHaveLength(4);
    } finally {
      unmount(root);
    }
  });
});
