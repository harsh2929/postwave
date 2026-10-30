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
  SubscriberDetail,
  SubscriberTrackingPrefs,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  identifierTransformsApi: { preview: mocks.preview },
}));

import {
  IdentifierNormalizationDisclosure,
  PurposeConsentSection,
  TrackingPrefsPanel,
} from "../../components/subscribers/SubscriberPrivacyPanels";

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
  mocks.preview.mockReset();
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
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rerender(node: ReactElement): void {
  act(() => root?.render(node));
}

function transformPreview(
  emailInput: string,
  emailOutput: string,
): {
  data: {
    config: {
      email_normalize_dots: boolean;
      email_normalize_plus: boolean;
      phone_e164_format: boolean;
      phone_default_region: string;
    };
    email_input: string;
    email_output: string;
    email_changed: boolean;
    phones: Array<{
      key: string;
      input: string;
      output: string;
      changed: boolean;
    }>;
  };
} {
  return {
    data: {
      config: {
        email_normalize_dots: true,
        email_normalize_plus: true,
        phone_e164_format: true,
        phone_default_region: "US",
      },
      email_input: emailInput,
      email_output: emailOutput,
      email_changed: emailInput !== emailOutput,
      phones: [],
    },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
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

describe("subscriber privacy panels", () => {
  it("renders absent purpose grants honestly instead of assuming consent", () => {
    render(
      <PurposeConsentSection
        detail={
          {
            consent_email_marketing_at: "2026-07-01T09:30:00.000Z",
            consent_sms_marketing_at: null,
            consent_profiling_at: null,
            consent_targeted_ads_at: null,
            consent_ai_processing_at: null,
          } as SubscriberDetail
        }
      />,
    );

    expect(document.body.textContent).toContain("Email marketing");
    expect(document.querySelectorAll(".badge.success")).toHaveLength(1);
    expect(
      Array.from(document.querySelectorAll(".badge")).filter(
        (badge) => badge.textContent === "Not granted",
      ),
    ).toHaveLength(4);
  });

  it("locks an existing click opt-out under GPC while leaving open tracking mutable", () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    const prefs: SubscriberTrackingPrefs = {
      subscriber_id: "subscriber-1",
      subscriber_email: "reader@example.com",
      open_opt_out_at: null,
      click_opt_out_at: "2026-07-02T10:00:00.000Z",
      effective_open_opt_out: true,
      effective_click_opt_out: true,
      source: "admin",
      gpc: true,
      policy_version: "v2",
      updated_at: "2026-07-02T10:00:00.000Z",
    };

    render(
      <TrackingPrefsPanel
        prefs={prefs}
        saving={null}
        err={null}
        canMutate
        onToggle={onToggle}
      />,
    );

    const toggles = document.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.disabled).toBe(false);
    expect(toggles[1]?.checked).toBe(true);
    expect(toggles[1]?.disabled).toBe(true);
    expect(
      document.querySelector(`label[for="${toggles[0]?.id}"]`)?.textContent,
    ).toContain("Open tracking opt-out");
    expect(
      document.querySelector(`label[for="${toggles[1]?.id}"]`)?.textContent,
    ).toContain("Click tracking opt-out");
    expect(document.body.textContent).toContain("GPC");
    expect(document.body.textContent).toContain("GPC opt-out honored");
    expect(document.body.textContent).toContain("Opens suppressed");
    expect(document.body.textContent).toContain("Clicks suppressed");
    expect(document.body.textContent).toContain(
      "Open tracking is suppressed by Global Privacy Control",
    );

    act(() => toggles[0]?.click());
    expect(onToggle).toHaveBeenCalledWith("open", true);
  });

  it("serializes tracking mutations and renders one group-level error", () => {
    const prefs: SubscriberTrackingPrefs = {
      subscriber_id: "subscriber-1",
      subscriber_email: "reader@example.com",
      open_opt_out_at: null,
      click_opt_out_at: null,
      effective_open_opt_out: false,
      effective_click_opt_out: false,
      source: "admin",
      gpc: false,
      policy_version: "v2",
      updated_at: "2026-07-02T10:00:00.000Z",
    };

    render(
      <TrackingPrefsPanel
        prefs={prefs}
        saving="open"
        err="Tracking update failed"
        canMutate
        onToggle={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const toggles = document.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.disabled).toBe(true);
    expect(toggles[1]?.disabled).toBe(true);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Tracking update failed",
    );
  });

  it("loads and reveals identifier transform before/after values", async () => {
    mocks.preview.mockResolvedValue({
      data: {
        config: {
          email_normalize_dots: true,
          email_normalize_plus: true,
          phone_e164_format: true,
          phone_default_region: "US",
        },
        email_input: "first.last+news@gmail.com",
        email_output: "firstlast@gmail.com",
        email_changed: true,
        phones: [
          {
            key: "phone",
            input: "(415) 555-0100",
            output: "+14155550100",
            changed: true,
          },
        ],
      },
    });

    render(
      <IdentifierNormalizationDisclosure
        email=" first.last+news@gmail.com "
        fields={{ phone: "(415) 555-0100" }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector("button")?.textContent).toContain(
        "Identifier normalization",
      );
    });
    expect(mocks.preview).toHaveBeenCalledWith({
      email: "first.last+news@gmail.com",
      custom_fields: { phone: "(415) 555-0100" },
    });

    act(() => document.querySelector<HTMLButtonElement>("button")?.click());
    expect(document.body.textContent).toContain("first.last+news@gmail.com");
    expect(document.body.textContent).toContain("firstlast@gmail.com");
    expect(document.body.textContent).toContain("+14155550100");
  });

  it("never renders a previous subscriber's identifier preview after inputs change", async () => {
    let resolveSecond: (value: unknown) => void = () => undefined;
    const pendingSecond = new Promise<unknown>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.preview
      .mockResolvedValueOnce(
        transformPreview("first.old@example.com", "firstold@example.com"),
      )
      .mockReturnValueOnce(pendingSecond);

    render(
      <IdentifierNormalizationDisclosure
        email="first.old@example.com"
        fields={{}}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("button")).not.toBeNull();
    });
    act(() => document.querySelector<HTMLButtonElement>("button")?.click());
    expect(document.body.textContent).toContain("first.old@example.com");

    rerender(
      <IdentifierNormalizationDisclosure
        email="second.new@example.com"
        fields={{}}
      />,
    );
    expect(document.body.textContent).not.toContain("first.old@example.com");

    await act(async () => {
      resolveSecond(
        transformPreview("second.new@example.com", "secondnew@example.com"),
      );
      await pendingSecond;
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("secondnew@example.com");
    });
  });

  it("recovers for a new subscriber after a previous preview error", async () => {
    mocks.preview
      .mockResolvedValueOnce({
        error: { message: "temporary failure", status: 503 },
      })
      .mockResolvedValueOnce(
        transformPreview("second.new@example.com", "secondnew@example.com"),
      );

    render(
      <IdentifierNormalizationDisclosure
        email="first.old@example.com"
        fields={{}}
      />,
    );
    await waitFor(() => {
      expect(mocks.preview).toHaveBeenCalledTimes(1);
    });

    rerender(
      <IdentifierNormalizationDisclosure
        email="second.new@example.com"
        fields={{}}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("button")?.textContent).toContain(
        "Identifier normalization",
      );
    });
  });
});
