// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const networkMocks = vi.hoisted(() => ({
  sendCampaignTest: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  updateCampaign: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: networkMocks.whoamiFresh,
}));

vi.mock("@/lib/campaigns-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns-api")>()),
  sendCampaignTest: networkMocks.sendCampaignTest,
  updateCampaign: networkMocks.updateCampaign,
}));

vi.mock("sonner", () => ({
  toast: {
    error: networkMocks.toastError,
    success: networkMocks.toastSuccess,
  },
}));

import {
  buildCampaignUpdateInput,
  isValidCampaignEmail,
  useCampaignSaveWorkflow,
  validateCampaignContentLinks,
  validateReplyTo,
  validateTestRecipient,
} from "../app/(dashboard)/app/campaigns/[id]/use-campaign-save-workflow";
import type { Campaign } from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";

const baseCampaign: Campaign = {
  id: "campaign-1",
  tenant_id: "tenant-1",
  name: "Launch",
  subject: "Hello",
  status: "draft",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

const validCampaign: Campaign = {
  ...baseCampaign,
  body_html: '<p><a href="https://shop.example.test/launch">Launch</a></p>',
  delivery_settings: { from_email: "sender@example.test" },
};

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

type WorkflowProps = Parameters<typeof useCampaignSaveWorkflow>[0];

let latest: ReturnType<typeof useCampaignSaveWorkflow> | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  networkMocks.whoamiFresh.mockResolvedValue(IDENTITY);
  latest = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  queryClient?.clear();
  document.body.replaceChildren();
  latest = null;
  queryClient = null;
  root = null;
});

function Harness(props: WorkflowProps) {
  latest = useCampaignSaveWorkflow(props);
  return null;
}

function renderWorkflow(
  overrides: Partial<WorkflowProps> = {},
): (next: Partial<WorkflowProps>) => void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const props: WorkflowProps = {
    campaign: validCampaign,
    campaignKey: ["campaign", validCampaign.id],
    campaignsBaseKey: ["campaigns"],
    queryClient,
    setCampaign: vi.fn(),
    setDirty: vi.fn(),
    testEmail: "recipient@example.test",
    canWrite: true,
    openedIdentity: IDENTITY,
    ...overrides,
  };
  const paint = (next: Partial<WorkflowProps> = {}) => {
    Object.assign(props, next);
    act(() => root?.render(createElement(Harness, { ...props })));
  };
  paint();
  return paint;
}

