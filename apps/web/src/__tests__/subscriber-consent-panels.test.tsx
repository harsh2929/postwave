// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The subscriber detail's consent + preference verbs (desktop parity rows
// audience-61/65/72/52/66). Each test drives a real render and asserts the
// CONSEQUENCE: the request's method + path + body + If-Match, the copy on
// the confirm that guards an irreversible decision, and what the panel then
// renders — or, for a withheld verb, that no request was made and the reason
// shown is the server's own sentence.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoamiFresh,
    whoamiFresh: mocks.whoamiFresh,
  };
});
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

import { ConsentPanel } from "@/app/(dashboard)/app/subscribers/[id]/_profile-panels";
import { FrequencyPreferencePanel } from "@/app/(dashboard)/app/subscribers/[id]/_frequency-panel";
import {
  GppSectionsPanel,
  JurisdictionReconfirmPanel,
  TrackingConsentPanel,
} from "@/app/(dashboard)/app/subscribers/[id]/_consent-panels";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = "11111111-1111-4111-8111-111111111111";
const tenantId = "tnt_1";
const version = `"subscriber:${id}:v4"`;
const freshVersion = `"subscriber:${id}:v5"`;
const now = "2026-09-05T08:00:00Z";
const authority: SubscriberAuthority = {
  tenantId,
  userId: "usr_1",
  role: "admin",
};

function emitEtag(options: unknown, etag: string): void {
  const onResponse = (options as { onResponse?: (response: Response) => void })
    ?.onResponse;
  onResponse?.(new Response(null, { headers: { ETag: etag } }));
}

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id,
    email: "ada@example.com",
    status: "enabled",
    consent_timestamp: now,
    consent_source: "double_optin",
    custom_fields: {},
    tags: [],
    version,
    ...overrides,
  } as Subscriber;
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
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

