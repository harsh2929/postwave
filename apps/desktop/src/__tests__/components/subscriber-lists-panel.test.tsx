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

import type {
  SubscriberDetail,
  SubscriberTrackingPrefs,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  addSubscriberToList: vi.fn(),
  captureFrequencyChange: vi.fn(),
  captureTrackingProps: vi.fn(),
  customFieldsList: vi.fn(),
  getConsentReceiptsByEmail: vi.fn(),
  getSubscriberGroupMemberships: vi.fn(),
  getSubscriberMergeFields: vi.fn(),
  getSubscriberTrackingPrefs: vi.fn(),
  listLists: vi.fn(),
  listMergeFieldSchema: vi.fn(),
  listsForSubscriber: vi.fn(),
  patchSubscriberMergeFields: vi.fn(),
  patchSubscriberTrackingPrefs: vi.fn(),
  removeSubscriberFromList: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  updateSubscriber: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    addSubscriberToList: mocks.addSubscriberToList,
    getConsentReceiptsByEmail: mocks.getConsentReceiptsByEmail,
    getSubscriberGroupMemberships: mocks.getSubscriberGroupMemberships,
    getSubscriberTrackingPrefs: mocks.getSubscriberTrackingPrefs,
    listLists: mocks.listLists,
    listsForSubscriber: mocks.listsForSubscriber,
    patchSubscriberTrackingPrefs: mocks.patchSubscriberTrackingPrefs,
    removeSubscriberFromList: mocks.removeSubscriberFromList,
    updateSubscriber: mocks.updateSubscriber,
  },
  customFieldsApi: { list: mocks.customFieldsList },
  getSubscriberMergeFields: mocks.getSubscriberMergeFields,
  listMergeFieldSchema: mocks.listMergeFieldSchema,
  patchSubscriberMergeFields: mocks.patchSubscriberMergeFields,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/subscribers/ChannelConsentsPanel", () => ({
  ChannelConsentsPanel: () => <div>Channel consent controls</div>,
}));

vi.mock("../../components/subscribers/FrequencyPreferencePanel", () => ({
  FrequencyPreferencePanel: (props: {
    onChange: (updated: SubscriberDetail) => void;
  }) => {
    mocks.captureFrequencyChange(props.onChange);
    return <div>Frequency preference controls</div>;
  },
}));

vi.mock("../../components/subscribers/GppSectionsPanel", () => ({
  GppSectionsPanel: () => <div>GPP sections</div>,
}));

vi.mock("../../components/subscribers/InlineTagChip", () => ({
  AddTagButton: (props: { onAdd: (tag: string) => Promise<void> }) => (
    <button
      type="button"
      aria-label="Add test tag"
      onClick={() => void props.onAdd("new-tag")}
    >
      Add tag
    </button>
  ),
}));

vi.mock("../../components/subscribers/SendTimesPanel", () => ({
  SendTimesPanel: () => <div>Send times</div>,
}));

vi.mock("../../components/subscribers/SubscriberPrivacyPanels", () => ({
  PurposeConsentSection: () => <div>Purpose consent grants</div>,
  TrackingPrefsPanel: (props: {
    canMutate: boolean;
    err: string | null;
    prefs: SubscriberTrackingPrefs | null;
    onToggle: (dimension: "open" | "click", next: boolean) => Promise<void>;
    onRetry?: () => void;
  }) => {
    mocks.captureTrackingProps(props);
    return (
      <div>
        <button
          type="button"
          aria-label="Toggle open tracking"
          disabled={!props.canMutate}
          onClick={() => void props.onToggle("open", true)}
        >
          Toggle tracking
        </button>
        {props.err ? <div role="alert">{props.err}</div> : null}
        {props.err && props.onRetry ? (
          <button type="button" onClick={props.onRetry}>
            Reload tracking preferences
          </button>
        ) : null}
      </div>
    );
  },
}));