function current(): ReturnType<typeof useCampaignSaveWorkflow> {
  if (!latest) throw new Error("Campaign workflow hook has not rendered.");
  return latest;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

describe("campaign save workflow helpers", () => {
  it("normalizes optional campaign fields for the update payload", () => {
    expect(buildCampaignUpdateInput(baseCampaign)).toEqual({
      name: "Launch",
      subject: "Hello",
      campaign_type: "regular",
      editor_mode: "html",
      preview_text: "",
      body_html: "",
      body_mjml: "",
      plain_text: "",
      from_name: "",
      reply_to: "",
      content_blocks: [],
      source_mode: "legacy_html",
      content_schema_version: 1,
      fact_contract: {},
      reusable_section_ids: [],
      variants: [],
      tracking_settings: {},
      delivery_settings: {},
      // Both audience halves are always present. An undefined value is
      // dropped by JSON.stringify, and PATCH reads a missing key as "leave
      // unchanged" — the previous expectation here (`segment_id: undefined`)
      // certified the bug that made "Everyone" impossible to save. The wire
      // body is proven in campaign-audience-save-roundtrip.test.ts.
      segment_id: "",
      list_id: "",
    });
  });

  it("preserves semantic nodes and Fact Contract without sending stale projections", () => {
    const nodes = [{ id: "title", type: "heading" }];
    const factContract = { schema_version: 1, primary_intent: "announce" };
    const payload = buildCampaignUpdateInput({
      ...baseCampaign,
      source_mode: "semantic",
      content_schema_version: 2,
      content_blocks: nodes,
      fact_contract: factContract,
      body_html: "<p>stale projection</p>",
      body_mjml: "<mjml>stale</mjml>",
      plain_text: "stale projection",
    });

    expect(payload).toMatchObject({
      source_mode: "semantic",
      content_schema_version: 2,
      content_blocks: nodes,
      fact_contract: factContract,
    });
    expect("body_html" in payload).toBe(false);
    expect("body_mjml" in payload).toBe(false);
    expect("plain_text" in payload).toBe(false);
  });

  it("never sends scheduled_at, which PATCH refuses outright", () => {
    // PATCH /api/v1/campaigns/{id} rejects any body carrying scheduled_at with
    // 422 `campaign_dispatch_state_owned`, and the guard tests for the KEY, not
    // its value — so an explicit null is refused exactly like a timestamp.
    // This payload included `scheduled_at: null` unconditionally, which meant
    // every save from the campaign editor failed, not only scheduling ones.
    //
    // The previous version of the test above asserted the null was present, so
    // it certified the bug rather than catching it.
    const payload = buildCampaignUpdateInput({
      ...baseCampaign,
      scheduled_at: "2026-09-01T09:00:00.000Z",
    });
    expect("scheduled_at" in payload).toBe(false);
  });

  it("validates reply-to and test recipient addresses before network calls", () => {
    expect(isValidCampaignEmail("qa@example.com")).toBe(true);
    expect(isValidCampaignEmail("not-an-email")).toBe(false);
    expect(validateReplyTo({ ...baseCampaign, reply_to: "bad" })).toBe(
      "Reply-to is not a valid email address.",
    );
    expect(
      validateReplyTo({ ...baseCampaign, reply_to: "ok@example.com" }),
    ).toBeNull();
    expect(validateTestRecipient("")).toBe("Test recipient is required.");
    expect(validateTestRecipient("bad")).toBe("Enter a valid email address.");
    expect(validateTestRecipient("ok@example.com")).toBeNull();
  });

  it("fails closed before persisting or dispatching placeholder and unsafe links", async () => {
    const placeholder = {
      ...baseCampaign,
      editor_mode: "blocks" as const,
      content_blocks: [
        { type: "button", label: "Buy", url: "https://example.com/buy" },
      ],
    };
    expect(await validateCampaignContentLinks(placeholder)).toContain(
      "still points to example.com",
    );

    expect(
      await validateCampaignContentLinks({
        ...baseCampaign,
        body_html: '<a href="java&#x73;cript:alert(1)">bad</a>',
      }),
    ).toContain("must be a safe absolute");
    expect(
      await validateCampaignContentLinks({
        ...baseCampaign,
        variants: [
          { body_html: '<a href="https://example.com/winner">Winner</a>' },
        ],
      }),
    ).toContain("Variant 1 HTML");
    expect(
      await validateCampaignContentLinks({
        ...baseCampaign,
        body_html:
          '<p><a href="https://shop.example.test/buy">Buy</a></p><a href="{{ unsubscribe_url }}">Leave</a>',
      }),
    ).toBeNull();
    expect(
      await validateCampaignContentLinks({
        ...baseCampaign,
        source_mode: "semantic",
        content_blocks: [
          {
            type: "action",
            content: {
              action: { canonical_url: "https://example.com/semantic" },
            },
          },
        ],
      }),
    ).toContain("Semantic source");
  });
});

describe("campaign save workflow network boundaries", () => {
  it("refuses a locally read-only invocation before freshness or campaign transport", async () => {
    renderWorkflow({ canWrite: false });

    await act(async () => {
      await expect(current().save()).resolves.toBe(false);
      await current().sendTest();
    });

    expect(networkMocks.whoamiFresh).not.toHaveBeenCalled();
    expect(networkMocks.updateCampaign).not.toHaveBeenCalled();
    expect(networkMocks.sendCampaignTest).not.toHaveBeenCalled();
  });

  it("fails closed when fresh authority no longer matches the opened editor", async () => {
    networkMocks.whoamiFresh.mockResolvedValue({
      ...IDENTITY,
      effective_role: "viewer",
      viewer_mode: true,
    });
    renderWorkflow();

    await act(async () => {
      await expect(current().save()).resolves.toBe(false);
    });

    expect(networkMocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(networkMocks.updateCampaign).not.toHaveBeenCalled();
    expect(networkMocks.sendCampaignTest).not.toHaveBeenCalled();
  });

  it("blocks invalid content before update or test-send network calls", async () => {
    renderWorkflow({
      campaign: {
        ...validCampaign,
        body_html: '<a href="java&#x73;cript:alert(1)">bad</a>',
      },
    });

    await act(async () => {
      expect(await current().save()).toBe(false);
      await current().sendTest();
    });

    expect(networkMocks.updateCampaign).not.toHaveBeenCalled();
    expect(networkMocks.sendCampaignTest).not.toHaveBeenCalled();
    expect(networkMocks.toastError).toHaveBeenCalledTimes(2);
  });

  it("regenerates the selected block source after returning from another editor", async () => {
    networkMocks.updateCampaign.mockResolvedValue(validCampaign);
    renderWorkflow({
      campaign: {
        ...validCampaign,
        editor_mode: "blocks",
        source_mode: "legacy_html",
        body_html: "<p>Stale plain-text projection</p>",
        content_blocks: [
          { type: "heading", content: "The selected block content" },
        ],
      },
    });
    await act(async () => {
      expect(await current().save()).toBe(true);
    });
    const payload = networkMocks.updateCampaign.mock.calls[0]?.[1];
    expect(payload.body_html).toContain("<h2>The selected block content</h2>");
    expect(payload.body_html).not.toContain("Stale plain-text projection");
    expect(payload.plain_text).toContain("The selected block content");
  });

  it("admits only one update for a same-tick save double click", async () => {
    const pending = deferred<Campaign>();
    networkMocks.updateCampaign.mockReturnValue(pending.promise);
    renderWorkflow();

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = current().save();
      duplicate = current().save();
    });
    await waitFor(() =>
      expect(networkMocks.updateCampaign).toHaveBeenCalledTimes(1),
    );
    expect(current().saving).toBe(true);

    await act(async () => {
      pending.resolve({ ...validCampaign, updated_at: "2026-01-03T00:00:00Z" });
      await expect(Promise.all([first, duplicate])).resolves.toEqual([
        true,
        false,
      ]);
      await flush();
    });
    expect(networkMocks.updateCampaign).toHaveBeenCalledTimes(1);
    expect(networkMocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(networkMocks.sendCampaignTest).not.toHaveBeenCalled();
    expect(current().saving).toBe(false);
  });

  it("admits only one persist and dispatch for a same-tick test-send double click", async () => {
    const pending = deferred<{
      accepted_at: string;
      message_id: string;
      to: string;
    }>();
    networkMocks.updateCampaign.mockResolvedValue(validCampaign);
    networkMocks.sendCampaignTest.mockReturnValue(pending.promise);
    renderWorkflow();

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = current().sendTest();
      duplicate = current().sendTest();
    });
    await waitFor(() =>
      expect(networkMocks.sendCampaignTest).toHaveBeenCalledTimes(1),
    );
    expect(networkMocks.updateCampaign).toHaveBeenCalledTimes(1);
    expect(networkMocks.sendCampaignTest).toHaveBeenCalledWith(
      validCampaign.id,
      "recipient@example.test",
    );

    await act(async () => {
      pending.resolve({
        accepted_at: "2026-01-03T00:00:00Z",
        message_id: "message-1",
        to: "recipient@example.test",
      });
      await Promise.all([first, duplicate]);
      await flush();
    });
    expect(networkMocks.updateCampaign).toHaveBeenCalledTimes(1);
    expect(networkMocks.sendCampaignTest).toHaveBeenCalledTimes(1);
    expect(networkMocks.whoamiFresh).toHaveBeenCalledTimes(2);
    expect(networkMocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
      networkMocks.updateCampaign.mock.invocationCallOrder[0]!,
    );
    expect(networkMocks.whoamiFresh.mock.invocationCallOrder[1]).toBeLessThan(
      networkMocks.sendCampaignTest.mock.invocationCallOrder[0]!,
    );
    expect(current().saving).toBe(false);
  });

  it("validates and persists one deep snapshot without overwriting newer edits", async () => {
    const submitted: Campaign = {
      ...validCampaign,
      content_blocks: [
        {
          type: "button",
          label: "Buy",
          url: "https://shop.example.test/buy",
        },
      ],
    };
    const pending = deferred<Campaign>();
    const setCampaign = vi.fn();
    const setDirty = vi.fn();
    networkMocks.updateCampaign.mockReturnValue(pending.promise);
    const rerender = renderWorkflow({
      campaign: submitted,
      setCampaign,
      setDirty,
    });

    let attempt!: Promise<boolean>;
    act(() => {
      attempt = current().save();
    });
    // Simulate an editor mutating a nested draft before the lazy validator
    // resolves. The submitted clone must remain the safe, original snapshot.
    submitted.content_blocks![0]!.url = "https://example.com/mutated";
    await waitFor(() =>
      expect(networkMocks.updateCampaign).toHaveBeenCalledTimes(1),
    );
    expect(networkMocks.updateCampaign.mock.calls[0]?.[1]).toMatchObject({
      content_blocks: [
        { type: "button", url: "https://shop.example.test/buy" },
      ],
    });

    rerender({ campaign: { ...submitted, subject: "Newer local edit" } });
    await act(async () => {
      pending.resolve({ ...validCampaign, updated_at: "2026-01-03T00:00:00Z" });
      await attempt;
      await flush();
    });
    expect(setCampaign).not.toHaveBeenCalled();
    expect(setDirty).not.toHaveBeenCalled();
  });
});
