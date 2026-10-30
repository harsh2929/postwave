// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity rows audience-25 (bulk resubscribe with evidence), audience-27/28
// (bulk custom-field / merge-field value) and audience-19 (add one subscriber
// with a typo suggestion and deliverability check).
//
// The bulk field verbs are pinned to the one-key endpoints: their body must
// carry exactly {subscriber_ids, key, value} — never a `custom_fields` or
// `merge_fields` map, which the profile PATCH treats as a FULL REPLACE.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code = `http_${status}`,
    ) {
      super(message);
    }
  }
  return {
    MockApiError,
    get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => []),
    post: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    whoami: vi.fn(),
    whoamiFresh: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      message: vi.fn(),
    },
  };
});

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post, patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: mocks.MockApiError,
  isApiError: (error: unknown) => error instanceof mocks.MockApiError,
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { AddSubscriberDialog } from "@/components/subscribers/AddSubscriberDialog";
import { BulkFieldValueDialog } from "@/components/subscribers/BulkFieldValueDialog";
import { BulkResubscribeDialog } from "@/components/subscribers/BulkResubscribeDialog";
import type { Subscriber } from "@/lib/subscribers-api";

import {
  button,
  cleanup,
  click,
  field,
  flush,
  render,
  topDialog,
  type,
} from "../helpers/subscriber-directory-harness";

const ME = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const AUTHORITY = { tenantId: ME.tenant_id, userId: ME.user_id, role: "owner" as const };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function row(id: string | undefined, status: Subscriber["status"]): Subscriber {
  return {
    id,
    email: `${id ?? "draft"}@example.com`,
    status,
    consent_timestamp: null,
    consent_source: "unknown",
    custom_fields: {},
    tags: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(ME);
  mocks.whoamiFresh.mockResolvedValue(ME);
  mocks.get.mockImplementation(async (path) => {
    if (path === "/api/v1/custom-fields")
      return [
        { id: "cf1", tenant_id: ME.tenant_id, key: "ltv", label: "Lifetime value", type: "number" },
        { id: "cf2", tenant_id: ME.tenant_id, key: "vip", label: "VIP", type: "boolean" },
        { id: "cf3", tenant_id: ME.tenant_id, key: "tier", label: "Tier", type: "enum", config: { options: ["gold", "silver"] } },
      ];
    throw new mocks.MockApiError(`unexpected GET ${String(path)}`, 404);
  });
});

afterEach(() => cleanup());

