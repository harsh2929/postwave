// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Mount reachability for the form editor (/app/forms/[id]):
//   automation-13 — the Settings tab's spam protection is the full card
//     (honeypot / captcha provider / rate limit) saving its own PATCH
//   automation-22 — a 412 on the editor's main Save offers "Reload latest
//     version", and reloading re-reads the form and adopts it
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Form } from "@/lib/forms-types";
import { setOnlineStatusForTest } from "@/lib/online-manager";
import { WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
  typeInto,
} from "./_mount-transport";

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "form_1" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/forms/form_1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI: me } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(me),
    whoamiFresh: vi.fn().mockResolvedValue(me),
  };
});

vi.mock("@/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

vi.mock("@/lib/use-forms-origin", () => ({
  useFormsOrigin: () => "https://forms.example",
}));

import FormEditorPage from "@/app/(dashboard)/app/forms/[id]/page";

const PATH = "/api/v1/forms/form_1";

function form(overrides: Partial<Form> = {}): Form {
  return {
    id: "form_1",
    tenantId: WHOAMI.tenant_id,
    slug: "newsletter",
    name: "Newsletter",
    optInMode: "single",
    structure: { fields: [] },
    settings: { successMessage: "Thanks!" },
    status: "draft",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

let root: Root | null = null;

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FormEditorPage),
      ),
    );
  });
  await settle(10);
  return host;
}

beforeEach(() => {
  setOnlineStatusForTest("online");
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  nav.search = "";
});

describe("form editor mounts", () => {
  it("renders the spam protection card on Settings and saves its own PATCH (automation-13)", async () => {
    nav.search = "tab=settings";
    let server = form();
    const { calls } = recordingTransport((req) => {
      if (req.path !== PATH) return undefined;
      if (req.method === "GET")
        return { body: server, headers: { etag: '"v1"' } };
      if (req.method === "PATCH") {
        server = {
          ...server,
          settings: (req.body as { settings: Form["settings"] }).settings,
          updatedAt: "2026-09-03T00:00:00Z",
        };
        return { body: server, headers: { etag: '"v2"' } };
      }
      return undefined;
    });
    const host = await mount();

    // The Settings tab body and the spam protection card inside it are two
    // nested next/dynamic chunks; give them a bounded moment to mount before
    // reading the card.
    const findCard = () =>
      [...host.querySelectorAll("section")].find(
        (s) => s.querySelector("h3")?.textContent?.trim() === "Spam protection",
      );
    const deadline = Date.now() + 10_000;
    while (!findCard() && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const card = findCard();
    expect(card).toBeDefined();
    expect(card!.textContent).toContain(
      "The honeypot runs on every submission.",
    );
    expect(host.textContent).not.toContain("Require reCAPTCHA");

    const honeypot = [...card!.querySelectorAll("label")]
      .find((l) => l.textContent?.includes("Honeypot field"))!
      .querySelector("input")!;
    await clickEl(honeypot);
    await clickEl(buttonByText(card!, "Save spam protection"));
    await settle(8);

    const patches = calls.filter(
      (c) => c.method === "PATCH" && c.path === PATH,
    );
    expect(patches).toHaveLength(1);
    const body = patches[0].body as { settings: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["settings"]);
    expect(body.settings.honeypotEnabled).toBe(false);
  });

  it("offers Reload latest version after a 412 on Save and adopts the reloaded form (automation-22)", async () => {
    let server = form();
    let conflict = true;
    const { calls } = recordingTransport((req) => {
      if (req.path !== PATH) return undefined;
      if (req.method === "GET")
        return { body: server, headers: { etag: '"v1"' } };
      if (req.method === "PATCH" && conflict) {
        conflict = false;
        server = form({
          name: "Newsletter (edited elsewhere)",
          updatedAt: "2026-09-02T00:00:00Z",
        });
        return {
          status: 412,
          body: { error: { code: "precondition_failed", message: "stale" } },
        };
      }
      return undefined;
    });
    const host = await mount();

    await typeInto(
      host.querySelector<HTMLInputElement>('input[aria-label="Form name"]')!,
      "Newsletter — my edit",
    );
    await clickEl(buttonByText(host, /^Save$/));
    // The 412 notice (conflict predicate + reload banner) is a next/dynamic
    // chunk behind the save; give it a bounded moment to mount before reading.
    const deadline = Date.now() + 10_000;
    while (
      buttonByText(host, "Reload latest version") === undefined &&
      Date.now() < deadline
    ) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    const reload = buttonByText(host, "Reload latest version");
    expect(reload).toBeDefined();
    const getsBefore = calls.filter(
      (c) => c.method === "GET" && c.path === PATH,
    ).length;
    await clickEl(reload);
    // The operator's unsaved edit is still on screen, so the reload confirms.
    await clickEl(buttonByText(document.body, "Discard and reload"));
    await settle(8);

    expect(
      calls.filter((c) => c.method === "GET" && c.path === PATH).length,
    ).toBe(getsBefore + 1);
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Form name"]')!
        .value,
    ).toBe("Newsletter (edited elsewhere)");
    expect(buttonByText(host, "Reload latest version")).toBeUndefined();
  });
});
