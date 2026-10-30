import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export type PostwaveAIEvidenceMode = "source" | "optimized";
export type PostwaveAIMode =
  | "chat"
  | "compose"
  | "subject"
  | "presend"
  | "agent"
  | "routines";
export type PostwaveAIRole = "admin" | "viewer";
export type EndpointMode = "success" | "error" | "deferred";

function evidenceMode(): PostwaveAIEvidenceMode {
  const mode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
  if (mode !== "source" && mode !== "optimized") {
    throw new Error(`Unsupported Moosewave AI evidence mode: ${mode}`);
  }
  return mode;
}

const EVIDENCE_MODE = evidenceMode();
const EVIDENCE_ROOT = fileURLToPath(
  new URL(
    "../../../../.audit-screenshots/postwave-ai-evidence/",
    import.meta.url,
  ),
);
const EVIDENCE_DIR = join(EVIDENCE_ROOT, EVIDENCE_MODE);
const DECLARED_PLAYWRIGHT_TEST_COUNT = 9;

export const POSTWAVE_AI_FIXED_TIME = "2026-08-08T08:30:00.000Z";
export const POSTWAVE_AI_TENANT_ID = "aa000000-0000-4000-8000-000000000001";
export const POSTWAVE_AI_SECRET_CANARY =
  "postwave-ai-provider-secret-must-never-reach-the-renderer";

const AI_PATH_PREFIXES = [
  "/api/v1/agent-routines",
  "/api/v1/ai/",
  "/api/v1/campaign-templates",
  "/api/v1/campaigns",
  "/api/v1/forms",
  "/api/v1/mcp/executions",
  "/api/v1/presend/",
  "/api/v1/segments",
  "/api/v1/sequences",
  "/api/v1/subject-",
  "/api/v1/voice/",
] as const;

