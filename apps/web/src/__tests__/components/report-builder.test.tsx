// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The builder must let somebody SEE a report before publishing it.
//
// A saved definition is what other people read numbers from. A builder that only
// saves lets somebody publish a report whose output they have never looked at,
// and the API exposes `/reporting/preview` precisely so a draft can be run
// without becoming a definition.

import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const metricRegistry = vi.fn();
const preview = vi.fn();
const saveDefinition = vi.fn();
const getDefinition = vi.fn();
const identity = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin" as const,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};
const whoamiFresh = vi.fn().mockResolvedValue(identity);
vi.mock("@/lib/reporting-api", () => ({
  reportingApi: {
    metricRegistry: (options: unknown) => metricRegistry(options),
    preview: (req: unknown, options: unknown) => preview(req, options),
    saveDefinition: (req: unknown, options: unknown) =>
      saveDefinition(req, options),
    getDefinition: (id: string, options: unknown) => getDefinition(id, options),
  },
}));
vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
  whoamiFresh: (signal?: AbortSignal) => whoamiFresh(signal),
}));
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => createElement("div", null),
}));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));
// analytics-64: the preview's "Download CSV" hands its file to this helper.
const downloadTextFile = vi.fn(
  (_filename: string, _content: string, _mime?: string) => undefined,
);
vi.mock("@/lib/download", () => ({
  downloadTextFile: (filename: string, content: string, mime?: string) =>
    downloadTextFile(filename, content, mime),
}));
vi.mock("@/lib/use-admin-gate", () => ({
  roleCanWrite: (role: string) => role === "owner" || role === "admin",
  useAdminGate: () => ({
    canWrite: true,
    loading: false,
    role: "admin",
    state: "writer",
    identity,
  }),
}));

const { ReportBuilder } =
  await import("@/app/(dashboard)/app/reports/_components/report-builder");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

let host: HTMLDivElement | null = null;
afterEach(() => {
  unmountRoots();
  host?.remove();
  host = null;
  metricRegistry.mockReset();
  preview.mockReset();
  saveDefinition.mockReset();
  getDefinition.mockReset();
  whoamiFresh.mockReset();
  whoamiFresh.mockResolvedValue(identity);
  downloadTextFile.mockClear();
});

async function settle(client: InstanceType<typeof QueryClient>) {
  for (
    let i = 0;
    i < 25 && (client.isFetching() > 0 || client.isMutating() > 0);
    i++
  ) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderBuilder() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = trackRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReportBuilder),
      ),
    );
  });
  await settle(client);
  return { el: host, client };
}

function click(el: HTMLElement) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function change(input: HTMLInputElement, value: string) {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ReportBuilder", () => {
  it("sends the selected metric KEYS to preview", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
      {
        key: "clicks",
        label: "Clicks",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    preview.mockResolvedValue({
      rows: [{ opens: 1 }],
      computed_as_of: "2026-08-12T06:00:00Z",
    });

    const { el, client } = await renderBuilder();
    const boxes = el.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[0]!);
    const buttons = [...el.querySelectorAll("button")];
    const previewBtn = buttons.find((b) => b.textContent?.includes("Preview"))!;
    await click(previewBtn);
    await settle(client);

    // `key`, not `id` — the gateway's own field name. The first version of the
    // web client declared `id`, which would have sent {id: "opens"} and had
    // every metric read as undefined server-side.
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: [{ key: "opens" }] }),
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(el.textContent).toContain("2026-08-12T06:00:00Z");
  });

  it("refuses to save a report with no name", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    const { el } = await renderBuilder();
    await click(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!);

    const saveBtn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save"),
    )!;
    // A nameless report is unfindable in the saved list. Refusing is kinder
    // than saving something nobody can locate afterwards.
    expect(saveBtn.disabled).toBe(true);
    await click(saveBtn);
    expect(saveDefinition).not.toHaveBeenCalled();
  });

  it("drops a stale preview when the selection changes", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
      {
        key: "clicks",
        label: "Clicks",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    preview.mockResolvedValue({
      rows: [{ opens: 1 }],
      computed_as_of: "2026-08-12T06:00:00Z",
    });

    const { el, client } = await renderBuilder();
    const boxes = el.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[0]!);
    await click(
      [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Preview"),
      )!,
    );
    await settle(client);
    expect(el.textContent).toContain("1 row");

    // Changing the selection must clear it: numbers left on screen under a
    // changed definition describe a report that is no longer the one above them.
    await click(boxes[1]!);
    expect(el.textContent).not.toContain("1 row");
  });

  it("takes a synchronous lock before fresh authority resolves", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    let releaseAuthority!: () => void;
    whoamiFresh.mockReturnValue(
      new Promise((resolve) => {
        releaseAuthority = () => resolve(identity);
      }),
    );
    preview.mockResolvedValue({ rows: [] });
    const { el, client } = await renderBuilder();
    await click(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const button = [...el.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Preview"),
    )!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(whoamiFresh).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();

    releaseAuthority();
    await settle(client);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("refuses save when fresh authority was downgraded", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    whoamiFresh.mockResolvedValue({ ...identity, role: "viewer" });
    const { el, client } = await renderBuilder();
    await click(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await change(el.querySelector<HTMLInputElement>("#report-name")!, "Risk");
    const save = [...el.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Save report"),
    )!;
    await click(save);
    await settle(client);

    expect(saveDefinition).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Could not save this report");
  });

  it("offers Download CSV of exactly the previewed rows (analytics-64)", async () => {
    metricRegistry.mockResolvedValue([
      {
        key: "opens",
        label: "Opens",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
      {
        key: "clicks",
        label: "Clicks",
        product_area: "campaigns",
        aggregation: "sum",
        value_type: "int",
        runtime_status: "supported",
      },
    ]);
    preview.mockResolvedValue({
      rows: [
        { opens: 120, clicks: 7 },
        { opens: 3, clicks: 1 },
      ],
      computed_as_of: "2026-08-12T06:00:00Z",
    });

    const { el, client } = await renderBuilder();
    const downloadButton = () =>
      [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Download CSV"),
      );
    // Nothing to export before a preview has run.
    expect(downloadButton()).toBeUndefined();

    await change(
      el.querySelector<HTMLInputElement>("#report-name")!,
      "Weekly engagement",
    );
    const boxes = el.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[0]!);
    await click(boxes[1]!);
    await click(
      [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Preview"),
      )!,
    );
    await settle(client);

    const section = el.querySelector('[aria-labelledby="report-preview-title"]');
    const button = downloadButton();
    expect(button).toBeDefined();
    expect(section?.contains(button!)).toBe(true);
    expect(button?.textContent).toContain("(2 rows)");
    expect(button?.disabled).toBe(false);

    await click(button!);
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, content, mime] = downloadTextFile.mock.calls[0]!;
    expect(filename).toMatch(/^weekly-engagement/);
    expect(filename).toMatch(/\.csv$/);
    expect(mime).toBe("text/csv;charset=utf-8");
    // Header in the preview table's column order, then the on-screen rows.
    expect(content.split(/\r?\n/).filter(Boolean)).toEqual([
      "opens,clicks",
      "120,7",
      "3,1",
    ]);
    // Client-side: the download makes no request of its own.
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
