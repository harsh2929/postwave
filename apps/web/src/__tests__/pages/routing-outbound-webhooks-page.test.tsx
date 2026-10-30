// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/routing/outbound-webhooks — the PUBLIC outbound-destination workspace
// (platform-108…116). This is the `/api/v1/outbound-webhooks` entity, not the
// `/api/v1/webhooks` family the settings/webhooks page manages.
//
// `@/lib/api` is mocked at the transport, so every assertion is on the literal
// method + path + body (+ the live-only transport options, which are part of
// the contract here: a replayed rotate mints two keys and a replayed delete is
// unrecoverable), on the confirm's copy, or on what the page renders back.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
      post: mocks.apiPost,
      patch: mocks.apiPatch,
      delete: mocks.apiDelete,
    },
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fixtures: the shapes internal/outbound_webhooks answers with --- */

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
};
const VIEWER = {
  ...OWNER,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const LIST_PATH = "/api/v1/outbound-webhooks";
const WH_1 = {
  id: "wh_1",
  url: "https://hooks.zapier.com/hooks/catch",
  description: "Zapier — created via gallery",
  events: ["campaign.sent", "subscriber.added"],
  active: true,
  signing_algorithm: "hmac_sha256",
  consecutive_failures: 0,
  last_succeeded_at: "2026-09-01T10:00:00Z",
};
const WH_2 = {
  id: "wh_2",
  url: "https://n8n.example.com/webhook/paused",
  description: "n8n",
  events: ["campaign.sent"],
  active: false,
  signing_algorithm: "ed25519",
};

const PAGE_1 = { webhooks: [WH_1, WH_2], next_cursor: "" };
const SEARCH_PAGE = { webhooks: [WH_1], next_cursor: "" };

/** Every mutation here refuses the offline outbox and transport retries. */
const LIVE = { requireOnline: true, maxAttempts: 1 };

function liveRequestOptions() {
  return expect.objectContaining({
    ...LIVE,
    cache: "no-store",
    signal: expect.any(AbortSignal),
    idempotencyKey: expect.any(String),
  });
}

function stubTransport(): void {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === LIST_PATH) return Promise.resolve(PAGE_1);
    if (path === `${LIST_PATH}?query=zapier`) {
      return Promise.resolve(SEARCH_PAGE);
    }
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
  mocks.apiPost.mockImplementation((path: string) => {
    if (path === LIST_PATH) {
      return Promise.resolve({
        webhook: { ...WH_1, id: "wh_new" },
        signing_secret: "whsec_live_value",
      });
    }
    if (path === `${LIST_PATH}/wh_1/test`) {
      return Promise.resolve({
        webhook_id: "wh_1",
        status_code: 202,
        signed: true,
        response: "accepted",
      });
    }
    if (path === `${LIST_PATH}/wh_1/rotate-secret`) {
      return Promise.resolve({
        webhook: WH_1,
        signing_secret: "whsec_rotated_value",
      });
    }
    if (/\/re-enable$/.test(path)) return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`Unexpected POST ${path}`));
  });
  mocks.apiPatch.mockImplementation(() => Promise.resolve(WH_1));
  mocks.apiDelete.mockImplementation((path: string) =>
    Promise.resolve({
      ok: true,
      deleted: !path.includes("soft=true"),
      deactivated: path.includes("soft=true"),
    }),
  );
}

/* ---------- harness ---------- */

async function render(ui: ReactNode): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

function text(): string {
  return document.body.textContent ?? "";
}

function dialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function dialogContaining(needle: string): HTMLElement {
  const el = dialogs().find((d) => d.textContent?.includes(needle));
  if (!el) throw new Error(`No open dialog containing "${needle}"`);
  return el;
}

function buttonByText(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`Missing button "${label}"`);
  return el;
}

function buttonByLabel(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`Missing button labelled "${label}"`);
  return el;
}

