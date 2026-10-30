// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// WritebackTargetsPanel had NEITHER a test nor a page that renders it, so the
// reverse-ETL operator surface — the per-target lifecycle buttons, the
// auto-sync-interval sentence, and the lazily-enabled run-history query — was
// entirely unexecuted, as was the CreateWritebackForm it mounts.
//
// Route table rather than recorded fixtures: nothing under
// /api/v1/integration-writeback was ever recorded, so on the fixture transport
// this panel renders only "You need admin access…"/error and proves nothing.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WritebackProvider,
  WritebackRun,
  WritebackTarget,
} from "@/lib/writeback-api";

import { flush, stubRouteTransport } from "../helpers/route-transport";
import {
  clickEveryControl,
  renderPage,
  unmount,
  WHOAMI,
} from "../pages/_harness";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const PROVIDERS: WritebackProvider[] = [
  { provider: "shopify", available: true },
  { provider: "hubspot", available: true },
  { provider: "klaviyo", available: false },
];

const TARGETS: WritebackTarget[] = [
  {
    id: "wb_auto",
    provider: "shopify",
    name: "Shopify VIP tags",
    status: "active",
    sync_interval_minutes: 30,
    last_run_at: "2026-08-19T09:15:00Z",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-08-19T09:15:00Z",
  },
  {
    id: "wb_manual",
    // No `name`: the row must fall back to the provider's display label.
    provider: "hubspot",
    name: "",
    status: "paused",
    sync_interval_minutes: 0,
    last_run_at: null,
    error_message: "hubspot rejected 3 properties",
    created_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  },
];

const RUNS: WritebackRun[] = [
  {
    id: "run_1",
    target_id: "wb_auto",
    run_mode: "manual",
    status: "completed",
    members_seen: 1200,
    matched: 1150,
    tags_written: 1150,
    fields_written: 2300,
    rows_failed: 0,
    started_at: "2026-08-19T09:15:00Z",
    completed_at: "2026-08-19T09:17:00Z",
    created_at: "2026-08-19T09:15:00Z",
  },
  {
    id: "run_2",
    target_id: "wb_auto",
    run_mode: "scheduled",
    status: "partial",
    members_seen: 900,
    matched: 800,
    tags_written: 800,
    fields_written: 1600,
    rows_failed: 12,
    error_message: "rate limited by shopify",
    started_at: "2026-08-18T09:15:00Z",
    completed_at: "2026-08-18T09:20:00Z",
    created_at: "2026-08-18T09:15:00Z",
  },
];

function routes(items: WritebackTarget[] = TARGETS) {
  return {
    "/api/v1/auth/me": WHOAMI,
    "/api/v1/integration-writeback/providers": { items: PROVIDERS },
    "/api/v1/integration-writeback/targets": { items },
    "/api/v1/integration-writeback/targets/wb_auto/runs": { items: RUNS },
  };
}

