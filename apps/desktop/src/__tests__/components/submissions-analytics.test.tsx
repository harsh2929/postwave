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

import type {
  FormAnalyticsResponse,
  FormSubmission,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  buildStreamUrl: vi.fn(),
  canAdmin: { value: true },
  downloadUrlToFile: vi.fn(),
  getFormAnalytics: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getFormAnalytics: mocks.getFormAnalytics },
  buildStreamUrl: mocks.buildStreamUrl,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
}));

vi.mock("../../lib/file-transfer", () => ({
  downloadUrlToFile: mocks.downloadUrlToFile,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { SubmissionsAnalytics } from "../../components/forms/SubmissionsAnalytics";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
  vi.clearAllMocks();
  mocks.canAdmin.value = true;
  mocks.getFormAnalytics.mockResolvedValue({ data: analytics() });
  mocks.buildStreamUrl.mockResolvedValue(
    "https://api.example.test/export.csv?stream_token=short-lived",
  );
  mocks.downloadUrlToFile.mockResolvedValue({
    ok: true,
    status: "download_started",
    transferId: "test-transfer",
    collision: false,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function submission(
  id: string,
  status: string,
  submittedAt = "2026-07-16T08:00:00.000Z",
): FormSubmission {
  return {
    id,
    formId: "form-1",
    email: `${id}@example.test`,
    status,
    submittedAt,
  };
}

function analytics(
  overrides: Partial<FormAnalyticsResponse> = {},
): FormAnalyticsResponse {
  return {
    form_id: "form-1",
    days: 30,
    visits: [{ date: "2026-07-16", count: 10 }],
    visits_total: 10,
    ...overrides,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function populatedSubmissions(): FormSubmission[] {
  return [
    submission("confirmed", "confirmed"),
    submission("pending", "pending"),
    submission("future-status", "__proto__"),
  ];
}

describe("SubmissionsAnalytics", () => {
  it("loads the exact visits window and includes unknown statuses honestly", async () => {
    render(
      <SubmissionsAnalytics
        formId="form-1"
        submissions={populatedSubmissions()}
        loading={false}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("30.0%"));

    expect(mocks.getFormAnalytics).toHaveBeenCalledWith("form-1", { days: 30 });
    expect(document.body.textContent).toContain("10 visits");
    expect(document.body.textContent).toContain("3 submissions / 10 visits");
    expect(document.body.textContent).toContain("Other");
    expect(document.body.textContent).toContain("Peak: 3/day");
  });

  it("treats an unavailable visits endpoint as a capability absence", async () => {
    mocks.getFormAnalytics.mockResolvedValue({
      error: { kind: "http", status: 501, message: "not implemented" },
    });
    render(
      <SubmissionsAnalytics formId="form-1" submissions={[]} loading={false} />,
    );

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Visit analytics aren't available on this server build",
      ),
    );
    expect(document.body.textContent).not.toContain("not implemented");
    expect(() => button("Retry")).toThrow();
  });

  it("ignores a visits response for a form that is no longer open", async () => {
    const oldRequest = deferred<{ data: FormAnalyticsResponse }>();
    mocks.getFormAnalytics
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        data: analytics({ form_id: "form-2", visits_total: 20 }),
      });
    const view = render(
      <SubmissionsAnalytics formId="form-1" submissions={[]} loading={false} />,
    );
    view.rerender(
      <SubmissionsAnalytics formId="form-2" submissions={[]} loading={false} />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("20 visits"),
    );

    await act(async () => {
      oldRequest.resolve({
        data: analytics({ form_id: "form-1", visits_total: 99 }),
      });
      await oldRequest.promise;
    });
    expect(document.body.textContent).toContain("20 visits");
    expect(document.body.textContent).not.toContain("99 visits");
  });

  it("gates the admin export before requesting a stream token", async () => {
    mocks.canAdmin.value = false;
    render(
      <SubmissionsAnalytics formId="form-1" submissions={[]} loading={false} />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("10 visits"),
    );
    const exportButton = button("Export CSV");

    expect(exportButton.disabled).toBe(false);
    expect(exportButton.getAttribute("aria-disabled")).toBe("true");
    expect(exportButton.getAttribute("title")).toBeNull();
    const descriptionId = exportButton.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Admin access is required",
    );
    exportButton.focus();
    expect(document.activeElement).toBe(exportButton);
    act(() => exportButton.click());
    expect(mocks.buildStreamUrl).not.toHaveBeenCalled();
    expect(mocks.downloadUrlToFile).not.toHaveBeenCalled();
  });

  it("serializes export creation and opens the exact short-lived URL", async () => {
    const pendingUrl = deferred<string>();
    mocks.buildStreamUrl.mockReturnValue(pendingUrl.promise);
    render(
      <SubmissionsAnalytics formId="form/a" submissions={[]} loading={false} />,
    );
    act(() => button("Export CSV").click());
    act(() => button("Opening export…").click());

    expect(mocks.buildStreamUrl).toHaveBeenCalledTimes(1);
    expect(mocks.buildStreamUrl).toHaveBeenCalledWith(
      "/api/v1/forms/form%2Fa/submissions.csv",
    );
    await act(async () => {
      pendingUrl.resolve(
        "https://api.example.test/export.csv?stream_token=one-use",
      );
      await pendingUrl.promise;
    });
    await waitFor(() =>
      expect(mocks.downloadUrlToFile).toHaveBeenCalledTimes(1),
    );
    expect(mocks.downloadUrlToFile).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.example.test/export.csv?stream_token=one-use",
        suggestedName: "form-form/a-submissions.csv",
        privacy: "confidential",
      }),
    );
    expect(button("Export CSV").disabled).toBe(false);
  });

  it("does not open an old form export after the form changes", async () => {
    const pendingUrl = deferred<string>();
    mocks.buildStreamUrl.mockReturnValue(pendingUrl.promise);
    const view = render(
      <SubmissionsAnalytics formId="form-1" submissions={[]} loading={false} />,
    );
    act(() => button("Export CSV").click());
    view.rerender(
      <SubmissionsAnalytics formId="form-2" submissions={[]} loading={false} />,
    );

    await act(async () => {
      pendingUrl.resolve("https://api.example.test/stale.csv?stream_token=old");
      await pendingUrl.promise;
    });
    expect(mocks.downloadUrlToFile).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("reports an export-token failure without attempting to open a URL", async () => {
    mocks.buildStreamUrl.mockRejectedValue(new Error("token unavailable"));
    render(
      <SubmissionsAnalytics formId="form-1" submissions={[]} loading={false} />,
    );
    act(() => button("Export CSV").click());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't open export: token unavailable",
    );
    expect(mocks.downloadUrlToFile).not.toHaveBeenCalled();
    expect(button("Export CSV").disabled).toBe(false);
  });

  it("explains the list sample while promising only the complete CSV path", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      submission(`row-${index}`, "confirmed"),
    );
    render(
      <SubmissionsAnalytics
        formId="form-1"
        submissions={rows}
        loading={false}
      />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("10 visits"),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("1,000 rows"),
    );

    expect(document.body.textContent).toContain(
      "Export CSV walks the complete available history.",
    );
    expect(document.body.textContent).not.toContain(
      "Export CSV is also capped",
    );
  });
});
