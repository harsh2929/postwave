// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { discountTools } from "../../src/tools/discounts.js";

const RECORD_ID = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";

function makeClient() {
  const discounts = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    redemptions: vi.fn().mockResolvedValue({ items: [] }),
  };
  return { client: { discounts }, discounts };
}

describe("discountTools", () => {
  it("exposes exactly the two sanitized archive reads", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = discountTools(client as any);

    expect(tools.map((tool) => tool.name)).toEqual([
      "discount_list",
      "discount_redemptions",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(tool.requiredScopes).toEqual(["read:reports"]);
      expect(tool.description).not.toMatch(/tenant's discount codes/iu);
    }
  });

  it("forwards only the opaque record id and bounded pagination", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = discountTools(c.client as any);
    const listTool = tools.find(({ name }) => name === "discount_list")!;
    const tool = tools.find(
      ({ name }) => name === "discount_redemptions",
    )!;

    await listTool.handler({
      record_id: RECORD_ID,
      limit: 50,
      offset: 100,
    });
    await tool.handler({ record_id: RECORD_ID, limit: 25, offset: 50 });

    expect(c.discounts.list).toHaveBeenCalledWith({
      record_id: RECORD_ID,
      limit: 50,
      offset: 100,
    });
    expect(c.discounts.redemptions).toHaveBeenCalledWith(RECORD_ID, {
      limit: 25,
      offset: 50,
    });
  });

  it("rejects redeemable codes and out-of-range pagination", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = discountTools(client as any).find(
      ({ name }) => name === "discount_redemptions",
    )!.schema;
    const listSchema = discountTools(client as any).find(
      ({ name }) => name === "discount_list",
    )!.schema;

    expect(
      listSchema.safeParse({ record_id: RECORD_ID, limit: 1, offset: 0 })
        .success,
    ).toBe(true);
    expect(listSchema.safeParse({ record_id: "SAVE20" }).success).toBe(false);
    expect(listSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listSchema.safeParse({ offset: 10_001 }).success).toBe(false);
    expect(schema.safeParse({ record_id: RECORD_ID }).success).toBe(true);
    expect(schema.safeParse({ record_id: "SAVE20" }).success).toBe(false);
    expect(schema.safeParse({ record_id: RECORD_ID, limit: 101 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ record_id: RECORD_ID, offset: -1 }).success).toBe(
      false,
    );
  });

  it("wraps errors with the exact tool name", async () => {
    const c = makeClient();
    c.discounts.redemptions.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = discountTools(c.client as any).find(
      ({ name }) => name === "discount_redemptions",
    )!;

    await expect(
      tool.handler({ record_id: RECORD_ID, limit: undefined, offset: undefined }),
    ).rejects.toThrow("discount_redemptions: boom");
  });
});
