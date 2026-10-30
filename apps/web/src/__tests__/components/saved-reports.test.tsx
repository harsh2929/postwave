// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The row's own Proof, as a test: a report saved elsewhere must open here with
// the SAME metric ids and filters, and with an as-of stamp.
//
// A report is a claim about the business. Two surfaces showing one saved report
// with different metrics — or with no statement of what it measured — is how two
// people leave a meeting having agreed on different numbers.

import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listDefinitions = vi.fn();
const listRuns = vi.fn();
const runDefinition = vi.fn();
const getDefinition = vi.fn();
const getRun = vi.fn();
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
    listDefinitions: (options: unknown) => listDefinitions(options),
    listRuns: (options: unknown) => listRuns(options),
    getDefinition: (id: string, options: unknown) => getDefinition(id, options),
    getRun: (id: string, options: unknown) => getRun(id, options),
    run: (id: string, options: unknown) => runDefinition(id, options),
  },
}));
vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
  whoamiFresh: (signal?: AbortSignal) => whoamiFresh(signal),
}));
vi.mock("@/components/relative-time", () => ({
  RelativeTime: ({ iso }: { iso: string }) => createElement("time", null, iso),
}));
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => createElement("div", null),
}));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));
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

const { SavedReports } =
  await import("@/app/(dashboard)/app/reports/_components/saved-reports");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

let host: HTMLDivElement | null = null;
afterEach(() => {
  unmountRoots();
  host?.remove();
  host = null;
  listDefinitions.mockReset();
  listRuns.mockReset();
  runDefinition.mockReset();
  getDefinition.mockReset();
  getRun.mockReset();
  whoamiFresh.mockReset();
  whoamiFresh.mockResolvedValue(identity);
});

async function renderReports() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = trackRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SavedReports),
      ),
    );
  });
  // isFetching() === 0 says the data landed, not that React re-rendered with
  // it, so each poll is wrapped in act — the same trap this repo has recorded
  // against three other web tests.
  for (let i = 0; i < 20 && client.isFetching() > 0; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

async function settleAsyncWork(turns = 10) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("SavedReports", () => {
  it("shows the saved metric ids, filters and metric version", async () => {
    listDefinitions.mockResolvedValue([
      {
        id: "r1",
        name: "Weekly engagement",
        description: "",
        product_area: "campaigns",
        status: "active",
        metrics: [{ key: "opens" }, { key: "clicks" }],
        dimensions: [],
        filters: { list_id: "abc" },
        time_range: {},
        visualization: "table",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        metric_version: "mv_9f2c",
      },
    ]);

    const text = (await renderReports()).textContent ?? "";
    // The Proof's exact terms: identical metric ids and filters.
    expect(text).toContain("opens, clicks");
    expect(text).toContain("list_id");
    expect(text).toContain("mv_9f2c");
  });

  it("says 'unknown' for a definition saved before provenance existed", async () => {
    listDefinitions.mockResolvedValue([
      {
        id: "r2",
        name: "Legacy report",
        description: "",
        product_area: "campaigns",
        status: "active",
        metrics: [{ key: "opens" }],
        dimensions: [],
        filters: {},
        time_range: {},
        visualization: "table",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const text = (await renderReports()).textContent ?? "";
    // A missing stamp and a fresh one must not look alike: omitting the row
    // would make an unprovenanced report indistinguishable from a stamped one.
    expect(text).toContain("unknown");
  });

  it("runs a saved definition through its real nested action", async () => {
    listDefinitions.mockResolvedValue([
      {
        id: "r3",
        name: "Run me",
        description: "",
        product_area: "campaigns",
        status: "active",
        metrics: [{ key: "opens" }],
        dimensions: [],
        filters: {},
        time_range: {},
        visualization: "table",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
      },
    ]);
    const definition = {
      id: "r3",
      name: "Run me",
      description: "",
      product_area: "campaigns",
      status: "active",
      metrics: [{ key: "opens" }],
      dimensions: [],
      filters: {},
      time_range: {},
      visualization: "table",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-10T00:00:00Z",
    };
    getDefinition.mockResolvedValue(definition);
    runDefinition.mockResolvedValue({
      id: "run-3",
      definition_id: "r3",
      status: "queued",
      rows: [],
    });
    getRun.mockResolvedValue({
      id: "run-3",
      definition_id: "r3",
      status: "queued",
      rows: [],
    });

    const rendered = await renderReports();
    const button = Array.from(rendered.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Run",
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(runDefinition).toHaveBeenCalledWith(
      "r3",
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("locks synchronously and refuses a definition that changed", async () => {
    const opened = {
      id: "r4",
      name: "Authority report",
      description: "",
      product_area: "campaigns",
      status: "active",
      metrics: [{ key: "opens" }],
      dimensions: [],
      filters: {},
      time_range: {},
      visualization: "table",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-10T00:00:00Z",
    };
    listDefinitions.mockResolvedValue([opened]);
    let releaseAuthority!: () => void;
    whoamiFresh.mockReturnValue(
      new Promise((resolve) => {
        releaseAuthority = () => resolve(identity);
      }),
    );
    getDefinition.mockResolvedValue({
      ...opened,
      updated_at: "2026-08-11T00:00:00Z",
    });

    const rendered = await renderReports();
    const button = [...rendered.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Run",
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(whoamiFresh).toHaveBeenCalledTimes(1);

    releaseAuthority();
    await settleAsyncWork();
    expect(runDefinition).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain("Could not run that report");
  });
});

const { RecentRuns } =
  await import("@/app/(dashboard)/app/reports/_components/recent-runs");

async function renderRuns() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = trackRoot(host);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RecentRuns)),
    );
  });
  for (let i = 0; i < 20 && client.isFetching() > 0; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe("RecentRuns", () => {
  it("shows the AS-OF stamp, which is what makes a number interpretable", async () => {
    listRuns.mockResolvedValue([
      {
        id: "run-1",
        definition_id: "r1",
        status: "succeeded",
        rows: [],
        metric_version: "mv_9f2c",
        computed_as_of: "2026-08-12T06:00:00Z",
      },
    ]);
    const text = (await renderRuns()).textContent ?? "";
    expect(text).toContain("2026-08-12T06:00:00Z");
    expect(text).toContain("mv_9f2c");
  });

  it("says 'unknown' rather than hiding a run with no provenance", async () => {
    listRuns.mockResolvedValue([
      { id: "run-2", status: "succeeded", rows: [] },
    ]);
    const text = (await renderRuns()).textContent ?? "";
    // An un-backfilled historical run is honest as "unknown"; an invented
    // timestamp would be indistinguishable from a real one.
    expect(text).toContain("unknown");
  });
});