import { SubscriberListsPanel } from "../../components/subscribers/SubscriberListsPanel";

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
  mocks.listMergeFieldSchema.mockResolvedValue({
    data: {
      items: [
        {
          key: "company",
          label: "Company",
          default_value: "",
        },
      ],
    },
  });
  mocks.getSubscriberMergeFields.mockResolvedValue({
    data: { values: { company: "Analytical Engines" } },
  });
  mocks.getSubscriberTrackingPrefs.mockResolvedValue({
    data: trackingPrefs({ gpc: true }),
    serverVersion: '"subscriber-tracking-consent:subscriber-1:v1"',
  });
  mocks.getConsentReceiptsByEmail.mockResolvedValue({
    data: { receipts: [{ captured_text: "Global Privacy Control (GPC)" }] },
  });
  mocks.customFieldsList.mockResolvedValue({
    data: [
      {
        key: "website",
        type: "url",
        config: { data_classification: "pii" },
      },
    ],
  });
  mocks.getSubscriberGroupMemberships.mockResolvedValue({
    data: {
      groups: [
        {
          group_id: "group-1",
          category: "Lifecycle",
          name: "VIP",
          type: "manual",
          joined_at: "2026-07-01T10:00:00.000Z",
        },
      ],
    },
  });
  mocks.listsForSubscriber.mockResolvedValue({
    data: { items: [{ id: "list-1", name: "Newsletter" }] },
  });
  mocks.listLists.mockResolvedValue({
    data: { items: [{ id: "list-2", name: "Product updates" }] },
  });
  mocks.updateSubscriber.mockResolvedValue({
    data: detail({ tags: [] }),
  });
  mocks.patchSubscriberMergeFields.mockResolvedValue({
    data: { values: { company: "New company" } },
  });
  mocks.patchSubscriberTrackingPrefs.mockResolvedValue({
    data: trackingPrefs({ open_opt_out_at: "2026-07-15T10:00:00.000Z" }),
    serverVersion: '"subscriber-tracking-consent:subscriber-1:v2"',
  });
  mocks.addSubscriberToList.mockResolvedValue({ data: undefined });
  mocks.removeSubscriberFromList.mockResolvedValue({ data: undefined });
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
    tags: ["vip"],
    custom_fields: { website: "not-a-url" },
    consent_source: "double_optin",
    consent_timestamp: "2026-07-01T09:30:00.000Z",
    ...overrides,
  } as SubscriberDetail;
}

function trackingPrefs(
  overrides: Partial<SubscriberTrackingPrefs> = {},
): SubscriberTrackingPrefs {
  return {
    subscriber_id: "subscriber-1",
    subscriber_email: "reader@example.com",
    open_opt_out_at: null,
    click_opt_out_at: null,
    effective_open_opt_out: false,
    effective_click_opt_out: false,
    source: "admin",
    gpc: false,
    policy_version: "v2",
    updated_at: "2026-07-19T01:02:03.000Z",
    ...overrides,
  };
}