function buttons(text: string, scope: ParentNode = document): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button")).filter(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.includes(text) === true,
  );
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = buttons(text, scope)[0];
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function byAriaLabel(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Button aria-label="${label}" not found`);
  return found;
}

function dialog(): HTMLElement {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const top = dialogs[dialogs.length - 1];
  if (!top) throw new Error("No open dialog");
  return top;
}

function change(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function field<T extends Element>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`Field ${selector} not found`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoamiFresh.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: tenantId,
    email: "operator@example.com",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
});

/* ------------------------- audience-61: channel consent ------------------- */

function emailConsent(status: "opted_in" | "opted_out", subscriberVersion: string) {
  return {
    id: "consent-1",
    subscriber_id: id,
    channel: "email",
    status,
    consent_source: "double_optin",
    consent_timestamp: now,
    frequency_cap_until: null,
    email: "ada@example.com",
    created_at: now,
    updated_at: now,
    subscriber_version: subscriberVersion,
  };
}

/** The text of one channel's row, so an assertion about Email cannot be
 * satisfied (or spoiled) by the four read-only channels beside it. */
function channelRowText(label: string): string {
  const row = Array.from(document.querySelectorAll("li")).find(
    (li) =>
      li.querySelector("div.text-sm.font-medium")?.textContent?.trim() === label,
  );
  if (!row) throw new Error(`No consent row for "${label}"`);
  return row.textContent ?? "";
}

describe("ConsentPanel — per-channel consent (audience-61)", () => {
  function primeList(status: "opted_in" | "opted_out" = "opted_in") {
    mocks.get.mockImplementation(async (path: string, options) => {
      if (path.endsWith("/channel-consents")) {
        emitEtag(options, version);
        return { items: [emailConsent(status, version)], subscriber_version: version };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  }

  function renderPanel(auth: SubscriberAuthority | null = authority) {
    return render(
      createElement(ConsentPanel, {
        id,
        enabled: true,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
        country: "gb",
        onAggregateChanged: vi.fn(),
      }),
    );
  }

  it("renders all five channels and withholds non-email writes with the server's sentence", async () => {
    primeList();
    renderPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Granted");
    });
    for (const label of ["Email", "SMS", "Push", "WhatsApp", "RCS"]) {
      expect(document.body.textContent).toContain(label);
    }
    const sms = byAriaLabel("SMS consent is read-only");
    expect(sms.disabled).toBe(true);
    const reason = document.getElementById(sms.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(
      "sms consent cannot be mutated until its canonical delivery store is connected; frequency-cap-only edits remain available",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("revokes email consent only after a confirm that names the consequence, under If-Match", async () => {
    primeList("opted_in");
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return emailConsent("opted_out", freshVersion);
    });
    renderPanel();
    await waitFor(() => byAriaLabel("Revoke Email consent"));
    await click(byAriaLabel("Revoke Email consent"));
    await waitFor(() => {
      expect(dialog().textContent).toContain("Revoke Email consent");
    });
    const form = dialog();
    change(field(form, 'textarea[id$="-evidence"]'), "Ticket SUP-4410, signed opt-out letter");
    change(field(form, 'textarea[id$="-reason"]'), "Subscriber asked in writing to stop all email");
    change(field(form, 'input[id$="-policy"]'), "privacy-2026-09");
    await click(field<HTMLInputElement>(form, 'input[type="checkbox"]'));

    // Nothing has been sent yet; the revoke is guarded by a confirm.
    await click(button("Record revocation", form));
    await waitFor(() => {
      expect(dialog().textContent).toContain("Revoke email consent?");
    });
    const confirm = dialog();
    expect(confirm.textContent).toContain("stops marketing email immediately");
    expect(confirm.textContent).toContain("cannot be undone");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(button("Revoke consent", confirm));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/channel-consents/email`,
      expect.objectContaining({
        status: "opted_out",
        consent_source: "direct_request",
        evidence_channel: "api",
        legal_basis: "consent",
        evidence: "Ticket SUP-4410, signed opt-out letter",
        reason: "Subscriber asked in writing to stop all email",
        policy_version: "privacy-2026-09",
        jurisdiction: "GB",
      }),
      expect.objectContaining({
        headers: { "If-Match": version },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Email consent revoked.");
    });
  });

  // A hosted double opt-in signup that has not been confirmed yet. The server
  // now records it as pending; the tab has to say what is being waited for
  // instead of reading like nothing was ever asked.
  it("says a pending consent is awaiting confirmation, not that none is recorded", async () => {
    mocks.get.mockImplementation(async (path: string, options) => {
      if (!path.endsWith("/channel-consents")) throw new Error(`unexpected GET ${path}`);
      emitEtag(options, version);
      return {
        items: [
          {
            ...emailConsent("opted_in", version),
            status: "pending",
            consent_timestamp: null,
            consent_source: "double_optin",
          },
        ],
        subscriber_version: version,
      };
    });
    renderPanel();
    await waitFor(() => {
      expect(channelRowText("Email")).toContain("Pending");
    });
    expect(channelRowText("Email")).toContain("Awaiting confirmation");
    expect(channelRowText("Email")).not.toContain("Not recorded");
    // No consent has been given, so no source may be named beside it.
    expect(channelRowText("Email")).not.toContain("Double opt-in confirmation");
  });

  // The stored source of a granted decision is the server's fold marker, which
  // names no act a reader could act on. It used to be printed verbatim.
  it("names a granted consent's source in words and never prints a storage token", async () => {
    mocks.get.mockImplementation(async (path: string, options) => {
      if (!path.endsWith("/channel-consents")) throw new Error(`unexpected GET ${path}`);
      emitEtag(options, version);
      return {
        items: [
          {
            ...emailConsent("opted_in", version),
            consent_source: "subscriber_email_terminal_v2",
          },
        ],
        subscriber_version: version,
      };
    });
    renderPanel();
    await waitFor(() => {
      expect(channelRowText("Email")).toContain("Granted");
    });
    expect(document.body.textContent).not.toContain("subscriber_email_terminal_v2");
    expect(channelRowText("Email")).not.toContain("Not recorded");
  });

  it("withholds the email verb from a viewer with the reason", async () => {
    primeList();
    renderPanel(null);
    await waitFor(() => byAriaLabel("Revoke Email consent"));
    const revoke = byAriaLabel("Revoke Email consent");
    expect(revoke.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Consent is read-only for viewers and while view-as mode is active.",
    );
  });
});

/* ------------------------ audience-65: send frequency --------------------- */