describe("bulk resubscribe with evidence (audience-25)", () => {
  const rows = [row(A, "blocklisted"), row(B, "blocklisted"), row(C, "enabled"), row(D, "disabled"), row(undefined, "blocklisted")];

  function fillProvenance(scope: HTMLElement) {
    type(field("Evidence source", scope), "preference_center");
    type(field("Captured via", scope), "web");
    type(field("Legal basis", scope), "consent");
    type(field("Captured at", scope), "2026-09-02T09:15");
    type(field("Jurisdiction", scope), "eu");
    type(field("Policy version", scope), "privacy-2026-06");
    type(field("Evidence reference", scope), "receipt:REOPTIN-9");
    type(field("Reason", scope), "Re-opted in through the preference center");
  }

  it("sends only the locally eligible rows with the full evidence envelope", async () => {
    mocks.post.mockResolvedValue({
      affected: 1,
      skipped: 1,
      source: "explicit_ids",
      exclusions: { protected_suppression: 1 },
    });
    const onDone = vi.fn();
    render(createElement(BulkResubscribeDialog, { rows, canAdmin: true, authority: AUTHORITY, onDone }));
    click(button("Re-subscribe…"));
    await flush();
    const dialog = topDialog();
    expect(dialog.textContent).toContain("Re-subscribe 2 subscribers");
    expect(dialog.textContent).toContain(
      "Left out of this request: 1 already subscribed, 1 disabled or unconfirmed (use Review consent & enable on each), 1 not yet saved.",
    );

    fillProvenance(dialog);
    click(field(/^This evidence covers each of the 2/, dialog) as HTMLInputElement);
    type(field("Type RESUBSCRIBE 2 to confirm", dialog), "RESUBSCRIBE 3");
    expect(button("Re-subscribe 2", dialog).disabled).toBe(true);
    type(field("Type RESUBSCRIBE 2 to confirm", dialog), "RESUBSCRIBE 2");
    click(button("Re-subscribe 2", dialog));
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/subscribers/bulk/resubscribe",
      {
        subscriber_ids: [A, B],
        source: "preference_center",
        channel: "web",
        legal_basis: "consent",
        occurred_at: new Date("2026-09-02T09:15").toISOString(),
        jurisdiction: "EU",
        evidence: "receipt:REOPTIN-9",
        reason: "Re-opted in through the preference center",
        policy_version: "privacy-2026-06",
      },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
    expect(dialog.textContent).toContain(
      "Resubscribed 1. The server skipped 1: 1 held by a protected suppression.",
    );
    expect(onDone).toHaveBeenCalledWith({
      affected: 1,
      skipped: 1,
      exclusions: { protected_suppression: 1 },
    });
  });

  it("refuses to submit without evidence", async () => {
    render(createElement(BulkResubscribeDialog, { rows, canAdmin: true }));
    click(button("Re-subscribe…"));
    await flush();
    const dialog = topDialog();
    click(field(/^This evidence covers each/, dialog) as HTMLInputElement);
    type(field("Type RESUBSCRIBE 2 to confirm", dialog), "RESUBSCRIBE 2");
    expect(button("Re-subscribe 2", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("Select where the evidence came from.");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("is withheld from non-admins and from an all-matching selection, with the reason", () => {
    render(createElement(BulkResubscribeDialog, { rows, canAdmin: false }));
    const trigger = button("Re-subscribe…");
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("Only an owner or admin can resubscribe in bulk.");
    cleanup();
    render(createElement(BulkResubscribeDialog, { rows, canAdmin: true, allMatchingSelected: true }));
    expect(button("Re-subscribe…").title).toContain("resubscribe does not run against every match");
  });
});

describe("bulk field value (audience-27, audience-28)", () => {
  it("sets one typed custom-field key after a confirm that names the overwrite", async () => {
    mocks.post.mockResolvedValue({ affected: 3, source: "explicit_ids" });
    const resolveIds = vi.fn(async () => [A, B, C]);
    const onDone = vi.fn();
    render(
      createElement(BulkFieldValueDialog, {
        mode: "custom",
        count: 3,
        resolveIds,
        canAdmin: true,
        authority: AUTHORITY,
        onDone,
      }),
    );
    click(button("Custom field…"));
    await flush();
    const dialog = topDialog();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/custom-fields", {
      signal: expect.any(AbortSignal),
    });
    type(field("Field", dialog), "ltv");
    type(field("Value", dialog), "abc");
    expect(button("Review", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("Enter a number.");
    type(field("Value", dialog), " 1250.5 ");
    click(button("Review", dialog));
    await flush();

    const confirm = topDialog();
    expect(confirm.textContent).toContain("Set Lifetime value on 3 subscribers?");
    expect(confirm.textContent).toContain(
      "Each subscriber's Lifetime value becomes “1250.5”, overwriting any value it has now. This cannot be undone in bulk. Other fields are not changed.",
    );
    expect(mocks.post).not.toHaveBeenCalled();
    click(button("Set on 3 subscribers", confirm));
    await flush();

    expect(resolveIds).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body] = mocks.post.mock.calls[0];
    expect(path).toBe("/api/v1/subscribers/bulk/set-custom-field");
    expect(body).toEqual({ subscriber_ids: [A, B, C], key: "ltv", value: 1250.5 });
    expect(Object.keys(body as object)).not.toContain("custom_fields");
    expect(onDone).toHaveBeenCalledWith({ affected: 3, skipped: 0, exclusions: {} });
    expect(mocks.toast.success).toHaveBeenCalledWith("Set Lifetime value on 3 subscribers.");
  });

  it("stores a boolean field as a JSON boolean", async () => {
    mocks.post.mockResolvedValue({ affected: 1, source: "explicit_ids" });
    render(
      createElement(BulkFieldValueDialog, {
        mode: "custom",
        count: 1,
        resolveIds: async () => [A],
        canAdmin: true,
      }),
    );
    click(button("Custom field…"));
    await flush();
    const dialog = topDialog();
    type(field("Field", dialog), "vip");
    type(field("Value", dialog), "false");
    click(button("Review", dialog));
    await flush();
    click(button("Set on 1 subscriber", topDialog()));
    await flush();
    expect(mocks.post.mock.calls[0][1]).toEqual({ subscriber_ids: [A], key: "vip", value: false });
  });

  it("sets one merge-field key through the merge-field endpoint", async () => {
    mocks.post.mockResolvedValue({ affected: 2, source: "explicit_ids" });
    render(
      createElement(BulkFieldValueDialog, {
        mode: "merge",
        count: 2,
        resolveIds: async () => [A, B],
        canAdmin: true,
      }),
    );
    click(button("Merge field…"));
    await flush();
    const dialog = topDialog();
    const select = field("Field", dialog) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "FNAME",
      "LNAME",
      "COMPANY",
      "ADDRESS",
      "PHONE",
      "ZIP",
      "CITY",
      "STATE",
      "COUNTRY",
    ]);
    type(select, "COMPANY");
    type(field("Value", dialog), " Acme Ltd ");
    click(button("Review", dialog));
    await flush();
    click(button("Set on 2 subscribers", topDialog()));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/subscribers/bulk/update-merge-field",
      { subscriber_ids: [A, B], key: "COMPANY", value: "Acme Ltd" },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
  });

  it("is withheld from non-admins with the reason", () => {
    render(
      createElement(BulkFieldValueDialog, {
        mode: "custom",
        count: 3,
        resolveIds: async () => [A],
        canAdmin: false,
      }),
    );
    const trigger = button("Custom field…");
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("Only an owner or admin can change fields in bulk.");
  });
});

describe("add subscriber with typo suggestion (audience-19)", () => {
  function mountAdd() {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      createElement(AddSubscriberDialog, {
        open: true,
        onOpenChange,
        canWrite: true,
        authority: AUTHORITY,
        onCreated,
      }),
    );
    return { onCreated, onOpenChange };
  }

  function verdict(email: string, valid = true, verdictCode = "ok") {
    return {
      email,
      valid,
      verdict: verdictCode,
      domain: email.split("@")[1],
      has_mx: valid,
      disposable: false,
      role_account: false,
      reasons: [],
    };
  }

  it("offers a click-to-apply suggestion for a domain typo, then re-checks the fixed address", async () => {
    mocks.post.mockImplementation(async (path, body) => {
      if (path === "/api/v1/email-validation/check")
        return verdict((body as { email: string }).email, false, "no_mx");
      if (path === "/api/v1/subscribers")
        return { id: A, email: "ada@gmail.com", status: "unconfirmed", tags: ["vip"] };
      throw new Error(`unexpected POST ${path}`);
    });
    const { onCreated, onOpenChange } = mountAdd();
    const email = field("Email") as HTMLInputElement;
    type(email, "ada@gmial.com");
    email.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush();

    expect(mocks.post).toHaveBeenCalledWith("/api/v1/email-validation/check", {
      email: "ada@gmial.com",
    });
    const suggestion = button("Replace the typed address with suggested address ada@gmail.com");
    expect(suggestion.textContent).toBe("Did you mean ada@gmail.com?");
    expect(email.value).toBe("ada@gmial.com"); // never applied on its own
    expect(button("Add subscriber").disabled).toBe(true); // undeliverable, not reviewed

    mocks.post.mockImplementation(async (path, body) => {
      if (path === "/api/v1/email-validation/check")
        return verdict((body as { email: string }).email);
      if (path === "/api/v1/subscribers")
        return { id: A, email: "ada@gmail.com", status: "unconfirmed", tags: ["vip"] };
      throw new Error(`unexpected POST ${path}`);
    });
    click(suggestion);
    await flush();
    expect(email.value).toBe("ada@gmail.com");
    expect(mocks.post).toHaveBeenLastCalledWith("/api/v1/email-validation/check", {
      email: "ada@gmail.com",
    });

    type(field("Tags (comma-separated)"), "vip, ,vip");
    click(button("Add subscriber"));
    await flush();
    expect(mocks.post).toHaveBeenLastCalledWith(
      "/api/v1/subscribers",
      { email: "ada@gmail.com", tags: ["vip"], status: "unconfirmed" },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: A }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires an explicit review before adding an undeliverable address", async () => {
    mocks.post.mockImplementation(async (path, body) => {
      if (path === "/api/v1/email-validation/check")
        return verdict((body as { email: string }).email, false, "no_mx");
      return { id: A, email: "ops@nomx.example", status: "unconfirmed", tags: [] };
    });
    mountAdd();
    const email = field("Email") as HTMLInputElement;
    type(email, "ops@nomx.example");
    email.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush();
    expect(document.body.textContent).toContain("This domain does not accept mail (no MX record).");
    expect(button("Add subscriber").disabled).toBe(true);
    click(field(/^I reviewed this warning/) as HTMLInputElement);
    expect(button("Add subscriber").disabled).toBe(false);
  });

  it("adds a Subscribed contact only with the evidence envelope and a country", async () => {
    mocks.post.mockImplementation(async (path, body) => {
      if (path === "/api/v1/email-validation/check")
        return verdict((body as { email: string }).email);
      return { id: A, email: "grace@example.com", status: "enabled", tags: [] };
    });
    mountAdd();
    type(field("Email"), "Grace@Example.com");
    type(field("Initial eligibility"), "enabled");
    const dialog = topDialog();
    type(field("Opt-in record", dialog), "single_optin");
    type(field("Captured via", dialog), "web");
    type(field("Legal basis", dialog), "consent");
    type(field("Captured at", dialog), "2026-09-03T08:00");
    type(field("Jurisdiction", dialog), "US-CA");
    type(field("Policy version", dialog), "privacy-2026-06");
    type(field("Evidence reference", dialog), "form:SIGNUP-77");
    type(field("Reason", dialog), "Signed up on the pricing page");
    click(field(/^This proof applies to/, dialog) as HTMLInputElement);
    type(field("Type grace@example.com to confirm", dialog), "grace@example.com");
    expect(button("Add subscriber").disabled).toBe(true);
    expect(dialog.textContent).toContain(
      "Use the subscriber's two-letter country code as the jurisdiction.",
    );
    type(field("Jurisdiction", dialog), "us");
    click(button("Add subscriber"));
    await flush();
    expect(mocks.post).toHaveBeenLastCalledWith(
      "/api/v1/subscribers",
      {
        email: "grace@example.com",
        tags: [],
        status: "enabled",
        consent_source: "single_optin",
        consent_timestamp: new Date("2026-09-03T08:00").toISOString(),
        consent_channel: "web",
        consent_legal_basis: "consent",
        consent_evidence: "form:SIGNUP-77",
        consent_reason: "Signed up on the pricing page",
        consent_policy_version: "privacy-2026-06",
        country: "US",
      },
      expect.objectContaining({ maxAttempts: 1 }),
    );
  });
});