function panel(
  overrides: Partial<ComponentProps<typeof SubscriberListsPanel>> = {},
): ReactElement {
  return (
    <SubscriberListsPanel
      active
      subscriberId="subscriber-1"
      subscriberEmail="reader@example.com"
      detail={detail()}
      canMutate
      onDetailChange={vi.fn()}
      onPersistedDetailChange={vi.fn()}
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

function changeValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function controlForLabel(label: string): HTMLElement {
  const matchingLabel = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const control = matchingLabel?.htmlFor
    ? document.getElementById(matchingLabel.htmlFor)
    : null;
  if (!control) throw new Error(`Expected a control labelled ${label}`);
  return control;
}

describe("SubscriberListsPanel", () => {
  it("does not fetch a hidden sensitive tab and loads it on activation", async () => {
    const view = render(panel({ active: false }));
    expect(mocks.getSubscriberMergeFields).not.toHaveBeenCalled();
    expect(mocks.getSubscriberTrackingPrefs).not.toHaveBeenCalled();
    expect(mocks.getSubscriberGroupMemberships).not.toHaveBeenCalled();
    expect(mocks.getConsentReceiptsByEmail).not.toHaveBeenCalled();
    expect(mocks.listsForSubscriber).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");

    view.rerender(panel({ active: true }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Newsletter");
      expect(document.body.textContent).toContain("VIP");
      expect(document.body.textContent).toContain("Double opt-in");
      expect(document.body.textContent).toContain(
        "Profile provenance alone does not establish send eligibility.",
      );
    });
    expect(
      document.querySelector('[aria-label="Invalid format"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Data classification: PII"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Personally identifiable information",
    );
    expect(document.body.textContent).toContain("Joined");
    expect(document.body.textContent).toContain("manual");
    expect(document.body.textContent).toContain("Company");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
      "Analytical Engines",
    );
    expect(mocks.captureTrackingProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        prefs: expect.objectContaining({ gpc: true }),
      }),
    );
    expect(mocks.getSubscriberTrackingPrefs).toHaveBeenCalledWith(
      "subscriber-1",
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.getConsentReceiptsByEmail).not.toHaveBeenCalled();
  });

  it("keeps an offline-queued tag removal optimistic and never consumes the ACK", async () => {
    const onDetailChange = vi.fn();
    const onPersistedDetailChange = vi.fn();
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
    render(panel({ onDetailChange, onPersistedDetailChange }));
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove tag vip"]',
        ),
      ).not.toBeNull();
    });

    const removeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove tag vip"]',
    );
    await act(async () => removeButton?.click());

    expect(mocks.updateSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      { tags: [] },
      { version: `"subscriber:subscriber-1:v1"` },
    );
    expect(onDetailChange).toHaveBeenCalledTimes(1);
    expect(onDetailChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subscriber-1", tags: [] }),
    );
    expect(onPersistedDetailChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subscriber-1", tags: [] }),
      { tags: [] },
    );
    expect(onPersistedDetailChange).not.toHaveBeenCalledWith(
      undefined,
      expect.anything(),
    );
  });

  it("requires confirmation before deleting a typed custom-field value", async () => {
    render(panel());
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove website"]',
        ),
      ).not.toBeNull();
      expect(
        document.querySelector('[aria-label="Data classification: PII"]'),
      ).not.toBeNull();
    });

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove website"]')
        ?.click(),
    );
    expect(mocks.updateSubscriber).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Remove custom field value?");
    expect(document.body.textContent).toContain("stored url value");
    expect(document.body.textContent).toContain("classified as PII");

    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Remove field value");
    act(() => confirm?.click());
    await waitFor(() => {
      expect(mocks.updateSubscriber).toHaveBeenCalledWith(
        "subscriber-1",
        { custom_fields: {} },
        { version: `"subscriber:subscriber-1:v1"` },
      );
    });
  });

  it("drops stale eager data when the subscriber changes", async () => {
    const previousValues = deferred<{
      data: { values: Record<string, string> };
    }>();
    mocks.getSubscriberMergeFields
      .mockReturnValueOnce(previousValues.promise)
      .mockResolvedValueOnce({
        data: { values: { company: "Second profile" } },
      });
    const view = render(panel());

    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        subscriberEmail: "second@example.com",
        detail: detail({ id: "subscriber-2", email: "second@example.com" }),
      }),
    );
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Second profile",
      );
    });

    await act(async () => {
      previousValues.resolve({
        data: { values: { company: "Previous profile secret" } },
      });
      await previousValues.promise;
    });
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
      "Second profile",
    );
    expect(document.body.textContent).not.toContain("Previous profile secret");
  });

  it("clears same-value local drafts and drops stale child callbacks after navigation", async () => {
    const onDetailChange = vi.fn();
    const onPersistedDetailChange = vi.fn();
    const view = render(panel({ onDetailChange, onPersistedDetailChange }));
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Analytical Engines",
      );
    });

    const oldFrequencyChange = mocks.captureFrequencyChange.mock.calls.at(
      -1,
    )?.[0] as ((updated: SubscriberDetail) => void) | undefined;
    const mergeInput = document.querySelector<HTMLInputElement>("input");
    if (!mergeInput || !oldFrequencyChange) {
      throw new Error("Expected merge-field and frequency controls");
    }
    changeValue(mergeInput, "Previous subscriber secret draft");
    expect(mergeInput.value).toBe("Previous subscriber secret draft");

    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        subscriberEmail: "second@example.com",
        detail: detail({ id: "subscriber-2", email: "second@example.com" }),
        onDetailChange,
        onPersistedDetailChange,
      }),
    );
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Analytical Engines",
      );
    });
    expect(document.querySelector<HTMLInputElement>("input")?.value).not.toBe(
      "Previous subscriber secret draft",
    );

    act(() => oldFrequencyChange(detail()));
    expect(onDetailChange).not.toHaveBeenCalled();
    expect(onPersistedDetailChange).not.toHaveBeenCalled();
  });

  it("drops an in-flight mutation completion after subscriber navigation", async () => {
    const update = deferred<{ data: SubscriberDetail }>();
    const onDetailChange = vi.fn();
    const onPersistedDetailChange = vi.fn();
    mocks.updateSubscriber.mockReturnValueOnce(update.promise);
    const view = render(panel({ onDetailChange, onPersistedDetailChange }));
    await waitFor(() => {
      expect(
        document.querySelector('button[aria-label="Remove tag vip"]'),
      ).not.toBeNull();
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove tag vip"]')
        ?.click();
    });
    expect(onDetailChange).toHaveBeenCalledTimes(1);
    onDetailChange.mockClear();

    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        subscriberEmail: "second@example.com",
        detail: detail({ id: "subscriber-2", email: "second@example.com" }),
        onDetailChange,
        onPersistedDetailChange,
      }),
    );
    await act(async () => {
      update.resolve({ data: detail({ tags: [] }) });
      await update.promise;
    });
    expect(onDetailChange).not.toHaveBeenCalled();
    expect(onPersistedDetailChange).not.toHaveBeenCalled();
  });

  it("drops an in-flight membership rollback after subscriber navigation", async () => {
    const removal = deferred<{ error: { message: string } }>();
    mocks.listsForSubscriber
      .mockResolvedValueOnce({
        data: { items: [{ id: "list-old", name: "Previous audience" }] },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "list-new", name: "Current audience" }] },
      });
    mocks.removeSubscriberFromList.mockReturnValueOnce(removal.promise);
    const view = render(panel());
    await waitFor(() => {
      expect(
        document.querySelector(
          'button[aria-label="Remove from Previous audience"]',
        ),
      ).not.toBeNull();
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from Previous audience"]',
        )
        ?.click(),
    );

    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        subscriberEmail: "second@example.com",
        detail: detail({ id: "subscriber-2", email: "second@example.com" }),
      }),
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Current audience");
    });

    await act(async () => {
      removal.resolve({ error: { message: "Old membership write failed" } });
      await removal.promise;
    });
    expect(document.body.textContent).toContain("Current audience");
    expect(document.body.textContent).not.toContain("Previous audience");
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining("Old membership write failed"),
    );
  });

  it("adds and removes real list memberships with accessible controls", async () => {
    render(panel());
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from Newsletter"]',
        ),
      ).not.toBeNull();
      expect(
        document.querySelector<HTMLSelectElement>("select"),
      ).not.toBeNull();
    });

    const select = document.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Expected the add-to-list picker");
    changeValue(select, "list-2");
    const addButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Add",
    );
    await act(async () => addButton?.click());
    expect(mocks.addSubscriberToList).toHaveBeenCalledWith(
      "list-2",
      "subscriber-1",
    );

    const removeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove from Newsletter"]',
    );
    await act(async () => removeButton?.click());
    expect(mocks.removeSubscriberFromList).toHaveBeenCalledWith(
      "list-1",
      "subscriber-1",
    );
  });

  it("surfaces tracking failures inline and rolls merge-field failures back", async () => {
    mocks.patchSubscriberTrackingPrefs.mockResolvedValue({
      error: { message: "Tracking update failed" },
    });
    mocks.patchSubscriberMergeFields.mockResolvedValue({
      error: { message: "Merge update failed" },
    });
    render(panel());
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Analytical Engines",
      );
    });

    const trackingButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle open tracking"]',
    );
    await act(async () => trackingButton?.click());
    expect(mocks.patchSubscriberTrackingPrefs).toHaveBeenCalledWith(
      "subscriber-1",
      { open_opt_out: true },
      { version: '"subscriber-tracking-consent:subscriber-1:v1"' },
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Tracking update failed",
    );

    const mergeInput = document.querySelector<HTMLInputElement>("input");
    if (!mergeInput) throw new Error("Expected the merge-field editor");
    changeValue(mergeInput, "Broken update");
    const saveButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    await act(async () => saveButton?.click());
    expect(mocks.patchSubscriberMergeFields).toHaveBeenCalledWith(
      "subscriber-1",
      { company: "Broken update" },
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't update company: Merge update failed",
    );
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Analytical Engines",
      );
    });
  });

  it("fails closed on a tracking revision conflict and reloads a reviewed revision", async () => {
    mocks.getSubscriberTrackingPrefs
      .mockResolvedValueOnce({
        data: trackingPrefs(),
        serverVersion: '"subscriber-tracking-consent:subscriber-1:v1"',
      })
      .mockResolvedValueOnce({
        data: trackingPrefs({
          click_opt_out_at: "2026-07-19T02:00:00.000Z",
          effective_click_opt_out: true,
          updated_at: "2026-07-19T02:00:00.000Z",
        }),
        serverVersion: '"subscriber-tracking-consent:subscriber-1:v3"',
      });
    mocks.patchSubscriberTrackingPrefs
      .mockResolvedValueOnce({
        error: {
          status: 412,
          code: "precondition_failed",
          message: "The resource changed.",
        },
      })
      .mockResolvedValueOnce({
        data: trackingPrefs({
          open_opt_out_at: "2026-07-19T02:05:00.000Z",
          effective_open_opt_out: true,
          updated_at: "2026-07-19T02:05:00.000Z",
        }),
        serverVersion: '"subscriber-tracking-consent:subscriber-1:v4"',
      });

    render(panel());
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle open tracking"]',
        )?.disabled,
      ).toBe(false);
    });

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle open tracking"]',
    );
    await act(async () => toggle?.click());

    expect(mocks.patchSubscriberTrackingPrefs).toHaveBeenLastCalledWith(
      "subscriber-1",
      { open_opt_out: true },
      { version: '"subscriber-tracking-consent:subscriber-1:v1"' },
    );
    expect(toggle?.disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "changed elsewhere",
    );

    const reload = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Reload tracking preferences");
    await act(async () => reload?.click());

    await waitFor(() => {
      expect(mocks.getSubscriberTrackingPrefs).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(toggle?.disabled).toBe(false);
      expect(
        mocks.captureTrackingProps.mock.calls.at(-1)?.[0]?.prefs,
      ).toMatchObject({ effective_click_opt_out: true });
    });
    expect(mocks.getSubscriberTrackingPrefs).toHaveBeenLastCalledWith(
      "subscriber-1",
      { signal: expect.any(AbortSignal) },
    );

    await act(async () => toggle?.click());
    expect(mocks.patchSubscriberTrackingPrefs).toHaveBeenLastCalledWith(
      "subscriber-1",
      { open_opt_out: true },
      { version: '"subscriber-tracking-consent:subscriber-1:v3"' },
    );
  });

  it("keeps verified merge values through a mismatched metadata retry", async () => {
    mocks.customFieldsList
      .mockResolvedValueOnce({ error: { message: "Definitions unavailable" } })
      .mockResolvedValue({ data: [] });
    mocks.getSubscriberMergeFields
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          values: { company: "Verified company" },
        },
      })
      .mockResolvedValueOnce({
        error: {
          message: "The server returned data for a different subscriber.",
        },
      })
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          values: { company: "Recovered company" },
        },
      });
    render(panel());
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Verified company",
      );
      expect(document.body.textContent).toContain("Retry subscriber metadata");
    });

    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Retry subscriber metadata");
    act(() => retry?.click());
    await waitFor(() => {
      expect(mocks.getSubscriberMergeFields).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(
        "Some subscriber metadata couldn't be loaded",
      );
    });
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
      "Verified company",
    );

    const retryAgain = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Retry subscriber metadata");
    act(() => retryAgain?.click());
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
        "Recovered company",
      );
    });
  });

  it("reconciles concurrent merge-field saves per key", async () => {
    mocks.listMergeFieldSchema.mockResolvedValue({
      data: {
        items: [
          { key: "company", label: "Company", default_value: "" },
          { key: "city", label: "City", default_value: "" },
        ],
      },
    });
    mocks.getSubscriberMergeFields.mockResolvedValue({
      data: {
        subscriber_id: "subscriber-1",
        values: { company: "Analytical Engines", city: "London old" },
      },
    });
    const companySave = deferred<{ error: { message: string } }>();
    const citySave = deferred<{
      data: {
        subscriber_id: string;
        values: Record<string, string>;
      };
    }>();
    mocks.patchSubscriberMergeFields.mockImplementation(
      (_subscriberId: string, values: Record<string, string>) =>
        Object.hasOwn(values, "company")
          ? companySave.promise
          : citySave.promise,
    );
    render(panel());
    await waitFor(() => {
      expect(document.querySelectorAll<HTMLInputElement>("input")).toHaveLength(
        2,
      );
    });

    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    changeValue(inputs[0]!, "Analytical Engines Ltd");
    changeValue(inputs[1]!, "London");
    const saveButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent === "Save");
    act(() => {
      saveButtons[0]?.click();
      saveButtons[1]?.click();
    });
    expect(mocks.patchSubscriberMergeFields).toHaveBeenCalledTimes(2);

    await act(async () => {
      citySave.resolve({
        data: {
          subscriber_id: "subscriber-1",
          values: { company: "Stale server copy", city: "London" },
        },
      });
      await citySave.promise;
      companySave.resolve({ error: { message: "Company write rejected" } });
      await companySave.promise;
    });

    await waitFor(() => {
      const current = document.querySelectorAll<HTMLInputElement>("input");
      expect(current[0]?.value).toBe("Analytical Engines");
      expect(current[1]?.value).toBe("London");
    });
    expect(document.body.textContent).not.toContain("Stale server copy");
  });

  it("uses validated type-appropriate merge-field controls and true save prerequisites", async () => {
    mocks.listMergeFieldSchema.mockResolvedValue({
      data: {
        items: [
          {
            key: "score",
            label: "Score",
            type: "number",
            default_value: "",
            required: true,
          },
          {
            key: "verified",
            label: "Verified",
            type: "boolean",
            default_value: "",
            required: true,
          },
          {
            key: "birthday",
            label: "Birthday",
            type: "date",
            default_value: "",
            required: false,
          },
          {
            key: "postal_address",
            label: "Postal address",
            type: "address",
            default_value: "",
            required: true,
          },
          {
            key: "mobile",
            label: "Mobile",
            type: "phone",
            default_value: "",
            required: false,
          },
        ],
      },
    });
    mocks.getSubscriberMergeFields.mockResolvedValue({
      data: {
        subscriber_id: "subscriber-1",
        values: {
          score: "legacy-not-a-number",
          verified: "true",
          birthday: "2025-02-29",
          postal_address: "12 Computing Lane\nLondon",
          mobile: "+44 20 7946 0958 x123",
        },
      },
    });
    mocks.patchSubscriberMergeFields.mockResolvedValue({
      data: {
        subscriber_id: "subscriber-1",
        values: { score: "12.5" },
      },
    });
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Postal address");
    });

    const score = controlForLabel("Score") as HTMLInputElement;
    const verified = controlForLabel("Verified");
    const birthday = controlForLabel("Birthday") as HTMLInputElement;
    const address = controlForLabel("Postal address");
    const mobile = controlForLabel("Mobile") as HTMLInputElement;
    expect(score.tagName).toBe("INPUT");
    expect(score.type).toBe("text");
    expect(score.getAttribute("aria-invalid")).toBe("true");
    expect(verified.tagName).toBe("SELECT");
    expect(birthday.type).toBe("text");
    expect(birthday.getAttribute("aria-invalid")).toBe("true");
    expect(address.tagName).toBe("TEXTAREA");
    expect(address.getAttribute("autocomplete")).toBe("street-address");
    expect(mobile.type).toBe("tel");
    expect(mobile.getAttribute("inputmode")).toBe("tel");
    expect(mobile.getAttribute("autocomplete")).toBe("tel");
    expect(document.body.textContent).toContain("Enter a finite number");

    const saveButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent === "Save");
    expect(saveButtons).toHaveLength(5);
    expect(saveButtons.every((button) => button.disabled)).toBe(true);

    changeValue(birthday, "2024-02-29");
    expect((controlForLabel("Birthday") as HTMLInputElement).type).toBe("date");
    changeValue(verified as HTMLSelectElement, "");
    expect(verified.getAttribute("aria-invalid")).toBe("true");
    expect(verified.parentElement?.querySelector("button")?.disabled).toBe(
      true,
    );
    changeValue(address as HTMLTextAreaElement, "");
    expect(address.getAttribute("aria-invalid")).toBe("true");
    expect(address.parentElement?.querySelector("button")?.disabled).toBe(true);
    changeValue(mobile, "call me");
    expect(mobile.getAttribute("aria-invalid")).toBe("true");
    expect(mobile.parentElement?.querySelector("button")?.disabled).toBe(true);

    changeValue(score, "12.5");
    const correctedScore = controlForLabel("Score") as HTMLInputElement;
    expect(correctedScore.type).toBe("number");
    expect(correctedScore.getAttribute("aria-invalid")).toBeNull();
    const scoreSave =
      correctedScore.parentElement?.querySelector<HTMLButtonElement>("button");
    expect(scoreSave?.disabled).toBe(false);
    await act(async () => scoreSave?.click());
    expect(mocks.patchSubscriberMergeFields).toHaveBeenCalledWith(
      "subscriber-1",
      { score: "12.5" },
    );
  });

  it("serializes same-tick membership requests and exposes the live prerequisite", async () => {
    const request = deferred<{ data: undefined }>();
    mocks.addSubscriberToList.mockReturnValue(request.promise);
    render(panel());
    await waitFor(() => {
      expect(
        document.querySelector<HTMLSelectElement>("select"),
      ).not.toBeNull();
    });
    const select = document.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Expected list picker");
    changeValue(select, "list-2");
    const add = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Add",
    );
    act(() => {
      add?.click();
      add?.click();
    });
    expect(mocks.addSubscriberToList).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Saving 1 list membership change",
    );
    await act(async () => {
      request.resolve({ data: undefined });
      await request.promise;
    });
  });

  it("reconciles concurrent list writes per key when one succeeds and one fails", async () => {
    const addition = deferred<{ data: { added: number; skipped: number } }>();
    const removal = deferred<{ error: { message: string } }>();
    mocks.addSubscriberToList.mockReturnValue(addition.promise);
    mocks.removeSubscriberFromList.mockReturnValue(removal.promise);
    render(panel());
    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from Newsletter"]',
        ),
      ).not.toBeNull();
    });

    const select = document.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Expected list picker");
    changeValue(select, "list-2");
    const add = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Add",
    );
    act(() => add?.click());
    await waitFor(() => {
      expect(
        document.querySelector(
          'button[aria-label="Remove from Product updates"]',
        ),
      ).not.toBeNull();
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from Newsletter"]',
        )
        ?.click(),
    );
    expect(mocks.addSubscriberToList).toHaveBeenCalledTimes(1);
    expect(mocks.removeSubscriberFromList).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Saving 2 list membership changes",
    );

    await act(async () => {
      addition.resolve({ data: { added: 1, skipped: 0 } });
      await addition.promise;
      removal.resolve({ error: { message: "Membership removal rejected" } });
      await removal.promise;
    });

    expect(document.body.textContent).toContain("Product updates");
    expect(document.body.textContent).toContain("Newsletter");
    expect(document.body.textContent).toContain(
      "No other list changes were undone",
    );
    expect(mocks.listsForSubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't remove from list: Membership removal rejected",
    );
  });

  it("keeps viewer mutation reasons focusable and has no serious axe violations", async () => {
    render(panel({ canMutate: false }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Newsletter");
    });
    const removeTag = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove tag vip"]',
    );
    const removeField = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove website"]',
    );
    for (const control of [removeTag, removeField]) {
      expect(control?.disabled).toBe(false);
      expect(control?.getAttribute("aria-disabled")).toBe("true");
      act(() => control?.click());
    }
    expect(mocks.updateSubscriber).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Viewer role can inspect tags but can't add or remove them",
    );
    expect(document.body.textContent).toContain(
      "Viewer role can inspect custom fields but can't remove them",
    );
    const mergeSave = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    expect(mergeSave?.disabled).toBe(true);

    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
