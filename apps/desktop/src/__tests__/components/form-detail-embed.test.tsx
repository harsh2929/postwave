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
  canAdmin: true,
  getForm: vi.fn(),
  getEmbed: vi.fn(),
  listSubmissions: vi.fn(),
  openUrl: vi.fn(),
  writeClipboard: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    deleteForm: vi.fn(),
    getForm: mocks.getForm,
    getFormEmbed: mocks.getEmbed,
    listFormSubmissions: mocks.listSubmissions,
    updateForm: vi.fn(),
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));
vi.mock("../../components/forms/EmbedPreviewCard", () => ({
  EmbedPreviewCard: ({ publicUrl }: { publicUrl: string }) => (
    <div data-testid="canonical-preview" data-public-url={publicUrl} />
  ),
}));
vi.mock("../../components/forms/FormFieldsEditor", () => ({
  FormFieldsEditor: () => null,
  firstFormFieldError: () => null,
}));
vi.mock("../../components/forms/FormSpamSettings", () => ({
  FormSpamSettings: () => null,
  applySpamSettings: (settings: Record<string, unknown>) => settings,
  parseSpamSettings: () => ({
    honeypotEnabled: true,
    captchaProvider: "",
    captchaSiteKey: "",
    rateLimitPerMin: "",
  }),
}));
vi.mock("../../components/forms/SubmissionsAnalytics", () => ({
  SubmissionsAnalytics: () => null,
}));
vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));
vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: () => undefined,
}));
vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.writeClipboard,
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));
vi.mock("../../lib/safe-url", () => ({
  safeFormSuccessRedirectUrl: (value: string) => value,
}));
vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useCanWrite: () => true,
}));
vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { FormDetailSlideover } from "../../components/FormDetailSlideover";

const FORM = {
  id: "form-1",
  name: "Launch list",
  slug: "launch",
  optInMode: "double" as const,
  status: "published" as const,
  structure: {
    fields: [{ id: "email", kind: "email", label: "Email", required: true }],
  },
  settings: {},
};

const IFRAME_CONTRACT = {
  flavor: "iframe" as const,
  snippet:
    '<iframe src="https://forms.example.test/forms/launch" title="Subscribe form"></iframe>',
  language: "html",
  instructions: "Paste anywhere inside the page body.",
  public_host: "https://forms.example.test",
  public_url: "https://forms.example.test/forms/launch",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.getForm.mockReset().mockResolvedValue({ data: FORM });
  mocks.getEmbed.mockReset().mockResolvedValue({ data: IFRAME_CONTRACT });
  mocks.listSubmissions.mockReset().mockResolvedValue({ data: [] });
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
  mocks.writeClipboard.mockReset().mockResolvedValue({ ok: true });
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function showForm(): void {
  render(
    <FormDetailSlideover
      formId={FORM.id}
      initial={FORM}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );
}

describe("FormDetailSlideover canonical embed contract", () => {
  it("renders only server-authored output and reuses its hosted URL", async () => {
    showForm();
    await flush();

    expect(mocks.getEmbed).toHaveBeenCalledWith(
      FORM.id,
      "iframe",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Iframe embed"]',
    );
    expect(textarea?.disabled).toBe(false);
    expect(textarea?.value).toBe(IFRAME_CONTRACT.snippet);
    expect(textarea?.value).not.toContain("sandbox=");
    expect(
      document
        .querySelector('[data-testid="canonical-preview"]')
        ?.getAttribute("data-public-url"),
    ).toBe(IFRAME_CONTRACT.public_url);

    const hosted = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="hosted"]',
    );
    if (!hosted) throw new Error("Hosted-page format was not rendered");
    act(() => hosted.click());
    await flush();

    expect(mocks.getEmbed).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Hosted form URL"]',
      )?.value,
    ).toBe(IFRAME_CONTRACT.public_url);
  });

  it("fails closed on an invalid public-host contract", async () => {
    mocks.getEmbed.mockResolvedValue({
      data: {
        ...IFRAME_CONTRACT,
        public_url: "https://untrusted.example.test/forms/launch",
      },
    });
    showForm();
    await flush();

    expect(document.body.textContent).toContain(
      "server did not return a valid canonical share contract",
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Iframe embed"]',
      )?.disabled,
    ).toBe(true);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Copy",
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="canonical-preview"]'),
    ).toBeNull();
  });

  it("keeps actions disabled after a read failure and recovers on retry", async () => {
    mocks.getEmbed
      .mockResolvedValueOnce({
        error: { message: "Embed service unavailable" },
      })
      .mockResolvedValueOnce({ data: IFRAME_CONTRACT });
    showForm();
    await flush();

    expect(document.body.textContent).toContain("Embed service unavailable");
    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Retry");
    if (!retry) throw new Error("Retry action was not rendered");
    act(() => retry.click());
    await flush();

    expect(mocks.getEmbed).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Iframe embed"]',
      )?.value,
    ).toBe(IFRAME_CONTRACT.snippet);
  });

  it("does not request the admin-scoped contract for a lower role", async () => {
    mocks.canAdmin = false;
    showForm();
    await flush();

    expect(mocks.getEmbed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Admin access is required to retrieve canonical share and embed details",
    );
    expect(
      document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="iframe"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Iframe embed"]',
      )?.disabled,
    ).toBe(true);
  });
});
