// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { pushSuppressionTools } from "../../src/tools/push-suppressions.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "fcm-device-token-with-enough-entropy-123";

function makeClient() {
  const pushSuppressions = {
    list: vi.fn(async () => ({ tenantId: TENANT, items: [], total: 0 })),
    add: vi.fn(async () => ({ id: ID })),
    remove: vi.fn(async () => ({ ok: true })),
    bulkImport: vi.fn(async () => ({ ok: true, created: 1 })),
    bulkRemove: vi.fn(async () => ({ ok: true, removed: 2 })),
  };
  return {
    client: { pushSuppressions } as never,
    pushSuppressions,
  };
}

describe("Route43 MCP push suppression tools", () => {
  it("publishes exactly five exact-admin tools with truthful annotations", () => {
    const { client } = makeClient();
    const tools = pushSuppressionTools(client);
    expect(tools.map((tool) => tool.name)).toEqual([
      "push_suppression_list",
      "push_suppression_add",
      "push_suppression_remove",
      "push_suppression_bulk_import",
      "push_suppression_bulk_remove",
    ]);
    for (const tool of tools) {
      expect(tool.requiredScopes).toEqual(["admin"]);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }
    expect(tools[0]?.description).toMatch(/release-held/u);
    expect(tools[0]?.description).toMatch(/never raw tokens or full digests/u);
    expect(tools[1]?.description).toMatch(/never place it in logs/u);
    expect(tools[2]?.annotations?.destructiveHint).toBe(true);
  });

  it("maps finite list filters and all version-bound mutations to the strict SDK", async () => {
    const { client, pushSuppressions } = makeClient();
    const tools = pushSuppressionTools(client);
    await tools[0]!.handler({
      tenant_id: TENANT,
      platform: "fcm",
      reason: "manual",
      hash_prefix: "01234567",
      cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
      limit: 25,
    });
    await tools[1]!.handler({
      tenant_id: TENANT,
      device_token: TOKEN,
      platform: "fcm",
      confirm_manual_hold: true,
    });
    await tools[2]!.handler({
      tenant_id: TENANT,
      suppression_id: ID,
      expected_version: 1,
      confirm_manual_hold_removal: true,
    });
    const imports = [
      { device_token: TOKEN, platform: "fcm" as const },
      {
        device_token: "web-device-token-with-enough-entropy-456",
        platform: "web" as const,
        reason: "manual" as const,
      },
    ];
    await tools[3]!.handler({
      tenant_id: TENANT,
      items: imports,
      confirm_manual_holds: true,
    });
    const removals = [
      { id: ID, expected_version: 1 },
      { id: SECOND_ID, expected_version: 4 },
    ];
    await tools[4]!.handler({
      tenant_id: TENANT,
      items: removals,
      confirm_manual_hold_removals: true,
    });

    expect(pushSuppressions.list).toHaveBeenCalledWith({
      tenantId: TENANT,
      platform: "fcm",
      reason: "manual",
      hashPrefix: "01234567",
      cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
      limit: 25,
    });
    expect(pushSuppressions.add).toHaveBeenCalledWith(
      { device_token: TOKEN, platform: "fcm", reason: "manual" },
      { tenantId: TENANT },
    );
    expect(pushSuppressions.remove).toHaveBeenCalledWith(ID, 1, {
      tenantId: TENANT,
    });
    expect(pushSuppressions.bulkImport).toHaveBeenCalledWith(
      imports.map((item) => ({ ...item, reason: "manual" })),
      { tenantId: TENANT },
    );
    expect(pushSuppressions.bulkRemove).toHaveBeenCalledWith(removals, {
      tenantId: TENANT,
    });
  });

  it("rejects token ambiguity, cursor drift, duplicates, and missing confirmation in schemas", () => {
    const { client } = makeClient();
    const tools = pushSuppressionTools(client);
    expect(
      tools[0]!.schema.safeParse({
        tenant_id: TENANT,
        cursor: "bad.cursor",
      }).success,
    ).toBe(false);
    expect(
      tools[1]!.schema.safeParse({
        tenant_id: TENANT,
        device_token: `${TOKEN}\n`,
        platform: "fcm",
        confirm_manual_hold: true,
      }).success,
    ).toBe(false);
    expect(
      tools[1]!.schema.safeParse({
        tenant_id: TENANT,
        device_token: TOKEN,
        platform: "fcm",
      }).success,
    ).toBe(false);
    expect(
      tools[3]!.schema.safeParse({
        tenant_id: TENANT,
        items: [
          { device_token: TOKEN, platform: "fcm" },
          { device_token: TOKEN, platform: "fcm" },
        ],
        confirm_manual_holds: true,
      }).success,
    ).toBe(false);
    expect(
      tools[4]!.schema.safeParse({
        tenant_id: TENANT,
        items: [
          { id: ID, expected_version: 1 },
          { id: ID, expected_version: 2 },
        ],
        confirm_manual_hold_removals: true,
      }).success,
    ).toBe(false);
  });

  it("documents exact-admin privacy, CAS, and the held delivery boundary", () => {
    const readme = readFileSync(
      new URL("../../README.md", import.meta.url),
      "utf8",
    ).replace(/\s+/gu, " ");

    for (const name of [
      "push_suppression_list",
      "push_suppression_add",
      "push_suppression_remove",
      "push_suppression_bulk_import",
      "push_suppression_bulk_remove",
    ]) {
      expect(readme).toContain(name);
    }
    expect(readme).toContain("exact-admin tools");
    expect(readme).toContain("tenant-customer APNs/FCM/Web registry");
    expect(readme).toContain("not operator Expo devices");
    expect(readme).toContain("minimized 16-hex fingerprints");
    expect(readme).toContain("expected_version");
    expect(readme).toContain("stillSuppressed=true");
    expect(readme).toContain("HOLD / NO-GO");
    expect(readme).toContain("automatic provider feedback");
    expect(readme).toContain("Web is registry-only");
  });
});
