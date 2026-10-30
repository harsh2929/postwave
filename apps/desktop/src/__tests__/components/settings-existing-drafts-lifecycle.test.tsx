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

const identifierConfig = {
  email_normalize_dots: false,
  email_normalize_plus: false,
  phone_e164_format: false,
  phone_default_region: "",
};
const archiveStatus = {
  domain: "old.example.com",
  cname_target: "custom-domains.moosewave.com",
  verification_token: "public-token",
  status: "pending",
  ssl_status: "pending",
};
const archiveSettings = {
  tenant_archive_slug: "acme",
  archive_domain: "old.example.com",
  archive_title: "Acme",
  archive_tagline: "News",
};
const limits = {
  max_custom_fields: 100,
  max_searchable_fields: 10,
  used_custom_fields: 4,
  used_searchable_fields: 2,
};

const mocks = vi.hoisted(() => ({
  getChain: vi.fn(),
  setChain: vi.fn(),
  getArchiveDomain: vi.fn(),
  getArchiveSettings: vi.fn(),
  putArchiveSettings: vi.fn(),
  verifyArchiveDomain: vi.fn(),
  deleteArchiveDomain: vi.fn(),
  getLimits: vi.fn(),
  updateLimits: vi.fn(),
  getIdentifiers: vi.fn(),
  updateIdentifiers: vi.fn(),
  previewIdentifiers: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  IDENTIFIER_TRANSFORM_PHONE_REGIONS: [
    { value: "", label: "None" },
    { value: "US", label: "United States" },
  ],
  api: {
    getApprovalChain: mocks.getChain,
    setApprovalChain: mocks.setChain,
    getArchiveCustomDomain: mocks.getArchiveDomain,
    getArchiveTenantSettings: mocks.getArchiveSettings,
    putArchiveTenantSettings: mocks.putArchiveSettings,
    verifyArchiveCustomDomain: mocks.verifyArchiveDomain,
    deleteArchiveCustomDomain: mocks.deleteArchiveDomain,
  },
  customFieldSettingsApi: {
    get: mocks.getLimits,
    update: mocks.updateLimits,
  },
  identifierTransformsApi: {
    get: mocks.getIdentifiers,
    update: mocks.updateIdentifiers,
    preview: mocks.previewIdentifiers,
  },
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => true }));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ApprovalChainSection } from "../../components/settings/ApprovalChainSection";
import { ArchiveDomainSection } from "../../components/settings/ArchiveDomainSection";
import { CustomFieldGovernance } from "../../components/settings/CustomFieldGovernance";
import { IdentifierTransformsSection } from "../../components/settings/IdentifierTransformsSection";
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getChain.mockResolvedValue({ data: { steps: [{ role: "editor" }] } });
  mocks.setChain.mockResolvedValue({ data: { steps: [{ role: "legal" }] } });
  mocks.getArchiveDomain.mockResolvedValue({ data: archiveStatus });
  mocks.getArchiveSettings.mockResolvedValue({ data: archiveSettings });
  mocks.putArchiveSettings.mockResolvedValue({
    data: { ...archiveSettings, archive_domain: "news.example.com" },
  });
  mocks.verifyArchiveDomain.mockResolvedValue({ data: archiveStatus });
  mocks.deleteArchiveDomain.mockResolvedValue({ data: {} });
  mocks.getLimits.mockResolvedValue({ data: limits });
  mocks.updateLimits.mockResolvedValue({
    data: { ...limits, max_custom_fields: 200 },
  });
  mocks.getIdentifiers.mockResolvedValue({ data: identifierConfig });
  mocks.updateIdentifiers.mockResolvedValue({
    data: { ...identifierConfig, email_normalize_dots: true },
  });
  mocks.previewIdentifiers.mockResolvedValue({
    data: {
      config: identifierConfig,
      email_input: "a@example.com",
      email_output: "a@example.com",
      email_changed: false,
      phones: [],
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
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

describe("existing settings lifecycle owners", () => {
  it("retains the focused archive heading across loading-to-loaded replacement", async () => {
    let resolveDomain:
      | ((value: { data: typeof archiveStatus }) => void)
      | null = null;
    let resolveSettings:
      | ((value: { data: typeof archiveSettings }) => void)
      | null = null;
    mocks.getArchiveDomain.mockReturnValue(
      new Promise((resolve) => {
        resolveDomain = resolve;
      }),
    );
    mocks.getArchiveSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    render(<ArchiveDomainSection />);
    const heading = document.querySelector<HTMLElement>(
      ".settings-section-title",
    );
    if (!heading) throw new Error("Expected archive loading heading");
    heading.tabIndex = -1;
    heading.focus();

    await act(async () => {
      resolveDomain?.({ data: archiveStatus });
      resolveSettings?.({ data: archiveSettings });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.querySelector("#archive-domain-input")).not.toBeNull(),
    );

    expect(document.querySelector(".settings-section-title")).toBe(heading);
    expect(document.activeElement).toBe(heading);
    const save = button("Save domain");
    const reasonId = save.getAttribute("aria-describedby");
    expect(save.disabled).toBe(true);
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "Change the custom domain",
    );
    expect(
      document.querySelector('[data-tour="archive-domain-section"] [title]'),
    ).toBeNull();
  });

  it("registers no approval-chain draft while the surface is held", async () => {
    render(<ApprovalChainSection />);
    expect(
      document.querySelector('[data-testid="approval-chain-release-hold"]'),
    ).not.toBeNull();
    expect(
      document.querySelector("button, input, select, textarea"),
    ).toBeNull();

    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.getChain).not.toHaveBeenCalled();
    expect(mocks.setChain).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("saves a custom-field limit against the loaded policy", async () => {
    render(<CustomFieldGovernance />);
    await waitFor(() => expect(button("Configure limits")).toBeTruthy());
    act(() => button("Configure limits").click());
    const max = document.querySelector<HTMLInputElement>(
      'input[type="number"]',
    );
    if (!max) throw new Error("Expected custom-field cap");
    setInput(max, "200");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Custom-field governance", canSave: true, canDiscard: true },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.updateLimits).toHaveBeenCalledWith({ max_custom_fields: 200 });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("saves an archive domain and advances the acknowledged domain", async () => {
    mocks.getArchiveDomain
      .mockResolvedValueOnce({ data: archiveStatus })
      .mockResolvedValue({
        data: { ...archiveStatus, domain: "news.example.com" },
      });
    render(<ArchiveDomainSection />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>("#archive-domain-input"),
      ).not.toBeNull(),
    );
    const domain = document.querySelector<HTMLInputElement>(
      "#archive-domain-input",
    )!;
    setInput(domain, "news.example.com");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Archive custom domain", canSave: true, canDiscard: true },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.putArchiveSettings).toHaveBeenCalledWith({
      archive_domain: "news.example.com",
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("saves identifier transforms while keeping preview input secondary", async () => {
    render(<IdentifierTransformsSection />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    const dots = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    act(() => dots.click());

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Identifier transforms", canSave: true, canDiscard: true },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.updateIdentifiers).toHaveBeenCalledWith({
      email_normalize_dots: true,
      email_normalize_plus: false,
      phone_e164_format: false,
      phone_default_region: "",
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