describe("FrequencyPreferencePanel — send frequency (audience-65)", () => {
  function renderPanel(
    record: Subscriber | undefined,
    auth: SubscriberAuthority | null = authority,
    onRecordRefetch = vi.fn(),
  ) {
    render(
      createElement(FrequencyPreferencePanel, {
        record,
        authority: auth,
        onRecordRefetch,
      }),
    );
    return onRecordRefetch;
  }

  function primePatch(overrides: Partial<Subscriber>) {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({ ...overrides, version: freshVersion });
    });
  }

  it("sets a cadence with one PATCH under the reviewed revision and reloads the record", async () => {
    primePatch({ frequency_preference: "weekly" });
    const refetch = renderPanel(subscriber({ frequency_preference: "default" }));
    const weekly = field<HTMLInputElement>(document, 'input[type="radio"][value="weekly"]');
    expect(weekly.checked).toBe(false);
    await click(weekly);
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}`,
      { frequency_preference: "weekly" },
      expect.objectContaining({
        headers: { "If-Match": version },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    await waitFor(() => {
      expect(refetch).toHaveBeenCalled();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Cadence set to weekly.");
    });
  });

  it("pauses until a date, then clears the expiry, with distinct bodies", async () => {
    const until = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    until.setSeconds(0, 0);
    primePatch({ frequency_preference: "paused", paused_until: until.toISOString() });
    renderPanel(subscriber({ frequency_preference: "default", paused_until: null }));
    const local = new Date(until.getTime() - until.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    change(field<HTMLInputElement>(document, 'input[type="datetime-local"]'), local);
    await click(button("Set expiry"));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch.mock.calls[0]?.[0]).toBe(`/api/v1/subscribers/${id}`);
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({
      frequency_preference: "paused",
      paused_until: until.toISOString(),
    });
    document.body.innerHTML = "";
    mocks.patch.mockReset();
    primePatch({ frequency_preference: "paused", paused_until: null });
    renderPanel(subscriber({ frequency_preference: "paused", paused_until: until.toISOString() }));
    expect(document.body.textContent).toContain("Until");
    await click(button("Clear expiry"));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({ clear_paused_until: true });
    expect(mocks.patch.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ headers: { "If-Match": version } }),
    );
  });

  it("disables every control for a viewer and says why, sending nothing", async () => {
    renderPanel(subscriber({ frequency_preference: "paused", paused_until: null }), null);
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios).toHaveLength(4);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    expect(button("Set expiry").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Viewer access can inspect send frequency but cannot change it.",
    );
    await click(field<HTMLInputElement>(document, 'input[type="radio"][value="weekly"]'));
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("disables writes when the record carries no exact revision", () => {
    renderPanel(subscriber({ version: undefined }));
    expect(document.body.textContent).toContain(
      "Reload this subscriber to obtain the latest revision before changing send frequency.",
    );
    expect(button("Set expiry").disabled).toBe(true);
  });
});

/* ------------------------ audience-72: tracking consent ------------------- */

const trackingVersion = `"subscriber-tracking-consent:${id}:2026-09-01T10:00:00Z"`;
const freshTrackingVersion = `"subscriber-tracking-consent:${id}:2026-09-05T08:00:00Z"`;

function trackingPrefs(overrides: Record<string, unknown> = {}) {
  return {
    subscriber_id: id,
    subscriber_email: "ada@example.com",
    open_opt_out_at: null,
    click_opt_out_at: null,
    effective_open_opt_out: false,
    effective_click_opt_out: false,
    source: "default",
    gpc: false,
    policy_version: "v1",
    updated_at: now,
    ...overrides,
  };
}

describe("TrackingConsentPanel — tracking opt-outs (audience-72)", () => {
  function primeGet(overrides: Record<string, unknown> = {}) {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, trackingVersion);
      return trackingPrefs(overrides);
    });
  }

  function renderPanel(auth: SubscriberAuthority | null = authority) {
    render(
      createElement(TrackingConsentPanel, {
        id,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
        enabled: true,
      }),
    );
  }

  it("records an open-tracking opt-out under If-Match and shows the effective decision", async () => {
    primeGet();
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshTrackingVersion);
      return trackingPrefs({
        open_opt_out_at: now,
        effective_open_opt_out: true,
        source: "dashboard",
      });
    });
    renderPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Opens active");
    });
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/tracking-consent`,
      expect.anything(),
    );
    const switches = document.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches).toHaveLength(2);
    const open = switches[0]!;
    expect(open.getAttribute("aria-checked")).toBe("false");
    await click(open);
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/tracking-consent`,
      { open_opt_out: true },
      expect.objectContaining({
        headers: { "If-Match": trackingVersion },
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Opens suppressed");
      expect(document.body.textContent).toContain("Clicks active");
    });
    expect(
      document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]?.getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Open tracking opt-out recorded.");
  });

  it("locks a GPC-suppressed opt-out and says GPC is honored", async () => {
    primeGet({
      gpc: true,
      open_opt_out_at: now,
      effective_open_opt_out: true,
      effective_click_opt_out: true,
      source: "gpc",
    });
    renderPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("GPC opt-out honored");
    });
    const switches = document.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches[0]?.disabled).toBe(true); // explicit + GPC: locked
    expect(switches[1]?.disabled).toBe(false); // may still record an explicit click opt-out
    expect(document.body.textContent).toContain(
      "Open tracking is suppressed by both explicit subscriber evidence and Global Privacy Control.",
    );
  });

  it("withholds the switches from a viewer with the reason", async () => {
    primeGet();
    renderPanel(null);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="switch"]')).toHaveLength(2);
    });
    const switches = document.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(Array.from(switches).every((s) => s.disabled)).toBe(true);
    expect(document.body.textContent).toContain(
      "Viewer access can inspect tracking preferences but cannot change them.",
    );
  });
});

/* -------------------- audience-52: jurisdiction re-confirm ---------------- */

describe("JurisdictionReconfirmPanel — re-confirmation evidence (audience-52)", () => {
  const changedAt = "2026-09-01T10:00:00.123456Z";
  const drifted = () =>
    subscriber({
      jurisdiction_reconfirm_required: true,
      detected_jurisdiction: "DE",
      jurisdiction_changed_at: changedAt,
      region: null,
    } as Partial<Subscriber>);

  function renderPanel(
    record: Subscriber | undefined,
    auth: SubscriberAuthority | null = authority,
    onRecordRefetch = vi.fn(),
  ) {
    render(
      createElement(JurisdictionReconfirmPanel, {
        record,
        authority: auth,
        onRecordRefetch,
      }),
    );
    return onRecordRefetch;
  }

  it("says nothing is pending when the drift flag is clear", () => {
    renderPanel(subscriber());
    expect(document.body.textContent).toContain(
      "No jurisdiction re-confirmation is pending for this subscriber.",
    );
    expect(buttons("Record subject")).toHaveLength(0);
  });

  it("records a decline with the exact disclosure after a confirm that names the consequence", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({
        jurisdiction_reconfirm_required: false,
        version: freshVersion,
      } as Partial<Subscriber>);
    });
    const refetch = renderPanel(drifted());
    expect(document.body.textContent).toContain(
      "Jurisdiction changed to DE. Re-confirmation required for GDPR.",
    );
    await click(button("Record subject decline"));
    const disclosure = "  You agree to receive marketing email.\n\tTerms apply.  ";
    change(field(document, 'input[id$="-policy"]'), "privacy-2026-09");
    change(field(document, 'textarea[id$="-captured"]'), disclosure);
    await click(field<HTMLInputElement>(document, 'input[type="checkbox"]'));
    await click(button("Record declined decision"));
    await waitFor(() => {
      expect(dialog().textContent).toContain("Record subject decline?");
    });
    const confirm = dialog();
    expect(confirm.textContent).toContain(
      "removes email consent for ada@example.com under GDPR",
    );
    expect(confirm.textContent).toContain("cannot be undone");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(button("Record declined decision", confirm));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/jurisdiction-reconfirm`,
      {
        decision: "declined",
        regime: "gdpr",
        privacy_policy_version: "privacy-2026-09",
        captured_text: disclosure,
        expected_jurisdiction_changed_at: changedAt,
        expected_subscriber_version: version,
      },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
    await waitFor(() => {
      expect(refetch).toHaveBeenCalled();
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Subject decline recorded and email consent removed.",
      );
    });
  });

  it("withholds both decisions from a viewer with the reason", () => {
    renderPanel(drifted(), null);
    expect(button("Record subject acceptance").disabled).toBe(true);
    expect(button("Record subject decline").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "A write-enabled role is required to record a fresh consent decision.",
    );
  });

  it("refuses to offer a decision when the regime cannot be classified", () => {
    renderPanel(
      subscriber({
        jurisdiction_reconfirm_required: true,
        detected_jurisdiction: "US",
        jurisdiction_changed_at: changedAt,
      } as Partial<Subscriber>),
    );
    expect(document.body.textContent).toContain(
      "does not map to a supported strict consent regime",
    );
    expect(buttons("Record subject")).toHaveLength(0);
  });
});

