// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import axe from "axe-core";
import { act, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  tenantId: "tenant-1",
  getBrandVoiceProfile: vi.fn(),
  putBrandVoiceProfile: vi.fn(),
  getVoiceProfile: vi.fn(),
  listVoiceSources: vi.fn(),
  createVoiceSource: vi.fn(),
  ingestVoiceSource: vi.fn(),
  deleteVoiceSource: vi.fn(),
  buildVoiceProfile: vi.fn(),
  listMCPExecutions: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => ({
    user: "user-1",
    tenant: mocks.tenantId,
    role: mocks.canAdmin ? "admin" : "editor",
    effectiveRole: mocks.canAdmin ? "admin" : "editor",
  }),
}));

vi.mock("../../lib/context-epoch", () => ({
  onContextEpochObserved: () => () => undefined,
  readContextEpoch: () => "epoch-1",
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getBrandVoiceProfile: mocks.getBrandVoiceProfile,
    putBrandVoiceProfile: mocks.putBrandVoiceProfile,
    getVoiceProfile: mocks.getVoiceProfile,
    listVoiceSources: mocks.listVoiceSources,
    createVoiceSource: mocks.createVoiceSource,
    ingestVoiceSource: mocks.ingestVoiceSource,
    deleteVoiceSource: mocks.deleteVoiceSource,
    buildVoiceProfile: mocks.buildVoiceProfile,
    listMCPExecutions: mocks.listMCPExecutions,
  },
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigate,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { BrandVoicePanel } from "../../components/ai/BrandVoicePanel";
import { RecentExecutionsStrip } from "../../components/ai/RecentExecutionsStrip";
import { VoiceProfileCard } from "../../components/ai/VoiceProfileCard";
import {
  boundedDisplayText,
  inspectorFailureMessage,
  safeDateTime,
  utf8ByteLength,
} from "../../components/ai/contextual-inspector-helpers";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.tenantId = "tenant-1";
  Object.entries(mocks).forEach(([key, value]) => {
    if (key !== "canAdmin" && typeof value === "function") value.mockReset();
  });
  mocks.getBrandVoiceProfile.mockResolvedValue({
    data: {
      descriptors: ["warm"],
      writing_rules: [],
      sample_snippets: [],
      updated_at: "2026-08-01T10:00:00Z",
    },
  });
  mocks.getVoiceProfile.mockResolvedValue({
    error: { status: 404, message: "not found" },
  });
  mocks.listVoiceSources.mockResolvedValue({ data: { items: [] } });
  mocks.listMCPExecutions.mockResolvedValue({
    data: {
      tenantId: "tenant-1",
      rows: [],
      detailPolicy: "minimized_v1",
      evidenceClass: "best_effort_observability",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      failure = caught;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

function changeTextarea(label: string, value: string): void {
  const field = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  );
  if (!field) throw new Error(`Missing ${label} textarea`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("Moosewave AI contextual inspector maturity", () => {
  it("settles both profile verifiers after StrictMode replays their mount effects", async () => {
    mocks.getVoiceProfile.mockResolvedValue({
      data: {
        description: "Verified corpus voice",
        generated_at: "2026-08-01T10:00:00Z",
        version: 4,
      },
    });
    mocks.listVoiceSources.mockResolvedValue({ data: { items: [] } });

    render(
      <StrictMode>
        <VoiceProfileCard />
        <BrandVoicePanel />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
      expect(document.body.textContent).toContain("Verified corpus voice");
      expect(document.body.textContent).toContain("Review or edit profile");
    });
    expect(mocks.getVoiceProfile).toHaveBeenCalledTimes(2);
    expect(mocks.listVoiceSources).toHaveBeenCalledTimes(2);
    expect(mocks.getBrandVoiceProfile).toHaveBeenCalledTimes(2);
  });

  it("uses bounded display text and a disclosure-safe failure vocabulary", () => {
    const raw = "SQL tenant@example.test /internal/secret";
    expect(
      inspectorFailureMessage({ status: 500, message: raw }, "brand-load"),
    ).toBe("The service couldn't complete the request. Retry when ready.");
    expect(
      inspectorFailureMessage({ status: 403, message: raw }, "brand-save"),
    ).toBe("Your current role can't make this change.");
    expect(
      inspectorFailureMessage({ kind: "parse", message: raw }, "profile-load"),
    ).not.toContain(raw);
    expect(boundedDisplayText(`abc\u0000${"x".repeat(20)}`, 8)).toBe(
      "abcxxxx…",
    );
    expect(safeDateTime("not-a-date")).toBeNull();
    expect(utf8ByteLength("é".repeat(33))).toBe(66);
  });

  it("fail-closes an unverified brand profile and contains raw load/save detail", async () => {
    const rawLoad = "SELECT * FROM tenants WHERE email='owner@example.test'";
    mocks.getBrandVoiceProfile.mockResolvedValueOnce({
      error: { status: 500, message: rawLoad },
    });
    render(<BrandVoicePanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service couldn't complete the request.",
      ),
    );
    expect(document.body.textContent).not.toContain(rawLoad);
    expect(
      document.querySelector<HTMLTextAreaElement>("textarea")?.readOnly,
    ).toBe(true);

    mocks.getBrandVoiceProfile.mockResolvedValueOnce({
      data: {
        descriptors: ["warm"],
        writing_rules: [],
        sample_snippets: [],
      },
    });
    act(() => button("Retry load").click());
    await waitFor(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Descriptors"]',
        )?.readOnly,
      ).toBe(false),
    );

    changeTextarea("Descriptors", "é".repeat(33));
    expect(document.body.textContent).toContain(
      "Descriptor 1 exceeds the 64-byte limit.",
    );
    expect(button("Save profile").getAttribute("aria-disabled")).toBe("true");

    const rawSave = "provider key sk-live-secret was rejected";
    changeTextarea("Descriptors", "warm\nprecise");
    mocks.putBrandVoiceProfile.mockResolvedValueOnce({
      error: { status: 500, message: rawSave },
    });
    act(() => button("Save profile").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service couldn't complete the request.",
      ),
    );
    expect(document.body.textContent).not.toContain(rawSave);
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Descriptors"]',
      )?.value,
    ).toBe("warm\nprecise");
  });

  it("keeps a verified brand profile readable but immutable for viewers", async () => {
    mocks.canAdmin = false;
    render(<BrandVoicePanel />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Descriptors"]',
        )?.readOnly,
      ).toBe(true),
    );
    expect(document.body.textContent).toContain("Admin access is required");
    expect(button("Save profile").getAttribute("aria-disabled")).toBe("true");
    act(() => button("Save profile").click());
    expect(mocks.putBrandVoiceProfile).not.toHaveBeenCalled();
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("requires verified, ingested voice sources and rejects credential-bearing URLs", async () => {
    mocks.getVoiceProfile.mockResolvedValue({
      data: {
        description: "Verified voice profile",
        generated_at: "2026-08-01T10:00:00Z",
        version: 4,
      },
    });
    mocks.listVoiceSources.mockResolvedValue({
      data: {
        items: [
          {
            id: "pending-source",
            params: { FeedURL: "https://example.test/feed.xml" },
            status: "pending",
          },
        ],
      },
    });
    render(<VoiceProfileCard />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Not ingested yet"),
    );
    expect(button("Rebuild from sources").getAttribute("aria-disabled")).toBe(
      "true",
    );

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Voice feed URL"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "https://user:password@example.test/feed.xml");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    act(() => button("Add URL").click());
    expect(mocks.createVoiceSource).not.toHaveBeenCalled();
  });

  it("never surfaces voice mutation internals and preserves one operation", async () => {
    const raw = "upstream returned token=secret-for-tenant";
    mocks.getVoiceProfile.mockResolvedValue({
      data: { generated_at: "2026-08-01T10:00:00Z", version: 2 },
    });
    mocks.listVoiceSources.mockResolvedValue({
      data: {
        items: [
          {
            id: "source-1",
            params: { FeedURL: "https://example.test/feed.xml" },
            last_ingested_at: "2026-08-01T09:00:00Z",
            last_item_count: 12,
          },
        ],
      },
    });
    mocks.ingestVoiceSource.mockResolvedValue({
      error: { status: 500, message: raw },
    });
    render(<VoiceProfileCard />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("12 items ingested"),
    );
    act(() => {
      button("Re-ingest").click();
      button("Re-ingest").click();
    });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError.mock.calls[0]?.[0]).toBe(
      "The service couldn't complete the request. Retry when ready.",
    );
    expect(String(mocks.toastError.mock.calls[0]?.[0])).not.toContain(raw);
  });

  it("pauses denied execution polling and can verify restored access manually", async () => {
    const raw = "permission denied for tenant secret@example.test";
    mocks.listMCPExecutions.mockResolvedValueOnce({
      error: { status: 403, message: raw },
    });
    render(<RecentExecutionsStrip />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Your current role can't view MCP execution activity.",
      ),
    );
    expect(document.body.textContent).not.toContain(raw);
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        candidate.textContent?.includes("Full history"),
      ),
    ).toBe(false);

    mocks.listMCPExecutions.mockResolvedValueOnce({
      data: {
        tenantId: "tenant-1",
        rows: [
          {
            id: 91,
            tenantId: "tenant-1",
            toolName: "campaign_report",
            method: "POST",
            path: "/api/v1/reports/campaigns",
            statusCode: 302,
            latencyMs: 18,
            costMicros: 0,
            calledAt: "2026-08-08T09:00:00Z",
            userAgent: "postwave-mcp-server/0.1.0",
          },
        ],
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      },
    });
    act(() => button("Check access again").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Redirected · 302"),
    );
    expect(document.querySelector("table")).not.toBeNull();
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("mounts no MCP telemetry owner for a non-admin identity", async () => {
    mocks.canAdmin = false;
    render(<RecentExecutionsStrip />);

    expect(document.body.textContent).toContain(
      "available only to the current workspace's effective admin role",
    );
    expect(mocks.listMCPExecutions).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    expect(mocks.listMCPExecutions).not.toHaveBeenCalled();
  });

  it("zeroizes prior rows before loading a newly observed tenant identity", async () => {
    mocks.listMCPExecutions.mockResolvedValueOnce({
      data: {
        tenantId: "tenant-1",
        rows: [
          {
            id: 81,
            tenantId: "tenant-1",
            toolName: "tenant_one_tool",
            method: "GET",
            path: "/api/v1/subscribers",
            statusCode: 200,
            latencyMs: 12,
            costMicros: 0,
            calledAt: "2026-08-08T09:00:00Z",
            userAgent: "postwave-mcp-server/0.1.0",
          },
        ],
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      },
    });
    const view = render(<RecentExecutionsStrip />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("tenant_one_tool"),
    );

    mocks.tenantId = "tenant-2";
    mocks.listMCPExecutions.mockResolvedValueOnce({
      data: {
        tenantId: "tenant-2",
        rows: [
          {
            id: 82,
            tenantId: "tenant-2",
            toolName: "tenant_two_tool",
            method: "GET",
            path: "/api/v1/campaigns",
            statusCode: 200,
            latencyMs: 10,
            costMicros: 0,
            calledAt: "2026-08-08T09:01:00Z",
            userAgent: "postwave-mcp-server/0.1.0",
          },
        ],
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      },
    });
    view.rerender(<RecentExecutionsStrip />);

    expect(document.body.textContent).not.toContain("tenant_one_tool");
    await waitFor(() =>
      expect(document.body.textContent).toContain("tenant_two_tool"),
    );
  });

  it("rejects a valid minimized envelope bound to another tenant", async () => {
    mocks.listMCPExecutions.mockResolvedValueOnce({
      data: {
        tenantId: "tenant-other",
        rows: [
          {
            id: 83,
            tenantId: "tenant-other",
            toolName: "wrong_tenant_tool",
            method: "GET",
            path: "/api/v1/subscribers",
            statusCode: 200,
            latencyMs: 9,
            costMicros: 0,
            calledAt: "2026-08-08T09:02:00Z",
            userAgent: "postwave-mcp-server/0.1.0",
          },
        ],
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      },
    });
    render(<RecentExecutionsStrip />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The server returned data this app couldn't verify.",
      ),
    );
    expect(document.body.textContent).not.toContain("wrong_tenant_tool");
  });

  it("rejects malformed execution envelopes instead of claiming an empty log", async () => {
    mocks.listMCPExecutions.mockResolvedValue({
      data: { rows: [{ id: 1, method: "GET", statusCode: 200 }] },
    });
    render(<RecentExecutionsStrip />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The server returned data this app couldn't verify.",
      ),
    );
    expect(document.body.textContent).not.toContain("No recent MCP calls");
  });

  it("owns responsive, forced-color CSS and leaves no component inline styles", () => {
    const root = resolve(process.cwd(), "src");
    const components = [
      "components/ai/VoiceProfileCard.tsx",
      "components/ai/BrandVoicePanel.tsx",
      "components/ai/SavedPromptsCard.tsx",
      "components/ai/RecentExecutionsStrip.tsx",
    ];
    for (const file of components) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toContain("style={{");
      expect(source).toContain("styles-postwave-ai-context.css");
    }
    const css = readFileSync(
      resolve(root, "styles-postwave-ai-context.css"),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 680px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