const DEFAULT_ENDPOINT_PAYLOADS: Readonly<Record<string, unknown>> = {
  "/api/v1/voice/profile": {
    id: "voice-profile-evidence-v7",
    tenant_id: POSTWAVE_AI_TENANT_ID,
    status: "ready",
    version: 7,
    description: "Warm, direct, practical, and grounded in honest numbers.",
    generated_at: "2026-08-07T16:20:00.000Z",
    built_at: "2026-08-07T16:20:00.000Z",
    tonal: { warmth: 0.84, directness: 0.78, optimism: 0.61 },
    stylistic: {
      avg_sentence_length: 13.8,
      passive_voice_pct: 0.04,
      formality_score: 0.42,
    },
    structural: {
      opening_hook_style: "specific observation",
      closing_pattern: "clear next step",
    },
    vocabulary: {
      distinctive_terms: [{ term: "practical" }, { term: "momentum" }],
    },
    persona: { recurring_themes: ["craft", "clarity", "customer trust"] },
    representative_samples: [
      { text: "Make the next useful step unmistakably clear." },
      { text: "Show the evidence, then let the reader decide." },
    ],
  },
  "/api/v1/voice/sources": {
    sources: [
      {
        id: "voice-source-docs",
        type: "blog_rss",
        params: { FeedURL: "https://docs.example.invalid/updates.xml" },
        last_ingested_at: "2026-08-07T15:40:00.000Z",
        last_item_count: 42,
      },
    ],
  },
  "/api/v1/voice/brand-profile": {
    id: "brand-profile-evidence",
    descriptors: ["warm", "specific", "no-jargon"],
    writing_rules: [
      "Lead with the reader's outcome.",
      "Use honest numbers and a single next step.",
    ],
    sample_snippets: [
      "Your launch is ready for a calmer final review. Every open issue is visible below.",
    ],
    is_active: true,
    created_at: "2026-07-01T09:00:00.000Z",
    updated_at: "2026-08-07T16:30:00.000Z",
  },
  "/api/v1/voice/templates": {
    templates: [
      {
        id: "voice-template-release",
        slug: "release-note",
        name: "Release note",
        description: "A concise customer update with one clear next step.",
      },
      {
        id: "voice-template-winback",
        slug: "win-back",
        name: "Win-back message",
        description: "A respectful re-engagement note without false urgency.",
      },
    ],
  },
  "/api/v1/mcp/executions": {
    rows: [
      {
        id: 901,
        tenantId: POSTWAVE_AI_TENANT_ID,
        apiKeyPrefix: "pw_agent_7YQ2",
        method: "POST",
        path: "/api/v1/campaigns",
        toolName: "create_campaign_draft",
        statusCode: 201,
        latencyMs: 184,
        costMicros: 0,
        calledAt: "2026-08-08T08:28:00.000Z",
      },
      {
        id: 900,
        tenantId: POSTWAVE_AI_TENANT_ID,
        apiKeyPrefix: "pw_agent_7YQ2",
        method: "GET",
        path: "/api/v1/segments",
        toolName: "list_segments",
        statusCode: 200,
        latencyMs: 76,
        costMicros: 0,
        calledAt: "2026-08-08T08:26:00.000Z",
      },
    ],
  },
  "/api/v1/agent-routines": {
    items: [
      {
        id: "routine-weekly-evidence",
        name: "Weekly product digest",
        prompt:
          "Draft a concise product digest from the approved release notes.",
        kind: "draft_campaign",
        schedule: "weekly",
        schedule_detail: {},
        target_segment_id: "segment-engaged",
        require_approval: true,
        enabled: true,
        has_active_run: true,
        last_run_at: "2026-08-01T08:00:00.000Z",
        created_by: "evidence-admin",
        created_at: "2026-07-01T08:00:00.000Z",
        updated_at: "2026-08-01T08:00:00.000Z",
      },
      {
        id: "routine-winback-evidence",
        name: "Paused win-back sequence",
        prompt: "Draft a respectful two-step win-back sequence.",
        kind: "draft_sequence",
        schedule: "monthly",
        schedule_detail: {},
        target_segment_id: null,
        require_approval: false,
        enabled: false,
        has_active_run: false,
        last_run_at: null,
        created_by: "evidence-admin",
        created_at: "2026-07-15T08:00:00.000Z",
        updated_at: "2026-07-15T08:00:00.000Z",
      },
    ],
  },
  "/api/v1/agent-routines/routine-weekly-evidence/runs": {
    items: [
      {
        id: "routine-run-evidence-active",
        routine_id: "routine-weekly-evidence",
        status: "running",
        started_at: "2026-08-08T08:29:30.000Z",
        finished_at: null,
      },
      {
        id: "routine-run-evidence-1",
        routine_id: "routine-weekly-evidence",
        status: "succeeded",
        output_kind: "campaign",
        output_ref: "campaign-draft-evidence",
        approval_id: "approval-evidence-1",
        prompt_used:
          "Draft a concise product digest from the approved release notes.",
        context_used: "Segment: Engaged readers · 4,280 estimated members",
        reasoning:
          "I led with the highest-impact release and kept one review CTA.",
        draft_preview: {
          kind: "campaign",
          name: "Weekly product digest",
          subject: "Three improvements, one calmer workflow",
          preview_text: "A practical look at what changed this week.",
          body: "Here are the three changes that matter most this week.",
        },
        started_at: "2026-08-01T08:00:00.000Z",
        finished_at: "2026-08-01T08:00:08.000Z",
      },
    ],
  },
  "/api/v1/agent-routines/routine-winback-evidence/runs": { items: [] },
  "/api/v1/segments": [
    { id: "segment-engaged", name: "Engaged readers" },
    { id: "segment-trial", name: "Active trials" },
  ],
  "/api/v1/campaigns": {
    items: [
      {
        id: "campaign-ai-1",
        name: "August product launch",
        subject: "A calmer launch workflow",
        status: "draft",
      },
    ],
    total: 1,
    page: 1,
    per_page: 40,
  },
  "/api/v1/voice/sequences": {
    items: [
      {
        id: "sequence-ai-1",
        name: "Customer welcome",
        status: "active",
      },
    ],
  },
  "/api/v1/campaign-templates": [
    {
      id: "template-ai-1",
      name: "Monthly digest",
      subject: "What changed this month",
      category: "newsletter",
    },
  ],
  "/api/v1/forms": [
    { id: "form-ai-1", name: "Product updates", slug: "product-updates" },
  ],
  "/api/v1/voice/generate": {
    text: "Subject: A calmer way to launch\n\nYour next launch can move quickly without hiding the final checks. Review the three readiness signals, resolve what matters, and choose the moment to send.",
    draft: {
      name: "Calmer launch",
      subject: "A calmer way to launch",
      body: "Your next launch can move quickly without hiding the final checks. Review the three readiness signals, resolve what matters, and choose the moment to send.",
      preview_text: "Three readiness signals, one clear next step.",
    },
  },
  "/api/v1/ai/compose/broadcast": {
    primary: {
      name: "Summer release briefing",
      subject: "Your launch checklist, now in one calm view",
      body: "<h2>Launch with clarity</h2><p>Review readiness, voice, and placement in one workspace.</p><p>Choose your next step when the evidence is complete.</p>",
      preview_text: "A more deliberate way to move from draft to review.",
    },
    subject_variants: [
      "Your launch checklist, now in one calm view",
      "Three signals before your next send",
      "A clearer final review for every launch",
    ],
    generated_at: POSTWAVE_AI_FIXED_TIME,
  },
  "/api/v1/ai/compose/variants": {
    subject_variants: [
      "See every launch risk before you send",
      "The final review your launch deserves",
      "Launch readiness without the guesswork",
    ],
    generated_at: POSTWAVE_AI_FIXED_TIME,
  },
  "/api/v1/subject-analyzer/score": {
    subject: "Make launch readiness easier to trust",
    attributes: {
      length: 37,
      length_bucket: "medium",
      word_count: 6,
      emoji_count: 0,
      has_question: false,
      has_personalize: false,
      uppercase_ratio: 0.03,
      all_caps: false,
    },
    expected_open: 0.427,
    expected_click: 0.082,
    matched_history: 84,
    suggestions: ["Keep the specific outcome in the first six words."],
  },
  "/api/v1/subject-lab/variants": {
    variants: [
      "Trust every launch decision",
      "A calmer final check before launch",
      "Launch with every signal in view",
      "One clear review before you send",
      "Your launch, verified step by step",
      "See the evidence before launch",
    ],
    axis: "length",
    generated_at: POSTWAVE_AI_FIXED_TIME,
  },
  "/api/v1/subject-lab/score": {
    baseline_open: 0.391,
    window_days: 180,
    variants: [
      {
        text: "Trust every launch decision",
        axis: "length",
        predicted_open: 0.458,
        ci_low: 0.431,
        ci_high: 0.485,
        matched_n: 142,
        low_confidence: false,
        below_baseline: false,
      },
      {
        text: "A calmer final check before launch",
        axis: "length",
        predicted_open: 0.447,
        ci_low: 0.421,
        ci_high: 0.473,
        matched_n: 127,
        low_confidence: false,
        below_baseline: false,
      },
      {
        text: "Launch with every signal in view",
        axis: "length",
        predicted_open: 0.438,
        ci_low: 0.409,
        ci_high: 0.467,
        matched_n: 98,
        low_confidence: false,
        below_baseline: false,
      },
      {
        text: "One clear review before you send",
        axis: "length",
        predicted_open: 0.407,
        ci_low: 0.369,
        ci_high: 0.445,
        matched_n: 31,
        low_confidence: true,
        below_baseline: false,
      },
      {
        text: "Your launch, verified step by step",
        axis: "length",
        predicted_open: 0.395,
        ci_low: 0.352,
        ci_high: 0.438,
        matched_n: 22,
        low_confidence: true,
        below_baseline: false,
      },
      {
        text: "See the evidence before launch",
        axis: "length",
        predicted_open: 0.381,
        ci_low: 0.348,
        ci_high: 0.414,
        matched_n: 51,
        low_confidence: false,
        below_baseline: true,
      },
    ],
  },
  "/api/v1/presend/verdict": {
    verdict: "ok",
    complete: true,
    summary: "All required advisory checks completed for this draft.",
    components: [
      {
        name: "eq_score",
        status: "ok",
        score: 91,
        message: "Content structure and clarity are strong.",
      },
      {
        name: "voice_drift",
        status: "ok",
        score: 88,
        message: "The draft remains close to the active voice profile.",
      },
      {
        name: "placement",
        status: "ok",
        score: 0.86,
        message: "Primary placement is predicted for most recipients.",
      },
    ],
    computed_at: POSTWAVE_AI_FIXED_TIME,
  },
};

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function deferredGate(): DeferredGate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export interface PostwaveAIRequestEvidence {
  body: string | null;
  method: string;
  order: number;
  pathname: string;
  search: string;
}

