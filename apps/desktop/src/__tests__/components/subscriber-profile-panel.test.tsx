// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ComponentProps, type ReactElement } from "react";
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

import type { SubscriberDetail } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  getSubscriberLifecycle: vi.fn(),
  listSubscriberAliases: vi.fn(),
  listSubscriberTraits: vi.fn(),
  getSubscriberPredictionMetadata: vi.fn(),
  updateSubscriber: vi.fn(),
  putSubscriberLifecycle: vi.fn(),
  upsertSubscriberAlias: vi.fn(),
  deleteSubscriberAlias: vi.fn(),
  captureAccountLinked: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  SUBSCRIBER_LIFECYCLE_STAGES: [
    "subscriber",
    "lead",
    "mql",
    "sql",
    "opportunity",
    "customer",
    "evangelist",
    "other",
  ],
  api: {
    getSubscriberLifecycle: mocks.getSubscriberLifecycle,
    listSubscriberAliases: mocks.listSubscriberAliases,
    listSubscriberTraits: mocks.listSubscriberTraits,
    getSubscriberPredictionMetadata: mocks.getSubscriberPredictionMetadata,
    updateSubscriber: mocks.updateSubscriber,
    putSubscriberLifecycle: mocks.putSubscriberLifecycle,
    upsertSubscriberAlias: mocks.upsertSubscriberAlias,
    deleteSubscriberAlias: mocks.deleteSubscriberAlias,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/subscribers/AccountSection", () => ({
  AccountSection: (props: {
    onLinked?: (updated: SubscriberDetail) => void;
  }) => {
    mocks.captureAccountLinked(props.onLinked);
    return null;
  },
}));
vi.mock("../../components/subscribers/CatalogAttributesPanel", () => ({
  CatalogAttributesPanel: () => null,
}));
vi.mock("../../components/subscribers/DemographicsPanel", () => ({
  DemographicsPanel: () => null,
}));
vi.mock("../../components/subscribers/FederatedIdentityPanel", () => ({
  FederatedIdentityPanel: () => null,
}));
vi.mock("../../components/subscribers/ReplenishmentCadencePanel", () => ({
  ReplenishmentCadencePanel: () => null,
}));
vi.mock("../../components/subscribers/SubscriberEmailsSection", () => ({
  SubscriberEmailsSection: () => null,
}));
vi.mock("../../components/subscribers/SubscriberPrivacyPanels", () => ({
  IdentifierNormalizationDisclosure: () => null,
}));

import { SubscriberProfilePanel } from "../../components/subscribers/SubscriberProfilePanel";

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
  mocks.getSubscriberLifecycle.mockResolvedValue({
    data: {
      subscriber_id: "subscriber-1",
      subscriber_version: `"subscriber:subscriber-1:v1"`,
      tenant_id: "tenant-1",
      stage: "lead",
      score: 4,
      updated_at: "2026-07-19T08:00:00.000Z",
    },
  });
  mocks.listSubscriberAliases.mockResolvedValue({ data: { items: [] } });
  mocks.listSubscriberTraits.mockResolvedValue({ data: { items: [] } });
  mocks.getSubscriberPredictionMetadata.mockResolvedValue({
    data: { subscriber_id: "subscriber-1", items: [] },
  });
  mocks.updateSubscriber.mockResolvedValue({
    data: detail({ first_name: "Updated" }),
  });
  mocks.putSubscriberLifecycle.mockResolvedValue({
    data: {
      subscriber_id: "subscriber-1",
      subscriber_version: `"subscriber:subscriber-1:v2"`,
      tenant_id: "tenant-1",
      stage: "customer",
      score: 4,
      updated_at: "2026-07-19T08:01:00.000Z",
    },
  });
  mocks.upsertSubscriberAlias.mockResolvedValue({
    data: {
      id: "alias-1",
      subscriber_id: "subscriber-1",
      alias_type: "external_id",
      alias_value: "crm-42",
      confidence: 1,
      source: "desktop",
      subscriber_version: `"subscriber:subscriber-1:v2"`,
      external_id: "crm-42",
    },
  });
  mocks.deleteSubscriberAlias.mockResolvedValue({
    data: {
      deleted: true,
      subscriber_id: "subscriber-1",
      subscriber_version: `"subscriber:subscriber-1:v3"`,
      external_id: null,
    },
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
  vi.clearAllMocks();
});