function checkboxByLabel(label: string, scope: ParentNode = document) {
  const el = scope.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="${label}"]`,
  );
  if (!el) throw new Error(`Missing checkbox "${label}"`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

async function toggle(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.click();
    await flush();
  });
}

async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

/** The page debounces the server query by 300ms before it refetches. */
async function settleSearchDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    await flush();
  });
}

function getPaths(): string[] {
  return mocks.apiGet.mock.calls.map(([path]) => path as string);
}

function postCalls(path: string): Array<[string, unknown, unknown]> {
  return mocks.apiPost.mock.calls.filter(([p]) => p === path) as Array<
    [string, unknown, unknown]
  >;
}

function deleteCalls(): Array<[string, unknown]> {
  return mocks.apiDelete.mock.calls as Array<[string, unknown]>;
}

async function mountPage(): Promise<Root> {
  const { OutboundWebhooksClient } =
    await import("@/app/(dashboard)/app/routing/outbound-webhooks/outbound-webhooks-client");
  const root = await render(createElement(OutboundWebhooksClient));
  await waitFor(() =>
    expect(document.querySelector("h1")?.textContent).toBe(
      "Outbound destinations",
    ),
  );
  return root;
}

function unmount(root: Root): void {
  act(() => root.unmount());
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  stubTransport();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("/app/routing/outbound-webhooks", () => {
  it("platform-108: searches destinations on the server through ?query= and renders the narrowed result", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      expect(getPaths()).toContain(LIST_PATH);
      expect(text()).toContain(WH_2.url);

      await type(
        document.querySelector<HTMLInputElement>("#outbound-webhook-search")!,
        "zapier",
      );
      await settleSearchDebounce();

      await waitFor(() =>
        expect(getPaths()).toContain(`${LIST_PATH}?query=zapier`),
      );
      await waitFor(() => {
        expect(text()).toContain(WH_1.url);
        expect(text()).not.toContain(WH_2.url);
      });
    } finally {
      unmount(root);
    }
  });

  it("platform-109: New destination posts the receiver preset and shows the signing secret exactly once", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByText("New destination"));
      const dialog = dialogContaining("New outbound destination");

      await choose(
        dialog.querySelector<HTMLSelectElement>('select[id$="-preset"]')!,
        "Zapier",
      );
      await type(
        dialog.querySelector<HTMLInputElement>('input[id$="-url"]')!,
        "  https://hooks.zapier.com/hooks/catch/1/abc  ",
      );
      await click(buttonByText("Create destination", dialog));

      await waitFor(() => expect(postCalls(LIST_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(LIST_PATH)[0]!;
      expect(body).toEqual({
        url: "https://hooks.zapier.com/hooks/catch/1/abc",
        description: "Zapier — created via gallery",
        events: ["campaign.sent", "subscriber.added"],
        algorithm: "hmac_sha256",
      });
      expect(opts).toEqual(liveRequestOptions());

      // Shown-once material: the secret is rendered, and it cannot be
      // dismissed until storage is confirmed.
      const reveal = await waitFor(() =>
        dialogContaining("Destination created"),
      ).then(() => dialogContaining("Destination created"));
      expect(reveal.textContent).toContain("whsec_live_value");
      const done = buttonByText("I've stored it securely", reveal);
      expect(done.disabled).toBe(true);

      await toggle(
        reveal.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
      );
      await click(buttonByText("I've stored it securely", reveal));
      await waitFor(() => expect(text()).not.toContain("whsec_live_value"));
    } finally {
      unmount(root);
    }
  });

  it("platform-110: Edit patches description and events, and preserves receiver auth and URL when they are untouched", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByLabel(`Edit ${WH_1.url}`));
      const dialog = dialogContaining("Edit outbound destination");

      await type(
        dialog.querySelector<HTMLInputElement>('input[id$="-description"]')!,
        "Zapier production",
      );
      // Drop one topic; the other has to survive the patch.
      await toggle(
        dialog.querySelector<HTMLInputElement>(
          'input[id$="-event-subscriber.added"]',
        )!,
      );
      await click(buttonByText("Save destination", dialog));

      await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledTimes(1));
      const [path, body, opts] = mocks.apiPatch.mock.calls[0]!;
      expect(path).toBe(`${LIST_PATH}/wh_1`);
      expect(body).toEqual({
        description: "Zapier production",
        events: ["campaign.sent"],
      });
      expect(opts).toEqual(liveRequestOptions());
    } finally {
      unmount(root);
    }
  });

  it("platform-111: Test names the live consequence, posts /test, and renders the returned status", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByLabel(`Send a test delivery to ${WH_1.url}`));
      const confirm = dialogContaining("Send a live test delivery?");
      expect(confirm.textContent).toContain(
        "the receiver may execute real side effects",
      );

      await click(buttonByText("Send test", confirm));
      await waitFor(() =>
        expect(postCalls(`${LIST_PATH}/wh_1/test`)).toHaveLength(1),
      );
      expect(postCalls(`${LIST_PATH}/wh_1/test`)[0]![2]).toEqual(
        liveRequestOptions(),
      );
      await waitFor(() =>
        expect(text()).toContain(`Live test to ${WH_1.url} returned HTTP 202.`),
      );
    } finally {
      unmount(root);
    }
  });

  it("platform-112: Rotate key posts /rotate-secret and reveals the new material once", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByLabel(`Rotate the signing key for ${WH_1.url}`));
      const confirm = dialogContaining("Rotate signing material?");
      expect(confirm.textContent).toContain(
        "dual-sign deliveries for 24 hours",
      );

      await click(buttonByText("Rotate key", confirm));
      await waitFor(() =>
        expect(postCalls(`${LIST_PATH}/wh_1/rotate-secret`)).toHaveLength(1),
      );
      expect(postCalls(`${LIST_PATH}/wh_1/rotate-secret`)[0]![2]).toEqual(
        liveRequestOptions(),
      );
      await waitFor(() => expect(text()).toContain("Signing material rotated"));
      expect(text()).toContain("whsec_rotated_value");
    } finally {
      unmount(root);
    }
  });

  it("platform-113: Pause names retention and soft-deletes the destination", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByLabel(`Pause ${WH_1.url}`));
      const confirm = dialogContaining("Pause this destination?");
      expect(confirm.textContent).toContain(
        "History, delivery rows, and signing configuration are retained for a later resume.",
      );

      await click(buttonByText("Pause destination", confirm));
      await waitFor(() => expect(deleteCalls()).toHaveLength(1));
      expect(deleteCalls()[0]).toEqual([
        `${LIST_PATH}/wh_1?soft=true`,
        liveRequestOptions(),
      ]);
    } finally {
      unmount(root);
    }
  });

  it("platform-114: Resume re-enables a paused destination without a confirm", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_2.url));
      await click(buttonByLabel(`Resume ${WH_2.url}`));
      await waitFor(() =>
        expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)).toHaveLength(1),
      );
      expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)[0]![2]).toEqual(
        liveRequestOptions(),
      );
      expect(deleteCalls()).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("platform-115: Delete requires the typed token, names the shredding, and hard-deletes", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await click(buttonByLabel(`Delete ${WH_1.url}`));
      const confirm = dialogContaining("Permanently delete this destination?");
      expect(confirm.textContent).toContain("signing secrets are shredded");

      const gated = buttonByText("Delete permanently", confirm);
      expect(gated.disabled).toBe(true);
      await type(confirm.querySelector<HTMLInputElement>("input")!, "DELETE");
      await click(buttonByText("Delete permanently", confirm));

      await waitFor(() => expect(deleteCalls()).toHaveLength(1));
      expect(deleteCalls()[0]).toEqual([
        `${LIST_PATH}/wh_1`,
        liveRequestOptions(),
      ]);
    } finally {
      unmount(root);
    }
  });

  it("platform-116: bulk pause and bulk delete fan out per selected id, and delete is token-gated", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await toggle(checkboxByLabel("Select every destination on this page"));
      await waitFor(() => expect(text()).toContain("2 selected"));

      await click(buttonByText("Pause all"));
      const pauseConfirm = dialogContaining("Pause 2 destinations?");
      await click(buttonByText("Pause selected", pauseConfirm));
      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(deleteCalls().map(([path]) => path)).toEqual([
        `${LIST_PATH}/wh_1?soft=true`,
        `${LIST_PATH}/wh_2?soft=true`,
      ]);

      // The bar clears on success, so re-select before the delete leg.
      mocks.apiDelete.mockClear();
      await toggle(checkboxByLabel("Select every destination on this page"));
      await waitFor(() => expect(text()).toContain("2 selected"));
      await click(buttonByText("Delete all"));
      const deleteConfirm = dialogContaining("Delete 2 destinations?");
      expect(buttonByText("Delete selected", deleteConfirm).disabled).toBe(
        true,
      );
      await type(
        deleteConfirm.querySelector<HTMLInputElement>("input")!,
        "DELETE",
      );
      await click(buttonByText("Delete selected", deleteConfirm));

      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(deleteCalls().map(([path]) => path)).toEqual([
        `${LIST_PATH}/wh_1`,
        `${LIST_PATH}/wh_2`,
      ]);
    } finally {
      unmount(root);
    }
  });

  it("platform-116: bulk resume re-enables every selected id", async () => {
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_1.url));
      await toggle(checkboxByLabel(`Select ${WH_2.url}`));
      await waitFor(() => expect(text()).toContain("1 selected"));

      await click(buttonByText("Resume all"));
      await waitFor(() =>
        expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)).toHaveLength(1),
      );
      expect(postCalls(`${LIST_PATH}/wh_1/re-enable`)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("dedupes a same-tick live write while fresh authority is unresolved", async () => {
    let resolveFresh: ((identity: typeof OWNER) => void) | undefined;
    mocks.whoamiFresh.mockImplementation(
      () =>
        new Promise<typeof OWNER>((resolve) => {
          resolveFresh = resolve;
        }),
    );
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_2.url));
      const resume = buttonByLabel(`Resume ${WH_2.url}`);
      act(() => {
        resume.click();
        resume.click();
      });
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)).toHaveLength(0);

      await act(async () => {
        resolveFresh?.(OWNER);
        await flush();
      });
      await waitFor(() =>
        expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)).toHaveLength(1),
      );
    } finally {
      unmount(root);
    }
  });

  it("blocks transport when fresh authority has been downgraded", async () => {
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_2.url));
      await click(buttonByLabel(`Resume ${WH_2.url}`));
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(postCalls(`${LIST_PATH}/wh_2/re-enable`)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("rejects a false-success resume receipt", async () => {
    mocks.apiPost.mockImplementation((path: string) => {
      if (path === `${LIST_PATH}/wh_2/re-enable`) {
        return Promise.resolve({ ok: false });
      }
      return Promise.reject(new Error(`Unexpected POST ${path}`));
    });
    const root = await mountPage();
    try {
      await waitFor(() => expect(text()).toContain(WH_2.url));
      await click(buttonByLabel(`Resume ${WH_2.url}`));
      await waitFor(() =>
        expect(text()).toContain(
          "The service did not confirm that the destination was resumed.",
        ),
      );
      expect(mocks.toast.success).not.toHaveBeenCalledWith(
        `${WH_2.url} was resumed.`,
      );
    } finally {
      unmount(root);
    }
  });

  it("withholds the whole surface from a viewer and asks the server for nothing", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const root = await mountPage();
    try {
      await waitFor(() =>
        expect(text()).toContain("Administrator access required"),
      );
      expect(text()).toContain(
        "This surface does not expose a partial read-only mode.",
      );
      expect(mocks.apiGet).not.toHaveBeenCalled();
      expect(document.querySelector("#outbound-webhook-search")).toBeNull();
    } finally {
      unmount(root);
    }
  });
});
