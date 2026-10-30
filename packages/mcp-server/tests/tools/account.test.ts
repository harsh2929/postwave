// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

import { accountTools } from "../../src/tools/account.js";

function makeClient() {
  const account = {
    me: vi.fn().mockResolvedValue({ tenant: "t_1", user: "u_1" }),
    update: vi.fn().mockResolvedValue({ tenant: "t_1", user: "u_1" }),
  };
  return { client: { account }, account };
}

describe("accountTools", () => {
  it("exposes exactly 2 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = accountTools(client as any);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "account_sending_identity_update",
      "account_whoami",
    ]);
  });

  it("each tool has a schema and a non-trivial description", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of accountTools(client as any)) {
      expect(typeof t.schema.safeParse).toBe("function");
      expect(t.description.length).toBeGreaterThan(15);
    }
  });

  it("account_whoami is read-only and calls me()", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_whoami")!;
    expect(t.annotations?.readOnlyHint).toBe(true);
    await t.handler({});
    expect(c.account.me).toHaveBeenCalledTimes(1);
  });

  it("sending_identity_update forwards the supplied fields", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_sending_identity_update")!;
    await t.handler({
      display_name: "Acme Team",
      default_reply_to: "hi@acme.com",
    });
    expect(c.account.update).toHaveBeenCalledWith({
      display_name: "Acme Team",
      default_reply_to: "hi@acme.com",
    });
  });

  it("sending_identity_update accepts a single field", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_sending_identity_update")!;
    expect(t.schema.safeParse({ display_name: "Acme" }).success).toBe(true);
  });

  it("sending_identity_update rejects an empty payload", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_sending_identity_update")!;
    expect(t.schema.safeParse({}).success).toBe(false);
  });

  // Regression: the tool no longer exposes sending_domain/from_email — those
  // map to a /api/v1/me PATCH that does not exist. It now mirrors the real
  // workspace-settings fields (display_name / default_reply_to).
  it("sending_identity_update rejects the removed legacy fields", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_sending_identity_update")!;
    // strict-by-default zod object: unknown keys without a known key fail the refine.
    expect(t.schema.safeParse({ sending_domain: "mail.acme.com" }).success).toBe(false);
    expect(t.schema.safeParse({ default_reply_to: "not-an-email" }).success).toBe(false);
  });

  it("wraps SDK errors with the tool name", async () => {
    const c = makeClient();
    c.account.me.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = accountTools(c.client as any).find((x) => x.name === "account_whoami")!;
    await expect(t.handler({})).rejects.toThrow("account_whoami: boom");
  });
});
