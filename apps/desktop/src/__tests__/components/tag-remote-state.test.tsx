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
  listTags: vi.fn(),
  listTagGroups: vi.fn(),
  listTagTaxonomy: vi.fn(),
  suggestTags: vi.fn(),
  createTag: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listTags: mocks.listTags,
    listTagGroups: mocks.listTagGroups,
    listTagTaxonomy: mocks.listTagTaxonomy,
    suggestTags: mocks.suggestTags,
    createTag: mocks.createTag,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));
vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: () => null,
  onPendingDeepLinkTarget: () => () => undefined,
}));
vi.mock("../../hooks/useDraftLifecycleController", () => ({
  useDraftLifecycleController: () => ({
    active: false,
    promiseRef: { current: null },
    runOperation: vi.fn(),
    submit: vi.fn(),
    requestClose: vi.fn(),
    discardAndClose: vi.fn(),
    discardConfirmOpen: false,
    keepEditing: vi.fn(),
  }),
}));

import {
  type TagCatalogController,
  useTagCatalog,
} from "../../pages/tags/useTagCatalog";
import {
  type TagCreateController,
  useTagCreate,
} from "../../pages/tags/useTagCreate";

const TAG_ID = "11111111-1111-4111-8111-111111111111";

function tagRecord(name: string) {
  return {
    id: TAG_ID,
    name,
    color: "slate",
    description: "",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    pii: false,
    version: 1,
    etag: `"tag:${TAG_ID}:v1"`,
  };
}

const initialTag = tagRecord("initial");
const intermediateTag = tagRecord("intermediate");
const finalTag = tagRecord("final");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listTags.mockResolvedValue({ data: { items: [initialTag] } });
  mocks.listTagGroups.mockResolvedValue({ data: { items: [] } });
  mocks.listTagTaxonomy.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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
      await flush();
    }
  }
  throw lastError;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function CatalogHarness({
  onProbe,
}: {
  onProbe: (probe: TagCatalogController) => void;
}): null {
  onProbe(useTagCatalog());
  return null;
}

function CreateHarness({
  onProbe,
}: {
  onProbe: (probe: TagCreateController) => void;
}): null {
  onProbe(
    useTagCreate({
      load: vi.fn().mockResolvedValue(undefined),
      reloadTaxonomy: vi.fn().mockResolvedValue(undefined),
    }),
  );
  return null;
}

describe("tag remote-state sequencing", () => {
  it("keeps verified rows visible and guarantees a forced trailing reload", async () => {
    let probe!: TagCatalogController;
    render(<CatalogHarness onProbe={(value) => (probe = value)} />);
    await waitFor(() => {
      expect(probe.rows).toEqual([initialTag]);
      expect(probe.loading).toBe(false);
    });

    const active = deferred<{
      data: { items: Array<typeof intermediateTag> };
    }>();
    const trailing = deferred<{ data: { items: Array<typeof finalTag> } }>();
    mocks.listTags
      .mockReturnValueOnce(active.promise)
      .mockReturnValueOnce(trailing.promise);

    let activeLoad!: Promise<void>;
    act(() => {
      activeLoad = probe.load();
    });
    await waitFor(() => {
      expect(mocks.listTags).toHaveBeenCalledTimes(2);
      expect(probe.loading).toBe(true);
      expect(probe.rows).toEqual([initialTag]);
    });

    let forcedLoad!: Promise<void>;
    act(() => {
      forcedLoad = probe.load({ forceFresh: true });
    });
    expect(mocks.listTags).toHaveBeenCalledTimes(2);

    await act(async () => {
      active.resolve({ data: { items: [intermediateTag] } });
      await active.promise;
    });
    await waitFor(() => {
      expect(mocks.listTags).toHaveBeenCalledTimes(3);
      expect(probe.loading).toBe(true);
      expect(probe.rows).toEqual([intermediateTag]);
    });

    await act(async () => {
      trailing.resolve({ data: { items: [finalTag] } });
      await Promise.all([activeLoad, forcedLoad]);
    });
    expect(probe.rows).toEqual([finalTag]);
    expect(probe.loading).toBe(false);
  });

  it("ignores stale suggestions and reports malformed suggestion envelopes", async () => {
    vi.useFakeTimers();
    const first = deferred<{
      data: {
        q: string;
        items: Array<{ tag: string; subscribers: number; registered: boolean }>;
      };
    }>();
    const second = deferred<{
      data: {
        q: string;
        items: Array<{ tag: string; subscribers: number; registered: boolean }>;
      };
    }>();
    mocks.suggestTags
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ data: {} });

    let probe!: TagCreateController;
    render(<CreateHarness onProbe={(value) => (probe = value)} />);
    act(() => {
      probe.openCreate();
      probe.setDraft({ ...probe.draft, name: "cu" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(mocks.suggestTags).toHaveBeenNthCalledWith(1, "cu", 5);

    act(() => probe.setDraft({ ...probe.draft, name: "customer" }));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(mocks.suggestTags).toHaveBeenNthCalledWith(2, "customer", 5);

    await act(async () => {
      second.resolve({
        data: {
          q: "customer",
          items: [{ tag: "customer", subscribers: 12, registered: true }],
        },
      });
      await second.promise;
    });
    expect(probe.suggestions.map((item) => item.tag)).toEqual(["customer"]);

    await act(async () => {
      first.resolve({
        data: {
          q: "cu",
          items: [{ tag: "cu", subscribers: 2, registered: false }],
        },
      });
      await first.promise;
    });
    expect(probe.suggestions.map((item) => item.tag)).toEqual(["customer"]);

    act(() => probe.setDraft({ ...probe.draft, name: "malformed" }));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await flush();
    expect(probe.suggestions).toEqual([]);
    expect(probe.suggestionError).toContain("could not be verified");
  });
});
