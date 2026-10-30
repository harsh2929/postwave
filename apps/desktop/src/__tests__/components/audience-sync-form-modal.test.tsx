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

import type { AudienceSync, List } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  listLists: vi.fn(),
  listSegments: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listLists: mocks.listLists },
  audienceSyncsApi: {
    create: mocks.create,
    update: mocks.update,
  },
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: mocks.listSegments },
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import {
  AudienceSyncFormModal,
  unwrapAudienceSyncLists,
} from "../../components/audiencesync/AudienceSyncFormModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listLists.mockResolvedValue({
    data: {
      data: {
        results: [
          {
            id: 7,
            uuid: "list-uuid-7",
            name: "Newsletter",
            subscriber_count: 42,
          },
        ],
      },
    },
  });
  mocks.listSegments.mockResolvedValue({
    data: [{ id: "segment-1", name: "Engaged readers" }],
  });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function savedSync(overrides: Partial<AudienceSync> = {}): AudienceSync {
  return {
    id: "sync-1",
    name: "CRM audience",
    source: { list_id: "list-uuid-7" },
    destination: {
      type: "webhook",
      url: "https://crm.example.com/audience",
      secret_set: true,
      secret_hint: "cdef",
    },
    schedule: "daily",
    enabled: true,
    created_at: "2026-07-15T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function modal({
  open = true,
  sync = null,
  onClose = vi.fn(),
  onSaved = vi.fn(),
}: {
  open?: boolean;
  sync?: AudienceSync | null;
  onClose?: () => void;
  onSaved?: () => void;
} = {}): ReactElement {
  return (
    <AudienceSyncFormModal
      open={open}
      sync={sync}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function input(placeholder: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!element) throw new Error(`Missing input: ${placeholder}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function select(label: string, value: string): void {
  const element = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!element) throw new Error(`Missing select: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AudienceSyncFormModal", () => {
  it("unwraps every supported Listmonk envelope without unsafe property access", () => {
    const lists: List[] = [{ id: 1, name: "One" }];
    expect(unwrapAudienceSyncLists(lists)).toEqual(lists);
    expect(unwrapAudienceSyncLists({ data: lists })).toEqual(lists);
    expect(unwrapAudienceSyncLists({ data: { results: lists } })).toEqual(
      lists,
    );
    expect(unwrapAudienceSyncLists({ items: lists })).toEqual(lists);
    expect(unwrapAudienceSyncLists({ results: lists })).toEqual(lists);
    expect(unwrapAudienceSyncLists({ data: { results: "invalid" } })).toEqual(
      [],
    );
    expect(unwrapAudienceSyncLists(null)).toEqual([]);
  });

  it("creates an exact list-sourced signed webhook sync", async () => {
    const onSaved = vi.fn();
    mocks.create.mockResolvedValueOnce({ data: savedSync() });
    render(modal({ onSaved }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Newsletter (42)");
    });

    input("e.g. Newsletter → CRM", "  CRM export  ");
    select("Source list", "7");
    input("https://example.com/postwave/audience", " https://crm.test/hook ");
    input("Paste a strong shared secret", " signing-secret ");
    act(() => button("Create sync").click());

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        name: "CRM export",
        source: { list_id: "7" },
        destination: {
          type: "webhook",
          url: "https://crm.test/hook",
          secret: "signing-secret",
        },
        schedule: "manual",
        enabled: true,
      });
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Sync created");
  });

  it("resolves a stored list UUID and omits a blank write-only secret on edit", async () => {
    mocks.update.mockResolvedValueOnce({ data: savedSync() });
    render(modal({ sync: savedSync() }));
    await waitFor(() => {
      const source = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Source list"]',
      );
      expect(source?.value).toBe("7");
    });

    act(() => button("Save changes").click());
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith("sync-1", {
        name: "CRM audience",
        source: { list_id: "7" },
        destination: {
          type: "webhook",
          url: "https://crm.example.com/audience",
        },
        schedule: "daily",
        enabled: true,
      });
    });
  });

  it("suppresses a pending save completion after the modal closes", async () => {
    const creation = deferred<{ data: AudienceSync }>();
    const onSaved = vi.fn();
    mocks.create.mockReturnValueOnce(creation.promise);
    const view = render(modal({ onSaved }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Newsletter"),
    );
    input("e.g. Newsletter → CRM", "CRM export");
    select("Source list", "7");
    input("https://example.com/postwave/audience", "https://crm.test/hook");
    input("Paste a strong shared secret", "secret");
    act(() => button("Create sync").click());

    view.rerender(modal({ open: false, onSaved }));
    creation.resolve({ data: savedSync() });
    await act(async () => Promise.resolve());

    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
