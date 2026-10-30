// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The subscriber detail's data sections (desktop parity rows audience-69/70/
// 71/83): list memberships, custom-field values, audience (merge) field values
// and linked custom-object records. Each test drives a real render and asserts
// the CONSEQUENCE of the verb — the request's method + path + body (+ If-Match
// where the server demands it), the copy on the confirm that guards a removal,
// and what the panel renders afterwards — or, for a withheld verb, that no
// request was made and the reason is shown.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import {
  CustomFieldValuesPanel,
  CustomObjectLinksPanel,
  ListMembershipsPanel,
  MergeFieldValuesPanel,
} from "@/app/(dashboard)/app/subscribers/[id]/_data-panels";
import { ApiError } from "@/lib/api";
import { mergeFieldValueProblem } from "@/lib/subscriber-detail-api";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const version = `"subscriber:${id}:v4"`;
const freshVersion = `"subscriber:${id}:v5"`;
const email = "ada@example.com";
const authority: SubscriberAuthority = { tenantId, userId, role: "editor" };

const newsletterUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const vipUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function emitEtag(options: unknown, etag: string): void {
  const onResponse = (options as { onResponse?: (response: Response) => void })
    ?.onResponse;
  onResponse?.(new Response(null, { headers: { ETag: etag } }));
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

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.trim() === text,
  );
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

