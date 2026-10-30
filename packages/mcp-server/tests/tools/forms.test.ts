// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { formTools } from "../../src/tools/forms.js";

function makeClient() {
  const forms = {
    create: vi.fn().mockResolvedValue({ id: "frm_001" }),
    listSubmissions: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: "frm_001", name: "patched" }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    confirmOptIn: vi.fn().mockResolvedValue({ ok: true, subscriber_email: "x@example.invalid" }),
  };
  const automations = {
    trigger: vi.fn().mockResolvedValue({ status: "queued" }),
    pause: vi.fn().mockResolvedValue({ id: "atm_001", status: "paused" }),
    resume: vi.fn().mockResolvedValue({ id: "atm_001", status: "active" }),
  };
  return { client: { forms, automations }, forms, automations };
}

describe("formTools", () => {
  it("exposes 7 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = formTools(client as any);
    expect(tools).toHaveLength(7);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("form_update forwards id + patch", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = formTools(c.client as any).find((x) => x.name === "form_update")!;
    await t.handler({ id: "frm_001", patch: { name: "patched" } });
    expect(c.forms.update).toHaveBeenCalledWith("frm_001", { name: "patched" });
  });

  it("optin_confirm forwards token", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = formTools(c.client as any).find((x) => x.name === "optin_confirm")!;
    await t.handler({ token: "tkn_abc" });
    expect(c.forms.confirmOptIn).toHaveBeenCalledWith("tkn_abc");
  });

  it("form_delete is idempotent at the schema layer", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = formTools(c.client as any).find((x) => x.name === "form_delete")!;
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ id: "frm_001" }).success).toBe(true);
  });
});
