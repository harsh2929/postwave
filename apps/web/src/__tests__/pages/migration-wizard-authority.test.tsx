// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  clearMigrationUploadLedgers: vi.fn(),
  discover: vi.fn(),
  dryRun: vi.fn(),
  getJob: vi.fn(),
  getVerification: vi.fn(),
  listCapabilities: vi.fn(),
  search: new URLSearchParams(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mocks.search,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});

vi.mock("@/lib/migration-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/migration-api")>();
  return {
    ...actual,
    clearMigrationUploadLedgers: mocks.clearMigrationUploadLedgers,
    discover: mocks.discover,
    dryRun: mocks.dryRun,
    getJob: mocks.getJob,
    getVerification: mocks.getVerification,
    listCapabilities: mocks.listCapabilities,
  };
});

import NewMigrationWizardPage from "@/app/(dashboard)/app/migrations/new/[source]/page";
import { qk } from "@/lib/query-keys";
import { mockCapabilities } from "@/lib/migration-mocks";
import type { MeResponse } from "@/lib/auth-api";
import type {
  DiscoveryReport,
  MigrationJob,
  SourcePlatform,
} from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// The wizard loads its steps and side panels with React.lazy. Import each of
// them in a hook, on the cold-import timeout: a panel still loading when its
// test unmounts would otherwise resolve later, and React logs "A suspended
// resource finished loading" into a following test, or after the file has
// ended through a worker that may already be closed, which fails the run.
importBeforeTests(
  () => import("@/components/migration/activecampaign-session-reconnect-card"),
  () => import("@/app/(dashboard)/app/migrations/new/[source]/connect-step"),
  () => import("@/app/(dashboard)/app/migrations/_cross-links"),
  () => import("@/app/(dashboard)/app/migrations/new/[source]/import-step"),
  () => import("@/components/migration/resource-completeness"),
  () => import("@/app/(dashboard)/app/migrations/new/[source]/review-only-alert"),
  () => import("@/app/(dashboard)/app/migrations/new/[source]/review-step"),
);

const ADMIN_A: MeResponse = {
  user_id: "usr_a",
  tenant_id: "tnt_a",
  email: "a@example.com",
  role: "owner",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace A",
  workspace_slug: "workspace-a",
};

const ADMIN_B: MeResponse = {
  ...ADMIN_A,
  user_id: "usr_b",
  tenant_id: "tnt_b",
  email: "b@example.com",
  workspace_name: "Workspace B",
  workspace_slug: "workspace-b",
};

const EDITOR: MeResponse = {
  ...ADMIN_A,
  role: "owner",
  effective_role: "editor",
};

const VIEWER_MODE: MeResponse = {
  ...ADMIN_A,
  effective_role: "viewer",
  viewer_mode: true,
};

const DISCOVERY: DiscoveryReport = {
  source: "convertkit",
  subscribers_count: 100,
  segments_count: 3,
  automations_count: 2,
  archive_count: 4,
  paid_subs_count: 0,
  custom_fields: ["first_name"],
  warnings: [],
};

const JOB: MigrationJob = {
  id: "job_1",
  tenant_id: "tnt_a",
  source: "convertkit",
  status: "awaiting_confirmation",
  progress: {
    subscribers_total: 0,
    subscribers_done: 0,
    segments_total: 0,
    segments_done: 0,
    automations_total: 0,
    automations_done: 0,
    paid_subs_total: 0,
    paid_subs_done: 0,
    archive_total: 0,
    archive_done: 0,
  },
  cursor: {},
  started_at: "2026-09-04T00:00:00.000Z",
  completed_at: null,
  rollback_until: null,
  source_session_expires_at: "2099-01-01T00:00:00.000Z",
  verification_report: null,
  error: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function render(ui: ReactNode): QueryClient {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(QueryClientProvider, { client: queryClient! }, ui),
    );
  });
  return queryClient;
}

function wizard(source: SourcePlatform = "activecampaign") {
  const value = { source };
  // React's `use(params)` understands an already-fulfilled thenable. Next
  // supplies this shape to the page at runtime; mirroring it keeps this unit
  // test synchronous without exporting a non-page symbol from page.tsx.
  const params = Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
  return createElement(NewMigrationWizardPage, { params });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = new URLSearchParams();
  mocks.listCapabilities.mockResolvedValue(mockCapabilities());
  mocks.discover.mockResolvedValue(DISCOVERY);
  mocks.dryRun.mockResolvedValue({ job_id: "job_dry_run" });
  mocks.getJob.mockResolvedValue(JOB);
  mocks.getVerification.mockReturnValue(new Promise(() => {}));
  mocks.whoamiFresh.mockResolvedValue(ADMIN_A);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  queryClient?.clear();
  container?.remove();
  root = null;
  container = null;
  queryClient = null;
});

