// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiiFindingsClient } from "@/app/(dashboard)/app/pii-findings/pii-findings-client";
import type {
  PiiFinding,
  PiiReviewInput,
  PiiScanConfig,
} from "@/lib/pii-findings-api";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  list: vi.fn(),
  listSubscriber: vi.fn(),
  review: vi.fn(),
  setEnabled: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami };
});
vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/pii-findings-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/pii-findings-api")>();
  return {
    ...actual,
    getPiiScanConfig: mocks.getConfig,
    listPiiFindings: mocks.list,
    listSubscriberPiiFindings: mocks.listSubscriber,
    reviewPiiFinding: mocks.review,
    setPiiScanEnabled: mocks.setEnabled,
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FINDING_ID = "00000000-0000-4000-8000-000000000101";
const SUBSCRIBER_ID = "00000000-0000-4000-8000-000000000201";
const ACTOR_ID = "00000000-0000-4000-8000-000000000301";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000401";
const FINGERPRINT = "a".repeat(64);
const metadata = {
  scanner_name: "postwave-shadow-pii",
  scanner_version: "2.0.0",
  detector_name: "regex-heuristic",
  detector_version: "2.0.0",
  policy_name: "undeclared-pii-review",
  policy_version: "sub-071-v2",
} as const;

function pendingFinding(): PiiFinding {
  return {
    id: FINDING_ID,
    subscriber_id: SUBSCRIBER_ID,
    field_name: "crm_notes",
    detected_type: "ssn",
    confidence: 0.98,
    fingerprint: FINGERPRINT,
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "active-v1",
    status: "pending",
    ...metadata,
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:01:00Z",
  };
}

function reviewedFinding(input: PiiReviewInput): PiiFinding {
  return {
    ...pendingFinding(),
    status: "reviewed",
    reviewed_at: "2026-08-29T10:02:00Z",
    reviewed_by: `user:${ACTOR_ID}`,
    updated_at: "2026-08-29T10:02:00Z",
    review_receipt: {
      receipt_id: RECEIPT_ID,
      status: "reviewed",
      reason: input.reason,
      comment: input.comment,
      evidence_reference: input.evidence_reference,
      reviewed_at: "2026-08-29T10:02:00Z",
      actor_type: "user",
      actor_id: ACTOR_ID,
      ...metadata,
      fingerprint: FINGERPRINT,
      fingerprint_scheme: "hmac-sha256-v1",
      fingerprint_key_version: "active-v1",
      finding_updated_at: input.expected_updated_at,
    },
  };
}

function config(): PiiScanConfig {
  return {
    available: true,
    scan_enabled: true,
    status: "enabled_caught_up",
    execution_mode: "transactional_revision_outbox",
    scheduled_scans_available: false,
    ...metadata,
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "active-v1",
    reliability: "at_least_once_with_dlq",
    coverage: "current_snapshot_covered",
    coverage_limitations: [
      "current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
      "retained_attribute_history_notes_and_event_content_not_scanned",
      "bounded_detector_truncation_requires_operator_repair",
    ],
    max_scan_fields: 500,
    max_scan_field_bytes: 65_536,
    max_scan_subscriber_bytes: 4_194_304,
    max_detections_per_field: 50,
    max_detections_per_subscriber: 200,
    coverage_evidence: {
      generation: 7,
      status: "caught_up",
      snapshot_exact: true,
      total_subscribers: 1,
      covered_subscribers: 1,
      pending_subscribers: 0,
      retrying_subscribers: 0,
      dead_letter_subscribers: 0,
      truncated_subscribers: 0,
      missing_state_subscribers: 0,
      coalesced_revisions: 2,
    },
    updated_at: "2026-08-29T10:03:00Z",
  };
}

function render(ui: ReactNode): { client: QueryClient; root: Root } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { client, root };
}

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const target = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(target instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return target;
}

function fieldByLabel(
  text: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const target =
    label instanceof HTMLLabelElement
      ? document.getElementById(label.htmlFor)
      : null;
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement) &&
    !(target instanceof HTMLSelectElement)
  ) {
    throw new Error(`Field not found: ${text}`);
  }
  return target;
}

