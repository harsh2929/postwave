// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity rows audience-11/12/13 (inline row edits) and audience-53 (detail:
// enable only through the consent-evidence review).
//
// Every write is PATCH /api/v1/subscribers/{id} under If-Match with the row's
// exact revision; the assertions pin the path, the body and the header, and
// what the component then reports. "Subscribed" must never be a bare status
// PATCH — it always carries the full evidence envelope.
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
      async (
        _path: string,
        _body?: unknown,
        _opts?: { headers?: Record<string, string>; onResponse?: (r: Response) => void },
      ): Promise<unknown> => undefined,
    ),
    patch: vi.fn(
      async (
        _path: string,
        _body?: unknown,
        _opts?: { headers?: Record<string, string>; onResponse?: (r: Response) => void },
      ): Promise<unknown> => ({}),
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
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: vi.fn(),
    delete: vi.fn(),
  },
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

import { EditSubscriberDialog } from "@/app/(dashboard)/app/subscribers/[id]/_edit-dialog";
import { InlineEmailRename } from "@/components/subscribers/InlineEmailRename";
import { InlineStatusChange } from "@/components/subscribers/InlineStatusChange";
import { InlineTagChips } from "@/components/subscribers/InlineTagChips";
import type { Subscriber } from "@/lib/subscribers-api";

import {
  button,
  byAriaLabel,
  cleanup,
  click,
  etagResponse,
  field,
  flush,
  queryButton,
  render,
  topDialog,
  type,
} from "../helpers/subscriber-directory-harness";

const ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const V1 = `"subscriber:${ID}:v100"`;
const V2 = `"subscriber:${ID}:v200"`;
const V3 = `"subscriber:${ID}:v300"`;
const ME = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const AUTHORITY = { tenantId: ME.tenant_id, userId: ME.user_id, role: "owner" as const };

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id: ID,
    email: "ada@example.com",
    status: "unconfirmed",
    consent_timestamp: null,
    consent_source: "unknown",
    custom_fields: { plan: "pro", name: "Ada" },
    tags: ["vip", "beta"],
    version: V1,
    country: "GB",
    ...overrides,
  };
}

let nextVersion = V2;

beforeEach(() => {
  vi.clearAllMocks();
  nextVersion = V2;
  mocks.whoami.mockResolvedValue(ME);
  mocks.whoamiFresh.mockResolvedValue(ME);
  mocks.get.mockResolvedValue([]);
  mocks.patch.mockImplementation(async (_path, body, opts) => {
    opts?.onResponse?.(etagResponse(nextVersion));
    return { ...subscriber(), ...(body as object), version: nextVersion };
  });
  mocks.post.mockImplementation(async (_path, _body, opts) => {
    opts?.onResponse?.(etagResponse(V2));
    return undefined;
  });
});

afterEach(() => cleanup());

function lastPatch() {
  const call = mocks.patch.mock.calls.at(-1);
  if (!call) throw new Error("no PATCH was sent");
  return { path: call[0], body: call[1], headers: call[2]?.headers };
}

/** Fill the reviewed opt-in evidence envelope inside `scope`. */
function fillEvidence(scope: HTMLElement, email = "ada@example.com") {
  type(field("Opt-in record", scope), "double_optin");
  type(field("Captured via", scope), "email");
  type(field("Legal basis", scope), "consent");
  type(field("Captured at", scope), "2026-09-01T10:30");
  type(field("Jurisdiction", scope), "gb");
  type(field("Policy version", scope), " privacy-2026-06 ");
  type(field("Evidence reference", scope), " receipt:OPTIN-1 ");
  type(field("Reason", scope), " Confirmed via double opt-in email ");
  click(field(/^This proof applies to/, scope) as HTMLInputElement);
  type(field(`Type ${email} to confirm`, scope), email);
}

const EXPECTED_ENABLE_BODY = {
  status: "enabled",
  consent_source: "double_optin",
  consent_timestamp: new Date("2026-09-01T10:30").toISOString(),
  consent_channel: "email",
  consent_legal_basis: "consent",
  consent_jurisdiction: "GB",
  consent_evidence: "receipt:OPTIN-1",
  consent_reason: "Confirmed via double opt-in email",
  consent_policy_version: "privacy-2026-06",
};

