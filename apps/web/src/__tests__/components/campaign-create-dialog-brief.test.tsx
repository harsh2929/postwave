// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// "Start from a brief" inside the new-campaign dialog (row campaigns-3,
// desktop CampaignCreateOverlays → SubjectLineAssistant): the brief goes to
// the subject-line generator, and a picked candidate becomes the draft's
// subject — without the assistant's own submit ever creating the campaign.
// Real transport; only `fetch` is stubbed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignCreateDialog } from "@/app/(dashboard)/app/campaigns/campaign-create-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/campaigns",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ME = {
  user_id: "u-1",
  tenant_id: "t-1",
  email: "ops@brand.example",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Brand",
  workspace_slug: "brand",
};

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let seen: Seen[] = [];
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

beforeEach(() => {
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const req: Seen = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(raw, "http://postwave.test").pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      seen.push(req);
      switch (req.path) {
        case "/api/v1/auth/me":
          return json(200, ME);
        case "/api/v1/subject-analyzer/buckets":
          return json(200, { buckets: [], campaigns_total: 0, window_days: 180 });
        case "/api/v1/ai/subject-lines/top-performers":
          return json(200, { window_days: 90, min_recipients: 20, top: [] });
        case "/api/v1/ai/subject-lines/generate":
          return json(200, {
            candidates: ["Autumn sale: 30% off"],
            generated_at: "2026-09-12T08:00:00Z",
            fallback: true,
          });
        case "/api/v1/subject-analyzer/score":
          return json(200, {
            subject: "Autumn sale: 30% off",
            attributes: {},
            expected_open: 0,
            expected_click: 0,
            matched_history: 0,
            suggestions: [],
          });
        default:
          return json(404, { error: { code: "not_found", message: "" } });
      }
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("new-campaign dialog: start from a brief", () => {
  it("generates from the brief and hands the pick to the draft subject", async () => {
    const onDraftChange = vi.fn();
    const onSubjectChange = vi.fn();
    const onCreate = vi.fn();
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
          <CampaignCreateDialog
            canWrite
            open
            draft={{ name: "Autumn", subject: "" }}
            onCreate={onCreate}
            onCreateABTest={vi.fn()}
            onDraftChange={onDraftChange}
            onOpenChange={vi.fn()}
            onRetryAudiences={vi.fn()}
            onSubjectChange={onSubjectChange}
            readOnlyMessage=""
            abCreateError={null}
            audienceError={false}
            audienceLoading={false}
            audienceSegments={[]}
            creatingABTest={false}
            suggestions={[]}
            suggestError={null}
            suggestLoading={false}
          />
        </QueryClientProvider>,
      );
    });

    // Collapsed by default: opening the dialog reads no history — even after
    // every pending request would have landed.
    for (let turn = 0; turn < 20; turn += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(seen.filter((req) => req.path.startsWith("/api/v1/subject-analyzer"))).toEqual([]);
    const toggle = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Start from a brief",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    let brief: HTMLTextAreaElement | null = null;
    await eventually(() => {
      const label = [...document.querySelectorAll("label")].find(
        (candidate) => candidate.textContent?.trim() === "What is this email about?",
      );
      brief = label ? (document.getElementById(label.htmlFor) as HTMLTextAreaElement) : null;
      expect(brief?.disabled).toBe(false);
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        brief!,
        "Autumn sale for 48 hours",
      );
      brief!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const generate = [...document.querySelectorAll("button")].find((candidate) =>
      /Generate from brief/.test(candidate.textContent ?? ""),
    )!;
    await act(async () => generate.click());

    await eventually(() =>
      expect(seen.filter((req) => req.path === "/api/v1/ai/subject-lines/generate")).toHaveLength(1),
    );
    expect(seen.find((req) => req.path === "/api/v1/ai/subject-lines/generate")?.body).toEqual({
      prompt: "Autumn sale for 48 hours",
      variant_count: 3,
    });
    // The assistant's submit is its own; it never creates the campaign.
    expect(onCreate).not.toHaveBeenCalled();
    await eventually(() =>
      expect(document.body.textContent).toContain("AI partial — some candidates were derived"),
    );
    const use = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Use “Autumn sale: 30% off” as the subject",
    )!;
    await act(async () => use.click());
    expect(onDraftChange).toHaveBeenCalledWith({ name: "Autumn", subject: "Autumn sale: 30% off" });
    expect(onSubjectChange).toHaveBeenCalledWith("Autumn sale: 30% off");
  });
});
