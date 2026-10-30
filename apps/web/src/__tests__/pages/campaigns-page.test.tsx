// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /campaigns. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";
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
  // Pages that call useRouter/usePathname throw "invariant expected app router
  // to be mounted" outside a Next app shell. The smoke test asks whether the
  // page renders, not whether navigation works, so the router is stubbed to
  // the same shape the repo's other render tests use.
  useRouter: () => navigation.router,
  usePathname: () => "/app/campaigns",
  useSearchParams: () => navigation.params,
  useParams: () => ({}),
  redirect: vi.fn(),
}));

import {
  clearAiCampaignHandoff,
  setAiCampaignHandoff,
} from "@/lib/ai-campaign-handoff";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: auth.whoami,
  whoamiFresh: auth.whoamiFresh,
}));

// The modules these tests import are cold work for vitest's transform
// pipeline; pay them before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/campaigns/campaigns-client"),
  () => import("@/lib/campaign-block-renderer"),
);

beforeEach(() => {
  navigation.params = new URLSearchParams();
  vi.clearAllMocks();
  auth.whoami.mockResolvedValue(WHOAMI);
  auth.whoamiFresh.mockResolvedValue(WHOAMI);
  clearAiCampaignHandoff();
  stubFixtureTransport();
});
afterEach(() => {
  clearAiCampaignHandoff();
  vi.unstubAllGlobals();
});

