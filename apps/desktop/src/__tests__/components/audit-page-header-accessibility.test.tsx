// @vitest-environment happy-dom

import axe from "axe-core";
import { act, Fragment, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../components/audit/TraceRequestLookup", () => ({
  TraceRequestLookup: () => (
    <form aria-label="Trace a request">
      <input aria-label="Request ID" />
      <button type="submit">Trace</button>
    </form>
  ),
}));

import {
  AuditPageHeader,
  AuditReleaseHolds,
  AuditVisibilityBanner,
  getAuditHeaderSubtitle,
} from "../../pages/audit/AuditPageHeader";
import type { AuditPageController } from "../../pages/audit/useAuditPageController";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function controller({
  liveTail = false,
  liveTailCount = 0,
  autoRefresh = false,
  hasPrivateProjection = true,
  data = {},
}: {
  liveTail?: boolean;
  liveTailCount?: number;
  autoRefresh?: boolean;
  hasPrivateProjection?: boolean;
  data?: Record<string, unknown>;
} = {}): AuditPageController {
  return {
    data: {
      rows: [],
      totalCount: 0,
      totalConfidence: "exact",
      stats: null,
      refreshAgeLabel: "just now",
      loading: false,
      refreshing: false,
      stale: false,
      load: vi.fn(async () => undefined),
      ...data,
    },
    scopes: {
      isAdmin: true,
      loading: false,
      hasScope: vi.fn(
        (scope: string) => scope === "audit:read_pii" && hasPrivateProjection,
      ),
    },
    visibleToLabel: "owners and audit administrators",
    liveTail,
    liveTailCount,
    setLiveTailEnabled: vi.fn(),
    autoRefresh,
    setAutoRefresh: vi.fn(),
    live: {
      connectionState: liveTail ? "reconnecting" : "off",
      connectionError: liveTail
        ? "Live events are reconnecting; the loaded snapshot remains available."
        : null,
      invalidFrameCount: 0,
      droppedRowCount: 0,
    },
  } as unknown as AuditPageController;
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

describe("AuditPageHeader investigation shell", () => {
  it("renders a quiet, truthful masthead and static release holds without mounting unsafe actions", async () => {
    const value = controller();
    render(
      <Fragment>
        <AuditPageHeader controller={value} />
        <AuditVisibilityBanner controller={value} />
        <AuditReleaseHolds />
      </Fragment>,
    );

    expect(document.querySelector("h1")?.textContent).toBe("Audit log");
    expect(document.body.textContent).toContain("Reconstruct who changed what");
    expect(document.body.textContent).toContain("Scope check passed");
    expect(document.body.textContent).not.toContain("PII masked");
    expect(document.body.textContent).toContain("Exports remain unavailable");
    expect(document.body.textContent).toContain(
      "Sensitive workflows remain unavailable",
    );
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);

    const buttonLabels = Array.from(document.querySelectorAll("button")).map(
      (candidate) => candidate.textContent?.trim(),
    );
    expect(buttonLabels).toEqual(["Trace", "Refresh now"]);
    for (const unsafeLabel of [
      "Export CSV",
      "Async export…",
      "Evidence schedules…",
      "Investigations",
      "Create portal session…",
      "Retention",
    ]) {
      expect(buttonLabels).not.toContain(unsafeLabel);
    }

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps snapshot refresh compact and leaves unsafe streaming unmounted", () => {
    const value = controller();
    render(<AuditPageHeader controller={value} />);

    const switches = Array.from(
      document.querySelectorAll<HTMLInputElement>('[role="switch"]'),
    );
    expect(switches).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "Live streaming is on release hold",
    );

    act(() => button("Refresh now").click());

    expect(value.data.load).toHaveBeenCalledOnce();
  });

  it("distinguishes a stale-preserving manual refresh", () => {
    const value = controller({
      liveTail: true,
      liveTailCount: 3,
      autoRefresh: false,
      data: { refreshing: true, stale: true, refreshAgeLabel: "2m ago" },
    });
    render(<AuditPageHeader controller={value} />);

    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(button("Refreshing…").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Live streaming is on release hold",
    );
    expect(document.body.textContent).toContain(
      "Retrying while the last verified rows remain visible",
    );
    expect(document.querySelector(".audit-live-pill")).toBeNull();
  });

  it("does not claim redaction when the server has not verified the PII projection", () => {
    const value = controller({ hasPrivateProjection: false });
    render(<AuditVisibilityBanner controller={value} />);

    expect(document.body.textContent).toContain(
      "PII projection is not server-verified",
    );
    expect(document.body.textContent).toContain("Verification required");
    expect(document.body.textContent).not.toContain("PII masked");
  });

  it("does not expose partial live evidence as a client-facing monitoring mode", () => {
    const value = controller({ liveTail: true });
    render(<AuditPageHeader controller={value} />);

    expect(document.body.textContent).toContain(
      "Live streaming is on release hold",
    );
    expect(document.body.textContent).not.toContain("Live evidence is partial");
    expect(
      document.querySelector("[data-testid='audit-live-connection-state']"),
    ).toBeNull();
  });

  it("reports empty and approximate loaded windows precisely", () => {
    expect(getAuditHeaderSubtitle(controller())).toBe("Showing 0-0 of 0");
    expect(
      getAuditHeaderSubtitle(
        controller({
          data: {
            rows: [{ id: "event-1" }],
            totalCount: 2_100,
            totalConfidence: "approximate",
          },
        }),
      ),
    ).toBe("Showing 1-1 of ~2,100");
  });
});