describe("inline email rename (audience-11)", () => {
  it("renames under the row revision and undoes with the revision the rename returned", async () => {
    const onRenamed = vi.fn();
    render(createElement(InlineEmailRename, { subscriber: subscriber(), canWrite: true, onRenamed }));
    click(button("Rename email for ada@example.com"));
    type(field("New email for ada@example.com"), " Ada.New@Example.com ");
    expect(button("Save").disabled).toBe(true); // identity rotation not reviewed
    click(field(/^I reviewed this identity rotation/) as HTMLInputElement);
    click(button("Save"));
    await flush();

    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: { email: "ada.new@example.com" },
      headers: { "If-Match": V1 },
    });
    expect(onRenamed).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: "ada.new@example.com", version: V2 }),
    );
    const [message, options] = mocks.toast.success.mock.calls.at(-1) as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Renamed to ada.new@example.com.");
    expect(options.action.label).toBe("Undo");

    nextVersion = V3;
    options.action.onClick();
    await flush();
    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: { email: "ada@example.com" },
      headers: { "If-Match": V2 },
    });
    expect(onRenamed).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: "ada@example.com", version: V3 }),
    );
    expect(mocks.toast.info).toHaveBeenCalledWith("Reverted to ada@example.com.");
  });

  it("renders the server's conflict instead of pretending the rename happened", async () => {
    mocks.patch.mockRejectedValueOnce(new mocks.MockApiError("taken", 409, "email_taken"));
    const onRenamed = vi.fn();
    render(createElement(InlineEmailRename, { subscriber: subscriber(), canWrite: true, onRenamed }));
    click(button("Rename email for ada@example.com"));
    type(field("New email for ada@example.com"), "grace@example.com");
    click(field(/^I reviewed this identity rotation/) as HTMLInputElement);
    click(button("Save"));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Another subscriber already uses that address.",
    );
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("offers no rename to a role that cannot write", () => {
    render(
      createElement(InlineEmailRename, { subscriber: subscriber(), canWrite: false, onRenamed: vi.fn() }),
    );
    expect(queryButton("Rename email for ada@example.com")).toBeNull();
  });
});

describe("inline tag chips (audience-13)", () => {
  it("removes and adds tags by sending the row's whole intended tag set", async () => {
    const onChanged = vi.fn();
    render(createElement(InlineTagChips, { subscriber: subscriber(), canWrite: true, onChanged }));

    click(button("Remove tag vip from ada@example.com"));
    await flush();
    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: { tags: ["beta"] },
      headers: { "If-Match": V1 },
    });
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["beta"] }));

    click(button("Add a tag to ada@example.com"));
    type(field("New tag for ada@example.com"), "  gold ");
    click(button("Add"));
    await flush();
    expect(lastPatch().body).toEqual({ tags: ["vip", "beta", "gold"] });
    expect(mocks.toast.success).toHaveBeenLastCalledWith("Tagged ada@example.com “gold”.");
  });

  it("does not send a duplicate tag", async () => {
    render(
      createElement(InlineTagChips, { subscriber: subscriber(), canWrite: true, onChanged: vi.fn() }),
    );
    click(button("Add a tag to ada@example.com"));
    type(field("New tag for ada@example.com"), "VIP");
    click(button("Add"));
    await flush();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith("ada@example.com already has “VIP”.");
  });

  it("shows tags read-only to a role that cannot write", () => {
    render(
      createElement(InlineTagChips, { subscriber: subscriber(), canWrite: false, onChanged: vi.fn() }),
    );
    expect(document.body.textContent).toContain("vip");
    expect(queryButton("Remove tag vip from ada@example.com")).toBeNull();
    expect(queryButton("Add a tag to ada@example.com")).toBeNull();
  });
});

