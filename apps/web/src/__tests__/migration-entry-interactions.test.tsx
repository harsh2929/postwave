// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectWithApiKey: vi.fn(),
  errorToast: vi.fn(),
  mockMode: false,
  startOAuth: vi.fn(),
  successToast: vi.fn(),
  uploadMigrationFile: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("@/lib/migration-api", () => ({
  connectWithApiKey: mocks.connectWithApiKey,
  startOAuth: mocks.startOAuth,
  uploadMigrationFile: mocks.uploadMigrationFile,
}));

vi.mock("@/lib/mock-mode", () => ({
  isMockModeEnabled: () => mocks.mockMode,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.errorToast,
    success: mocks.successToast,
  },
}));

import {
  ConnectStep,
  migrationFileSelectionError,
} from "@/app/(dashboard)/app/migrations/new/[source]/connect-step";
import { SourceCatalog } from "@/app/(dashboard)/app/migrations/_source-catalog";
import { mockCapabilities } from "@/lib/migration-mocks";
import type { MeResponse } from "@/lib/auth-api";

const ADMIN_IDENTITY: MeResponse = {
  user_id: "usr_admin",
  tenant_id: "tnt_1",
  email: "admin@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const AUTHORITY_PROPS = {
  identity: ADMIN_IDENTITY,
  authorityKey: "tnt_1:usr_admin:admin:member",
  beforeWrite: (signal?: AbortSignal) =>
    mocks.verifyFreshAdminAuthority(ADMIN_IDENTITY, signal),
} as const;

