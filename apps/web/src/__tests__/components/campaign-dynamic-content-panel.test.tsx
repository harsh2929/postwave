// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Dynamic content regions in the campaign editor — desktop parity row
// campaigns-54 (DynamicContentPanel). Mounted through CampaignFieldsSection,
// which is where the editor renders it.
//
// Asserted consequences: the regions GET is issued only once the author opens
// the panel; a branch pick changes what the preview iframe actually renders —
// including across a multi-byte prefix, where the server's BYTE offsets and
// JS string indices disagree; picks are refused against an unsaved draft;
// "+ Region" writes the skeleton into the draft field the regions route reads;
// and "Quote a reader reply" stays contained (no reply is loaded).

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { get: mocks.get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import type { Campaign } from "@/lib/campaigns-api";
import { REGION_SKELETON } from "@/lib/campaign-detail-panels-api";
import {
  CampaignFieldsSection,
  type CampaignFieldChange,
} from "@/app/(dashboard)/app/campaigns/[id]/campaign-fields-section";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CAMPAIGN_ID = "11111111-2222-4333-8444-555555555555";
const BASE = `/api/v1/campaigns/${CAMPAIGN_ID}`;
const REGIONS_PATH = `${BASE}/regions`;

// Two multi-byte characters before the region: "é" (2 bytes) and "☕" (3).
const PREFIX = "<p>Café ☕</p>";
const REGION = "{{#if VIP}}<b>Hi VIP</b>{{else}}<i>Hi there</i>{{/if}}";
const SUFFIX = "<p>end</p>";
const BODY = `${PREFIX}${REGION}${SUFFIX}`;
const encoder = new TextEncoder();
const START = encoder.encode(PREFIX).length;
const END = START + encoder.encode(REGION).length;

function me(role: MeResponse["role"]): MeResponse {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "author@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

const SAVED: Campaign = {
  id: CAMPAIGN_ID,
  tenant_id: "tnt_1",
  name: "Spring sale",
  subject: "Spring is here",
  status: "draft",
  campaign_type: "regular",
  editor_mode: "html",
  body_html: BODY,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
};

const roots: Root[] = [];

function render(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    '[data-testid="campaign-dynamic-content"]',
  );
  if (!found) throw new Error("dynamic content panel not rendered");
  return found;
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function previewSource(): string {
  const frame = panel().querySelector("iframe");
  if (!frame) throw new Error("no preview iframe");
  return frame.getAttribute("srcdoc") ?? (frame as HTMLIFrameElement).srcdoc;
}

function mount(options: {
  draft?: Partial<Campaign>;
  editorMode?: NonNullable<Campaign["editor_mode"]>;
  role?: MeResponse["role"];
  onFieldChange?: ReturnType<typeof vi.fn<CampaignFieldChange>>;
}) {
  const identity = me(options.role ?? "editor");
  mocks.whoami.mockResolvedValue(identity);
  const onFieldChange = options.onFieldChange ?? vi.fn<CampaignFieldChange>();
  render(
    createElement(CampaignFieldsSection, {
      campaign: { ...SAVED, ...options.draft },
      editorMode: options.editorMode ?? "html",
      identity,
      onFieldChange,
    }),
  );
  return onFieldChange;
}

async function open(): Promise<void> {
  await click(buttonIn(panel(), "Dynamic content"));
  await waitFor(() => expect(panel().textContent).toContain("VIP"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === BASE) return SAVED;
    if (path === REGIONS_PATH) {
      return {
        campaign_id: CAMPAIGN_ID,
        source: "body_html",
        regions: [
          {
            key: "VIP",
            start: START,
            end: END,
            true_branch: "<b>Hi VIP</b>",
            false_branch: "<i>Hi there</i>",
            has_else: true,
          },
        ],
      };
    }
    throw new ApiError("No fixture recorded for this route.", 404);
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("dynamic content regions (campaigns-54)", () => {
  it("loads regions only when opened, and previews each branch across a multi-byte prefix", async () => {
    mount({});
    await act(async () => {
      await flush();
    });
    expect(mocks.get.mock.calls.map((call) => call[0])).not.toContain(
      REGIONS_PATH,
    );

    await open();
    expect(mocks.get.mock.calls.map((call) => call[0])).toContain(REGIONS_PATH);

    await click(buttonIn(panel(), "True branch"));
    let html = previewSource();
    expect(html).toContain(`${PREFIX}<b>Hi VIP</b>${SUFFIX}`);
    expect(html).not.toContain("Hi there");
    expect(html).not.toContain("{{#if");

    await click(buttonIn(panel(), "Else branch"));
    html = previewSource();
    expect(html).toContain(`${PREFIX}<i>Hi there</i>${SUFFIX}`);
    expect(html).not.toContain("Hi VIP");

    await click(buttonIn(panel(), "Default"));
    expect(previewSource()).toContain(BODY);
  });

  it("refuses branch picks against an unsaved draft and previews the draft as written", async () => {
    const draftBody = `<p>New intro</p>${BODY}`;
    mount({ draft: { body_html: draftBody } });
    await open();
    await waitFor(() =>
      expect(panel().textContent).toContain("Save the campaign first"),
    );
    expect(buttonIn(panel(), "True branch").disabled).toBe(true);
    expect(previewSource()).toContain(draftBody);
  });

  it("appends a region skeleton to the draft field the regions route reads", async () => {
    const htmlChange = mount({});
    await open();
    await click(buttonIn(panel(), "Region"));
    expect(htmlChange).toHaveBeenLastCalledWith(
      "body_html",
      BODY + REGION_SKELETON,
    );

    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";

    const textChange = mount({
      draft: { editor_mode: "plain_text", plain_text: "Hello" },
      editorMode: "plain_text",
    });
    await click(buttonIn(panel(), "Dynamic content"));
    await waitFor(() => expect(buttonIn(panel(), "Region").disabled).toBe(false));
    await click(buttonIn(panel(), "Region"));
    expect(textChange).toHaveBeenLastCalledWith(
      "plain_text",
      "Hello" + REGION_SKELETON,
    );
  });

  it("withholds insertion from a viewer and from an editor mode the route does not read", async () => {
    mount({ role: "viewer" });
    await open();
    expect(buttonIn(panel(), "Region").disabled).toBe(true);
    expect(panel().textContent).toContain(
      "Campaign changes are read-only for this session.",
    );

    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";

    mount({ draft: { editor_mode: "mjml" }, editorMode: "mjml" });
    await open();
    expect(buttonIn(panel(), "Region").disabled).toBe(true);
    expect(panel().textContent).toContain(
      "Switch the editor to HTML or plain text to insert one.",
    );
  });

  it("keeps reader quotes contained: the dialog explains and loads no reply", async () => {
    mount({});
    await open();
    await click(buttonIn(panel(), "Quote a reader reply"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Reader quotes require consent");
    expect(dialog?.textContent).toContain("No reply content or sender address is loaded");
    expect(
      mocks.get.mock.calls.some((call) => String(call[0]).includes("/replies")),
    ).toBe(false);
  });
});