export interface PostwaveAIA11yRun {
  label: string;
  selector: string;
  violations: Array<{
    id: string;
    impact: string | null;
    nodes: Array<{ target: string[]; failureSummary?: string }>;
  }>;
}

export interface PostwaveAIHarness {
  a11yRuns: PostwaveAIA11yRun[];
  assetFailures: string[];
  expectedHttpFailures: string[];
  observedHttpFailures: Array<{ pathname: string; status: number }>;
  requests: PostwaveAIRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
  setEndpointMode: (pathname: string, mode: EndpointMode) => void;
  setEndpointPayload: (pathname: string, payload: unknown) => void;
  releaseEndpoint: (pathname: string) => void;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function authPayload(role: PostwaveAIRole): Record<string, unknown> {
  return {
    user_id: `postwave-ai-${role}`,
    tenant_id: POSTWAVE_AI_TENANT_ID,
    email: `${role}@postwave-ai.example.invalid`,
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Moosewave AI Evidence",
    workspace_slug: "postwave-ai-evidence",
  };
}

function pathIsAIProduct(pathname: string): boolean {
  return AI_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function canonicalPayloadPath(pathname: string): string {
  if (pathname === "/api/v1/mcp/executions") return pathname;
  if (
    pathname === "/api/v1/campaigns" ||
    pathname === "/api/v1/voice/sequences" ||
    pathname === "/api/v1/campaign-templates" ||
    pathname === "/api/v1/forms"
  ) {
    return pathname;
  }
  return pathname;
}

function requestEvidence(
  request: Request,
  order: number,
): PostwaveAIRequestEvidence {
  const url = new URL(request.url());
  return {
    body: request.postData() ?? null,
    method: request.method(),
    order,
    pathname: url.pathname,
    search: url.search,
  };
}

function allowedMethod(pathname: string, method: string): boolean {
  if (
    pathname === "/api/v1/auth/me" ||
    pathname === "/api/v1/voice/profile" ||
    pathname === "/api/v1/voice/sources" ||
    pathname === "/api/v1/voice/brand-profile" ||
    pathname === "/api/v1/voice/templates" ||
    pathname === "/api/v1/mcp/executions" ||
    pathname === "/api/v1/agent-routines" ||
    pathname === "/api/v1/segments" ||
    pathname === "/api/v1/campaigns" ||
    pathname === "/api/v1/voice/sequences" ||
    pathname === "/api/v1/campaign-templates" ||
    pathname === "/api/v1/forms" ||
    pathname.endsWith("/runs")
  ) {
    return method === "GET";
  }
  return method === "POST";
}

function successStatus(pathname: string): number {
  if (/\/agent-routines\/[^/]+\/run$/u.test(pathname)) return 202;
  if (pathname === "/api/v1/agent-routines") return 200;
  return 200;
}

function errorBody(pathname: string): Record<string, unknown> {
  return {
    error: {
      code: "evidence_service_unavailable",
      message: pathIsAIProduct(pathname)
        ? "This AI operation is temporarily unavailable. Retry when the service has recovered."
        : "The request is temporarily unavailable.",
      details: { diagnostic: POSTWAVE_AI_SECRET_CANARY },
    },
  };
}

function dynamicPayload(
  pathname: string,
  request: Request,
  payloads: Map<string, unknown>,
): unknown {
  const explicit = payloads.get(pathname);
  if (explicit !== undefined) return explicit;
  if (/\/api\/v1\/agent-routines\/[^/]+\/run$/u.test(pathname)) {
    return { run_id: "routine-run-evidence-started", status: "running" };
  }
  if (pathname === "/api/v1/agent-routines" && request.method() === "POST") {
    return {
      id: "routine-created-evidence",
      name: "Evidence routine",
      prompt: "Draft a review-ready customer update.",
      kind: "draft_campaign",
      schedule: "manual",
      target_segment_id: null,
      require_approval: true,
      enabled: true,
      has_active_run: false,
      created_at: POSTWAVE_AI_FIXED_TIME,
      updated_at: POSTWAVE_AI_FIXED_TIME,
    };
  }
  return DEFAULT_ENDPOINT_PAYLOADS[canonicalPayloadPath(pathname)];
}

export async function installPostwaveAIHarness(
  page: Page,
  role: PostwaveAIRole,
  initialModes: Partial<Record<string, EndpointMode>> = {},
): Promise<PostwaveAIHarness> {
  const endpointModes = new Map<string, EndpointMode>();
  for (const [pathname, mode] of Object.entries(initialModes)) {
    if (mode) endpointModes.set(pathname, mode);
  }
  const payloads = new Map<string, unknown>();
  const gates = new Map<string, DeferredGate[]>();
  const harness: PostwaveAIHarness = {
    a11yRuns: [],
    assetFailures: [],
    expectedHttpFailures: [],
    observedHttpFailures: [],
    requests: [],
    runtimeErrors: [],
    unexpectedRequests: [],
    setEndpointMode(pathname, mode) {
      endpointModes.set(pathname, mode);
      if (mode === "error") harness.expectedHttpFailures.push(pathname);
    },
    setEndpointPayload(pathname, payload) {
      payloads.set(pathname, payload);
    },
    releaseEndpoint(pathname) {
      endpointModes.set(pathname, "success");
      for (const gate of gates.get(pathname) ?? []) gate.release();
      gates.delete(pathname);
    },
  };

  for (const [pathname, mode] of endpointModes) {
    if (mode === "error") harness.expectedHttpFailures.push(pathname);
  }

  page.on("pageerror", (error) => harness.runtimeErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const locationUrl = message.location().url;
    if (
      message.text().startsWith("Failed to load resource:") &&
      locationUrl &&
      harness.expectedHttpFailures.includes(new URL(locationUrl).pathname)
    ) {
      return;
    }
    harness.runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    harness.observedHttpFailures.push({
      pathname: url.pathname,
      status: response.status(),
    });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/assets/")) {
      harness.assetFailures.push(
        `${url.pathname}: ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });

  // The shared visual fixture's broad `**/api/**` fallback also matches Vite
  // source-module URLs under `/src/lib/api/`. Let those modules reach Vite;
  // receiving fixture JSON in place of JavaScript leaves a correctly blank
  // shell before the production route can boot.
  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === "/api/v1/auth/me") {
      await json(route, authPayload(role));
      return;
    }
    if (pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@postwave-ai.example.invalid`,
        tenant: "Moosewave AI Evidence",
        role,
      });
      return;
    }
    if (pathname === "/api/v1/api-keys/me") {
      await json(route, {
        tenant_id: POSTWAVE_AI_TENANT_ID,
        tenant_slug: "postwave-ai-evidence",
        scopes: role === "admin" ? ["admin"] : [],
        actor: `${role}@postwave-ai.example.invalid`,
      });
      return;
    }
    if (pathname === "/api/v1/streams/token") {
      await json(route, {
        token: "postwave-ai-evidence-stream-token",
        expires_at: "2026-08-08T08:31:00.000Z",
        ttl_seconds: 60,
      });
      return;
    }
    if (!pathIsAIProduct(pathname)) {
      await route.fallback();
      return;
    }

    const evidence = requestEvidence(request, harness.requests.length + 1);
    harness.requests.push(evidence);
    if (!allowedMethod(pathname, request.method())) {
      harness.unexpectedRequests.push(
        `${request.method()} ${pathname}${url.search} (method mismatch)`,
      );
      await json(route, errorBody(pathname), 405);
      return;
    }

    if (role === "viewer" && pathname === "/api/v1/mcp/executions") {
      harness.expectedHttpFailures.push(pathname);
      await json(
        route,
        {
          error: {
            code: "forbidden",
            message: "MCP execution telemetry requires an admin role.",
          },
        },
        403,
      );
      return;
    }

    let payload = dynamicPayload(pathname, request, payloads);
    if (payload === undefined) {
      harness.unexpectedRequests.push(
        `${request.method()} ${pathname}${url.search} (unmocked AI request)`,
      );
      await json(route, errorBody(pathname), 501);
      return;
    }

    const mode = endpointModes.get(pathname) ?? "success";
    if (mode === "deferred") {
      const gate = deferredGate();
      gates.set(pathname, [...(gates.get(pathname) ?? []), gate]);
      await gate.promise;
      payload = dynamicPayload(pathname, request, payloads);
    } else if (mode === "error") {
      await json(route, errorBody(pathname), 503);
      return;
    }

    await json(route, payload, successStatus(pathname));
  });

  return harness;
}

export async function openPostwaveAI(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    deferredEndpoints?: string[];
    height?: number;
    mode?: PostwaveAIMode;
    role?: PostwaveAIRole;
    theme?: "system" | "dark" | "light";
    width?: number;
  } = {},
): Promise<PostwaveAIHarness> {
  const role = options.role ?? "admin";
  const mode = options.mode ?? "chat";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  await page.addInitScript(
    ({
      identityRole,
      tenantId,
    }: {
      identityRole: PostwaveAIRole;
      tenantId: string;
    }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `postwave-ai-${identityRole}`,
          tenant_id: tenantId,
          role: identityRole,
          effective_role: identityRole,
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { identityRole: role, tenantId: POSTWAVE_AI_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(POSTWAVE_AI_FIXED_TIME));
  const initialModes = Object.fromEntries(
    (options.deferredEndpoints ?? []).map((pathname) => [
      pathname,
      "deferred" as const,
    ]),
  );
  const harness = await installPostwaveAIHarness(page, role, initialModes);
  const query = mode === "chat" ? "" : `?tab=${mode}`;
  await page.goto(`/app/ai${query}`);
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "Moosewave AI", level: 1 }),
  ).toBeVisible();
  const activeLabel =
    mode === "subject" ? "Subject lab" : mode === "presend" ? "Pre-send" : mode;
  const activeTab = page.getByRole("tab", {
    name: new RegExp(`^${activeLabel}`, "iu"),
  });
  await expect(activeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ai-shell")).toBeVisible();
  await waitForPostwaveAIInspector(page);
  return harness;
}

async function waitForPostwaveAIInspector(page: Page): Promise<void> {
  const inspector = page.locator("#postwave-ai-inspector");
  if ((await inspector.count()) === 0 || !(await inspector.isVisible())) return;
  await expect(inspector.locator('[aria-busy="true"]')).toHaveCount(0);
}

export async function selectPostwaveAIMode(
  page: Page,
  mode: PostwaveAIMode,
): Promise<Locator> {
  const label =
    mode === "subject" ? "Subject lab" : mode === "presend" ? "Pre-send" : mode;
  const tab = page.getByRole("tab", { name: new RegExp(`^${label}`, "iu") });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await waitForPostwaveAIInspector(page);
  return tab;
}

export async function expectNoPostwaveAIOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".ai-shell");
    const stage = document.querySelector<HTMLElement>(".ai-workspace-stage");
    const visiblePanel = document.querySelector<HTMLElement>(
      '.ai-workspace-stage [role="tabpanel"]:not([hidden])',
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      stage: stage ? stage.scrollWidth - stage.clientWidth : 0,
      visiblePanel: visiblePanel
        ? visiblePanel.scrollWidth - visiblePanel.clientWidth
        : 0,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.stage).toBeLessThanOrEqual(1);
  expect(overflow.visiblePanel).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function auditPostwaveAIA11y(
  page: Page,
  harness: PostwaveAIHarness,
  label: string,
  selector = ".ai-shell",
  options: { includeColorContrast?: boolean } = {},
): Promise<PostwaveAIA11yRun["violations"]> {
  await waitForPostwaveAIInspector(page);
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  const hasAxe = await page.evaluate(() => "axe" in window);
  if (!hasAxe) await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(
    async ({ includeColorContrast, rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
              options: unknown,
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{
                  target: string[];
                  failureSummary?: string;
                }>;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run(rootSelector, {
        resultTypes: ["violations"],
        rules: includeColorContrast
          ? undefined
          : { "color-contrast": { enabled: false } },
        runOnly: {
          type: "tag",
          values: [
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22a",
            "wcag22aa",
          ],
        },
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        )
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failureSummary: node.failureSummary,
          })),
        }));
    },
    {
      includeColorContrast: options.includeColorContrast ?? true,
      rootSelector: selector,
    },
  );
  harness.a11yRuns.push({ label, selector, violations });
  return violations;
}

export async function scrollPostwaveAITargetIntoFrame(
  page: Page,
  target: Locator,
  viewportTop = 92,
): Promise<void> {
  await expect(page.locator(".content")).toBeVisible();
  await expect(target).toBeVisible();
  await target.evaluate(async (element, top) => {
    const owner = document.querySelector<HTMLElement>(".content");
    if (!owner) throw new Error("Missing shell content scroll owner.");
    const requested = Math.max(
      0,
      element.getBoundingClientRect().top + owner.scrollTop - top,
    );
    owner.scrollTo({ top: requested, behavior: "instant" });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, viewportTop);
}

export async function resetPostwaveAIScroll(page: Page): Promise<void> {
  const content = page.locator(".content");
  await content.evaluate((element) => {
    element.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBe(0);
}

export async function expectPostwaveAIReducedMotion(page: Page): Promise<void> {
  const running = await page.locator(".ai-shell").evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running")
      .map((animation) => animation.effect?.getComputedTiming().duration ?? 0),
  );
  expect(running).toEqual([]);
}

export async function expectPostwaveAIForcedColors(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".ai-page-header");
    const selected = document.querySelector<HTMLElement>(
      '.ai-mode-tab[aria-selected="true"]',
    );
    if (!header || !selected) {
      throw new Error("Missing Moosewave AI forced-colors evidence target.");
    }
    const canvas = document.createElement("span");
    canvas.style.cssText =
      "color: CanvasText; background: Canvas; forced-color-adjust: none";
    const highlight = document.createElement("span");
    highlight.style.cssText =
      "color: HighlightText; background: Highlight; forced-color-adjust: none";
    document.body.append(canvas, highlight);
    const result = {
      actual: {
        headerBorder: getComputedStyle(header).borderColor,
        selectedBorder: getComputedStyle(selected).borderColor,
      },
      expected: {
        canvasText: getComputedStyle(canvas).color,
      },
    };
    canvas.remove();
    highlight.remove();
    return result;
  });
  expect(colors.actual.headerBorder).toBe(colors.expected.canvasText);
  expect(colors.actual.selectedBorder).toBe(colors.expected.canvasText);
}

export async function expectPostwaveAISafety(
  page: Page,
  harness: PostwaveAIHarness,
): Promise<void> {
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.assetFailures).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(
    harness.observedHttpFailures.filter(
      ({ pathname }) => !harness.expectedHttpFailures.includes(pathname),
    ),
  ).toEqual([]);
  for (const pathname of new Set(harness.expectedHttpFailures)) {
    expect(
      harness.observedHttpFailures.some(
        (failure) => failure.pathname === pathname,
      ),
    ).toBe(true);
  }
  expect(harness.requests.map(({ order }) => order)).toEqual(
    harness.requests.map((_, index) => index + 1),
  );
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(POSTWAVE_AI_SECRET_CANARY);
  expect(JSON.stringify(harness.requests)).not.toContain("test-key");
}

export async function capturePostwaveAIEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: PostwaveAIHarness,
): Promise<void> {
  await waitForPostwaveAIInspector(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const screenshotPath = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path: screenshotPath,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });

  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const baseCommitSha =
    typeof metadata["postwaveAIBaseCommitSha"] === "string"
      ? metadata["postwaveAIBaseCommitSha"]
      : "unavailable";
  const media = await page.evaluate(() => ({
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    command:
      `PW_EVIDENCE_MODE=${EVIDENCE_MODE} pnpm exec playwright test ` +
      "--config tests/e2e/postwave-ai.playwright.config.ts",
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    fixedTimeUtc: POSTWAVE_AI_FIXED_TIME,
    timezoneId: "UTC",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    project: testInfo.project.name,
    report: `../reports/${EVIDENCE_MODE}.json`,
  };
  const requestLedgerPath = join(EVIDENCE_DIR, `${name}.requests.json`);
  const qualityPath = join(EVIDENCE_DIR, `${name}.quality.json`);
  await writeFile(
    join(EVIDENCE_DIR, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, "command-receipt.json"),
    `${JSON.stringify(
      {
        ...receipt,
        webServerCommand:
          EVIDENCE_MODE === "source"
            ? "pnpm exec vite --port 1457 --strictPort"
            : "pnpm build && pnpm exec vite preview --port 1458 --strictPort",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    requestLedgerPath,
    `${JSON.stringify(
      {
        ...receipt,
        capturedAtFixedUtc: POSTWAVE_AI_FIXED_TIME,
        url: page.url(),
        viewport: page.viewportSize(),
        media,
        requests: harness.requests,
        expectedHttpFailures: harness.expectedHttpFailures,
        unexpectedRequests: harness.unexpectedRequests,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    qualityPath,
    `${JSON.stringify(
      {
        ...receipt,
        a11yRuns: harness.a11yRuns,
        runtimeErrors: harness.runtimeErrors,
        assetFailures: harness.assetFailures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
  await testInfo.attach(`${name}-requests`, {
    path: requestLedgerPath,
    contentType: "application/json",
  });
  await testInfo.attach(`${name}-quality`, {
    path: qualityPath,
    contentType: "application/json",
  });
}