function change(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue({
    user_id: ACTOR_ID,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Privacy workspace",
    workspace_slug: "privacy-workspace",
  });
  mocks.getConfig.mockResolvedValue(config());
  mocks.list.mockResolvedValue({
    items: [pendingFinding()],
    total: 1,
    page: 1,
    per_page: 25,
  });
  mocks.listSubscriber.mockResolvedValue({
    items: [pendingFinding()],
    total: 1,
    page: 1,
    per_page: 20,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Shadow-PII findings page", () => {
  it("does not expose an enabled no-op refresh before identity resolves", () => {
    mocks.whoami.mockReturnValue(new Promise(() => undefined));
    const { root } = render(<PiiFindingsClient />);
    try {
      expect(document.body.textContent).toContain(
        "Verifying administrator access",
      );
      expect(
        [...document.querySelectorAll("button")].some((candidate) =>
          candidate.textContent?.includes(
            "Refresh PII findings and scanner configuration",
          ),
        ),
      ).toBe(false);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.getConfig).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not request sensitive data when the effective role is not admin", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: ACTOR_ID,
      tenant_id: "00000000-0000-4000-8000-000000000001",
      email: "viewer@example.test",
      role: "viewer",
      effective_role: "viewer",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Privacy workspace",
      workspace_slug: "privacy-workspace",
    });
    const { root } = render(<PiiFindingsClient />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Admin access required"),
      );
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.getConfig).not.toHaveBeenCalled();
      expect(mocks.listSubscriber).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders failed reads as unknown and provides an explicit retry", async () => {
    mocks.list.mockRejectedValue(new Error("transport unavailable"));
    const { root } = render(<PiiFindingsClient />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Could not verify scanner state",
        ),
      );
      expect(document.body.textContent).not.toContain(
        "No findings match these filters",
      );
      await act(async () => button("Retry queue").click());
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads subscriber detail, blocks PII-shaped comments, and records a verified receipt", async () => {
    mocks.review.mockImplementation(
      async (_id: string, input: PiiReviewInput) => reviewedFinding(input),
    );
    const { client, root } = render(<PiiFindingsClient />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    try {
      await waitFor(() => expect(button("Inspect")).toBeDefined());
      await act(async () => button("Inspect").click());
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(mocks.listSubscriber).toHaveBeenCalled();
      });
      expect(document.body.textContent).toContain(
        "The matched subscriber value is never returned or displayed",
      );

      await act(async () => button("Record reviewed").click());
      await act(async () => {
        change(fieldByLabel("Reason"), "confirmed_pii");
        change(fieldByLabel("Decision comment"), "Confirmed jane@example.test");
        change(fieldByLabel("Evidence reference"), "ticket:DPO-123");
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Remove personal-data-shaped values",
        ),
      );
      expect(button("Record reviewed").disabled).toBe(false);
      await act(async () => button("Record reviewed").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain("Decision is incomplete"),
      );
      expect(mocks.review).not.toHaveBeenCalled();

      await act(async () => {
        change(
          fieldByLabel("Decision comment"),
          "Verified in the privacy case and assigned remediation ownership.",
        );
      });
      await waitFor(() =>
        expect(button("Record reviewed").disabled).toBe(false),
      );
      await act(async () => button("Record reviewed").click());

      await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
      expect(mocks.review).toHaveBeenCalledWith(
        FINDING_ID,
        expect.objectContaining({
          status: "reviewed",
          reason: "confirmed_pii",
          evidence_reference: "ticket:DPO-123",
          expected_updated_at: "2026-08-29T10:01:00Z",
        }),
        expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
      );
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Immutable decision receipt",
        ),
      );
      expect(document.body.textContent).toContain(RECEIPT_ID);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [
          "pii-admin",
          "00000000-0000-4000-8000-000000000001",
          ACTOR_ID,
          "owner",
          "durable-mode",
        ],
        exact: false,
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [
          "pii-admin",
          "00000000-0000-4000-8000-000000000001",
          ACTOR_ID,
          "owner",
          "durable-mode",
          "subscriber-findings",
          SUBSCRIBER_ID,
        ],
        exact: false,
      });
    } finally {
      act(() => root.unmount());
    }
  });
});
