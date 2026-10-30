// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { useMigrationWizardRuntime } from "../../components/migration/useMigrationWizardRuntime";
import {
  api,
  type MigrationJob,
  type MigrationPreview,
  type MigrationSource,
} from "../../lib/api-client";
import type { MigrationSourceDef } from "../../lib/migration-sources";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let runPreview:
  | ((source: MigrationSource, id: string) => Promise<void>)
  | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(api, "listMigrationSources").mockResolvedValue({ data: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  runPreview = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function Harness(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [, setJob] = useState<MigrationJob | null>(null);
  const [, setOAuthWaiting] = useState(false);
  const [, setPreview] = useState<MigrationPreview | null>(null);
  const [, setSource] = useState<MigrationSourceDef | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const runtime = useMigrationWizardRuntime({
    setBusy,
    setJob,
    setOAuthWaiting,
    setPreview,
    setSource,
    setStepError,
  });
  runPreview = runtime.runPreview;
  return (
    <>
      <output aria-label="busy state">{busy ? "busy" : "idle"}</output>
      <output aria-label="step error">{stepError ?? "none"}</output>
    </>
  );
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

it("settles busy state and avoids polling when a dry-run acknowledgement is null", async () => {
  const preview = vi.spyOn(api, "previewMigration").mockResolvedValue(
    { data: null } as unknown as Awaited<
      ReturnType<typeof api.previewMigration>
    >,
  );
  const poll = vi.spyOn(api, "getMigration").mockResolvedValue({
    error: { kind: "parse", message: "poll should not start" },
  });
  render();

  await act(async () => {
    await runPreview?.("klaviyo", "job_1");
  });

  expect(preview).toHaveBeenCalledWith("klaviyo", "job_1", undefined);
  expect(poll).not.toHaveBeenCalled();
  expect(
    container?.querySelector('[aria-label="busy state"]')?.textContent,
  ).toBe("idle");
  expect(
    container?.querySelector('[aria-label="step error"]')?.textContent,
  ).not.toBe("none");
});