const ADMIN_IDENTITY_B: MeResponse = {
  ...ADMIN_IDENTITY,
  user_id: "usr_admin_b",
  tenant_id: "tnt_2",
  email: "admin-b@example.com",
  workspace_name: "Workspace B",
  workspace_slug: "workspace-b",
};

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function render(ui: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(ui));
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyFreshAdminAuthority.mockResolvedValue(ADMIN_IDENTITY);
  mocks.mockMode = false;
  sessionStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("migration entry interactions", () => {
  it("starts OAuth once, rejects an unsafe destination, and leaves no replay marker", async () => {
    const request = deferred<{ authorize_url: string; state: string }>();
    mocks.startOAuth.mockReturnValue(request.promise);
    const onConnected = vi.fn();
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="mailchimp"
        authMethod="oauth2"
        desktopReturn
        onConnected={onConnected}
      />,
    );
    const button = rendered.querySelector("button")!;

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.startOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.verifyFreshAdminAuthority).toHaveBeenCalledTimes(1);
    expect(
      mocks.verifyFreshAdminAuthority.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.startOAuth.mock.invocationCallOrder[0]!);
    expect(button.textContent).toContain("Opening connection");

    await act(async () => {
      request.resolve({
        authorize_url: "javascript:alert(document.cookie)",
        state: "state-1",
      });
      await request.promise;
      await Promise.resolve();
    });

    const alert = rendered.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("unsafe OAuth URL");
    expect(document.activeElement).toBe(alert);
    expect(sessionStorage.getItem("postwave:oauth-pending")).toBeNull();
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("locks API credentials per attempt, focuses failure, and retries with the edited workspace binding", async () => {
    const failed = deferred<{ job_id: string; account_id: string }>();
    const retried = deferred<{ job_id: string; account_id: string }>();
    mocks.connectWithApiKey
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    const onConnected = vi.fn();
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="customerio"
        authMethod="api_key"
        onConnected={onConnected}
      />,
    );
    const credential = rendered.querySelector<HTMLInputElement>("#api-key")!;
    const workspace = rendered.querySelector<HTMLInputElement>("#account-id")!;
    const region =
      rendered.querySelector<HTMLSelectElement>("#customerio-region")!;
    const form = rendered.querySelector("form")!;

    changeInput(credential, "  app-secret  ");
    changeInput(workspace, " 12345 ");
    await act(async () => {
      region.value = "eu";
      region.dispatchEvent(new Event("change", { bubbles: true }));
      form.requestSubmit();
      form.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.connectWithApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.verifyFreshAdminAuthority).toHaveBeenCalledTimes(1);
    expect(mocks.connectWithApiKey).toHaveBeenCalledWith(
      "customerio",
      "app-secret",
      "12345",
      { region: "eu" },
      expect.anything(),
    );

    await act(async () => {
      failed.reject(new Error("Workspace token was rejected"));
      await failed.promise.catch(() => undefined);
      await Promise.resolve();
    });
    const alert = rendered.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Workspace token was rejected");
    expect(document.activeElement).toBe(alert);

    changeInput(credential, "replacement-secret");
    expect(rendered.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.connectWithApiKey).toHaveBeenCalledTimes(2);

    await act(async () => {
      retried.resolve({ job_id: "job-customerio", account_id: "12345" });
      await retried.promise;
      await Promise.resolve();
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith("job-customerio");
  });

  it("fails closed before sending credentials when fresh admin authority changed", async () => {
    mocks.verifyFreshAdminAuthority.mockRejectedValueOnce(
      new Error(
        "Workspace identity or authority changed. Nothing was written; reload and retry.",
      ),
    );
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="convertkit"
        authMethod="api_key"
        onConnected={vi.fn()}
      />,
    );
    changeInput(
      rendered.querySelector<HTMLInputElement>("#api-key")!,
      "secret",
    );

    await act(async () => {
      rendered.querySelector("form")?.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.connectWithApiKey).not.toHaveBeenCalled();
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      "authority changed",
    );
  });

  it("aborts and ignores an old credential response when the authority key changes", async () => {
    const request = deferred<{ job_id: string; account_id: string }>();
    mocks.connectWithApiKey.mockReturnValue(request.promise);
    const onConnected = vi.fn();
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="convertkit"
        authMethod="api_key"
        onConnected={onConnected}
      />,
    );
    changeInput(
      rendered.querySelector<HTMLInputElement>("#api-key")!,
      "old-secret",
    );
    await act(async () => {
      rendered.querySelector("form")?.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.connectWithApiKey).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <ConnectStep
          source="convertkit"
          authMethod="api_key"
          onConnected={onConnected}
          identity={ADMIN_IDENTITY_B}
          authorityKey="tnt_2:usr_admin_b:admin:member"
          beforeWrite={(signal) =>
            mocks.verifyFreshAdminAuthority(ADMIN_IDENTITY_B, signal)
          }
        />,
      );
    });
    expect(rendered.querySelector<HTMLInputElement>("#api-key")?.value).toBe(
      "",
    );

    await act(async () => {
      request.resolve({ job_id: "job_old", account_id: "old" });
      await request.promise;
      await Promise.resolve();
    });
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("rejects empty and wrong-type exports before upload", () => {
    expect(
      migrationFileSelectionError("csv", { name: "contacts.csv", size: 0 }),
    ).toContain("isn't empty");
    expect(
      migrationFileSelectionError("csv", { name: "contacts.exe", size: 42 }),
    ).toBe("Choose a CSV file.");
    expect(
      migrationFileSelectionError("substack", {
        name: "official-export.zip",
        size: 42,
      }),
    ).toBeNull();
    expect(
      migrationFileSelectionError("substack", {
        name: "official-export.json",
        size: 42,
      }),
    ).toContain("Substack ZIP");
  });

  it("locks a Substack upload, preserves the file for recovery, and focuses upload failure", async () => {
    const failed = deferred<{ job_id: string; account_id: string }>();
    const retried = deferred<{ job_id: string; account_id: string }>();
    mocks.uploadMigrationFile
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    const onConnected = vi.fn();
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="substack"
        authMethod="csv_upload"
        onConnected={onConnected}
      />,
    );
    const input =
      rendered.querySelector<HTMLInputElement>('input[type="file"]')!;
    await selectFile(
      input,
      new File(["not-an-archive"], "substack-export.exe", {
        type: "application/octet-stream",
      }),
    );
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      "Substack ZIP",
    );
    expect(mocks.uploadMigrationFile).not.toHaveBeenCalled();

    await selectFile(
      input,
      new File(["zip-content"], "substack-export.zip", {
        type: "application/zip",
      }),
    );
    const useFile = Array.from(rendered.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Use this file"),
    )!;
    await act(async () => {
      useFile.click();
      useFile.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.uploadMigrationFile).toHaveBeenCalledTimes(1);
    expect(mocks.verifyFreshAdminAuthority).toHaveBeenCalledTimes(1);
    expect(rendered.textContent).toContain("substack-export.zip");

    await act(async () => {
      failed.reject(new Error("Upload connection was interrupted"));
      await failed.promise.catch(() => undefined);
      await Promise.resolve();
    });
    const alert = rendered.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Upload connection was interrupted");
    expect(document.activeElement).toBe(alert);
    expect(rendered.textContent).toContain("substack-export.zip");

    const retry = Array.from(rendered.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Use this file"),
    )!;
    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.uploadMigrationFile).toHaveBeenCalledTimes(2);
    await act(async () => {
      retried.resolve({ job_id: "job-substack", account_id: "archive" });
      await retried.promise;
      await Promise.resolve();
    });
    expect(onConnected).toHaveBeenCalledWith("job-substack");
  });

  it("cancels a stale CSV header read when a newer invalid selection wins", async () => {
    const slowHeader = deferred<string>();
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="csv"
        authMethod="csv_upload"
        onConnected={vi.fn()}
      />,
    );
    const input =
      rendered.querySelector<HTMLInputElement>('input[type="file"]')!;
    const slowFile = {
      name: "slow.csv",
      size: 24,
      slice: () => ({ text: () => slowHeader.promise }),
    } as unknown as File;

    await selectFile(input, slowFile);
    expect(rendered.textContent).toContain("Reading columns");
    await selectFile(
      input,
      new File(["not-csv"], "newer-selection.exe", {
        type: "application/octet-stream",
      }),
    );
    expect(rendered.textContent).not.toContain("Reading columns");
    expect(rendered.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose a CSV file.",
    );

    await act(async () => {
      slowHeader.resolve("email,name");
      await slowHeader.promise;
      await Promise.resolve();
    });
    expect(rendered.textContent).not.toContain("Confirm columns");
    expect(rendered.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose a CSV file.",
    );
  });

  it("fails closed on empty and pathological CSV headers", async () => {
    const rendered = render(
      <ConnectStep
        {...AUTHORITY_PROPS}
        source="csv"
        authMethod="csv_upload"
        onConnected={vi.fn()}
      />,
    );
    const input =
      rendered.querySelector<HTMLInputElement>('input[type="file"]')!;

    await selectFile(
      input,
      new File(["\n"], "empty-header.csv", { type: "text/csv" }),
    );
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      "No columns were detected",
    );
    expect(mocks.uploadMigrationFile).not.toHaveBeenCalled();

    const tooManyColumns = Array.from(
      { length: 2_001 },
      (_, index) => `column_${index}`,
    ).join(",");
    await selectFile(
      input,
      new File([`${tooManyColumns}\n`], "too-wide.csv", { type: "text/csv" }),
    );
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      "2,001 columns",
    );
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      "2,000 columns or fewer",
    );
    expect(rendered.textContent).not.toContain("Confirm columns");
    expect(mocks.uploadMigrationFile).not.toHaveBeenCalled();
  });

  it("makes source-card controls unambiguous and search recovery one tap", () => {
    const rendered = render(
      <SourceCatalog
        capabilities={mockCapabilities()}
        authorityKey="tnt_1:usr_admin:admin:member"
        canAdmin
      />,
    );
    expect(
      rendered.querySelector('[aria-label="Klaviyo migration guide"]'),
    ).not.toBeNull();
    expect(
      rendered.querySelector('[aria-label="Connect Klaviyo migration"]'),
    ).not.toBeNull();
    const details = rendered.querySelector<HTMLButtonElement>(
      '[aria-label="Klaviyo details"]',
    )!;
    act(() => details.click());
    expect(details.getAttribute("aria-label")).toBe("Klaviyo show less");
    expect(details.getAttribute("aria-expanded")).toBe("true");

    const search = rendered.querySelector<HTMLInputElement>(
      '[aria-label="Search migration sources"]',
    )!;
    changeInput(search, "no-provider-has-this-name");
    expect(rendered.textContent).toContain(
      "No sources match “no-provider-has-this-name”",
    );
    const clear = rendered.querySelector<HTMLButtonElement>(
      '[aria-label="Clear migration source search"]',
    )!;
    act(() => clear.click());
    expect(search.value).toBe("");
    expect(rendered.querySelectorAll('[data-testid^="source-"]')).toHaveLength(
      mockCapabilities().length,
    );
    expect(document.activeElement).toBe(search);
  });
});
