// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Brand voice profile (desktop BrandVoicePanel parity): load, edit
// descriptors / writing rules / sample snippets, Save. Rendered through the
// real /compliance-requests page and the real transport; only `fetch` is
// stubbed, so the assertions are on the PUT that leaves the browser.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/compliance-requests",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

const SAVED = {
  id: "abababab-abab-4bab-8bab-abababababab",
  descriptors: ["warm", "plain-spoken"],
  writing_rules: ["Never use exclamation marks."],
  sample_snippets: ["Thanks for being here.", "Your order is on its way."],
  is_active: true,
  created_at: "2026-09-01T09:00:00Z",
  updated_at: "2026-09-01T09:00:00Z",
};

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let seen: Seen[] = [];
let getProfile: () => Response = () => json(200, SAVED);
let putProfile: (body: Record<string, unknown>) => Response = (body) =>
  json(200, { ...SAVED, ...body, updated_at: "2026-09-12T08:00:00Z" });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubTransport() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = new URL(raw, "http://postwave.test").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ method, path, body });
      if (path === "/api/v1/voice/brand-profile") {
        return method === "PUT" ? putProfile(body) : getProfile();
      }
      if (path === "/api/v1/zero-copy-triggers") return json(200, { items: [] });
      return json(404, { error: { code: "not_found", message: "" } });
    }),
  );
}

function field(label: string): HTMLTextAreaElement {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const element = found ? document.getElementById(found.htmlFor) : null;
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`no ${label}`);
  return element;
}

function saveButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Save profile",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("no save button");
  return found;
}

async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
      ?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

async function mountPage() {
  const Page = (await import("@/app/(dashboard)/app/compliance-requests/page"))
    .default;
  return renderPage(Page);
}

function puts(): Seen[] {
  return seen.filter(
    (request) =>
      request.method === "PUT" && request.path === "/api/v1/voice/brand-profile",
  );
}

beforeEach(() => {
  seen = [];
  getProfile = () => json(200, SAVED);
  putProfile = (body) =>
    json(200, { ...SAVED, ...body, updated_at: "2026-09-12T08:00:00Z" });
  mocks.whoami.mockReset().mockResolvedValue(WHOAMI);
  stubTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("brand voice profile editor", () => {
  it("loads the saved lists, then PUTs the edited descriptors, rules, and snippets", async () => {
    const { container, root } = await mountPage();
    try {
      await eventually(() =>
        expect(field("Descriptors").value).toBe("warm\nplain-spoken"),
      );
      expect(field("Writing rules").value).toBe("Never use exclamation marks.");
      expect(field("Sample snippets").value).toBe(
        "Thanks for being here.\n\nYour order is on its way.",
      );
      expect(saveButton().disabled).toBe(true);

      await type(field("Descriptors"), "warm\n  \nplain-spoken\nhonest-math ");
      await type(
        field("Writing rules"),
        "Never use exclamation marks.\nAlways use serial commas.",
      );
      // A snippet may span lines; only a blank line separates snippets.
      await type(
        field("Sample snippets"),
        "One line,\nsame snippet.\n\n  \n\nTwo, three.",
      );
      expect(saveButton().disabled).toBe(false);
      await act(async () => saveButton().click());

      await eventually(() => expect(puts()).toHaveLength(1));
      expect(puts()[0]?.body).toEqual({
        descriptors: ["warm", "plain-spoken", "honest-math"],
        writing_rules: [
          "Never use exclamation marks.",
          "Always use serial commas.",
        ],
        sample_snippets: ["One line,\nsame snippet.", "Two, three."],
      });
      await eventually(() =>
        expect(container.textContent).toContain("Brand voice profile saved."),
      );
      // The saved profile is the new baseline, normalized from the response.
      expect(field("Descriptors").value).toBe("warm\nplain-spoken\nhonest-math");
      expect(saveButton().disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("creates the first profile from the 404 empty state", async () => {
    getProfile = () => json(404, { error: { code: "not_found", message: "" } });
    const { container, root } = await mountPage();
    try {
      await eventually(() =>
        expect(container.textContent).toContain(
          "No profile is saved yet. Saving creates it.",
        ),
      );
      await type(field("Descriptors"), "direct");
      await act(async () => saveButton().click());
      await eventually(() => expect(puts()).toHaveLength(1));
      expect(puts()[0]?.body).toEqual({
        descriptors: ["direct"],
        writing_rules: [],
        sample_snippets: [],
      });
    } finally {
      unmount(root);
    }
  });

  it("blocks an over-limit descriptor before any request and names it", async () => {
    const { container, root } = await mountPage();
    try {
      await eventually(() => expect(field("Descriptors").value).toContain("warm"));
      await type(field("Descriptors"), `warm\n${"x".repeat(65)}`);
      expect(container.textContent).toContain(
        "Descriptor 2 exceeds the 64-byte limit.",
      );
      expect(saveButton().disabled).toBe(true);
      expect(puts()).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("renders the server's refusal sentence when the save is denied", async () => {
    putProfile = () =>
      json(403, {
        error: {
          code: "forbidden",
          message: "This API key lacks the admin scope.",
        },
      });
    const { container, root } = await mountPage();
    try {
      await eventually(() => expect(field("Descriptors").value).toContain("warm"));
      await type(field("Descriptors"), "warm\nbold");
      await act(async () => saveButton().click());
      await eventually(() =>
        expect(container.textContent).toContain(
          "This API key lacks the admin scope.",
        ),
      );
      expect(container.textContent).toContain("Profile not saved");
    } finally {
      unmount(root);
    }
  });

  it("keeps the profile readable but not editable for a non-admin", async () => {
    mocks.whoami.mockResolvedValue({
      ...WHOAMI,
      role: "editor",
      effective_role: "editor",
    });
    const { container, root } = await mountPage();
    try {
      await eventually(() =>
        expect(field("Descriptors").value).toBe("warm\nplain-spoken"),
      );
      expect(field("Descriptors").readOnly).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(container.textContent).toContain(
        "Admin access is required to edit this tenant-wide profile.",
      );
      expect(puts()).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });
});