describe("campaigns page", () => {
  it("opens a sent campaign's analytics from its report action", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://localhost",
        ).pathname;
        if (
          path === "/api/v1/campaigns" &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json([
            {
              id: "sent-campaign",
              name: "QA sent",
              subject: "QA",
              status: "sent",
              created_at: "2026-10-24T10:00:00Z",
              updated_at: "2026-10-24T10:00:00Z",
            },
          ]);
        }
        return originalFetch(input, init);
      }),
    );
    const { CampaignsClient: Page } =
      await import("@/app/(dashboard)/app/campaigns/campaigns-client");
    const { root, container } = await renderPage(Page);
    try {
      await waitFor(() =>
        expect(
          container
            .querySelector('a[aria-label="View report"]')
            ?.getAttribute("href"),
        ).toBe("/app/campaigns/sent-campaign/analytics"),
      );
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Campaigns");
      expect(
        container.querySelector('th[aria-sort="descending"]')?.textContent,
      ).toContain("Updated");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("consumes an AI draft privately and opens a reviewable campaign handoff", async () => {
    await import("@/lib/campaign-block-renderer");
    navigation.params = new URLSearchParams("create=1");
    setAiCampaignHandoff({
      mode: "ab_test",
      name: "Release launch",
      subject: "Primary release subject",
      bodyHtml: "<p>Confidential generated draft</p>",
      previewText: "A private preview",
      subjectVariants: [
        "Primary release subject",
        "Alternative release subject",
      ],
    });

    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { root } = await renderPage(Page);
    try {
      expect(
        document.querySelector<HTMLInputElement>("#campaign-name")?.value,
      ).toBe("Release launch");
      expect(
        document.querySelector<HTMLInputElement>("#campaign-subject")?.value,
      ).toBe("Primary release subject");
      expect(document.body.textContent).toContain(
        "Alternative release subject",
      );
      expect(navigation.router.replace).toHaveBeenCalledWith("/app/campaigns", {
        scroll: false,
      });

      const create = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ].find(
        (button) =>
          button.type === "button" && button.textContent?.trim() === "Create",
      );
      expect(create).not.toBeUndefined();
      await act(async () => {
        create?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const fetchMock = vi.mocked(globalThis.fetch);
      const write = fetchMock.mock.calls.find(([input, init]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");
        return (
          new URL(url, "http://postwave.test").pathname ===
            "/api/v1/campaigns" && method === "POST"
        );
      });
      expect(write).not.toBeUndefined();
      const [requestInput, requestInit] = write ?? [];
      const requestBody =
        requestInput instanceof Request
          ? await requestInput.clone().text()
          : String(requestInit?.body ?? "");
      expect(JSON.parse(requestBody)).toMatchObject({
        name: "Release launch",
        subject: "Primary release subject",
        body_html: "<p>Confidential generated draft</p>",
        preview_text: "A private preview",
      });
    } finally {
      unmount(root);
    }
  });

  it("does not persist an AI handoff that still contains an example.com link", async () => {
    await import("@/lib/campaign-block-renderer");
    navigation.params = new URLSearchParams("create=1");
    setAiCampaignHandoff({
      mode: "draft",
      name: "Unsafe launch",
      subject: "Review this link",
      bodyHtml: '<p><a href="https://example.com/offer">Buy now</a></p>',
      previewText: "",
      subjectVariants: [],
    });

    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { root } = await renderPage(Page);
    try {
      const create = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ].find((candidate) => candidate.textContent?.trim() === "Create");
      expect(create).toBeDefined();
      await act(async () => {
        create?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const writes = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([input, init]) => {
          const request = input instanceof Request ? input : null;
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const method = request?.method ?? init?.method ?? "GET";
          return (
            new URL(url, "http://postwave.test").pathname ===
              "/api/v1/campaigns" && method === "POST"
          );
        });
      expect(writes).toHaveLength(0);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("keeps viewer-mode sessions read-only while preserving campaign navigation", async () => {
    auth.whoami.mockResolvedValue({ ...WHOAMI, viewer_mode: true });

    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { container, root } = await renderPage(Page);
    try {
      const newCampaign = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent?.trim() === "New campaign");
      expect(newCampaign?.disabled).toBe(true);
      expect(newCampaign?.title).toContain("read-only for this session");

      const mutationControls = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "table button[aria-label]",
        ),
      ).filter((control) =>
        /^(Pause|Resume|Cancel campaign|Duplicate |Delete )/.test(
          control.getAttribute("aria-label") ?? "",
        ),
      );
      expect(
        mutationControls.some((control) =>
          control.getAttribute("aria-label")?.startsWith("Duplicate "),
        ),
      ).toBe(true);
      expect(
        mutationControls.some((control) =>
          control.getAttribute("aria-label")?.startsWith("Delete "),
        ),
      ).toBe(true);
      for (const control of mutationControls) {
        expect(control.disabled).toBe(true);
        expect(control.title).toContain("read-only for this session");
      }
      for (const checkbox of container.querySelectorAll<HTMLInputElement>(
        'table input[type="checkbox"]',
      )) {
        expect(checkbox.disabled).toBe(true);
      }
      expect(
        container.querySelector('a[href^="/app/campaigns/"]'),
      ).not.toBeNull();
      expect(container.querySelector('a[href$="/ab"]')).toBeNull();

      await act(async () => {
        container
          .querySelector<HTMLTableRowElement>('[data-testid="campaign-row"]')
          ?.click();
      });
      const send = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent?.trim() === "Send");
      expect(send?.disabled).toBe(true);
      expect(send?.title).toContain("read-only for this session");
    } finally {
      unmount(root);
    }
  });

  it("rechecks authority and makes no campaign write when viewer mode changes before create", async () => {
    await import("@/lib/campaign-block-renderer");
    navigation.params = new URLSearchParams("create=1");
    setAiCampaignHandoff({
      mode: "draft",
      name: "Authority race",
      subject: "Authority changed before save",
      bodyHtml: "<p>Safe content</p>",
      previewText: "",
      subjectVariants: [],
    });
    auth.whoamiFresh.mockResolvedValueOnce({ ...WHOAMI, viewer_mode: true });

    const Page = (
      await import("@/app/(dashboard)/app/campaigns/campaigns-client")
    ).CampaignsClient;
    const { root } = await renderPage(Page);
    try {
      const create = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ).find(
        (candidate) =>
          candidate.type === "button" &&
          candidate.textContent?.trim() === "Create",
      );
      expect(create).toBeDefined();
      await act(async () => {
        create?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(auth.whoamiFresh).toHaveBeenCalledOnce();
      const campaignWrites = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([input, init]) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const method =
            input instanceof Request ? input.method : (init?.method ?? "GET");
          return (
            new URL(url, "http://postwave.test").pathname.startsWith(
              "/api/v1/campaigns",
            ) && method !== "GET"
          );
        });
      expect(campaignWrites).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });
});
