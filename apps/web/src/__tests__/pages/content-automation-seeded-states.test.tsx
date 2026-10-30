// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue({
    ...WHOAMI,
    tenant_id: "00000000-0000-4000-8000-000000000001",
  }),
}));

function stubResponses(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = new URL(raw, "http://postwave.test").pathname;
      const body = responses[path] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const CASES: Array<{
  name: string;
  load: () => Promise<ComponentType>;
  responses: Record<string, unknown>;
  expected: string[];
}> = [
  {
    name: "assets",
    load: async () =>
      (await import("@/app/(dashboard)/app/assets/page")).default,
    responses: {
      "/api/v1/assets": {
        counts: { all: 1, recent: 1, inUse: 1, unused: 0, large: 0 },
        nextCursor: null,
        items: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            tenantId: "00000000-0000-4000-8000-000000000001",
            filename: "hero-wide.png",
            mime: "image/png",
            bytes: 1536,
            width: 1200,
            height: 630,
            url: "/api/v1/assets/00000000-0000-4000-8000-000000000002/blob",
            createdAt: "2026-08-28T10:00:00Z",
            updatedAt: "2026-08-28T10:00:00Z",
            version: 3,
            altText: "Campaign hero",
            referencesCount: 1,
            lastUsedAt: "2026-08-28T10:00:00Z",
            folderId: "00000000-0000-4000-8000-000000000003",
          },
        ],
      },
      "/api/v1/assets/folders": {
        folders: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            tenantId: "00000000-0000-4000-8000-000000000001",
            name: "Campaign art",
            createdAt: "2026-08-28T09:00:00Z",
            updatedAt: "2026-08-28T09:00:00Z",
            version: 2,
            assetCount: 1,
          },
        ],
      },
      "/api/v1/assets/tags": { tags: [{ tag: "launch", count: 1 }] },
    },
    expected: ["hero-wide.png", "1 live reference", "Campaign art", "launch"],
  },
  {
    name: "content library",
    load: async () =>
      (await import("@/app/(dashboard)/app/content-library/page")).default,
    responses: {
      "/api/v1/collections": {
        total: 1,
        items: [
          {
            id: "00000000-0000-4000-8000-000000000004",
            tenant_id: "00000000-0000-4000-8000-000000000001",
            name: "Holiday",
            collection_type: "content",
            source_type: "manual",
            data: [{ season: "winter" }, { season: "summer" }],
            row_count: 2,
            created_at: "2026-08-28T08:00:00Z",
            updated_at: "2026-08-28T08:00:00Z",
            version: 4,
          },
        ],
      },
      "/api/v1/blocks/saved": {
        total: 1,
        items: [
          {
            id: "00000000-0000-4000-8000-000000000005",
            tenant_id: "00000000-0000-4000-8000-000000000001",
            name: "Footer CTA",
            kind: "section",
            body_html: "<footer>Read more</footer>",
            body_json: { type: "footer" },
            created_at: "2026-08-28T07:00:00Z",
            updated_at: "2026-08-28T07:00:00Z",
            version: 5,
          },
        ],
      },
    },
    expected: ["Holiday", "Footer CTA", "section"],
  },
  {
    name: "social capture",
    load: async () =>
      (await import("@/app/(dashboard)/app/social-capture/page")).default,
    responses: {
      "/api/v1/social-capture/catalog": {
        networks: [
          { key: "instagram", label: "Instagram", runtime_status: "live" },
        ],
      },
      "/api/v1/social-capture/tap-to-text": {
        items: [
          {
            id: "tap_1",
            name: "Text JOIN",
            keyword: "JOIN",
            status: "active",
          },
        ],
      },
      "/api/v1/social-capture/auto-replies": {
        items: [
          {
            id: "reply_1",
            name: "Instagram welcome",
            network: "instagram",
            trigger_phrases: ["guide"],
            status: "active",
          },
        ],
      },
      "/api/v1/social-capture/leads": {
        items: [
          {
            id: "lead_1",
            subscriber_email: "lead@example.com",
            network: "instagram",
            status: "captured",
          },
        ],
      },
    },
    expected: ["Text JOIN", "Instagram welcome", "lead@example.com"],
  },
  {
    name: "content quality",
    load: async () =>
      (await import("@/app/(dashboard)/app/content-quality/page")).default,
    responses: {
      "/api/v1/subject-analyzer/buckets": {
        campaigns_total: 12,
        window_days: 90,
        buckets: [
          {
            attribute: "has_question",
            bucket: "yes",
            campaigns: 4,
            open_rate: 0.45,
            click_rate: 0.12,
          },
        ],
      },
      "/api/v1/analytics/template-leaderboard": {
        items: [
          {
            template_id: "template_1",
            template_name: "Launch template",
            campaigns_used: 3,
            sent: 1200,
            open_rate: 0.51,
            click_rate: 0.09,
          },
        ],
      },
      "/api/v1/ai-regression/runs/latest": {
        run: {
          id: "run_1",
          status: "completed",
          gate_result: "pass",
          fidelity_score_mean: 88,
          total_examples: 5,
          scored_examples: 5,
          error_examples: 0,
        },
      },
    },
    expected: ["has question: yes", "Launch template", "pass", "88 / 100"],
  },
  {
    name: "AI quality",
    load: async () =>
      (await import("@/app/(dashboard)/app/ai-quality/page")).default,
    responses: {
      "/api/v1/ai-regression/settings": {
        warn_threshold: 70,
        hard_gate_enabled: true,
        hard_gate_threshold: 60,
        min_examples_for_gate: 1,
      },
      "/api/v1/ai-regression/golden-examples": {
        items: [
          {
            id: "00000000-0000-4000-8000-000000000041",
            surface_kind: "subject_line",
            brief: "Regression prompt",
            model_id: "model-v2",
            created_at: "2026-08-28T10:00:00Z",
          },
        ],
      },
      "/api/v1/ai-regression/runs": {
        items: [
          {
            id: "00000000-0000-4000-8000-000000000042",
            runtime_provider: "google",
            model_id: "gemini-3-flash-preview",
            model_version_tag: "model-v2",
            prompt_version_tag: "voice-regression-replay-v2",
            status: "completed",
            gate_result: "pass",
            fidelity_score_mean: 82,
            fidelity_score_p25: 82,
            passed_examples: 1,
            scored_examples: 1,
            error_examples: 0,
            total_examples: 1,
            warn_threshold: 70,
            hard_gate_enabled: true,
            hard_gate_threshold: 60,
            min_examples_for_gate: 1,
            max_attempts: 3,
            attempt_count: 1,
            created_at: "2026-08-28T10:00:00Z",
            completed_at: "2026-08-28T10:01:00Z",
            updated_at: "2026-08-28T10:01:00Z",
          },
        ],
      },
    },
    expected: ["Subject line", "Regression prompt", "pass", "82.0 / 100"],
  },
  {
    name: "translations",
    load: async () =>
      (await import("@/app/(dashboard)/app/translations/page")).default,
    responses: {
      "/api/v1/translations/settings": {
        tenant_id: "t_test",
        enabled: true,
        default_locale: "en",
        supported_locales: ["en", "fr"],
        fallback_strategy: "default_locale",
        locale_attribute: "locale",
      },
      "/api/v1/translations/dictionary": {
        entries: [
          {
            id: "entry_1",
            term: "Moosewave",
            translations: { fr: "Moosewave FR" },
            case_sensitive: true,
          },
        ],
      },
    },
    expected: ["Moosewave", "Moosewave FR", "Case sensitive"],
  },
];

describe("content and automation seeded states", () => {
  it.each(CASES)(
    "$name renders actionable record detail, not only a count",
    async ({ load, responses, expected }) => {
      stubResponses(responses);
      const Page = await load();
      const { container, root } = await renderPage(Page);
      try {
        for (const text of expected)
          expect(container.textContent).toContain(text);
      } finally {
        unmount(root);
      }
    },
  );
});
