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

import type { UTMPreviewResponse, UTMTemplate } from "../../lib/api-client";
import {
  inspectLifecycle,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  upsertCampaign: vi.fn(),
  upsertDefault: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  utmTemplatesApi: {
    list: mocks.list,
    preview: mocks.preview,
    remove: mocks.remove,
    upsertCampaign: mocks.upsertCampaign,
    upsertDefault: mocks.upsertDefault,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import {
  type UTMTemplatesController,
  useUTMTemplatesController,
} from "../../components/composer/useUTMTemplatesController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface ProbeProps {
  campaignId: string | number;
  canAdmin: boolean;
  canMutate: boolean;
  open: boolean;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UTMTemplatesController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    data: { templates: [template()], count: 1 },
  });
  mocks.preview.mockResolvedValue({ data: previewResponse("newsletter") });
  mocks.remove.mockResolvedValue({ data: undefined });
  mocks.upsertCampaign.mockResolvedValue({ data: { id: "template-2" } });
  mocks.upsertDefault.mockResolvedValue({ data: { id: "template-1" } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function template(overrides: Partial<UTMTemplate> = {}): UTMTemplate {
  return {
    id: "template-1",
    is_default: true,
    enabled: true,
    utm_source: "newsletter",
    created_at: "2026-07-16T09:00:00.000Z",
    updated_at: "2026-07-16T09:00:00.000Z",
    ...overrides,
  };
}

function previewResponse(source: string): UTMPreviewResponse {
  return {
    original: "https://example.test/launch",
    rewritten: `https://example.test/launch?utm_source=${source}`,
    template: template({ utm_source: source }),
  };
}

function Probe(props: ProbeProps): ReactElement {
  latest = useUTMTemplatesController(props);
  return (
    <div>
      <span data-testid="loading">{String(latest.loading)}</span>
      <span data-testid="error">{latest.loadError ?? "none"}</span>
      <span data-testid="templates">
        {latest.templates?.map((item) => item.id).join(",") ?? "null"}
      </span>
      <span data-testid="mutation">{latest.mutation ?? "none"}</span>
      <span data-testid="delete">{latest.deleteTarget?.id ?? "none"}</span>
      <span data-testid="previewing">{String(latest.previewing)}</span>
      <span data-testid="preview-error">{latest.previewError ?? "none"}</span>
      <span data-testid="rewritten">{latest.preview?.rewritten ?? "none"}</span>
      <span data-testid="source">{latest.form.utm_source}</span>
    </div>
  );
}

function renderController(overrides: Partial<ProbeProps> = {}): {
  rerender: (next: Partial<ProbeProps>) => void;
  unmount: () => void;
} {
  let props: ProbeProps = {
    campaignId: "campaign-1",
    canAdmin: true,
    canMutate: true,
    open: true,
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (): void => {
    act(() => root?.render(<Probe {...props} />));
  };
  render();
  return {
    rerender(next) {
      props = { ...props, ...next };
      render();
    },
    unmount() {
      act(() => root?.unmount());
      root = null;
    },
  };
}

function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

async function renderLoaded(
  overrides: Partial<ProbeProps> = {},
): Promise<void> {
  renderController(overrides);
  await waitFor(() => expect(text("loading")).toBe("false"));
}

describe("UTM templates controller", () => {
  it("keeps edited UTM fields discard-only during global lifecycle", async () => {
    await renderLoaded();
    act(() => latest?.setFormValue("utm_source", "campaign-source"));

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "UTM template draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.upsertDefault).not.toHaveBeenCalled();
    expect(mocks.upsertCampaign).not.toHaveBeenCalled();
    act(() => latest?.discardDraft());
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("does not read while closed and keeps only the newest overlapping load", async () => {
    const oldRequest = deferred<{
      data: { templates: UTMTemplate[]; count: number };
    }>();
    mocks.list
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        data: {
          templates: [template({ id: "new-template" })],
          count: 1,
        },
      });
    const view = renderController({ open: false });
    expect(mocks.list).not.toHaveBeenCalled();
    view.rerender({ open: true });
    act(() => void latest?.load());
    await waitFor(() => expect(text("templates")).toBe("new-template"));

    await act(async () => {
      oldRequest.resolve({
        data: {
          templates: [template({ id: "old-template" })],
          count: 1,
        },
      });
      await oldRequest.promise;
    });
    expect(text("templates")).toBe("new-template");
  });

  it("serializes exact trimmed saves across both save targets", async () => {
    const pending = deferred<{ data: { id: string } }>();
    mocks.upsertDefault.mockReturnValue(pending.promise);
    mocks.list
      .mockResolvedValueOnce({ data: { templates: [template()], count: 1 } })
      .mockResolvedValueOnce({
        data: { templates: [template({ utm_source: "new-source" })], count: 1 },
      });
    await renderLoaded();
    act(() => {
      latest?.setFormValue("utm_source", "  new-source  ");
      latest?.setFormValue("utm_campaign", " {{campaign_name}} ");
    });

    let first!: Promise<void>;
    act(() => {
      first = latest!.saveDefault();
      void latest?.saveDefault();
      void latest?.applyToCampaign();
    });
    expect(mocks.upsertDefault).toHaveBeenCalledTimes(1);
    expect(mocks.upsertDefault).toHaveBeenCalledWith({
      utm_source: "new-source",
      utm_campaign: "{{campaign_name}}",
    });
    expect(mocks.upsertCampaign).not.toHaveBeenCalled();
    expect(text("mutation")).toBe("default");

    await act(async () => {
      pending.resolve({ data: { id: "template-1" } });
      await first;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Tenant default UTM template saved",
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(text("mutation")).toBe("none");

    await act(async () => latest?.applyToCampaign());
    expect(mocks.upsertCampaign).toHaveBeenCalledWith("campaign-1", {
      utm_source: "new-source",
      utm_campaign: "{{campaign_name}}",
    });
  });

  it("enforces viewer/admin gates inside mutation handlers", async () => {
    await renderLoaded({ canAdmin: false });
    act(() => latest?.setFormValue("utm_source", "newsletter"));
    await act(async () => latest?.saveDefault());
    expect(mocks.upsertDefault).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "UTM template changes need an admin role",
    );
  });

  it("keeps delete confirmation on failure and clears it only after success", async () => {
    mocks.remove
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "delete unavailable" },
      })
      .mockResolvedValueOnce({ data: undefined });
    await renderLoaded();
    act(() => latest?.selectDelete(template()));
    expect(text("delete")).toBe("template-1");

    await act(async () => latest?.deleteTemplate());
    expect(text("delete")).toBe("template-1");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't delete template: delete unavailable",
    );
    await act(async () => latest?.deleteTemplate());
    expect(text("delete")).toBe("none");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("UTM template deleted");
  });

  it("validates previews and keeps preview requests exact single-flight", async () => {
    const oldRequest = deferred<{ data: UTMPreviewResponse }>();
    mocks.preview
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ data: previewResponse("new") });
    await renderLoaded();
    act(() => latest?.setPreviewUrl("javascript:alert(1)"));
    await act(async () => latest?.runPreview());
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(text("preview-error")).toContain("http:// or https://");

    act(() => latest?.setPreviewUrl("https://example.test/old"));
    let oldRun!: Promise<void>;
    act(() => {
      oldRun = latest!.runPreview();
    });
    // Inputs and a duplicate preview cannot replace an exact in-flight
    // request. This is the same same-tick contract used by lifecycle exit.
    act(() => latest?.setPreviewUrl("https://example.test/new"));
    act(() => void latest?.runPreview());
    expect(latest?.previewUrl).toBe("https://example.test/old");
    expect(mocks.preview).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldRequest.resolve({ data: previewResponse("old") });
      await oldRun;
    });
    expect(text("rewritten")).toContain("utm_source=old");

    act(() => latest?.setPreviewUrl("https://example.test/new"));
    await act(async () => latest?.runPreview());
    expect(mocks.preview).toHaveBeenLastCalledWith({
      url: "https://example.test/new",
      campaign_id: "campaign-1",
    });
    expect(text("rewritten")).toContain("utm_source=new");
  });

  it("suppresses pending save completion after role downgrade", async () => {
    const pending = deferred<{ data: { id: string } }>();
    mocks.upsertDefault.mockReturnValue(pending.promise);
    const view = renderController();
    await waitFor(() => expect(text("loading")).toBe("false"));
    act(() => latest?.setFormValue("utm_source", "newsletter"));
    act(() => void latest?.saveDefault());
    view.rerender({ canAdmin: false });

    await act(async () => {
      pending.resolve({ data: { id: "template-1" } });
      await pending.promise;
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(text("mutation")).toBe("none");
  });
});
