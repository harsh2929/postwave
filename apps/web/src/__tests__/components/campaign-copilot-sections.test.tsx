// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The campaign-bound Copilot rail (desktop composer/CopilotRail parity, rows
// campaigns-52 / -3 / -4): the pre-send verdict on the SAVED campaign, the
// Subject Lab hand-off into a bandit A/B, and the "start from a brief"
// assistant with analyzer scores, buckets and top performers. Mounted through
// the real CopilotRail with a campaignId, exactly as the campaign editor does.
// Real transport; only `fetch` is stubbed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopilotRail } from "@/components/ai/copilot-rail";
import type { MeResponse } from "@/lib/auth-api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/campaigns/c-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "c-1" }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function identity(role: MeResponse["role"]): MeResponse {
  return {
    user_id: "u-1",
    tenant_id: "t-1",
    email: "ops@brand.example",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Brand",
    workspace_slug: "brand",
  };
}

const SAVED = {
  id: "c-1",
  tenant_id: "t-1",
  name: "Autumn launch",
  subject: "Autumn is here — 30% off",
  status: "draft",
  from_name: "Brand",
  body_html: "<p>Hello autumn</p>",
  segment_id: "seg-1",
  delivery_settings: { from_email: "news@brand.example" },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const BASE_COMPONENTS = [
  { name: "eq_score", status: "ok", score: 82 },
  { name: "voice_drift", status: "ok", score: 90 },
  { name: "placement", status: "ok", score: 0.91 },
];

interface Seen {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

let seen: Seen[] = [];
let me: MeResponse = identity("admin");
let saved: Record<string, unknown> = SAVED;
let handler: (req: Seen) => Response | undefined = () => undefined;
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

async function mount(props: { onApplySubject?: (subject: string) => void; subject?: string } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CopilotRail
          subject={props.subject ?? SAVED.subject}
          campaignId="c-1"
          generate={async () => []}
          previewOptimizer={async () => ({ recommended_arms: [] }) as never}
          onApplySubject={props.onApplySubject}
        />
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(label: RegExp, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((candidate) =>
    label.test(candidate.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${label}`);
  return found;
}

function field<T extends HTMLElement>(label: string): T {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const element = found ? document.getElementById(found.htmlFor) : null;
  if (!element) throw new Error(`no field ${label}`);
  return element as T;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

const calls = (method: string, path: string) =>
  seen.filter((req) => req.method === method && req.path === path);

beforeEach(() => {
  seen = [];
  me = identity("admin");
  saved = SAVED;
  handler = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req: Seen = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(raw, "http://postwave.test").pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      };
      seen.push(req);
      const custom = handler(req);
      if (custom) return custom;
      if (req.path === "/api/v1/auth/me") return json(200, me);
      if (req.method === "GET" && req.path === "/api/v1/campaigns/c-1") return json(200, saved);
      return json(404, { error: { code: "not_found", message: "Not found." } });
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("campaign-bound pre-send verdict (campaigns-52)", () => {
  it("grades the saved campaign and never reads an incomplete run as a pass", async () => {
    handler = (req) =>
      req.method === "POST" && req.path === "/api/v1/presend/verdict"
        ? json(200, {
            verdict: "incomplete",
            complete: false,
            summary: "Campaign Assurance has no frozen run for this campaign.",
            components: [
              ...BASE_COMPONENTS,
              {
                name: "campaign_assurance",
                status: "error",
                error: "No frozen Campaign Assurance run is available for this campaign.",
              },
            ],
            computed_at: "2026-09-12T08:00:00Z",
          })
        : undefined;
    // The editor holds an unsaved subject; the verdict must grade the saved one.
    const container = await mount({ subject: "Unsaved edit in progress" });
    const section = container.querySelector('[data-testid="copilot-section-verdict"]')!;
    expect(section.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    await eventually(() => expect(button(/Run pre-send check/, section).disabled).toBe(false));
    await click(button(/Run pre-send check/, section));

    await eventually(() => expect(calls("POST", "/api/v1/presend/verdict")).toHaveLength(1));
    const post = calls("POST", "/api/v1/presend/verdict")[0]!;
    // No frozen assurance run (404) → the campaign-only identity.
    expect(post.body).toEqual({
      subject: "Autumn is here — 30% off",
      from: "news@brand.example",
      html: "<p>Hello autumn</p>",
      text: "<p>Hello autumn</p>",
      campaign_id: "c-1",
    });
    expect(post.headers.has("Idempotency-Key")).toBe(false);
    expect(calls("GET", "/api/v1/campaigns/c-1/assurance")).toHaveLength(1);

    await eventually(() =>
      expect(container.querySelector('[data-testid="copilot-verdict"]')?.textContent).toContain(
        "Incomplete — not a pass",
      ),
    );
    const verdict = container.querySelector('[data-testid="copilot-verdict"]')!.textContent;
    expect(verdict).toContain("Incomplete — do not infer a pass");
    expect(verdict).toContain(
      "No frozen Campaign Assurance run is available for this campaign.",
    );
    expect(verdict).toContain("Content quality");
    expect(verdict).toContain("Completed · 82 / 100");
    expect(verdict).toContain("Completed · 91%");
    // The editor's subject differs from the graded one: flagged, not hidden.
    expect(verdict).toContain("Editor has changed");
    expect(button(/Re-run checks/, section)).toBeTruthy();
  });

  it("sends the frozen revision identity and reports four of four when all ran", async () => {
    handler = (req) => {
      if (req.path === "/api/v1/campaigns/c-1/assurance") {
        return json(200, {
          measurement: { name: "Predicted Agent Comprehension", interpretation: "", source_classes: [] },
          data: { detail: { run: { content_revision_id: "rev-1", source_hash: "hash-1" } } },
        });
      }
      if (req.path === "/api/v1/presend/verdict") {
        return json(200, {
          verdict: "ok",
          complete: true,
          summary: "All checks passed.",
          components: [...BASE_COMPONENTS, { name: "campaign_assurance", status: "ok", score: 88 }],
          computed_at: "2026-09-12T08:00:00Z",
        });
      }
      return undefined;
    };
    const container = await mount();
    await eventually(() => expect(button(/Run pre-send check/).disabled).toBe(false));
    await click(button(/Run pre-send check/));
    await eventually(() =>
      expect(calls("POST", "/api/v1/presend/verdict")[0]?.body).toMatchObject({
        campaign_id: "c-1",
        content_revision_id: "rev-1",
        source_hash: "hash-1",
      }),
    );
    await eventually(() =>
      expect(container.textContent).toContain("All four checks passed"),
    );
    expect(container.textContent).toContain("4 of 4 checks completed");
    expect(container.textContent).toContain("Saved campaign");
  });

  it("does not call a run complete when the requested assurance check is missing", async () => {
    handler = (req) =>
      req.path === "/api/v1/presend/verdict"
        ? json(200, {
            verdict: "ok",
            complete: true,
            summary: "All checks passed.",
            components: BASE_COMPONENTS,
            computed_at: "2026-09-12T08:00:00Z",
          })
        : undefined;
    const container = await mount();
    await eventually(() => expect(button(/Run pre-send check/).disabled).toBe(false));
    await click(button(/Run pre-send check/));
    await eventually(() =>
      expect(container.textContent).toContain("Incomplete — not a pass"),
    );
    expect(container.textContent).not.toContain("All four checks passed");
    expect(container.textContent).toContain("No Campaign Assurance result was returned.");
  });

  it("names what to save instead of posting an ungradable campaign", async () => {
    saved = { ...SAVED, delivery_settings: {} };
    const container = await mount();
    await eventually(() => expect(button(/Run pre-send check/).disabled).toBe(false));
    await click(button(/Run pre-send check/));
    await eventually(() =>
      expect(container.textContent).toContain("Save a From address to run the pre-send check."),
    );
    expect(calls("POST", "/api/v1/presend/verdict")).toHaveLength(0);
  });

  it("withholds the check from a viewer role with the reason", async () => {
    me = identity("viewer");
    const container = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("Owner, admin, or editor access is required."),
    );
    expect(button(/Run pre-send check/).disabled).toBe(true);
  });
});

describe("Subject Lab hand-off (campaigns-4)", () => {
  const VARIANTS = [
    "Autumn deals inside",
    "Your autumn 30% is waiting",
    "Fall into savings today",
    "🍂 Autumn sale starts now",
    "Did you see our autumn sale?",
  ];
  const SCORES = [
    { text: VARIANTS[0], predicted_open: 0.21, ci_low: 0.15, ci_high: 0.27, matched_n: 40, low_confidence: false, below_baseline: false },
    { text: VARIANTS[1], predicted_open: 0.26, ci_low: 0.22, ci_high: 0.3, matched_n: 55, low_confidence: false, below_baseline: false },
    { text: VARIANTS[2], predicted_open: 0.18, ci_low: 0.1, ci_high: 0.26, matched_n: 12, low_confidence: true, below_baseline: true },
    { text: VARIANTS[3], predicted_open: 0.24, ci_low: 0.2, ci_high: 0.28, matched_n: 61, low_confidence: false, below_baseline: false },
    // Highest point estimate, thinnest sample: it must NOT lead the ranking.
    { text: VARIANTS[4], predicted_open: 0.3, ci_low: 0.12, ci_high: 0.48, matched_n: 6, low_confidence: true, below_baseline: false },
  ];

  function labServer(flag = "true") {
    handler = (req) => {
      if (req.path === "/api/v1/feature-flags/subject_lab/resolve") {
        return json(200, { key: "subject_lab", value: flag, source: "tenant" });
      }
      if (req.path === "/api/v1/subject-lab/variants") {
        return json(200, { variants: VARIANTS, axis: "question", generated_at: "2026-09-12T08:00:00Z" });
      }
      if (req.path === "/api/v1/subject-lab/score") {
        return json(200, { baseline_open: 0.2, window_days: 180, variants: SCORES });
      }
      if (req.path === "/api/v1/campaigns/ab-test") {
        return json(201, { parent: { ...SAVED, id: "p-1" }, children: [{}, {}, {}] });
      }
      if (req.path === "/api/v1/campaigns/p-1/ab/settings") return json(200, {});
      return undefined;
    };
  }

  async function openLab(container: HTMLElement) {
    const section = container.querySelector('[data-testid="copilot-section-lab"]')!;
    await click(section.querySelector("button")!);
    await eventually(() => expect(button(/Open Subject Lab/)).toBeTruthy());
    await click(button(/Open Subject Lab/));
    await eventually(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    return document.querySelector('[role="dialog"]') as HTMLElement;
  }

  it("generates by axis, scores, and runs the top three as a real bandit", async () => {
    labServer();
    const container = await mount();
    const dialog = await openLab(container);
    expect(calls("GET", "/api/v1/feature-flags/subject_lab/resolve")).toHaveLength(1);

    await act(async () => {
      const axis = field<HTMLSelectElement>("Vary by");
      axis.value = "question";
      axis.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button(/Generate and score/, dialog));
    await eventually(() => expect(calls("POST", "/api/v1/subject-lab/score")).toHaveLength(1));
    expect(calls("POST", "/api/v1/subject-lab/variants")[0]?.body).toEqual({
      seed_subject: "Autumn is here — 30% off",
      axis: "question",
      count: 6,
      body_excerpt: "<p>Hello autumn</p>",
    });
    expect(calls("POST", "/api/v1/subject-lab/score")[0]?.body).toEqual({ subjects: VARIANTS });

    // Ranked by the low end of the interval, not the point estimate.
    await eventually(() =>
      expect(document.querySelector('[data-testid="subject-lab-variants"]')).not.toBeNull(),
    );
    const ranked = [
      ...document.querySelectorAll('[data-testid="subject-lab-variants"] > li'),
    ].map((row) => row.querySelector("p")?.textContent?.replace(/^\d+\./u, ""));
    expect(ranked.slice(0, 3)).toEqual([VARIANTS[1], VARIANTS[3], VARIANTS[0]]);
    expect(document.body.textContent).toContain("Low confidence");

    await click(button(/Run top 3 as a bandit A\/B/, dialog));
    await eventually(() =>
      expect(calls("POST", "/api/v1/campaigns/p-1/ab/settings")).toHaveLength(1),
    );
    expect(calls("POST", "/api/v1/campaigns/ab-test")[0]?.body).toEqual({
      name: "Autumn launch (subject test)",
      subject_variants: [VARIANTS[1], VARIANTS[3], VARIANTS[0]],
      body_html: "<p>Hello autumn</p>",
      audience_segment_id: "seg-1",
      from_name: "Brand",
      delivery_settings: { from_email: "news@brand.example" },
    });
    expect(calls("POST", "/api/v1/campaigns/p-1/ab/settings")[0]?.body).toEqual({
      winner_metric: "open_rate",
      evaluation_window_hours: 24,
      winner_recipients_pct: 100,
      sample_pct: 100,
      bandit_strategy: "thompson",
      explore_floor: 0.1,
      recompute_interval_minutes: 30,
    });
    await eventually(() =>
      expect(dialog.textContent).toContain(
        "Created draft A/B test “Autumn launch (subject test)” with 3 variants. Allocation: Thompson sampling on opens, 10% exploration floor.",
      ),
    );
    expect(dialog.querySelector('a[href="/app/campaigns/p-1/ab"]')).not.toBeNull();
  });

  it("A/B tests every subject at an even split, with no bandit setting", async () => {
    labServer();
    const container = await mount();
    const dialog = await openLab(container);
    await click(button(/Generate and score/, dialog));
    await eventually(() => expect(button(/A\/B test all 5 subjects/, dialog).disabled).toBe(false));
    await click(button(/A\/B test all 5 subjects/, dialog));
    await eventually(() => expect(calls("POST", "/api/v1/campaigns/ab-test")).toHaveLength(1));
    expect(
      (calls("POST", "/api/v1/campaigns/ab-test")[0]?.body as { subject_variants: string[] })
        .subject_variants,
    ).toHaveLength(5);
    await eventually(() => expect(dialog.textContent).toContain("with 3 variants."));
    expect(calls("POST", "/api/v1/campaigns/p-1/ab/settings")).toHaveLength(0);
  });

  it("hands a picked variant back to the editor", async () => {
    labServer();
    const onApplySubject = vi.fn();
    const container = await mount({ onApplySubject });
    const dialog = await openLab(container);
    await click(button(/Generate and score/, dialog));
    await eventually(() =>
      expect(document.querySelector('[data-testid="subject-lab-variants"]')).not.toBeNull(),
    );
    const use = [...dialog.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === `Use “${VARIANTS[1]}” as the subject`,
    )!;
    await click(use);
    expect(onApplySubject).toHaveBeenCalledWith(VARIANTS[1]);
  });

  it("withholds the A/B hand-off when the saved campaign has no audience", async () => {
    labServer();
    saved = { ...SAVED, segment_id: "" };
    const container = await mount();
    const dialog = await openLab(container);
    await click(button(/Generate and score/, dialog));
    await eventually(() =>
      expect(dialog.textContent).toContain(
        "Choose and save this campaign's audience before starting an A/B test.",
      ),
    );
    expect(button(/Run top 3 as a bandit A\/B/, dialog).disabled).toBe(true);
  });

  it("says the lab is off when the resolved flag is off", async () => {
    labServer("false");
    const container = await mount();
    const section = container.querySelector('[data-testid="copilot-section-lab"]')!;
    await click(section.querySelector("button")!);
    await eventually(() =>
      expect(section.textContent).toContain("Subject Lab is off for this workspace."),
    );
    expect([...section.querySelectorAll("button")].some((b) => /Open Subject Lab/.test(b.textContent ?? ""))).toBe(false);
  });
});

describe("start from a brief (campaigns-3)", () => {
  function briefServer() {
    handler = (req) => {
      if (req.path === "/api/v1/subject-analyzer/buckets") {
        return json(200, {
          buckets: [
            { attribute: "length", bucket: "short", campaigns: 4, open_rate: 0.31, click_rate: 0.04 },
            { attribute: "emoji", bucket: "has_emoji", campaigns: 2, open_rate: 0.22, click_rate: 0.02 },
          ],
          campaigns_total: 9,
          window_days: 180,
        });
      }
      if (req.path === "/api/v1/ai/subject-lines/top-performers") {
        return json(200, {
          window_days: 90,
          min_recipients: 20,
          top: [
            {
              campaign_id: "5b0c6a7e-3f7d-4f55-9a55-5d8b0f6a1c21",
              name: "Spring",
              subject: "Spring sale is live",
              sent_at: "2026-05-01T00:00:00Z",
              recipients: 100,
              opens: 40,
              clicks: 5,
              open_rate: 0.4,
              click_rate: 0.05,
            },
          ],
        });
      }
      if (req.path === "/api/v1/ai/subject-lines/generate") {
        return json(200, {
          candidates: ["Autumn sale: 30% off", "48 hours of autumn savings"],
          generated_at: "2026-09-12T08:00:00Z",
          fallback: false,
        });
      }
      if (req.path === "/api/v1/subject-analyzer/score") {
        const subject = (req.body as { subject: string }).subject;
        return json(200, {
          subject,
          attributes: {},
          expected_open: subject.startsWith("Autumn") ? 0.28 : 0,
          expected_click: subject.startsWith("Autumn") ? 0.03 : 0,
          matched_history: subject.startsWith("Autumn") ? 6 : 0,
          suggestions: subject.startsWith("Autumn") ? ["Try a shorter subject."] : [],
        });
      }
      return undefined;
    };
  }

  it("generates from the brief and grades each candidate against history", async () => {
    briefServer();
    const onApplySubject = vi.fn();
    const container = await mount({ onApplySubject });
    const section = container.querySelector('[data-testid="copilot-section-brief"]')!;
    await click(section.querySelector("button")!);
    await eventually(() => expect(section.textContent).toContain("Spring sale is live"));
    expect(calls("GET", "/api/v1/subject-analyzer/buckets")).toHaveLength(1);

    await type(field<HTMLTextAreaElement>("What is this email about?"), "Autumn sale, 30% off for 48 hours");
    await act(async () => {
      const tone = field<HTMLSelectElement>("Tone");
      tone.value = "urgent";
      tone.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type(field<HTMLInputElement>("Audience (optional)"), "VIP subscribers");
    await click(button(/Generate from brief/, section));

    await eventually(() => expect(calls("POST", "/api/v1/subject-analyzer/score")).toHaveLength(2));
    expect(calls("POST", "/api/v1/ai/subject-lines/generate")[0]?.body).toEqual({
      prompt: "Autumn sale, 30% off for 48 hours",
      variant_count: 3,
      tone: "urgent",
      target_audience: "VIP subscribers",
    });
    expect(calls("POST", "/api/v1/subject-analyzer/score").map((req) => req.body)).toEqual([
      { subject: "Autumn sale: 30% off" },
      { subject: "48 hours of autumn savings" },
    ]);
    await eventually(() =>
      expect(section.textContent).toContain(
        "Expected open 28.0% · click 3.0% · from 6 matching campaigns",
      ),
    );
    // Zero matched history is "no basis", never a 0% forecast.
    expect(section.textContent).toContain("no basis to predict opens or clicks");
    expect(section.textContent).toContain("Try a shorter subject.");

    await click(button(/Show details/, section));
    expect(section.querySelector('[data-testid="subject-buckets"]')?.textContent).toContain(
      "31.0% open",
    );

    const use = [...section.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Use “Autumn sale: 30% off” as the subject",
    )!;
    await click(use);
    expect(onApplySubject).toHaveBeenCalledWith("Autumn sale: 30% off");
  });

  it("withholds generation from an editor with the reason, but still shows history", async () => {
    briefServer();
    me = identity("editor");
    const container = await mount();
    const section = container.querySelector('[data-testid="copilot-section-brief"]')!;
    await click(section.querySelector("button")!);
    await eventually(() => expect(section.textContent).toContain("Spring sale is live"));
    expect(section.textContent).toContain(
      "Generating subject lines from a brief needs an owner or admin role.",
    );
    expect(button(/Generate from brief/, section).disabled).toBe(true);
    expect(calls("POST", "/api/v1/ai/subject-lines/generate")).toHaveLength(0);
  });
});
