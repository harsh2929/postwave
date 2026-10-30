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

import type { LandingPage } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: { value: true },
  create: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
}));

vi.mock("../../lib/api-client", () => ({
  landingPagesApi: {
    create: mocks.create,
    list: mocks.list,
    remove: mocks.remove,
    update: mocks.update,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { LandingPagesSection } from "../../components/forms/LandingPagesSection";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.canAdmin.value = true;
  mocks.list.mockResolvedValue({ data: [page()] });
  mocks.create.mockResolvedValue({ data: page() });
  mocks.update.mockResolvedValue({ data: page() });
  mocks.remove.mockResolvedValue({ data: undefined });
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

function page(overrides: Partial<LandingPage> = {}): LandingPage {
  return {
    id: "page-1",
    tenant_id: "tenant-1",
    slug: "spring-promo",
    name: "Spring promo",
    status: "draft",
    template: "minimal",
    blocks: [{ type: "hero" }],
    seo: {},
    tracking: {},
    metrics: {},
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function render(node: ReactElement = <LandingPagesSection />): {
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

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(id: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Missing input: ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("LandingPagesSection", () => {
  it("sorts rows and keeps every mutation hidden from non-admin viewers", async () => {
    mocks.canAdmin.value = false;
    mocks.list.mockResolvedValueOnce({
      data: [
        page({
          id: "older",
          name: "Older",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        page({
          id: "newer",
          name: "Newer",
          updated_at: "2026-06-01T00:00:00Z",
        }),
      ],
    });
    render();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Newer");
    });
    const names = Array.from(document.querySelectorAll<HTMLElement>("[title]"))
      .map((element) => element.title)
      .filter((title) => title === "Older" || title === "Newer");
    expect(names).toEqual(["Newer", "Older"]);
    expect(document.body.textContent).not.toContain("New page");
    expect(document.body.textContent).not.toContain("Publish");
    expect(document.body.textContent).not.toContain("Edit");
    expect(document.body.textContent).not.toContain("Archive");
  });

  it("creates the exact normalized record and reloads the list", async () => {
    render();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    act(() => button("New page").click());
    setInput("lp-name", " Launch Page ");
    expect(document.querySelector<HTMLInputElement>("#lp-slug")?.value).toBe(
      "launch-page",
    );
    expect(
      document.querySelector<HTMLInputElement>("#lp-domain")?.readOnly,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      "Inspection only in desktop until DNS ownership",
    );
    setInput("lp-template", "feature");
    act(() => button("Create page").click());

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        slug: "launch-page",
        name: "Launch Page",
        template: "feature",
      });
      expect(mocks.list).toHaveBeenCalledTimes(2);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Landing page created");
  });

  it("serializes row mutations and publishes through the exact patch", async () => {
    const update = deferred<{ data: LandingPage }>();
    mocks.update.mockReturnValueOnce(update.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Spring promo"),
    );

    act(() => button("Publish").click());
    expect(mocks.update).toHaveBeenCalledWith("page-1", {
      status: "published",
    });
    expect(button("Publish").disabled).toBe(true);
    expect(button("Edit").disabled).toBe(true);
    expect(button("Archive").disabled).toBe(true);

    update.resolve({ data: page({ status: "published" }) });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('"Spring promo" published');
  });

  it("truthfully confirms archival before retaining and refreshing the record", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Spring promo"),
    );

    act(() => button("Archive").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Archive "Spring promo"?');
    expect(dialog?.textContent).toContain("record and history are retained");
    act(() => button("Archive", dialog ?? document).click());

    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith("page-1");
      expect(mocks.list).toHaveBeenCalledTimes(2);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Landing page "Spring promo" archived',
    );
  });

  it("ignores a save completion after the section has unmounted", async () => {
    const save = deferred<{ data: LandingPage }>();
    mocks.create.mockReturnValueOnce(save.promise);
    const view = render();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    act(() => button("New page").click());
    setInput("lp-name", "Transient page");
    act(() => button("Create page").click());
    view.rerender(<></>);
    save.resolve({ data: page({ name: "Transient page" }) });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("contains unsupported endpoints without exposing a dead create action", async () => {
    mocks.list.mockResolvedValueOnce({
      error: { status: 501, message: "Not implemented" },
    });
    render();

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This API build doesn't expose landing pages",
      );
    });
    expect(document.body.textContent).not.toContain("New page");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