async function panel() {
  return (await import("@/components/integrations/writeback-targets-panel"))
    .WritebackTargetsPanel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("WritebackTargetsPanel", () => {
  beforeEach(() => {
    stubRouteTransport(routes());
  });

  it("renders a card per target, naming the provider and its sync cadence", async () => {
    const WritebackTargetsPanel = await panel();
    const { text, root } = await renderPage(WritebackTargetsPanel);
    try {
      expect(text).toContain("Two-way sync (write-back)");
      expect(text).toContain("Shopify VIP tags");
      // Falls back to providerLabel("hubspot") because the target has no name.
      expect(text).toContain("HubSpot");
      expect(text).toContain("hubspot rejected 3 properties");
      // The interval sentence has two branches and both must be right.
      expect(text).toContain("auto every 30 min");
      expect(text).toContain("manual runs only");
      expect(text).toContain("last run never");
      expect(text).not.toContain("Invalid Date");
      expect(text).not.toContain("No write-back targets");
    } finally {
      unmount(root);
    }
  });

  it("offers Pause on the active target and Resume on the paused one", async () => {
    const WritebackTargetsPanel = await panel();
    const { container, root } = await renderPage(WritebackTargetsPanel);
    try {
      const labels = [...container.querySelectorAll("button")].map((b) =>
        b.textContent?.trim(),
      );
      expect(labels.filter((l) => l === "Pause")).toHaveLength(1);
      expect(labels.filter((l) => l === "Resume")).toHaveLength(1);
      expect(labels.filter((l) => l === "Run now")).toHaveLength(2);
      expect(labels.filter((l) => l === "Run history")).toHaveLength(2);
    } finally {
      unmount(root);
    }
  });

  it("shows the empty state when there are no targets", async () => {
    vi.unstubAllGlobals();
    stubRouteTransport(routes([]));
    const WritebackTargetsPanel = await panel();
    const { text, root } = await renderPage(WritebackTargetsPanel);
    try {
      expect(text).toContain("No write-back targets");
    } finally {
      unmount(root);
    }
  });

  it("loads that target's run history — and only that target's — on demand", async () => {
    const WritebackTargetsPanel = await panel();
    // Asserted against the CALL LOG, not the DOM. Dropping
    // `enabled: Boolean(runsForId)` leaves the rendering unchanged (the
    // section is gated on `runsOpen` separately) while firing a wasted request
    // to `/targets//runs` on every mount — a mutation this test missed until
    // it stopped asking the DOM and started asking the transport.
    const transport = stubRouteTransport(routes());
    const { container, root } = await renderPage(WritebackTargetsPanel);
    try {
      expect(transport.requested("/runs")).toBe(0);
      expect(container.textContent).not.toContain("1150/1200 matched");

      const toggles = [...container.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === "Run history",
      );
      expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
      toggles[0].click();
      await flush(container);

      expect(transport.requested("/targets/wb_auto/runs")).toBe(1);
      expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
      expect(toggles[0].textContent?.trim()).toBe("Hide run history");
      expect(container.textContent).toContain("1150/1200 matched");
      expect(container.textContent).toContain("12 failed");
      expect(container.textContent).toContain("scheduled");
      expect(container.textContent).toContain("rate limited by shopify");

      // Pressing it again collapses the history rather than leaving it open.
      toggles[0].click();
      await flush(container);
      expect(container.textContent).not.toContain("1150/1200 matched");
    } finally {
      unmount(root);
    }
  });

  it("mounts the create form, wired to the available providers, on New write-back", async () => {
    const WritebackTargetsPanel = await panel();
    const { container, root } = await renderPage(WritebackTargetsPanel);
    try {
      const newBtn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "New write-back",
      );
      expect(newBtn).toBeDefined();
      act(() => newBtn!.click());
      await flush(container);

      const select = container.querySelector<HTMLSelectElement>("#wb-provider");
      expect(select).not.toBeNull();
      // The panel must hand the form the providers it fetched, filtered to the
      // available ones by the form itself.
      expect(
        [...select!.querySelectorAll("option")].map((o) => o.textContent),
      ).toEqual(["Shopify", "HubSpot"]);
      // Segments 404 in this table. That failed request must stay distinct from
      // a successful empty list or an operator could trust a false empty state.
      expect(container.textContent).toContain("Segments could not be loaded");
      expect(container.textContent).not.toContain("No segments yet");
    } finally {
      unmount(root);
    }
  });

  it("clicks every control without a handler exploding", async () => {
    const WritebackTargetsPanel = await panel();
    const { container, root } = await renderPage(WritebackTargetsPanel);
    try {
      expect(document.body.textContent).not.toContain(
        "Disconnect this write-back target?",
      );
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      expect(clicked).toBeGreaterThanOrEqual(8);
      expect(document.body.textContent).toContain(
        "Disconnect this write-back target?",
      );
    } finally {
      unmount(root);
    }
  });
});