function labelled<T extends HTMLElement>(text: string): T {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : null;
  if (!control) throw new Error(`Control labelled "${text}" not found`);
  return control as T;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.requestSubmit();
    await flush();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoamiFresh.mockResolvedValue({
    user_id: userId,
    tenant_id: tenantId,
    email: "operator@example.com",
    role: "editor",
    effective_role: "editor",
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

/* ------------------- audience-69: list memberships ---------------------- */

describe("ListMembershipsPanel — list memberships (audience-69)", () => {
  function catalogueRow(engineId: number, name: string, uuid: string) {
    return {
      id: engineId,
      postwave_uuid: uuid,
      name,
      type: "private",
      optin: "single",
      tags: [],
      description: "",
    };
  }

  function prime(memberships: Array<{ id: string; name: string }>) {
    let current = memberships;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === `/api/v1/lists/for-subscriber/${id}`) {
        return { subscriber_id: id, items: current, count: current.length };
      }
      if (path === "/api/v1/lists") {
        return {
          data: {
            results: [
              catalogueRow(7, "Newsletter", newsletterUuid),
              catalogueRow(9, "VIP", vipUuid),
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    return (next: Array<{ id: string; name: string }>) => {
      current = next;
    };
  }

  function renderPanel(auth: SubscriberAuthority | null = authority) {
    return render(
      createElement(ListMembershipsPanel, {
        id,
        email,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
      }),
    );
  }

  it("adds the subscriber to a chosen list and renders the new membership", async () => {
    const setMemberships = prime([{ id: newsletterUuid, name: "Newsletter" }]);
    mocks.post.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => {
        setMemberships([
          { id: newsletterUuid, name: "Newsletter" },
          { id: vipUuid, name: "VIP" },
        ]);
        return { added: 1, skipped: 0 };
      },
    );
    renderPanel();
    await waitFor(() => labelled<HTMLSelectElement>("Add to list"));
    const picker = labelled<HTMLSelectElement>("Add to list");
    // A list the subscriber is already on is not offered again.
    expect(Array.from(picker.options).map((option) => option.text)).toEqual([
      "Choose a list…",
      "VIP",
    ]);
    await act(async () => {
      change(picker, "9");
      await flush();
    });
    await click(button("Add"));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.post.mock.calls[0] as [
      string,
      unknown,
      { requireOnline?: boolean; idempotencyKey?: string },
    ];
    expect(path).toBe(`/api/v1/lists/${vipUuid}/subscribers`);
    expect(body).toEqual({ subscriber_ids: [id] });
    expect(options.requireOnline).toBe(true);
    expect(options.idempotencyKey).toMatch(/^subscriber-list-add:/);
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    await waitFor(() => {
      const chips = Array.from(
        document.querySelectorAll('[data-testid="subscriber-list-membership"]'),
      ).map((chip) => chip.textContent);
      expect(chips).toEqual(["Newsletter", "VIP"]);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Added to VIP.");
  });

  it("removes from a list only after a confirm that names the consequence", async () => {
    const setMemberships = prime([
      { id: newsletterUuid, name: "Newsletter" },
      { id: vipUuid, name: "VIP" },
    ]);
    mocks.delete.mockImplementation(
      async (_path: string, _options?: unknown) => {
        setMemberships([{ id: newsletterUuid, name: "Newsletter" }]);
        return undefined;
      },
    );
    renderPanel();
    await waitFor(() => byAriaLabel("Remove from VIP"));
    await click(byAriaLabel("Remove from VIP"));
    await waitFor(() =>
      expect(dialog().textContent).toContain("Remove from VIP?"),
    );
    expect(dialog().textContent).toContain(
      `${email} stops receiving campaigns sent to VIP.`,
    );
    expect(mocks.delete).not.toHaveBeenCalled();

    await click(button("Remove from list", dialog()));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
    expect(mocks.delete.mock.calls[0]?.[0]).toBe(
      `/api/v1/lists/${vipUuid}/subscribers/${id}`,
    );
    await waitFor(() => {
      const chips = Array.from(
        document.querySelectorAll('[data-testid="subscriber-list-membership"]'),
      ).map((chip) => chip.textContent);
      expect(chips).toEqual(["Newsletter"]);
    });
  });

  it("renders the server's refusal when an add is denied", async () => {
    prime([]);
    mocks.post.mockRejectedValue(
      new ApiError("This list is archived and cannot accept new members.", 409),
    );
    renderPanel();
    await waitFor(() => labelled<HTMLSelectElement>("Add to list"));
    await act(async () => {
      change(labelled<HTMLSelectElement>("Add to list"), "7");
      await flush();
    });
    await click(button("Add"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "This list is archived and cannot accept new members.",
      ),
    );
  });

  it("shows a viewer the memberships but withholds add/remove with the reason", async () => {
    prime([{ id: newsletterUuid, name: "Newsletter" }]);
    renderPanel(null);
    await waitFor(() => expect(text()).toContain("Newsletter"));
    expect(document.querySelector('[aria-label="Remove from Newsletter"]')).toBeNull();
    expect(() => labelled("Add to list")).toThrow();
    expect(text()).toContain(
      "Viewer access can inspect list memberships but cannot add or remove them.",
    );
    expect(mocks.get).not.toHaveBeenCalledWith("/api/v1/lists", expect.anything());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});

/* ------------------- audience-70: custom-field values -------------------- */

describe("CustomFieldValuesPanel — custom-field values (audience-70)", () => {
  const definitions = [
    {
      id: "cf-1",
      tenant_id: tenantId,
      key: "plan_seats",
      label: "Plan seats",
      type: "number",
      config: {},
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
    {
      id: "cf-2",
      tenant_id: tenantId,
      key: "national_id",
      label: "National ID",
      type: "string",
      config: { data_classification: "pii" },
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ];

  function record(overrides: Partial<Subscriber> = {}): Subscriber {
    return {
      id,
      email,
      status: "enabled",
      consent_timestamp: null,
      consent_source: "api",
      // `legacy_name` is an ad-hoc key no definition covers — it must survive
      // every full-replace PATCH this panel sends.
      custom_fields: { plan_seats: 3, national_id: "AB123", legacy_name: "Ada L" },
      tags: [],
      version,
      ...overrides,
    } as Subscriber;
  }

  function prime() {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/custom-fields") return definitions;
      throw new Error(`unexpected GET ${path}`);
    });
  }

  function renderPanel(
    auth: SubscriberAuthority | null = authority,
    onRecordRefetch = vi.fn(),
  ) {
    render(
      createElement(CustomFieldValuesPanel, {
        id,
        record: record(),
        email,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
        onRecordRefetch,
      }),
    );
    return onRecordRefetch;
  }

  it("shows the classification badge and saves a typed value as the full map under If-Match", async () => {
    prime();
    mocks.patch.mockImplementation(
      async (_path: string, body: unknown, options?: unknown) => {
        emitEtag(options, freshVersion);
        return {
          ...record(),
          custom_fields: (body as { custom_fields: Subscriber["custom_fields"] })
            .custom_fields,
          version: freshVersion,
        };
      },
    );
    renderPanel();
    await waitFor(() => byAriaLabel("Edit Plan seats"));
    expect(
      document.querySelector('[aria-label="Data classification: PII"]')
        ?.textContent,
    ).toBe("PII");

    await click(byAriaLabel("Edit Plan seats"));
    const input = labelled<HTMLInputElement>("Plan seats");
    expect(input.type).toBe("number");
    await act(async () => {
      change(input, "12");
      await flush();
    });
    await submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.patch.mock.calls[0] as [
      string,
      unknown,
      { headers?: Record<string, string> },
    ];
    expect(path).toBe(`/api/v1/subscribers/${id}`);
    expect(body).toEqual({
      custom_fields: { plan_seats: 12, national_id: "AB123", legacy_name: "Ada L" },
    });
    expect(options.headers).toEqual({ "If-Match": version });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Plan seats updated."),
    );
  });

  it("refuses a value of the wrong type without sending anything", async () => {
    prime();
    renderPanel();
    await waitFor(() => byAriaLabel("Edit National ID"));
    await click(byAriaLabel("Edit National ID"));
    const input = labelled<HTMLInputElement>("National ID");
    await act(async () => {
      change(input, "   ");
      await flush();
    });
    await submit(input.closest("form") as HTMLFormElement);
    expect(text()).toContain("Enter a value, or use Remove to clear this field.");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("removes a classified value only after a confirm that names what is deleted", async () => {
    prime();
    mocks.patch.mockImplementation(
      async (_path: string, body: unknown, options?: unknown) => {
        emitEtag(options, freshVersion);
        return {
          ...record(),
          custom_fields: (body as { custom_fields: Subscriber["custom_fields"] })
            .custom_fields,
          version: freshVersion,
        };
      },
    );
    renderPanel();
    await waitFor(() => byAriaLabel("Remove National ID"));
    await click(byAriaLabel("Remove National ID"));
    await waitFor(() =>
      expect(dialog().textContent).toContain("Remove National ID?"),
    );
    expect(dialog().textContent).toContain(
      `This deletes the stored string value classified as PII from ${email}.`,
    );
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(button("Remove value", dialog()));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({
      custom_fields: { plan_seats: 3, legacy_name: "Ada L" },
    });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Removed National ID."),
    );
  });

  it("reloads the profile on a stale revision instead of overwriting", async () => {
    prime();
    mocks.patch.mockRejectedValue(new ApiError("precondition failed", 412));
    const onRecordRefetch = renderPanel();
    await waitFor(() => byAriaLabel("Edit Plan seats"));
    await click(byAriaLabel("Edit Plan seats"));
    const input = labelled<HTMLInputElement>("Plan seats");
    await act(async () => {
      change(input, "4");
      await flush();
    });
    await submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(text()).toContain(
        "This subscriber changed while you were reviewing it.",
      ),
    );
    expect(onRecordRefetch).toHaveBeenCalled();
  });

  it("shows a viewer every value but no edit or remove, with the reason", async () => {
    prime();
    renderPanel(null);
    await waitFor(() => expect(text()).toContain("AB123"));
    expect(text()).toContain("Ada L");
    expect(document.querySelector('[aria-label="Edit Plan seats"]')).toBeNull();
    expect(document.querySelector('[aria-label="Remove National ID"]')).toBeNull();
    expect(text()).toContain(
      "Viewer access can inspect custom fields but cannot change them.",
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

/* ------------------- audience-71: merge-field values --------------------- */

describe("MergeFieldValuesPanel — audience (merge) field values (audience-71)", () => {
  const schema = {
    items: [
      {
        tenant_id: tenantId,
        key: "FNAME",
        label: "First name",
        type: "text",
        default_value: "",
        required: false,
        position: 1,
        value_count: 10,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
      {
        tenant_id: tenantId,
        key: "BDAY",
        label: "Birthday",
        type: "date",
        default_value: "",
        required: false,
        position: 2,
        value_count: 0,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
      {
        tenant_id: tenantId,
        key: "CITY",
        label: "City",
        type: "text",
        default_value: "London",
        required: false,
        position: 3,
        value_count: 4,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
      {
        tenant_id: tenantId,
        key: "LNAME",
        label: "Last name",
        type: "text",
        default_value: "",
        required: true,
        position: 4,
        value_count: 10,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
    ],
  };

  function prime(values: Record<string, string>) {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/merge-fields/schema") return schema;
      if (path === `/api/v1/subscribers/${id}/merge-fields`) {
        return { subscriber_id: id, values };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  }

  function renderPanel(auth: SubscriberAuthority | null = authority) {
    render(
      createElement(MergeFieldValuesPanel, {
        id,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
      }),
    );
  }

  it("saves one field as a partial upsert and renders the server's values", async () => {
    prime({ FNAME: "Ad", BDAY: "", CITY: "Paris" });
    mocks.patch.mockImplementation(
      async (_path: string, body: unknown, _options?: unknown) => ({
        subscriber_id: id,
        values: { FNAME: (body as { FNAME: string }).FNAME, BDAY: "", CITY: "Paris" },
      }),
    );
    renderPanel();
    await waitFor(() => labelled<HTMLInputElement>("First name"));
    const input = labelled<HTMLInputElement>("First name");
    expect(input.value).toBe("Ad");
    await act(async () => {
      change(input, "  Ada ");
      await flush();
    });
    await click(byAriaLabel("Save First name"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.patch.mock.calls[0] as [
      string,
      unknown,
      { requireOnline?: boolean },
    ];
    expect(path).toBe(`/api/v1/subscribers/${id}/merge-fields`);
    expect(body).toEqual({ FNAME: "Ada" });
    expect(options.requireOnline).toBe(true);
    await waitFor(() =>
      expect(labelled<HTMLInputElement>("First name").value).toBe("Ada"),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("First name updated.");
  });

  it("holds a value the server would refuse in the browser and sends nothing", async () => {
    prime({ FNAME: "Ada", BDAY: "", CITY: "Paris", LNAME: "Lovelace" });
    renderPanel();
    await waitFor(() => labelled<HTMLInputElement>("Last name"));
    // Typed inputs carry the native constraint for the typed fields.
    expect(labelled<HTMLInputElement>("Birthday").type).toBe("date");
    const input = labelled<HTMLInputElement>("Last name");
    await act(async () => {
      change(input, "   ");
      await flush();
    });
    expect(text()).toContain("Last name is required and cannot be cleared.");
    expect(byAriaLabel("Save Last name").disabled).toBe(true);
    // A required field never offers Clear either.
    expect(document.querySelector('[aria-label="Clear Last name"]')).toBeNull();
    await submit(input.closest("form") as HTMLFormElement);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("mirrors the server's typed-value rules", () => {
    const date = { type: "date" as const, required: false, label: "Birthday" };
    expect(mergeFieldValueProblem(date, "2026-02-30")).toBe(
      "Date values must use YYYY-MM-DD.",
    );
    expect(mergeFieldValueProblem(date, "2026-02-28")).toBeNull();
    expect(
      mergeFieldValueProblem(
        { type: "number", required: false, label: "Score" },
        "12abc",
      ),
    ).toBe("Number values must be valid finite numbers.");
    expect(
      mergeFieldValueProblem(
        { type: "boolean", required: false, label: "VIP" },
        "yes",
      ),
    ).toBe("Boolean values must be true or false.");
  });

  it("clears a stored value only after a confirm naming the default it falls back to", async () => {
    prime({ FNAME: "Ada", BDAY: "", CITY: "Paris" });
    mocks.patch.mockResolvedValue({
      subscriber_id: id,
      values: { FNAME: "Ada", BDAY: "", CITY: "London" },
    });
    renderPanel();
    await waitFor(() => byAriaLabel("Clear City"));
    await click(byAriaLabel("Clear City"));
    await waitFor(() => expect(dialog().textContent).toContain("Clear City?"));
    expect(dialog().textContent).toContain(
      'The stored value "Paris" is removed; *|CITY|* renders the default "London"',
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    await click(button("Clear value", dialog()));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[0]).toBe(
      `/api/v1/subscribers/${id}/merge-fields`,
    );
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({ CITY: "" });
    await waitFor(() =>
      expect(labelled<HTMLInputElement>("City").value).toBe("London"),
    );
  });

  it("renders the server's validation sentence on refusal", async () => {
    prime({ FNAME: "Ada", BDAY: "", CITY: "Paris" });
    mocks.patch.mockRejectedValue(
      new ApiError("merge_fields: invalid input: FNAME is locked by an import", 422),
    );
    renderPanel();
    await waitFor(() => labelled<HTMLInputElement>("First name"));
    await act(async () => {
      change(labelled<HTMLInputElement>("First name"), "Grace");
      await flush();
    });
    await click(byAriaLabel("Save First name"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "merge_fields: invalid input: FNAME is locked by an import",
      ),
    );
  });

  it("gives a viewer read-only fields and the reason", async () => {
    prime({ FNAME: "Ada", BDAY: "", CITY: "Paris" });
    renderPanel(null);
    await waitFor(() => labelled<HTMLInputElement>("First name"));
    expect(labelled<HTMLInputElement>("First name").disabled).toBe(true);
    expect(document.querySelector('[aria-label="Save First name"]')).toBeNull();
    expect(document.querySelector('[aria-label="Clear City"]')).toBeNull();
    expect(text()).toContain(
      "Viewer access can inspect audience fields but cannot change them.",
    );
  });
});

/* ------------------- audience-83: custom-object links -------------------- */

describe("CustomObjectLinksPanel — linked custom-object records (audience-83)", () => {
  const typeId = "44444444-4444-4444-8444-444444444444";
  const recordId = "55555555-5555-4555-8555-555555555555";
  const otherRecordId = "66666666-6666-4666-8666-666666666666";
  const linkId = "77777777-7777-4777-8777-777777777777";
  const newLinkId = "88888888-8888-4888-8888-888888888888";
  const stamp = "2026-09-01T00:00:00Z";

  function link(overrides: Record<string, unknown> = {}) {
    return {
      id: linkId,
      tenantId,
      objectTypeId: typeId,
      objectRecordId: recordId,
      subscriberId: id,
      relationship: "purchased",
      metadata: {},
      createdAt: stamp,
      objectTypeKey: "order",
      objectTypeLabel: "Order",
      externalId: "ORD-1",
      properties: { total: 42 },
      ...overrides,
    };
  }

  function prime(initial: unknown[]) {
    let current = initial;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === `/api/v1/subscribers/${id}/custom-objects`) {
        return { items: current };
      }
      if (path === "/api/v1/custom-objects/types") {
        return {
          items: [
            {
              id: typeId,
              tenantId,
              key: "order",
              label: "Order",
              primaryKey: "order_id",
              schema: {},
              status: "active",
              version: 1,
              createdAt: stamp,
              updatedAt: stamp,
            },
          ],
        };
      }
      if (path === `/api/v1/custom-objects/types/${typeId}/records?limit=100`) {
        return {
          items: [
            {
              id: otherRecordId,
              tenantId,
              objectTypeId: typeId,
              externalId: "ORD-2",
              properties: {},
              version: 1,
              createdAt: stamp,
              updatedAt: stamp,
            },
          ],
          limit: 100,
          hasMore: false,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    return (next: unknown[]) => {
      current = next;
    };
  }

  function renderPanel(auth: SubscriberAuthority | null = authority) {
    render(
      createElement(CustomObjectLinksPanel, {
        id,
        email,
        tenantId,
        role: auth ? auth.role : "viewer",
        authority: auth,
      }),
    );
  }

  it("lists linked records grouped by type with a properties preview", async () => {
    prime([link()]);
    renderPanel();
    await waitFor(() => expect(text()).toContain("ORD-1"));
    expect(text()).toContain("Order (1)");
    expect(text()).toContain("purchased");
    expect(text()).toContain("total");
    expect(
      document.querySelector('a[href="/app/custom-objects"]'),
    ).not.toBeNull();
  });

  it("unlinks only after a confirm that says the record itself survives", async () => {
    const setLinks = prime([link()]);
    mocks.delete.mockImplementation(
      async (_path: string, _options?: unknown) => {
        setLinks([]);
        return undefined;
      },
    );
    renderPanel();
    await waitFor(() => byAriaLabel("Unlink ORD-1"));
    await click(byAriaLabel("Unlink ORD-1"));
    await waitFor(() => expect(dialog().textContent).toContain("Unlink ORD-1?"));
    expect(dialog().textContent).toContain("The record itself is not deleted.");
    expect(mocks.delete).not.toHaveBeenCalled();
    await click(button("Unlink record", dialog()));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
    expect(mocks.delete.mock.calls[0]?.[0]).toBe(
      `/api/v1/subscribers/${id}/custom-objects/${linkId}`,
    );
    await waitFor(() =>
      expect(text()).toContain(
        "No custom-object records are linked to this subscriber.",
      ),
    );
  });

  it("relabels a link with PATCH and renders the new relationship", async () => {
    const setLinks = prime([link()]);
    mocks.patch.mockImplementation(
      async (_path: string, body: unknown, _options?: unknown) => {
        const relationship = (body as { relationship: string }).relationship;
        setLinks([link({ relationship })]);
        return link({ relationship });
      },
    );
    renderPanel();
    await waitFor(() => byAriaLabel("Edit relationship for ORD-1"));
    await click(byAriaLabel("Edit relationship for ORD-1"));
    const input = labelled<HTMLInputElement>("Relationship label");
    await act(async () => {
      change(input, " owner ");
      await flush();
    });
    await submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[0]).toBe(
      `/api/v1/subscribers/${id}/custom-objects/${linkId}`,
    );
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({ relationship: "owner" });
    await waitFor(() => expect(text()).toContain("owner"));
    expect(text()).not.toContain("purchased");
  });

  it("links a chosen record from the linker dialog and renders it", async () => {
    const setLinks = prime([]);
    mocks.post.mockImplementation(
      async (_path: string, body: unknown, _options?: unknown) => {
        const input = body as { objectRecordId: string; relationship: string };
        const created = link({
          id: newLinkId,
          objectRecordId: input.objectRecordId,
          relationship: input.relationship,
          externalId: "ORD-2",
        });
        setLinks([created]);
        return created;
      },
    );
    renderPanel();
    await waitFor(() => button("Link a record"));
    await click(button("Link a record"));
    await waitFor(() => {
      expect(labelled<HTMLSelectElement>("Record").value).toBe(otherRecordId);
    });
    await act(async () => {
      change(labelled<HTMLInputElement>("Relationship"), "reserved");
      await flush();
    });
    await click(button("Link record", dialog()));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.post.mock.calls[0] as [
      string,
      unknown,
      { requireOnline?: boolean },
    ];
    expect(path).toBe(`/api/v1/subscribers/${id}/custom-objects`);
    expect(body).toEqual({
      objectRecordId: otherRecordId,
      relationship: "reserved",
    });
    expect(options.requireOnline).toBe(true);
    await waitFor(() => expect(text()).toContain("ORD-2"));
    expect(text()).toContain("reserved");
  });

  it("renders the server's sentence when a link already exists", async () => {
    prime([]);
    mocks.post.mockRejectedValue(
      new ApiError(
        "this record is already linked to the subscriber with that relationship",
        409,
      ),
    );
    renderPanel();
    await waitFor(() => button("Link a record"));
    await click(button("Link a record"));
    await waitFor(() =>
      expect(labelled<HTMLSelectElement>("Record").value).toBe(otherRecordId),
    );
    await click(button("Link record", dialog()));
    await waitFor(() =>
      expect(dialog().textContent).toContain(
        "this record is already linked to the subscriber with that relationship",
      ),
    );
  });

  it("shows a viewer the links without link, relabel or unlink", async () => {
    prime([link()]);
    renderPanel(null);
    await waitFor(() => expect(text()).toContain("ORD-1"));
    expect(() => button("Link a record")).toThrow();
    expect(document.querySelector('[aria-label="Unlink ORD-1"]')).toBeNull();
    expect(
      document.querySelector('[aria-label="Edit relationship for ORD-1"]'),
    ).toBeNull();
    expect(text()).toContain(
      "Viewer access can inspect linked records but cannot link, relabel, or unlink them.",
    );
  });
});

/* --------------------------- reachability -------------------------------- */

describe("subscriber detail wiring", () => {
  it("mounts the data panels in the Profile and Lists & Tags tabs", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/app/(dashboard)/app/subscribers/[id]/subscriber-detail-panels.tsx",
      ),
      "utf8",
    );
    for (const panel of [
      "ListMembershipsPanel",
      "CustomFieldValuesPanel",
      "MergeFieldValuesPanel",
      "CustomObjectLinksPanel",
    ]) {
      expect(source).toContain(`module.${panel}`);
      expect(source).toContain(`<${panel}`);
    }
    expect(source).toContain('tab === "profile" ? profilePanel');
    expect(source).toContain('tab === "lists" ? listsPanel');
  });
});
