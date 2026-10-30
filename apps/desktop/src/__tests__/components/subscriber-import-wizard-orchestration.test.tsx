// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriberImportPreview } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  remap: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  progressUrl: vi.fn(),
  pick: vi.fn(),
  completeTransfer: vi.fn(),
  failTransfer: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    previewSubscriberImport: mocks.preview,
    getImportRemapOptions: mocks.remap,
    patchSubscriberImport: mocks.patch,
    getSubscriberImport: mocks.get,
    confirmSubscriberImport: mocks.confirm,
    cancelSubscriberImport: mocks.cancel,
    subscriberImportProgressUrlAuthed: mocks.progressUrl,
  },
}));

vi.mock("../../lib/file-transfer", () => ({
  pickImportFiles: mocks.pick,
  beginUploadTransfer: () => ({
    complete: mocks.completeTransfer,
    fail: mocks.failTransfer,
  }),
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));

vi.mock("../../components/subscribers/SubscriberImportSteps", () => {
  const steps = [
    { id: "upload", label: "Source", summary: "Choose" },
    { id: "mapping", label: "Fields", summary: "Map" },
    { id: "consent", label: "Consent", summary: "Protect" },
    { id: "options", label: "Handling", summary: "Handle" },
    { id: "review", label: "Verify", summary: "Verify" },
  ] as const;
  return {
    IMPORT_STEPS: steps,
    ImportStepper: () => null,
    UploadStep: ({ onPick }: { onPick: () => void }) => (
      <button type="button" onClick={onPick}>Pick source</button>
    ),
    MappingStep: () => <div>mapping-step</div>,
    ConsentStep: ({ draft }: { draft: { mode: string } }) => (
      <div>{`consent-step:${draft.mode}`}</div>
    ),
    OptionsStep: ({ onTagDraft }: { onTagDraft: (value: string) => void }) => (
      <button type="button" onClick={() => onTagDraft("launch")}>Stage launch tag</button>
    ),
    ReviewStep: () => <div>review-step</div>,
  };
});

import { ImportSubscribersWizard } from "../../components/subscribers/ImportSubscribersWizard";

const ID = "018f07e2-7b1a-7000-8000-000000000001";
const mapping = {
  path: "imports/tenant/source.csv",
  headers: ["email"],
  columns: [{ index: 0, name: "email", kind: "email" as const }],
  rows: 1,
};
const preview: SubscriberImportPreview = {
  id: ID,
  status: "preview",
  mapping,
  sample_rows: [],
  rows_total: 1,
  rows_new: 1,
  rows_existing: 0,
  rows_file_dupes: 0,
  on_existing: "skip",
  classification_authoritative: false,
  upload_classification_exact: true,
  source_fingerprint: "a".repeat(64),
  source_fingerprint_scheme: "hmac-sha256-v1",
  source_fingerprint_key_version: "k2026_07",
  preflight_required: true,
  configuration_revision: 0,
  sample_values_truncated: false,
};

function authoritative(
  overrides: Partial<SubscriberImportPreview> = {},
): SubscriberImportPreview {
  return {
    ...preview,
    filename: "audience.csv",
    configuration_revision: 1,
    consent_source: "",
    consent_source_url: "",
    consent_captured_at: "",
    consent_legal_basis: "",
    consent_jurisdiction: "",
    consent_reason: "",
    consent_policy_version: "",
    consent_evidence_reference: "",
    consent_scope: "",
    consent_scope_acknowledged: false,
    consent_contract_version: "subscriber-import-consent/v1",
    consent_contract_state: "none",
    tags: ["launch"],
    auto_create_properties: false,
    schedule_type: "immediate",
    schedule_cron: "",
    scheduled_at: "",
    next_scheduled_at: "",
    drip_hours_interval: 0,
    drip_hours_total: 0,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.pick.mockResolvedValue({
    ok: true,
    files: [new File(["email\na@example.test"], "audience.csv", { type: "text/csv" })],
  });
  mocks.preview.mockResolvedValue({ data: preview });
  mocks.remap.mockResolvedValue({
    data: {
      merge_fields: [
        { kind: "email", label: "Email" },
        { kind: "ignore", label: "Ignore" },
      ],
      custom_fields: [],
    },
  });
  mocks.patch.mockResolvedValue({
    data: {
      id: ID,
      status: "preview",
      updated: true,
      configuration_revision: 1,
      preflight_required: true,
    },
  });
  mocks.get.mockResolvedValue({ data: authoritative() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function renderWizard(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ImportSubscribersWizard
        open
        onClose={vi.fn()}
        onCompleted={vi.fn()}
        identityScope="tenant:admin"
        canImport
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function reachOptions(): Promise<void> {
  await click("Pick source");
  await click("Create safe preview");
  await click("Review consent boundary");
  await click("Review handling");
}

describe("subscriber import wizard orchestration", () => {
  it("serializes preview/remap and carries the uncommitted tag into the same save tick", async () => {
    renderWizard();
    await click("Pick source");

    await act(async () => {
      const action = button("Create safe preview");
      action.click();
      action.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.remap).toHaveBeenCalledTimes(1);

    await click("Review consent boundary");
    await click("Review handling");
    await click("Stage launch tag");
    await click("Save and verify");

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[0]?.[1]).toMatchObject({
      configuration_revision: 0,
      tags: ["launch"],
      on_existing: "skip",
      consent_scope_acknowledged: false,
    });
    expect(container?.textContent).toContain("review-step");
  });

  it("recovers a revision conflict into an explicit legacy-consent repair review", async () => {
    mocks.patch.mockResolvedValue({
      error: {
        kind: "http",
        status: 409,
        code: "configuration_revision_mismatch",
        message: "raw concurrent state",
      },
    });
    mocks.get.mockResolvedValue({
      data: authoritative({
        configuration_revision: 2,
        consent_contract_state: "incomplete",
        consent_contract_version: "",
        consent_source: "single_optin",
        tags: ["server-version"],
      }),
    });
    renderWizard();
    await reachOptions();
    await click("Stage launch tag");
    await click("Save and verify");

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("consent-step:none");
    expect(container?.textContent).toContain("legacy partial consent record");
    expect(container?.textContent).not.toContain("raw concurrent state");
  });
});