describe("inline status change (audience-12)", () => {
  function mountStatus(sub = subscriber()) {
    const onChanged = vi.fn();
    render(
      createElement(InlineStatusChange, {
        subscriber: sub,
        canWrite: true,
        authority: AUTHORITY,
        onChanged,
      }),
    );
    return onChanged;
  }

  it("sends a versioned status PATCH for Disabled after re-reading the session", async () => {
    const onChanged = mountStatus();
    type(byAriaLabel<HTMLSelectElement>("Status for ada@example.com"), "disabled");
    await flush();
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: { status: "disabled" },
      headers: { "If-Match": V1 },
    });
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "disabled" }));
  });

  it("never enables with a bare PATCH: Subscribed opens the evidence review", async () => {
    const onChanged = mountStatus();
    type(byAriaLabel<HTMLSelectElement>("Status for ada@example.com"), "enabled");
    await flush();
    expect(mocks.patch).not.toHaveBeenCalled();
    const review = topDialog();
    expect(review.textContent).toContain("Review consent & confirm");
    const submit = button("Record evidence & confirm", review);
    expect(submit.disabled).toBe(true);

    fillEvidence(review, "ada@example.com");
    type(field("Type ada@example.com to confirm", review), "ADA@example.com");
    expect(button("Record evidence & confirm", review).disabled).toBe(true);
    type(field("Type ada@example.com to confirm", review), "ada@example.com");
    click(button("Record evidence & confirm", review));
    await flush();

    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: EXPECTED_ENABLE_BODY,
      headers: { "If-Match": V1 },
    });
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "enabled" }));
    expect(mocks.toast.success).toHaveBeenCalledWith("ada@example.com is now subscribed.");
  });

  it("unsubscribes through the canonical suppress path only after a confirm naming the consequence", async () => {
    const onChanged = mountStatus(subscriber({ status: "enabled" }));
    type(byAriaLabel<HTMLSelectElement>("Status for ada@example.com"), "blocklisted");
    await flush();
    const confirm = topDialog();
    expect(confirm.textContent).toContain("Unsubscribe ada@example.com?");
    expect(confirm.textContent).toContain("Only a workspace admin can lift a suppression");
    expect(mocks.post).not.toHaveBeenCalled();
    click(button("Unsubscribe", confirm));
    await flush();
    const call = mocks.post.mock.calls.at(-1);
    expect(call?.[0]).toBe(`/api/v1/subscribers/${ID}/suppress`);
    expect(call?.[2]?.headers).toEqual({ "If-Match": V1 });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "blocklisted" }));
  });

  it("shows a read-only status to a role that cannot write", () => {
    render(
      createElement(InlineStatusChange, {
        subscriber: subscriber({ status: "enabled" }),
        canWrite: false,
        onChanged: vi.fn(),
      }),
    );
    expect(document.querySelector("select")).toBeNull();
    expect(document.body.textContent).toBe("Subscribed");
  });
});

describe("detail edit dialog: enable only through evidence review (audience-53)", () => {
  function mountEdit(sub = subscriber()) {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(
      createElement(EditSubscriberDialog, {
        open: true,
        onOpenChange,
        subscriber: sub,
        authority: AUTHORITY,
        onSaved,
      }),
    );
    return { onSaved, onOpenChange };
  }

  it("records the evidence envelope and hands the enabled profile back to the page", async () => {
    const { onSaved, onOpenChange } = mountEdit();
    await flush();
    const status = field("Status") as HTMLSelectElement;
    expect([...status.options].map((option) => option.value)).not.toContain("enabled");

    click(button("Review consent & confirm"));
    await flush();
    const review = topDialog();
    fillEvidence(review);
    click(button("Record evidence & confirm", review));
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(lastPatch()).toEqual({
      path: `/api/v1/subscribers/${ID}`,
      body: EXPECTED_ENABLE_BODY,
      headers: { "If-Match": V1 },
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ status: "enabled", version: V2 }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("withholds the review while other edits are unsaved, with the reason", async () => {
    mountEdit();
    await flush();
    type(field("First name"), "Ada");
    const review = button("Review consent & confirm");
    expect(review.disabled).toBe(true);
    expect(document.body.textContent).toContain("Save or discard the other edits first.");
  });

  it("offers no enable review for a subscriber that is already subscribed or archived", async () => {
    mountEdit(subscriber({ status: "enabled" }));
    await flush();
    expect(queryButton(/^Review consent/)).toBeNull();
    cleanup();
    mountEdit(subscriber({ status: "disabled", archived_at: "2026-09-01T00:00:00Z" }));
    await flush();
    expect(queryButton(/^Review consent/)).toBeNull();
  });
});