/* --------------------------- audience-66: GPP ----------------------------- */

describe("GppSectionsPanel — GPP sections (audience-66)", () => {
  function renderPanel() {
    render(
      createElement(GppSectionsPanel, {
        id,
        tenantId,
        role: "admin",
        enabled: true,
      }),
    );
  }

  it("lists each jurisdiction's encoded section with its audit trail", async () => {
    mocks.get.mockResolvedValue({
      subscriber_id: id,
      sections: { "us-ca": "DBABLA~BVQqAAAACgA.QA", "eu-tcf": "CP1234" },
      audit: [
        {
          id: "a1",
          subscriber_id: id,
          jurisdiction: "us-ca",
          section_value: "DBABLA~BVQqAAAACgA.QA",
          source: "cmp_webhook",
          created_at: now,
        },
        {
          id: "a2",
          subscriber_id: id,
          jurisdiction: "eu-tcf",
          section_value: "",
          source: "manual_override",
          created_at: now,
        },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("us-ca");
    });
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/gpp`,
      expect.anything(),
    );
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "eu-tcf",
      "us-ca",
    ]);
    expect(rows[1]?.querySelector("code")?.getAttribute("title")).toBe(
      "DBABLA~BVQqAAAACgA.QA",
    );
    expect(document.body.textContent).toContain("Audit trail (2)");
    expect(document.body.textContent).toContain("CMP webhook");
    expect(document.body.textContent).toContain("(cleared)");
  });

  it("renders an honest empty state, not an inferred consent", async () => {
    mocks.get.mockResolvedValue({ subscriber_id: id, sections: {}, audit: [] });
    renderPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No GPP consent sections recorded for this profile.",
      );
    });
    expect(document.querySelector("table")).toBeNull();
  });
});
