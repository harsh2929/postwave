// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

import { templateTools } from "../../src/tools/templates.js";

function makeClient() {
  const templates = {
    list: vi.fn().mockResolvedValue([{ id: "t1", slug: "welcome" }]),
    get: vi.fn().mockResolvedValue({ id: "t1", slug: "welcome" }),
    create: vi.fn().mockResolvedValue({ id: "t1", slug: "welcome" }),
    update: vi.fn().mockResolvedValue({ id: "t1", slug: "welcome-v2" }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return { client: { templates }, templates };
}

const validTemplate = {
  slug: "welcome-3",
  category: "welcome" as const,
  name: "Welcome 3",
  description: "A 3-email welcome",
  length: 3,
  variables: [{ key: "first_name", label: "First name", required: true, example: "Sam" }],
  emails: [
    {
      position: 1,
      delay_seconds: 0,
      subject_skeleton: "Hi {{first_name}}",
      body_skeleton: "<p>Welcome</p>",
      notes: "",
    },
  ],
  tags: ["onboarding"],
  author: "system",
  performance: { open_rate: 0.5, click_rate: 0.1, conversion_rate: 0.02, sample_size: 100 },
};

describe("templateTools", () => {
  it("exposes exactly 5 CRUD tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = templateTools(client as any);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "template_create",
      "template_delete",
      "template_get",
      "template_list",
      "template_update",
    ]);
  });

  it("each tool has a schema and a non-trivial description", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of templateTools(client as any)) {
      expect(typeof t.schema.safeParse).toBe("function");
      expect(t.description.length).toBeGreaterThan(15);
    }
  });

  it("template_list forwards optional category", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_list")!;
    await t.handler({ category: "sales" });
    expect(c.templates.list).toHaveBeenCalledWith("sales");
  });

  it("template_list rejects an unknown category", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_list")!;
    expect(t.schema.safeParse({ category: "nope" }).success).toBe(false);
  });

  it("template_get forwards id_or_slug", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_get")!;
    await t.handler({ id_or_slug: "welcome-3" });
    expect(c.templates.get).toHaveBeenCalledWith("welcome-3");
  });

  it("template_get rejects an empty id", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_get")!;
    expect(t.schema.safeParse({ id_or_slug: "   " }).success).toBe(false);
  });

  it("template_create forwards the full template", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_create")!;
    await t.handler(validTemplate);
    expect(c.templates.create).toHaveBeenCalledTimes(1);
    expect(c.templates.create.mock.calls[0]![0].slug).toBe("welcome-3");
  });

  it("template_create requires at least one email", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_create")!;
    expect(t.schema.safeParse({ ...validTemplate, emails: [] }).success).toBe(false);
  });

  it("template_update forwards id and patch", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_update")!;
    await t.handler({ id_or_slug: "welcome-3", patch: { slug: "welcome-3-v2" } });
    expect(c.templates.update).toHaveBeenCalledWith("welcome-3", { slug: "welcome-3-v2" });
  });

  it("template_delete forwards id and returns a confirmation", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_delete")!;
    const out = await t.handler({ id_or_slug: "welcome-3" });
    expect(c.templates.delete).toHaveBeenCalledWith("welcome-3");
    expect(out).toEqual({ deleted: true, id_or_slug: "welcome-3" });
  });

  it("template_delete is annotated destructive; reads are readOnly", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = templateTools(c.client as any);
    expect(tools.find((t) => t.name === "template_delete")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "template_list")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "template_get")!.annotations?.readOnlyHint).toBe(true);
  });

  it("wraps SDK errors with the tool name", async () => {
    const c = makeClient();
    c.templates.get.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = templateTools(c.client as any).find((x) => x.name === "template_get")!;
    await expect(t.handler({ id_or_slug: "x" })).rejects.toThrow("template_get: boom");
  });
});
