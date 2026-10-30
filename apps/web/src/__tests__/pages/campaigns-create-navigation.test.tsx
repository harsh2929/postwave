// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// New campaign: "Name it and draft a subject to get started — you'll build
// the email next." After a successful Create the dialog closed and the person
// was left on the campaign list. Create now opens the editor, and it never
// waits on — or depends on — the AI subject suggestions typed alongside it.
//
// Mounted through the shared page harness against recorded fixtures, with the
// two requests this flow writes answered here.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubFixtureTransport, unmount, WHOAMI } from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

const navigation = vi.hoisted(() => ({
  params: undefined as unknown as URLSearchParams,
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  },
}));

const auth = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  usePathname: () => "/app/campaigns",
  useSearchParams: () => navigation.params,
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: auth.whoami,
  whoamiFresh: auth.whoamiFresh,
}));

importBeforeTests(
  () => import("@/app/(dashboard)/app/campaigns/campaigns-client"),
  () => import("@/lib/campaign-block-renderer"),
  () => import("@/lib/voice-api"),
);

const CREATED = {
  id: "c1a2b3c4-0000-4000-8000-000000000001",
  tenant_id: WHOAMI.tenant_id,
  name: "Spring launch",
  subject: "Our spring launch is here",
  status: "draft",
  created_at: "2026-09-15T10:00:00.000Z",
  updated_at: "2026-09-15T10:00:00.000Z",
};

type VoiceBehaviour = "hang" | "fail";

interface Traffic {
  creates: number;
  voiceCalls: number;
}

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (
    input instanceof Request ? input.method : (init?.method ?? "GET")
  ).toUpperCase();
  return { path: new URL(url, "http://postwave.test").pathname, method };
}

/** Recorded fixtures for every read; the create and the AI call answered here. */
function serveCreateFlow(voice: VoiceBehaviour): Traffic {
  stubFixtureTransport();
  const fixtures = globalThis.fetch as typeof fetch;
  const traffic: Traffic = { creates: 0, voiceCalls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, method } = requestParts(input, init);
      if (path === "/api/v1/campaigns" && method === "POST") {
        traffic.creates += 1;
        return new Response(JSON.stringify(CREATED), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/v1/voice/generate") {
        traffic.voiceCalls += 1;
        if (voice === "hang") return new Promise<Response>(() => undefined);
        return new Response(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "an internal error occurred",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return fixtures(input, init);
    }),
  );
  return traffic;
}

function typeInto(id: string, value: string): void {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonNamed(
  name: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`no button "${name}"`);
  return match;
}

async function openDialog(): Promise<HTMLElement> {
  act(() => buttonNamed("New campaign").click());
  let dialog: HTMLElement | null = null;
  await waitFor(() => {
    dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
  });
  return dialog as unknown as HTMLElement;
}

beforeEach(() => {
  navigation.params = new URLSearchParams();
  vi.clearAllMocks();
  auth.whoami.mockResolvedValue(WHOAMI);
  auth.whoamiFresh.mockResolvedValue(WHOAMI);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("new campaign", () => {
  it("opens the editor for the created campaign while an AI suggestion is still pending", async () => {
    const traffic = serveCreateFlow("hang");
    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { root } = await renderPage(Page);
    try {
      const dialog = await openDialog();
      typeInto("campaign-name", "Spring launch");
      typeInto("campaign-subject", "Our spring launch is here");
      // The suggestion request goes out after its debounce and never answers.
      await waitFor(() => expect(traffic.voiceCalls).toBe(1));

      act(() => buttonNamed("Create", dialog).click());

      await waitFor(() =>
        expect(navigation.router.push).toHaveBeenCalledWith(
          `/app/campaigns/${CREATED.id}`,
        ),
      );
      expect(traffic.creates).toBe(1);
    } finally {
      unmount(root);
    }
  });

  it("stops asking for AI suggestions after the service fails, until asked to try again", async () => {
    const traffic = serveCreateFlow("fail");
    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { root } = await renderPage(Page);
    try {
      await openDialog();
      typeInto("campaign-subject", "Our spring launch is here");
      await waitFor(() =>
        expect(
          document.querySelector(
            '[data-testid="ai-subject-suggestions-unavailable"]',
          )?.textContent,
        ).toContain("AI suggestions are unavailable right now."),
      );
      expect(traffic.voiceCalls).toBe(1);
      expect(document.body.textContent).not.toContain("Thinking...");

      // More typing does not reach for a service that just failed.
      typeInto("campaign-subject", "Our spring launch is finally here");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(traffic.voiceCalls).toBe(1);

      act(() => buttonNamed("Try suggestions again").click());
      await waitFor(() => expect(traffic.voiceCalls).toBe(2));
    } finally {
      unmount(root);
    }
  });
});