function detail(overrides: Partial<SubscriberDetail> = {}): SubscriberDetail {
  return {
    id: "subscriber-1",
    version: `"subscriber:subscriber-1:v1"`,
    email: "reader@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    full_name: "Ada Lovelace",
    display_name: "Ada",
    locale: "en-GB",
    language: "en",
    country: "GB",
    region: "London",
    ...overrides,
  } as SubscriberDetail;
}

function panel(
  overrides: Partial<ComponentProps<typeof SubscriberProfilePanel>> = {},
): ReactElement {
  return (
    <SubscriberProfilePanel
      active
      subscriberId="subscriber-1"
      detail={detail()}
      canMutate
      onPersistedDetailChange={vi.fn()}
      onRefreshDetail={vi.fn()}
      formatRelativeTime={() => "just now"}
      {...overrides}
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

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("SubscriberProfilePanel", () => {
  it("does not fetch a hidden profile tab and loads it when activated", async () => {
    const view = render(panel({ active: false }));
    expect(mocks.getSubscriberLifecycle).not.toHaveBeenCalled();
    expect(mocks.getSubscriberPredictionMetadata).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");

    view.rerender(panel({ active: true }));
    await waitFor(() => {
      expect(mocks.getSubscriberLifecycle).toHaveBeenCalledWith(
        "subscriber-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.getSubscriberPredictionMetadata).toHaveBeenCalledWith(
        "subscriber-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(document.body.textContent).toContain("Lifecycle");
      expect(document.body.textContent).toContain("4/5Current score");
      expect(document.body.textContent).toContain("No model has scored");
    });
  });

  it("keeps an offline-queued name update optimistic instead of consuming the ACK", async () => {
    const onChange = vi.fn();
    mocks.updateSubscriber.mockResolvedValue({
      queued: true,
      receipt: {
        queueId: "mutation-1",
        queuedAt: "2026-07-16T00:00:00.000Z",
        state: "pending",
        resource: "subscribers",
        action: "Update subscriber profile",
        record: "Subscriber subscriber-1",
      },
    });
    render(panel({ onPersistedDetailChange: onChange }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("No model has scored"),
    );

    const firstName = document.querySelector<HTMLInputElement>(
      'input[aria-label="First name"]',
    );
    if (!firstName) throw new Error("Expected the first-name editor");
    changeInput(firstName, "Grace");

    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save names",
    );
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());

    expect(mocks.updateSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      {
        first_name: "Grace",
        last_name: "Lovelace",
        full_name: "Ada Lovelace",
        display_name: "Ada",
      },
      { version: `"subscriber:subscriber-1:v1"` },
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "subscriber-1",
        first_name: "Grace",
        email: "reader@example.com",
      }),
    );
    expect(onChange).not.toHaveBeenCalledWith(undefined);
  });

  it("reviews stage and score together, prevents duplicate submits, and chains the verified profile token", async () => {
    const pending = deferred<{
      data: {
        subscriber_id: string;
        subscriber_version: string;
        tenant_id: string;
        stage: "customer";
        score: number;
        updated_at: string;
      };
    }>();
    const onChange = vi.fn();
    mocks.putSubscriberLifecycle.mockReturnValueOnce(pending.promise);
    render(panel({ onPersistedDetailChange: onChange }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("4/5Current score"),
    );
    const lifecycle = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Lifecycle stage"]',
    );
    if (!lifecycle) throw new Error("Expected lifecycle stage selector");

    changeSelect(lifecycle, "customer");
    const scoreFive = document.querySelector<HTMLInputElement>(
      'input[name="subscriber-lifecycle-score"][value="5"]',
    );
    if (!scoreFive) throw new Error("Expected lifecycle score 5 control");
    act(() => scoreFive.click());
    expect(mocks.putSubscriberLifecycle).not.toHaveBeenCalled();

    const review = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Review change",
    );
    act(() => review?.click());
    expect(document.body.textContent).toContain("Move Lead to Customer?");
    expect(document.body.textContent).toContain("Score 5/5");
    expect(mocks.putSubscriberLifecycle).not.toHaveBeenCalled();

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Move to Customer",
    );
    act(() => confirm?.click());
    expect(lifecycle.disabled).toBe(true);
    expect(mocks.putSubscriberLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.putSubscriberLifecycle).toHaveBeenCalledWith(
      "subscriber-1",
      { stage: "customer", score: 5, source: "desktop" },
      `"subscriber:subscriber-1:v1"`,
    );

    await act(async () => {
      pending.resolve({
        data: {
          subscriber_id: "subscriber-1",
          subscriber_version: `"subscriber:subscriber-1:v2"`,
          tenant_id: "tenant-1",
          stage: "customer",
          score: 5,
          updated_at: "2026-07-19T08:01:00.000Z",
        },
      });
      await pending.promise;
    });

    await waitFor(() => {
      expect(lifecycle.disabled).toBe(false);
      expect(lifecycle.value).toBe("customer");
      expect(scoreFive.checked).toBe(true);
      expect(document.body.textContent).not.toContain("Move Lead to Customer?");
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "subscriber-1",
        version: `"subscriber:subscriber-1:v2"`,
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Lifecycle moved to Customer",
    );
  });

  it("keeps lifecycle writes locked until the authoritative stage, score, and revision load", async () => {
    const pending = deferred<{
      data: {
        subscriber_id: string;
        subscriber_version: string;
        tenant_id: string;
        stage: "lead";
        score: number;
        updated_at: string;
      };
    }>();
    mocks.getSubscriberLifecycle.mockReturnValueOnce(pending.promise);
    render(panel());

    const lifecycle = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Lifecycle stage"]',
    );
    expect(lifecycle?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Lifecycle editing stays locked until the server verifies",
    );
    expect(document.body.textContent).toContain(
      "Loading verified lifecycle state",
    );
    expect(mocks.putSubscriberLifecycle).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        data: {
          subscriber_id: "subscriber-1",
          subscriber_version: `"subscriber:subscriber-1:v1"`,
          tenant_id: "tenant-1",
          stage: "lead",
          score: 4,
          updated_at: "2026-07-19T08:00:00.000Z",
        },
      });
      await pending.promise;
    });
    await waitFor(() => expect(lifecycle?.disabled).toBe(false));
    expect(lifecycle?.value).toBe("lead");
  });

  it("fails closed and offers retry when lifecycle truth cannot be verified", async () => {
    mocks.getSubscriberLifecycle.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "private upstream" },
    });
    render(panel());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Retry lifecycle"),
    );
    const lifecycle = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Lifecycle stage"]',
    );
    expect(lifecycle?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Lifecycle editing is locked because the current state couldn't be verified",
    );
    expect(mocks.putSubscriberLifecycle).not.toHaveBeenCalled();
  });

  it("refreshes a stale profile while preserving the operator's reviewed lifecycle draft", async () => {
    const onRefreshDetail = vi.fn();
    mocks.getSubscriberLifecycle
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          subscriber_version: `"subscriber:subscriber-1:v1"`,
          tenant_id: "tenant-1",
          stage: "lead",
          score: 4,
          updated_at: "2026-07-19T08:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          subscriber_version: `"subscriber:subscriber-1:v9"`,
          tenant_id: "tenant-1",
          stage: "mql",
          score: 2,
          updated_at: "2026-07-19T08:05:00.000Z",
        },
      });
    mocks.putSubscriberLifecycle.mockResolvedValueOnce({
      error: { kind: "http", status: 412, message: "stale" },
    });
    render(panel({ onRefreshDetail }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("4/5Current score"),
    );

    const lifecycle = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Lifecycle stage"]',
    );
    const scoreFive = document.querySelector<HTMLInputElement>(
      'input[name="subscriber-lifecycle-score"][value="5"]',
    );
    if (!lifecycle || !scoreFive) throw new Error("Expected lifecycle editor");
    changeSelect(lifecycle, "customer");
    act(() => scoreFive.click());
    const review = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Review change",
    );
    act(() => review?.click());
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Move to Customer",
    );
    await act(async () => confirm?.click());

    await waitFor(() => {
      expect(onRefreshDetail).toHaveBeenCalledTimes(1);
      expect(mocks.getSubscriberLifecycle).toHaveBeenCalledTimes(2);
      expect(lifecycle.disabled).toBe(false);
    });
    expect(lifecycle.value).toBe("customer");
    expect(scoreFive.checked).toBe(true);
    expect(document.body.textContent).toContain("Mql");
    expect(document.body.textContent).toContain("2/5Current score");
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("changed elsewhere"),
    );
  });

  it("drops an unsaved draft and an in-flight mutation when the subscriber changes", async () => {
    const update = deferred<{ data: SubscriberDetail }>();
    const onChange = vi.fn();
    mocks.updateSubscriber.mockReturnValueOnce(update.promise);
    const view = render(panel({ onPersistedDetailChange: onChange }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("No model has scored");
    });

    const firstName = document.querySelector<HTMLInputElement>(
      'input[aria-label="First name"]',
    );
    if (!firstName) throw new Error("Expected the first-name editor");
    changeInput(firstName, "Previous subscriber secret draft");
    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save names",
    );
    act(() => save?.click());
    const staleAccountCompletion:
      | ((updated: SubscriberDetail) => void)
      | undefined = mocks.captureAccountLinked.mock.calls[0]?.[0];
    expect(mocks.updateSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      expect.objectContaining({
        first_name: "Previous subscriber secret draft",
      }),
      { version: `"subscriber:subscriber-1:v1"` },
    );

    // The next subscriber deliberately has the same persisted names. A reset
    // effect keyed only to those fields cannot clear the previous draft.
    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        detail: detail({
          id: "subscriber-2",
          email: "second@example.com",
        }),
        onPersistedDetailChange: onChange,
      }),
    );
    const replacementFirstName = document.querySelector<HTMLInputElement>(
      'input[aria-label="First name"]',
    );
    expect(replacementFirstName?.value).toBe("Ada");
    expect(document.body.textContent).not.toContain(
      "Previous subscriber secret draft",
    );

    update.resolve({
      data: detail({ first_name: "Previous subscriber secret draft" }),
    });
    await act(async () => Promise.resolve());
    act(() => {
      staleAccountCompletion?.(
        detail({ first_name: "Previous subscriber account completion" }),
      );
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith("Names saved");
    expect(replacementFirstName?.value).toBe("Ada");
  });

  it("surfaces unavailable graph routes and hides an unsupported prediction section", async () => {
    const unavailable = {
      error: { kind: "http", status: 404, message: "not found" },
    };
    mocks.getSubscriberLifecycle.mockResolvedValue(unavailable);
    mocks.listSubscriberAliases.mockResolvedValue(unavailable);
    mocks.listSubscriberTraits.mockResolvedValue(unavailable);
    mocks.getSubscriberPredictionMetadata.mockResolvedValue(unavailable);
    render(panel());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Profile graph routes are not available",
      );
    });
    expect(document.body.textContent).not.toContain("Prediction metadata");
  });

  it("exposes prediction confidence and expands explainability features", async () => {
    mocks.getSubscriberPredictionMetadata.mockResolvedValue({
      data: {
        subscriber_id: "subscriber-1",
        items: [
          {
            id: "prediction-1",
            subscriber_id: "subscriber-1",
            score_type: "churn",
            model_version: "churn-v3",
            confidence: 0.82,
            features: { recent_clicks: 4, inactive_days: 2 },
            computed_at: "2026-07-15T08:00:00.000Z",
          },
        ],
      },
    });
    render(panel());

    await waitFor(() => {
      expect(
        document.querySelector('[role="meter"][aria-label="churn confidence"]'),
      ).not.toBeNull();
    });
    const meter = document.querySelector<HTMLElement>(
      '[role="meter"][aria-label="churn confidence"]',
    );
    expect(meter?.getAttribute("aria-valuenow")).toBe("82");
    expect(meter?.getAttribute("aria-label")).toBe("churn confidence");

    const featureButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Feature snapshot"),
    );
    act(() => featureButton?.click());
    expect(featureButton?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("pre")?.textContent).toContain(
      '"recent_clicks": 4',
    );
  });

  it("uses verified contact workflows and chains the subscriber revision for alias writes", async () => {
    const onChange = vi.fn();
    render(panel({ onPersistedDetailChange: onChange }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("No model has scored"),
    );

    const type = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Alias type"]',
    );
    const value = document.querySelector<HTMLInputElement>(
      'input[aria-label="Alias value"]',
    );
    if (!type || !value) throw new Error("Expected the identity-alias editor");
    expect(Array.from(type.options, (option) => option.value)).toEqual([
      "external_id",
      "anonymous_id",
      "device_token",
      "push_token",
      "custom",
    ]);
    expect(document.body.textContent).toContain(
      "Email and phone identities are added through their verified contact-method workflows",
    );

    changeInput(value, "crm-42");
    const add = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Add",
    );
    await act(async () => add?.click());

    expect(mocks.upsertSubscriberAlias).toHaveBeenCalledWith(
      "subscriber-1",
      {
        alias_type: "external_id",
        alias_value: "crm-42",
        source: "desktop",
        provenance: { surface: "subscriber_slideover" },
      },
      `"subscriber:subscriber-1:v1"`,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "subscriber-1",
        version: `"subscriber:subscriber-1:v2"`,
        external_id: "crm-42",
      }),
    );
    expect(document.body.textContent).toContain("External customer ID: crm-42");
  });

  it("keeps viewer prerequisites focusable and exposes full identity data without native titles", async () => {
    mocks.listSubscriberAliases.mockResolvedValue({
      data: {
        items: [
          {
            id: "alias-1",
            subscriber_id: "subscriber-1",
            alias_type: "external_id",
            alias_value: "crm-identifier-that-must-wrap-without-truncation",
            confidence: 1,
            source: "desktop",
          },
        ],
      },
    });
    mocks.listSubscriberTraits.mockResolvedValue({
      data: {
        items: [
          {
            id: "trait-1",
            key: "lifecycle_context",
            value: { tier: "enterprise", region: "apac" },
            source: "computed",
          },
        ],
      },
    });
    render(
      panel({
        canMutate: false,
        detail: detail({ profile_id: "profile-id-that-remains-visible" }),
      }),
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "profile-id-that-remains-visible",
      );
      expect(document.body.textContent).toContain(
        "crm-identifier-that-must-wrap",
      );
      expect(document.body.textContent).toContain('"tier":"enterprise"');
    });

    const saveNames = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save names",
    );
    expect(saveNames?.disabled).toBe(false);
    expect(saveNames?.getAttribute("aria-disabled")).toBe("true");
    act(() => saveNames?.click());
    expect(mocks.updateSubscriber).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Viewer role can inspect names but can't edit them",
    );
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("closes the same-tick duplicate name-save gap and contains thrown requests", async () => {
    const pending = deferred<{ data: SubscriberDetail }>();
    mocks.updateSubscriber.mockReturnValueOnce(pending.promise);
    render(panel());
    await waitFor(() =>
      expect(document.body.textContent).toContain("No model has scored"),
    );
    const firstName = document.querySelector<HTMLInputElement>(
      'input[aria-label="First name"]',
    );
    if (!firstName) throw new Error("Expected first-name editor");
    changeInput(firstName, "Grace");
    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save names",
    );
    act(() => {
      save?.click();
      save?.click();
    });
    expect(mocks.updateSubscriber).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ data: detail({ first_name: "Grace" }) });
      await pending.promise;
    });

    mocks.updateSubscriber.mockRejectedValueOnce(
      new Error("private upstream detail"),
    );
    changeInput(firstName, "Katherine");
    await act(async () => save?.click());
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      "Couldn't save names. Check your connection and retry.",
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining("private upstream detail"),
    );
  });

  it("has no serious automated accessibility violations in the populated profile", async () => {
    render(panel());
    await waitFor(() =>
      expect(document.body.textContent).toContain("No model has scored"),
    );
    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
