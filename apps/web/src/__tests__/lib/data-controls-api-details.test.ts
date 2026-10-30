// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  listImportTemplates,
  listInboundWebhooks,
  listProfileTransformRules,
} from "@/lib/data-controls-api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("data-controls detailed clients", () => {
  it("preserves the row details needed by the parity surface", async () => {
    mocks.get
      .mockResolvedValueOnce({
        items: [
          {
            id: "rule-1",
            name: "Canonical campaign source",
            source_path: "metadata.utm_source",
            target_key: "campaign_source",
            transform: "lowercase",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "template-1",
            name: "Event export",
            mapping: { columns: [{ source: "Email", target: "email" }] },
            source_hint: "Conference CSV",
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "hook-1",
            name: "Signup relay",
            slug: "signup-relay",
            enabled: true,
            createdAt: "2026-08-03T00:00:00Z",
          },
        ],
      });

    await expect(listProfileTransformRules()).resolves.toEqual([
      {
        id: "rule-1",
        name: "Canonical campaign source",
        source_path: "metadata.utm_source",
        target_key: "campaign_source",
        transform: "lowercase",
        status: "active",
      },
    ]);
    await expect(listImportTemplates()).resolves.toMatchObject([
      {
        id: "template-1",
        source_hint: "Conference CSV",
        mapping: { columns: [{ source: "Email", target: "email" }] },
      },
    ]);
    await expect(listInboundWebhooks()).resolves.toEqual([
      {
        id: "hook-1",
        name: "Signup relay",
        slug: "signup-relay",
        enabled: true,
        created_at: "2026-08-03T00:00:00Z",
      },
    ]);

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/profile-transform-rules",
      "/api/v1/subscriber-import-templates",
      "/api/v1/inbound-webhooks",
    ]);
  });

  it("keeps an incomplete row visible but rejects a malformed envelope or identity", async () => {
    mocks.get.mockResolvedValueOnce({ items: [{ id: "older-rule" }] });
    await expect(listProfileTransformRules()).resolves.toEqual([
      {
        id: "older-rule",
        name: null,
        source_path: null,
        target_key: null,
        transform: null,
        status: null,
      },
    ]);

    mocks.get.mockResolvedValueOnce({});
    await expect(listImportTemplates()).rejects.toThrow(/malformed/i);

    mocks.get.mockResolvedValueOnce({ items: [{ name: "No identity" }] });
    await expect(listInboundWebhooks()).rejects.toThrow(/row 1.*malformed/i);
  });
});
