// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { createSequence, duplicateSequence } from "@/lib/voice-api";
afterEach(() => vi.unstubAllGlobals());
it("keeps manual lifecycle fields out of the template-generation request", async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      if ("status" in body)
        return new Response(
          JSON.stringify({
            error: {
              message: "template-backed generation does not accept status",
            },
          }),
          { status: 400 },
        );
      return new Response(
        JSON.stringify({
          id: "generated",
          version: 1,
          name: body.name,
          status: "draft",
          emails: [],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }),
  );
  const result = await createSequence({
    templateId: "welcome",
    name: "Generated QA",
    status: "draft",
    variables: { audience: "QA" },
  });
  expect(posts).toEqual([
    {
      name: "Generated QA",
      template_id: "welcome",
      variables: { audience: "QA" },
    },
  ]);
  expect(result.status).toBe("draft");
});
it("duplicates the full draft graph and planning settings in one creation request", async () => {
  const steps = [
    {
      type: "email",
      position: 1,
      email: {
        subject: "Welcome",
        body: "Original",
        variants: [
          { key: "a", subject: "A", body: "A", weight_bp: 6000 },
          { key: "b", subject: "B", body: "B", weight_bp: 4000 },
        ],
      },
    },
    {
      type: "condition",
      position: 2,
      condition: {
        predicate: "tag_present",
        value: "qa",
        yes_branch: [{ type: "exit", position: 1 }],
        no_branch: [],
      },
    },
  ];
  const source = {
    id: "original",
    version: 4,
    name: "Onboarding",
    status: "draft",
    steps,
    goal: { kind: "click", exit_on_goal: true },
    stuck_after_days: 3,
  };
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body =
        init?.method === "POST" ? JSON.parse(String(init.body)) : null;
      if (body) posts.push(body);
      return new Response(
        JSON.stringify(body ? { ...body, id: "copy", version: 1 } : source),
        {
          status: body ? 201 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
  const result = await duplicateSequence("original");
  expect(posts).toEqual([
    {
      name: "Onboarding (copy)",
      status: "draft",
      steps,
      goal: source.goal,
      stuck_after_days: 3,
    },
  ]);
  expect(result).toMatchObject({
    id: "copy",
    version: 1,
    goal: source.goal,
    stuckAfterDays: 3,
  });
});
