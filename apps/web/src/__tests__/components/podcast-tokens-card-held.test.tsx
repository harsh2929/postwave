// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-64..67 — the private podcast card under the REAL (unmocked)
// archive release policy: ARCHIVE_PRIVATE_PODCAST_AVAILABLE is false, exactly
// as desktop gates the whole card in ArchivePageContent. The card must render
// desktop's review-gate copy and NOTHING else — no lookup, mint, rotate,
// revoke or copy control — and no verb may reach the network from the card,
// from the archive operations panel that mounts it, or from the transport.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArchiveOperationsPanel } from "@/app/(dashboard)/app/archive-settings/archive-operations-panel";
import { PodcastTokensCard } from "@/components/archive/PodcastTokensCard";
import {
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE,
  ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON,
} from "@/lib/archive-operational-availability";
import type { MeResponse } from "@/lib/auth-api";
import {
  getPodcastSubscriberToken,
  mintPodcastSubscriberToken,
  revokePodcastSubscriberToken,
} from "@/lib/podcast-tokens-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

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

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 5));
      });
    }
  }
  throw lastError;
}

async function mount(ui: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always" },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    );
  });
  return container;
}

function podcastCalls(): unknown[][] {
  return (fetchMock.mock.calls as unknown[][]).filter(([input]) =>
    String(input).includes("/api/v1/podcast/"),
  );
}

beforeEach(() => {
  // Every unrecorded read answers 404, the state the app genuinely sees; the
  // operations panel renders its error branches around the podcast surface.
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { code: "not_found", message: "" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("PodcastTokensCard under the shipped release policy", () => {
  it("is the policy this file pins", () => {
    expect(ARCHIVE_PRIVATE_PODCAST_AVAILABLE).toBe(false);
  });

  it("renders desktop's review gate with the reason and no controls", async () => {
    const container = await mount(<PodcastTokensCard me={me} />);
    expect(container.textContent).toContain(
      "Private feed access is held back.",
    );
    expect(container.textContent).toContain("Review gated");
    const note = container.querySelector('[role="note"]');
    expect(note?.textContent).toBe(ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON);
    expect(container.textContent).toContain(
      "Issued tokens must never be recoverable after reveal.",
    );
    expect(container.querySelectorAll("button, input, textarea")).toHaveLength(
      0,
    );
    expect(container.textContent).not.toContain("Look up");
    expect(container.textContent).not.toContain("Mint token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is mounted on the archive operations panel, still held, still silent", async () => {
    const container = await mount(
      <ArchiveOperationsPanel me={me} queryBase={["archive-admin", "t"]} />,
    );
    // The card is a next/dynamic chunk under its own surface.
    await eventually(() => {
      const surface = container.querySelector("#ar-private-podcast");
      expect(surface).not.toBeNull();
      expect(surface!.closest("section")?.textContent).toContain(
        "Private feed access is held back.",
      );
    });
    const section = container
      .querySelector("#ar-private-podcast")!
      .closest("section")!;
    expect(section.textContent).toContain(
      ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON,
    );
    expect(section.querySelectorAll("button, input")).toHaveLength(0);
    expect(podcastCalls()).toEqual([]);
  });

  it("refuses every held verb in the transport before any request", async () => {
    const held = {
      code: "archive_private_podcast_unavailable",
      status: 503,
      message: ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON,
    };
    await expect(
      getPodcastSubscriberToken("reader@example.test"),
    ).rejects.toMatchObject(held);
    await expect(
      mintPodcastSubscriberToken("reader@example.test"),
    ).rejects.toMatchObject(held);
    await expect(
      revokePodcastSubscriberToken("reader@example.test"),
    ).rejects.toMatchObject(held);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
