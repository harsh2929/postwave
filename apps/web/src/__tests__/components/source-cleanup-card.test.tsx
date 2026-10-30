// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceCleanupCard } from "@/components/migration/source-cleanup-card";
import type { MigrationJob } from "@/lib/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/migration-api", () => ({
  removeMigrationSourceData: mocks.remove,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
const job = {
  id: "job-a",
  source: "convertkit",
  status: "completed",
} as MigrationJob;

async function render(
  props: {
    beforeWrite?: (signal?: AbortSignal) => Promise<void>;
    onRemoved?: (job: MigrationJob) => void;
    authorityKey?: string;
  } = {},
) {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () =>
    root!.render(
      createElement(SourceCleanupCard, {
        job,
        authorityKey: "tenant:admin",
        beforeWrite: async () => undefined,
        onRemoved: vi.fn(),
        ...props,
      }),
    ),
  );
}
async function confirmAndRemove() {
  await act(async () =>
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click(),
  );
  await act(async () =>
    (document.querySelector("button") as HTMLButtonElement).click(),
  );
}

describe("source cleanup", () => {
  it("requires a deliberate selection and reports local removal without claiming provider revocation", async () => {
    const beforeWrite = vi.fn().mockResolvedValue(undefined),
      onRemoved = vi.fn();
    const updated = { ...job, source_session_expires_at: null };
    mocks.remove.mockResolvedValue({
      job: updated,
      stored_source_data_removed: true,
      provider_access_revoked: false,
    });
    await render({ beforeWrite, onRemoved });
    expect(
      (document.querySelector("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    await confirmAndRemove();
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith("job-a", expect.any(AbortSignal));
    expect(onRemoved).toHaveBeenCalledWith(updated);
    expect(document.body.textContent).toContain(
      "also revoke the migration key or disconnect the authorized app",
    );
    expect(document.body.textContent).toContain("have been removed");
  });
  it("does not erase data when fresh authority verification fails", async () => {
    await render({
      beforeWrite: async () => {
        throw new Error("Workspace changed");
      },
    });
    await confirmAndRemove();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });
  it("discards a response from a previous workspace", async () => {
    let resolve!: (value: unknown) => void;
    mocks.remove.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const onRemoved = vi.fn();
    await render({ onRemoved });
    await confirmAndRemove();
    await render({ authorityKey: "other:admin", onRemoved });
    await act(async () =>
      resolve({
        job,
        stored_source_data_removed: true,
        provider_access_revoked: false,
      }),
    );
    expect(onRemoved).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
