// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-64..67 — the private podcast card with the release hold simulated
// as LIFTED (the availability module is mocked to true). Proves every verb is
// complete behind the gate, by request: lookup GET, mint POST (reveal-once,
// no idempotency key), rotate POST behind its confirm, revoke DELETE behind
// its confirm followed by the re-read, and the copy affordances for the public
// and one-time private feed URLs.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PodcastTokensCard } from "@/components/archive/PodcastTokensCard";
import type { MeResponse } from "@/lib/auth-api";
import { setOnlineStatusForTest } from "@/lib/online-manager";
import { publicPodcastFeedUrl } from "@/lib/podcast-tokens-api";

vi.mock("@/lib/archive-operational-availability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/archive-operational-availability")
  >()),
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE: true,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const EMAIL = "reader@example.test";
const TOKEN_PATH = "/api/v1/podcast/subscribers/reader%40example.test/token";
const FEED_URL =
  "https://api.example.test/api/public/podcast/archive-workspace/feed/sekret-1.xml";

const me: MeResponse = {
  user_id: "archive-owner",
  tenant_id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Archive workspace",
  workspace_slug: "archive-workspace",
};

const roots: Root[] = [];
let calls: Recorded[];
let tokenState: "none" | "active" | "revoked";
let mintCount: number;
let writeText: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenRecord(secret: string | null) {
  return {
    tenant_id: me.tenant_id,
    subscriber_email: EMAIL,
    ...(secret
      ? {
          token: secret,
          feed_url: FEED_URL.replace("sekret-1", secret),
        }
      : {}),
    last_used_at: null,
    revoked_at: tokenState === "revoked" ? "2026-09-12T10:00:00Z" : null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
  };
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label}`);
  }
  return node;
}

function maybeButton(scope: ParentNode, label: string): boolean {
  return [...scope.querySelectorAll("button")].some(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("no dialog open");
  return node;
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<PodcastTokensCard me={me} />);
  });
  return container;
}

beforeEach(() => {
  setOnlineStatusForTest("online");
  calls = [];
  tokenState = "none";
  mintCount = 0;
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const record: Recorded = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers,
      };
      calls.push(record);
      if (record.path !== TOKEN_PATH) {
        return json({ error: { code: "not_found", message: "" } }, 404);
      }
      if (record.method === "GET") {
        if (tokenState === "none") {
          return json({ error: { code: "not_found", message: "no token" } }, 404);
        }
        return json(tokenRecord(null));
      }
      if (record.method === "POST") {
        tokenState = "active";
        mintCount += 1;
        return json(tokenRecord(`sekret-${mintCount}`));
      }
      if (record.method === "DELETE") {
        tokenState = "revoked";
        return json({ ok: true });
      }
      return json({}, 405);
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("PodcastTokensCard with the release hold lifted", () => {
  it("shows and copies the public feed URL without any request", async () => {
    const container = await render();
    expect(container.querySelector('[role="note"]')).toBeNull();
    const expected = publicPodcastFeedUrl("archive-workspace");
    expect(expected).toContain("/api/public/podcast/archive-workspace/feed.xml");
    const field = container.querySelector<HTMLInputElement>(
      'input[readonly]',
    )!;
    expect(field.value).toBe(expected);
    await click(button(container, "Copy public feed URL"));
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(toastMock.success).toHaveBeenCalledWith("Public feed URL copied");
    expect(calls).toEqual([]);
  });

  it("looks up, mints once-shown, rotates behind confirm, copies, and revokes behind confirm", async () => {
    const container = await render();
    const email = container.querySelector<HTMLInputElement>(
      'input[type="email"]',
    )!;

    // Validation stops a bad address before any request.
    type(email, "not-an-email");
    await click(button(container, "Look up"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter a valid subscriber email.",
    );
    expect(calls).toEqual([]);

    // Lookup → GET, 404 → "no token on file" + Mint.
    type(email, EMAIL);
    await click(button(container, "Look up"));
    expect(calls).toEqual([
      expect.objectContaining({ method: "GET", path: TOKEN_PATH }),
    ]);
    expect(container.textContent).toContain(
      `No podcast token on file for ${EMAIL}`,
    );

    // Mint → POST {} with no idempotency key (reveal-once); URL shown once.
    await click(button(container, "Mint token"));
    const mint = calls[1];
    expect(mint).toMatchObject({ method: "POST", path: TOKEN_PATH, body: {} });
    expect(mint.headers["idempotency-key"]).toBeUndefined();
    expect(container.textContent).toContain("Active");
    const privateField = () =>
      [...container.querySelectorAll<HTMLInputElement>("input[readonly]")].find(
        (candidate) => candidate.value.includes("/feed/"),
      );
    expect(privateField()?.value).toBe(FEED_URL);
    expect(toastMock.success).toHaveBeenCalledWith(`Token minted for ${EMAIL}`);

    // Acknowledge → the one-time URL is gone and cannot be re-shown.
    await click(button(container, "I stored it securely"));
    expect(privateField()).toBeUndefined();
    expect(container.textContent).toContain(
      "The feed URL can't be re-shown",
    );

    // Rotate → confirm dialog → second POST → new secret shown once.
    await click(button(container, "Rotate token"));
    expect(dialog().textContent).toContain("Rotate token?");
    expect(calls).toHaveLength(2);
    await click(button(dialog(), "Rotate"));
    expect(calls[2]).toMatchObject({ method: "POST", path: TOKEN_PATH });
    expect(privateField()?.value).toBe(FEED_URL.replace("sekret-1", "sekret-2"));

    // Copy the private URL → clipboard receives it, then it is discarded.
    await click(button(container, "Copy private feed URL"));
    expect(writeText).toHaveBeenLastCalledWith(
      FEED_URL.replace("sekret-1", "sekret-2"),
    );
    expect(privateField()).toBeUndefined();

    // Revoke → confirm dialog → DELETE then GET re-read → Revoked.
    await click(button(container, "Revoke"));
    expect(dialog().textContent).toContain("Revoke podcast token?");
    expect(calls).toHaveLength(3);
    await click(button(dialog(), "Revoke"));
    expect(calls.slice(3)).toEqual([
      expect.objectContaining({ method: "DELETE", path: TOKEN_PATH }),
      expect.objectContaining({ method: "GET", path: TOKEN_PATH }),
    ]);
    expect(container.textContent).toContain("Revoked");
    expect(maybeButton(container, "Revoke")).toBe(false);
    expect(maybeButton(container, "Mint new token")).toBe(true);
    expect(toastMock.success).toHaveBeenCalledWith(`Token revoked for ${EMAIL}`);
  });

  it("asks before a shown private URL is discarded by a new lookup", async () => {
    const container = await render();
    const email = container.querySelector<HTMLInputElement>(
      'input[type="email"]',
    )!;
    type(email, EMAIL);
    await click(button(container, "Look up"));
    await click(button(container, "Mint token"));
    expect(calls).toHaveLength(2);

    type(email, "other@example.test");
    await click(button(container, "Look up"));
    expect(dialog().textContent).toContain(
      "Discard the shown private feed URL?",
    );
    // Nothing was requested while the operator decides.
    expect(calls).toHaveLength(2);
    await click(button(dialog(), "Keep URL open"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toHaveLength(2);

    await click(button(container, "Look up"));
    await click(button(dialog(), "Discard and look up"));
    expect(calls[2]).toMatchObject({
      method: "GET",
      path: "/api/v1/podcast/subscribers/other%40example.test/token",
    });
  });
});