describe("new migration wizard authority", () => {
  it("does not request protected capabilities until admin identity resolves and uses the effective scoped key", async () => {
    const auth = deferred<MeResponse>();
    mocks.whoami.mockReturnValue(auth.promise);
    const client = render(wizard());

    expect(document.body.textContent).toContain("Checking migration access");
    expect(mocks.listCapabilities).not.toHaveBeenCalled();

    await act(async () => {
      auth.resolve(ADMIN_A);
      await auth.promise;
      await flush();
    });
    await waitFor(() => {
      expect(mocks.listCapabilities).toHaveBeenCalledTimes(1);
    });

    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual([
      "migrations",
      "tnt_a",
      "admin",
      "usr_a",
      "member",
      "capabilities",
    ]);
  });

  it.each([
    [EDITOR, "effective editor role"],
    [VIEWER_MODE, "Viewer mode is active"],
  ])(
    "keeps protected reads off for read-only identity %#",
    async (identity, copy) => {
      mocks.whoami.mockResolvedValue(identity);
      const client = render(wizard());
      client.setQueryData(["migrations", "stale-secret"], { secret: true });

      await waitFor(() => {
        expect(document.body.textContent).toContain(copy);
      });
      expect(mocks.listCapabilities).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(
          client
            .getQueryCache()
            .find({ queryKey: ["migrations", "stale-secret"], exact: true }),
        ).toBeUndefined();
      });
    },
  );

  it("renders an authentication error separately and retries before loading protected data", async () => {
    mocks.whoami
      .mockRejectedValueOnce(new Error("Session verification unavailable"))
      .mockResolvedValueOnce(ADMIN_A);
    render(wizard());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Couldn’t verify migration access",
      );
      expect(document.body.textContent).toContain(
        "Session verification unavailable",
      );
    });
    expect(mocks.listCapabilities).not.toHaveBeenCalled();

    await act(async () => {
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Retry access check"),
      );
      retry?.click();
      await flush();
    });
    await waitFor(() => {
      expect(mocks.listCapabilities).toHaveBeenCalledTimes(1);
    });
  });

  it("purges old privileged cache and credential state when user or tenant changes", async () => {
    mocks.whoami.mockResolvedValue(ADMIN_A);
    const client = render(wizard());
    await waitFor(() => {
      expect(document.querySelector("#api-key")).toBeInstanceOf(
        HTMLInputElement,
      );
    });
    const credential = document.querySelector<HTMLInputElement>("#api-key")!;
    changeInput(credential, "tenant-a-secret");
    expect(credential.value).toBe("tenant-a-secret");
    const oldKey = [
      "migrations",
      "tnt_a",
      "admin",
      "usr_a",
      "member",
      "private-discovery",
    ] as const;
    client.setQueryData(oldKey, { private: true });
    sessionStorage.setItem("postwave:oauth-pending", "stale");

    await act(async () => {
      client.setQueryData(qk.authMe(), ADMIN_B);
      await flush();
    });
    await waitFor(() => {
      expect(mocks.listCapabilities).toHaveBeenCalledTimes(2);
      expect(document.querySelector<HTMLInputElement>("#api-key")?.value).toBe(
        "",
      );
      expect(
        client.getQueryCache().find({ queryKey: oldKey, exact: true }),
      ).toBeUndefined();
    });
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBeNull();
    expect(mocks.clearMigrationUploadLedgers).toHaveBeenCalled();
  });

  it("fresh-checks automatic discovery and single-flights a frozen dry-run intent", async () => {
    mocks.search = new URLSearchParams("step=discover&job_id=job_1");
    mocks.whoami.mockResolvedValue(ADMIN_A);
    mocks.discover.mockResolvedValue({
      ...DISCOVERY,
      source: "mailchimp",
      audiences: [{ id: "aud_1", name: "Newsletter", subscribers_total: 100 }],
    });
    render(wizard("mailchimp"));

    await waitFor(() => {
      const selectAll = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Select all"),
      );
      expect(selectAll).toBeDefined();
    });
    act(() => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Select all"))
        ?.click();
    });

    let run: HTMLButtonElement | undefined;
    await waitFor(() => {
      run = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Run dry-run"),
      );
      expect(run).toBeDefined();
      expect(run?.disabled).toBe(false);
      expect(mocks.discover).toHaveBeenCalledTimes(1);
    });
    expect(mocks.discover).toHaveBeenCalledWith(
      "mailchimp",
      "job_1",
      undefined,
      expect.anything(),
    );
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      run?.click();
      run?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.dryRun).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dryRun).toHaveBeenCalledWith(
      "mailchimp",
      "job_1",
      expect.any(Array),
      expect.anything(),
    );
    // Initial discovery, the frozen Mailchimp audience re-discovery, and the
    // dry-run itself each cross a separate last-moment authority boundary.
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(3);
  });

  it("stops before dry-run transport when fresh effective authority changed", async () => {
    mocks.search = new URLSearchParams("step=discover&job_id=job_1");
    mocks.whoami.mockResolvedValue(ADMIN_A);
    mocks.whoamiFresh
      .mockResolvedValueOnce(ADMIN_A)
      .mockResolvedValueOnce(EDITOR);
    sessionStorage.setItem("postwave:oauth-pending", "old-admin-flow");
    const client = render(wizard("convertkit"));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Run dry-run");
    });

    await act(async () => {
      const run = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Run dry-run"),
      );
      run?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
    expect(mocks.dryRun).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Owner or admin access required",
      );
    });
    expect(document.body.textContent).not.toContain("Run dry-run");
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBeNull();
    expect(mocks.clearMigrationUploadLedgers).toHaveBeenCalled();
    expect(
      client
        .getQueryCache()
        .findAll()
        .some((query) => query.queryKey[0] === "migrations"),
    ).toBe(false);
  });
});
