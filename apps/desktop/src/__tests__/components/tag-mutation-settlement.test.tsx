// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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
  updateTag: vi.fn(),
  createTag: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { updateTag: mocks.updateTag, createTag: mocks.createTag },
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));
vi.mock("../../components/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactElement }) =>
    open ? <div>{children}</div> : null,
  ModalFooter: ({ children }: { children: ReactElement }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../../components/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));
vi.mock("../../hooks/useDraftLifecycleController", () => ({
  useDraftLifecycleController: (options: {
    save: () => Promise<boolean>;
    close: () => void;
    discard: () => void;
  }) => ({
    active: false,
    submit: options.save,
    requestClose: options.close,
    discardAndClose: options.discard,
    discardConfirmOpen: false,
    keepEditing: vi.fn(),
  }),
}));

import { BulkEditModal } from "../../components/tags/BulkEditModal";
import { RegisterOrphanModal } from "../../components/tags/RegisterOrphanModal";
import {
  type TagEditController,
  useTagEdit,
} from "../../pages/tags/useTagEdit";

const TAG_ONE_ID = "11111111-1111-4111-8111-111111111111";
const TAG_TWO_ID = "22222222-2222-4222-8222-222222222222";

function tagRecord(id: string, name: string) {
  return {
    id,
    name,
    color: "slate",
    description: "",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    pii: false,
    version: 1,
    etag: `"tag:${id}:v1"`,
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
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

function EditHarness({
  load,
  reloadTaxonomy,
  onProbe,
}: {
  load: (options?: { forceFresh?: boolean }) => Promise<void>;
  reloadTaxonomy: () => Promise<void>;
  onProbe: (probe: TagEditController) => void;
}): null {
  onProbe(useTagEdit({ load, reloadTaxonomy }));
  return null;
}

describe("tag mutation settlement", () => {
  it("sends one omission-preserving versioned rename and group patch", async () => {
    const current = tagRecord(TAG_ONE_ID, "one");
    mocks.updateTag.mockResolvedValueOnce({
      data: { ...current, name: "priority", group_id: TAG_TWO_ID },
    });
    let probe!: TagEditController;
    render(
      <EditHarness
        load={vi.fn().mockResolvedValue(undefined)}
        reloadTaxonomy={vi.fn().mockResolvedValue(undefined)}
        onProbe={(value) => (probe = value)}
      />,
    );

    act(() => probe.openEdit(current));
    act(() =>
      probe.setDraft({
        ...probe.draft,
        name: "priority",
        groupId: TAG_TWO_ID,
      }),
    );
    let saved = false;
    await act(async () => {
      saved = await probe.lifecycle.submit();
    });

    expect(saved).toBe(true);
    expect(mocks.updateTag).toHaveBeenCalledWith(
      TAG_ONE_ID,
      { name: "priority", group_id: TAG_TWO_ID },
      `"tag:${TAG_ONE_ID}:v1"`,
    );
  });

  it("preserves an edit draft and refreshes before retry after 412", async () => {
    const current = tagRecord(TAG_ONE_ID, "one");
    const load = vi.fn().mockResolvedValue(undefined);
    mocks.updateTag.mockResolvedValueOnce({
      error: { status: 412, message: "stale" },
    });
    let probe!: TagEditController;
    render(
      <EditHarness
        load={load}
        reloadTaxonomy={vi.fn().mockResolvedValue(undefined)}
        onProbe={(value) => (probe = value)}
      />,
    );

    act(() => probe.openEdit(current));
    act(() =>
      probe.setDraft({ ...probe.draft, description: "Preserved draft" }),
    );
    let saved = true;
    await act(async () => {
      saved = await probe.lifecycle.submit();
    });

    expect(saved).toBe(false);
    expect(probe.target?.id).toBe(TAG_ONE_ID);
    expect(probe.draft.description).toBe("Preserved draft");
    expect(probe.error).toContain("changed elsewhere");
    expect(load).toHaveBeenCalledWith({ forceFresh: true });
  });

  it("retains only failed bulk tags and retries after a thrown request", async () => {
    mocks.updateTag
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: tagRecord(TAG_TWO_ID, "two") })
      .mockResolvedValueOnce({ data: tagRecord(TAG_ONE_ID, "one") });
    const onApplied = vi.fn();
    const onRetainSelection = vi.fn();
    render(
      <BulkEditModal
        open
        tags={[tagRecord(TAG_ONE_ID, "one"), tagRecord(TAG_TWO_ID, "two")]}
        onClose={vi.fn()}
        onApplied={onApplied}
        onRetainSelection={onRetainSelection}
      />,
    );

    act(() => button("Apply to 2 tags").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Retry 1 failed tag"),
    );
    expect(onRetainSelection).toHaveBeenCalledWith([TAG_ONE_ID]);
    expect(onApplied).not.toHaveBeenCalled();
    expect(mocks.updateTag).toHaveBeenNthCalledWith(
      1,
      TAG_ONE_ID,
      { color: "slate" },
      `"tag:${TAG_ONE_ID}:v1"`,
    );

    act(() => button("Retry 1 failed tag").click());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mocks.updateTag).toHaveBeenCalledTimes(3);
  });

  it("settles orphan registration after a thrown request and permits retry", async () => {
    mocks.createTag
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        data: tagRecord(TAG_ONE_ID, "orphan"),
      });
    const onRegistered = vi.fn();
    render(
      <RegisterOrphanModal
        name="orphan"
        subscriberCount={null}
        onClose={vi.fn()}
        onRegistered={onRegistered}
      />,
    );

    act(() => button("Register tag").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "registration request failed",
      ),
    );
    expect(button("Register tag").disabled).toBe(false);

    act(() => button("Register tag").click());
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith("orphan"));
    expect(mocks.createTag).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late orphan success after unmount", async () => {
    let resolve!: (value: { data: ReturnType<typeof tagRecord> }) => void;
    mocks.createTag.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onRegistered = vi.fn();
    render(
      <RegisterOrphanModal
        name="orphan"
        subscriberCount={2}
        onClose={vi.fn()}
        onRegistered={onRegistered}
      />,
    );
    act(() => button("Register tag").click());
    act(() => root?.unmount());
    root = null;
    await act(async () => resolve({ data: tagRecord(TAG_ONE_ID, "orphan") }));
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
