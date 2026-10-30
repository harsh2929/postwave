// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Variant } from "@/lib/abtests-types";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "0");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("editing previously saved A/B variants", () => {
  it.each([false, true])(
    "round-trips a server record through the strict write contract (MJML=%s)",
    async (mjml) => {
      const stored: Variant = {
        id: "arm-id",
        campaign_id: "campaign-id",
        tenant_id: "tenant-id",
        created_at: "2026-10-24T10:00:00Z",
        variant_label: "A",
        subject: "Before",
        from_name: "QA",
        from_email: "qa@example.test",
        body_html: "<p>Before</p>",
        weight: 50,
      };
      const writes: Record<string, unknown>[][] = [];
      const fetchMock = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const path = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
            "http://localhost",
          ).pathname;
          if (path === "/api/mjml")
            return Response.json({ html: "<p>Compiled revision</p>" });
          if (init?.method === "POST") {
            const payload = JSON.parse(String(init.body)) as Record<
              string,
              unknown
            >[];
            const allowed = new Set([
              "variant_label",
              "subject",
              "from_name",
              "from_email",
              "body_mjml",
              "body_html",
              "weight",
            ]);
            if (
              payload.some((arm) =>
                Object.keys(arm).some((key) => !allowed.has(key)),
              )
            ) {
              return Response.json(
                { error: "Request body contains an unknown field." },
                { status: 400 },
              );
            }
            writes.push(payload);
            return Response.json(payload.map((arm) => ({ ...stored, ...arm })));
          }
          return Response.json([stored]);
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createVariants, listVariants } =
        await import("@/lib/abtests-api");
      const loaded = await listVariants("campaign-id");
      const saved = await createVariants(
        "campaign-id",
        loaded.map((arm) => ({
          ...arm,
          subject: "After",
          ...(mjml ? { body_mjml: "<mjml><mj-body /></mjml>" } : {}),
        })),
      );
      // The response contains read-only metadata again; a second edit must work
      // without leaking it into the write, just as reopening the editor should.
      await createVariants(
        "campaign-id",
        saved.map((arm) => ({ ...arm, subject: "After again" })),
      );
      expect(writes).toHaveLength(2);
      expect(writes[1]?.[0]).toMatchObject({
        subject: "After again",
        weight: 100,
        body_html: mjml ? "<p>Compiled revision</p>" : "<p>Before</p>",
      });
      expect(writes[1]?.[0]).not.toHaveProperty("id");
      expect(writes[1]?.[0]).not.toHaveProperty("tenant_id");
      expect(writes[1]?.[0]).not.toHaveProperty("campaign_id");
      expect(writes[1]?.[0]).not.toHaveProperty("created_at");
    },
  );
});
