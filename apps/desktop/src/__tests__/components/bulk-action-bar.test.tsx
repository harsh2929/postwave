// @vitest-environment happy-dom

import axe from "axe-core";
import {
  act,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
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

import type { Subscriber } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  listLists: vi.fn(),
  bulkTag: vi.fn(),
  bulkSuppress: vi.fn(),
  bulkDelete: vi.fn(),
  bulkRecover: vi.fn(),
  bulkResubscribe: vi.fn(),
  bulkAddToList: vi.fn(),
  bulkSetCustomField: vi.fn(),
  bulkUpdateMergeField: vi.fn(),
  bulkGrantConsent: vi.fn(),
  bulkRevokeConsent: vi.fn(),
  bulkExport: vi.fn(),
  saveFile: vi.fn(),
  validate: vi.fn(),
  merge: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listLists: mocks.listLists,
    bulkTagSubscribers: mocks.bulkTag,
    bulkUnsubscribeSubscribers: mocks.bulkSuppress,
    bulkDeleteSubscribers: mocks.bulkDelete,
    bulkRecoverSubscribers: mocks.bulkRecover,
    bulkResubscribeSubscribers: mocks.bulkResubscribe,
    bulkAddToListSubscribers: mocks.bulkAddToList,
    bulkSetCustomFieldSubscribers: mocks.bulkSetCustomField,
    bulkUpdateMergeFieldSubscribers: mocks.bulkUpdateMergeField,
    bulkGrantConsentSubscribers: mocks.bulkGrantConsent,
    bulkRevokeConsentSubscribers: mocks.bulkRevokeConsent,
    bulkExportSubscribersBySegment: mocks.bulkExport,
  },
  emailValidationApi: { checkBatch: mocks.validate },
  mergeApplyApi: { apply: mocks.merge },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/file-transfer", () => ({ saveFile: mocks.saveFile }));

vi.mock("../../components/subscribers/LookalikeGeneratorModal", () => ({
  LookalikeGeneratorModal: () => null,
}));

vi.mock("../../components/subscribers/ValidationResultsModal", () => ({
  ValidationResultsModal: (props: {
    open: boolean;
    validSubsetCount: number;
    onExportValidSubset: () => void;
  }) =>
    props.open ? (
      <button type="button" onClick={props.onExportValidSubset}>
        Export validated subset ({props.validSubsetCount})
      </button>
    ) : null,
}));

import { BulkActionBar } from "../../components/subscribers/BulkActionBar";
import {
  bulkBusyLabel,
  classifyResubscribeEligibility,
  parseBulkTags,
  selectedSubscriberIds,
} from "../../components/subscribers/bulk-action-types";

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
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.canAdmin = true;
  mocks.listLists.mockResolvedValue({ data: { results: [] } });
  mocks.bulkTag.mockResolvedValue({
    data: { affected: 2, recovery_token: "recovery-token" },
  });
  mocks.bulkSuppress.mockResolvedValue({
    data: { affected: 2, source: "explicit_ids" },
  });
  mocks.bulkDelete.mockResolvedValue({
    data: { affected: 5 },
  });
  mocks.bulkGrantConsent.mockResolvedValue({ data: { affected: 2 } });
  mocks.bulkAddToList.mockResolvedValue({ data: { affected: 2 } });
  mocks.bulkSetCustomField.mockResolvedValue({ data: { affected: 2 } });
  mocks.bulkUpdateMergeField.mockResolvedValue({ data: { affected: 2 } });
  mocks.bulkResubscribe.mockResolvedValue({
    data: { affected: 1, exclusions: {} },
  });
  mocks.bulkExport.mockResolvedValue({
    data: {
      blob: new Blob(["email\none@example.test\n"], { type: "text/csv" }),
      filename: "selected-subscribers.csv",
    },
  });
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "bulk-export-one",
    collision: false,
  });
  mocks.merge.mockResolvedValue({ data: { events_moved: 3 } });
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function subscriber(id: string, email = `${id}@example.com`): Subscriber {
  return { id, email, status: "enabled", tags: [] } as Subscriber;
}

function renderBar(
  selected: Subscriber[],
  overrides: {
    canMutate?: boolean;
    setRows?: Dispatch<SetStateAction<Subscriber[] | null>>;
    onDone?: (skipReload?: boolean) => void;
    onOpenDedupeReview?: () => void;
  } = {},
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const node: ReactElement = (
    <BulkActionBar
      selected={selected}
      onClear={() => undefined}
      rows={selected}
      setRows={overrides.setRows}
      onDone={overrides.onDone ?? (() => undefined)}
      onOpenDedupeReview={overrides.onOpenDedupeReview ?? (() => undefined)}
      canMutate={overrides.canMutate ?? true}
    />
  );
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function lastButton(label: string): HTMLButtonElement {
  const matches = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((candidate) => candidate.textContent?.trim() === label);
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function fillConsentEvidence(prefix: string, confirmation: string): string {
  const captured = "2026-01-02T10:30";
  setSelect(
    document.getElementById(`${prefix}-source`) as HTMLSelectElement,
    "double_optin",
  );
  setSelect(
    document.getElementById(`${prefix}-channel`) as HTMLSelectElement,
    "email",
  );
  setSelect(
    document.getElementById(`${prefix}-basis`) as HTMLSelectElement,
    "consent",
  );
  setInput(
    document.getElementById(`${prefix}-occurred-at`) as HTMLInputElement,
    captured,
  );
  setInput(
    document.getElementById(`${prefix}-jurisdiction`) as HTMLInputElement,
    "gb",
  );
  setInput(
    document.getElementById(`${prefix}-policy`) as HTMLInputElement,
    "privacy-2026-01",
  );
  setTextarea(
    document.getElementById(`${prefix}-evidence`) as HTMLTextAreaElement,
    "receipt:consent-123",
  );
  setTextarea(
    document.getElementById(`${prefix}-reason`) as HTMLTextAreaElement,
    "Reviewed the double opt-in receipt.",
  );
  const confirmationInput = document.getElementById(
    `${prefix}-confirmation`,
  ) as HTMLInputElement;
  const scope = confirmationInput
    .closest('[role="dialog"]')
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!scope) throw new Error(`Missing ${prefix} scope acknowledgement`);
  act(() => scope.click());
  setInput(confirmationInput, confirmation);
  return new Date(captured).toISOString();
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
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

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTime(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("BulkActionBar extraction", () => {
  it("keeps payload helpers, tag parsing, and progress labels exact", () => {
    expect(
      selectedSubscriberIds([
        subscriber("one"),
        { email: "missing@example.com" } as Subscriber,
        subscriber("two"),
      ]),
    ).toEqual(["one", "two"]);
    expect(parseBulkTags(" vip, beta-tester, , vip ")).toEqual([
      "vip",
      "beta-tester",
      "vip",
    ]);
    expect(
      bulkBusyLabel(
        "tag",
        { current: 1, total: 3, label: "Tagging" },
        "Add tag",
        "Tagging",
        "tag",
      ),
    ).toBe("Tagging 1/3…");

    expect(
      classifyResubscribeEligibility([
        { ...subscriber("blocked"), status: "blocklisted" },
        subscriber("active"),
        { ...subscriber("unknown"), status: "migrated_state" },
        { email: "missing-id@example.test", status: "blocklisted" },
      ]),
    ).toEqual({
      eligibleIds: ["blocked"],
      eligible: 1,
      alreadySubscribed: 1,
      ineligible: 0,
      unknown: 1,
      missingId: 1,
    });
  });

  it("gates admin-only mutations while retaining read-only validation", () => {
    mocks.canAdmin = false;
    renderBar([subscriber("one"), subscriber("two")]);

    expect(
      document.querySelector('[role="region"][aria-label="Bulk actions"]'),
    ).not.toBeNull();
    expect(button("Add tag").disabled).toBe(true);
    expect(button("Suppress").disabled).toBe(true);
    expect(button("Delete").disabled).toBe(true);
    expect(button("Validate emails").disabled).toBe(false);
    expect(button("Generate Lookalike").disabled).toBe(false);
    expect(button("Review duplicates…").disabled).toBe(false);
  });

  it("exposes visible action guidance, disclosure ownership, and blocked reasons", async () => {
    mocks.canAdmin = false;
    renderBar([subscriber("one"), subscriber("two")], { canMutate: false });

    const region = document.querySelector<HTMLElement>(
      '[role="region"][aria-label="Bulk actions"]',
    );
    expect(region).not.toBeNull();
    expect(region?.querySelector("[title]")).toBeNull();
    expect(region?.textContent).toContain("Validate is read-only");
    expect(region?.textContent).toContain(
      "Viewer access can validate selected emails but cannot change subscriber records.",
    );

    const validate = button("Validate emails");
    const guidanceId = validate.getAttribute("aria-describedby");
    expect(guidanceId).not.toBeNull();
    expect(document.getElementById(guidanceId!)?.textContent).toContain(
      "mail routing",
    );

    const more = button("More…");
    act(() => more.click());
    const controlledId = more.getAttribute("aria-controls");
    const controlled = controlledId
      ? document.getElementById(controlledId)
      : null;
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(controlled?.getAttribute("role")).toBe("group");
    expect(controlled?.getAttribute("aria-label")).toBe("More bulk actions");

    const results = await axe.run(region!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("submits comma-separated tags on Enter with exact sequenced payloads", async () => {
    const setRows = vi.fn(
      (_next: SetStateAction<Subscriber[] | null>): void => undefined,
    );
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar([subscriber("one"), subscriber("two")], { setRows, onDone });

    act(() => button("Add tag").click());
    const input = document.querySelector<HTMLInputElement>("#bulk-tags");
    if (!input) throw new Error("Missing bulk tag input");
    setInput(input, "vip, beta-tester");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() => expect(mocks.bulkTag).toHaveBeenCalledTimes(2));
    expect(mocks.bulkTag).toHaveBeenNthCalledWith(1, {
      subscriber_ids: ["one", "two"],
      tag: "vip",
    });
    expect(mocks.bulkTag).toHaveBeenNthCalledWith(2, {
      subscriber_ids: ["one", "two"],
      tag: "beta-tester",
    });
    expect(setRows).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("makes privacy erasure explicit, irreversible, and type-confirmed", async () => {
    const selected = Array.from({ length: 5 }, (_, index) =>
      subscriber(String(index + 1)),
    );
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar(selected, { onDone });

    act(() => button("Delete").click());
    expect(document.body.textContent).toContain("Irreversible privacy erasure");
    expect(document.body.textContent).toContain("no recovery snapshot or Undo");
    const confirm = button("Permanently erase");
    expect(confirm.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="ERASE 5"]',
    );
    if (!input) throw new Error("Missing delete confirmation input");
    setInput(input, "ERASE 5");
    expect(button("Permanently erase").disabled).toBe(false);
    act(() => button("Permanently erase").click());

    await waitFor(() => expect(mocks.bulkDelete).toHaveBeenCalledTimes(1));
    expect(mocks.bulkDelete).toHaveBeenCalledWith({
      subscriber_ids: ["1", "2", "3", "4", "5"],
    });
    expect(mocks.bulkRecover).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Permanently erased 5 subscribers. Every known address remains suppressed; no recovery copy was created.",
      ),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("routes merge intent into the complete reviewed duplicate workspace", () => {
    const onOpenDedupeReview = vi.fn();
    renderBar([subscriber("primary"), subscriber("duplicate")], {
      onOpenDedupeReview,
    });

    act(() => button("Review duplicates…").click());

    expect(onOpenDedupeReview).toHaveBeenCalledTimes(1);
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(document.querySelector('input[name="merge-primary"]')).toBeNull();
  });

  it("keeps extended consent actions admin-gated with the exact ledger payload", async () => {
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar([subscriber("one"), subscriber("two")], { onDone });

    act(() => button("More…").click());
    expect(button("Grant consent").disabled).toBe(false);
    act(() => button("Grant consent").click());
    expect(button("Grant").disabled).toBe(true);
    const occurredAt = fillConsentEvidence("bulk-consent", "GRANT 2");
    act(() => button("Grant").click());

    await waitFor(() =>
      expect(mocks.bulkGrantConsent).toHaveBeenCalledTimes(1),
    );
    expect(mocks.bulkGrantConsent).toHaveBeenCalledWith({
      subscriber_ids: ["one", "two"],
      category: "email_marketing",
      source: "double_optin",
      channel: "email",
      legal_basis: "consent",
      occurred_at: occurredAt,
      jurisdiction: "GB",
      evidence: "receipt:consent-123",
      reason: "Reviewed the double opt-in receipt.",
      policy_version: "privacy-2026-01",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("resubscribes only recognized blocklisted rows after explicit evidence review", async () => {
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar(
      [
        { ...subscriber("blocked"), status: "blocklisted" },
        subscriber("active"),
        { ...subscriber("unknown"), status: "legacy_mystery" },
      ],
      { onDone },
    );

    act(() => button("More…").click());
    act(() => button("Resubscribe").click());
    expect(document.body.textContent).toContain("Unknown or missing id");
    expect(button("Resubscribe 1").disabled).toBe(true);
    const occurredAt = fillConsentEvidence("bulk-resubscribe", "RESUBSCRIBE 1");
    act(() => button("Resubscribe 1").click());

    await waitFor(() => expect(mocks.bulkResubscribe).toHaveBeenCalledTimes(1));
    expect(mocks.bulkResubscribe).toHaveBeenCalledWith({
      subscriber_ids: ["blocked"],
      source: "double_optin",
      channel: "email",
      legal_basis: "consent",
      occurred_at: occurredAt,
      jurisdiction: "GB",
      evidence: "receipt:consent-123",
      reason: "Reviewed the double opt-in receipt.",
      policy_version: "privacy-2026-01",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("keeps bulk export busy through persistence and reports exact id scope", async () => {
    let resolveSave: ((value: unknown) => void) | null = null;
    mocks.saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderBar([
      subscriber("one"),
      { email: "missing-id@example.test" } as Subscriber,
      subscriber("two"),
    ]);
    act(() => button("More…").click());
    act(() => button("Export CSV").click());

    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledTimes(1));
    expect(mocks.bulkExport).toHaveBeenCalledWith({
      subscriber_ids: ["one", "two"],
    });
    expect(button("Exporting…").disabled).toBe(true);

    await act(async () => {
      resolveSave?.({
        ok: true,
        status: "saved",
        transferId: "bulk-saved",
        collision: false,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Selected-subscriber export saved for 2 subscribers.",
      ),
    );
  });

  it("exports only the validated, id-bearing valid subset", async () => {
    mocks.validate.mockResolvedValue({
      data: {
        summary: { total: 3, valid: 2, invalid: 1 },
        results: [
          {
            email: "valid@example.test",
            valid: true,
            verdict: "ok",
            reasons: [],
          },
          {
            email: "invalid@example.test",
            valid: false,
            verdict: "no_mx",
            reasons: ["No MX"],
          },
          {
            email: "idless@example.test",
            valid: true,
            verdict: "ok",
            reasons: [],
          },
        ],
      },
    });
    renderBar([
      subscriber("valid", "valid@example.test"),
      subscriber("invalid", "invalid@example.test"),
      { email: "idless@example.test", status: "enabled" } as Subscriber,
    ]);

    act(() => button("Validate emails").click());
    await waitFor(() => expect(mocks.validate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(button("Export validated subset (1)")).not.toBeNull(),
    );
    act(() => button("Export validated subset (1)").click());

    await waitFor(() => expect(mocks.bulkExport).toHaveBeenCalledTimes(1));
    expect(mocks.bulkExport).toHaveBeenCalledWith({
      subscriber_ids: ["valid"],
    });
  });

  it("treats bulk export cancellation as neutral and write failure as failed", async () => {
    mocks.saveFile.mockResolvedValueOnce({
      ok: true,
      status: "cancelled",
      transferId: "bulk-cancelled",
    });
    renderBar([subscriber("one")]);
    act(() => button("More…").click());
    act(() => button("Export CSV").click());
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    mocks.saveFile.mockResolvedValueOnce({
      ok: false,
      transferId: "bulk-failed",
      code: "write_failed",
      message: "Moosewave could not save the file.",
    });
    act(() => button("Export CSV").click());
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Moosewave could not save the file.",
    );
  });

  it("does not overwrite concurrent rows with a stale snapshot after suppression fails", async () => {
    mocks.bulkSuppress.mockResolvedValue({
      error: { kind: "http", status: 500, message: "gateway offline" },
    });
    const setRows = vi.fn(
      (_next: SetStateAction<Subscriber[] | null>): void => undefined,
    );
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    const selected = [subscriber("one"), subscriber("two")];
    renderBar(selected, { setRows, onDone });

    act(() => button("Suppress").click());
    act(() => lastButton("Suppress").click());

    await waitFor(() => expect(mocks.bulkSuppress).toHaveBeenCalledTimes(1));
    expect(mocks.bulkSuppress).toHaveBeenCalledWith({
      subscriber_ids: ["one", "two"],
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The exact 2-subscriber scope remains selected for an explicit retry.",
      ),
    );
    expect(setRows).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The server did not confirm suppression: gateway offline",
    );
    expect(button("Suppress retained scope (2)")).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("honours Retry-After with a visible single-flight countdown before retrying", async () => {
    vi.useFakeTimers();
    mocks.bulkSuppress
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 429,
          message: "slow down",
          retryAfterSeconds: 2,
        },
      })
      .mockResolvedValueOnce({
        data: { affected: 2, source: "explicit_ids" },
      });
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar([subscriber("one"), subscriber("two")], { onDone });

    act(() => button("Suppress").click());
    act(() => lastButton("Suppress").click());
    await flushAsync();

    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "automatic attempt 2 of 3 starts in 2s",
    );
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuetext"),
    ).toBe("Waiting 2 seconds before the next automatic attempt");

    await advanceTime(1_000);
    expect(document.body.textContent).toContain(
      "automatic attempt 2 of 3 starts in 1s",
    );
    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(1);

    await advanceTime(1_000);
    await flushAsync();
    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith(false);
  });

  it("cancels an automatic retry wait without making another request", async () => {
    vi.useFakeTimers();
    mocks.bulkSuppress.mockResolvedValue({
      error: {
        kind: "http",
        status: 429,
        message: "slow down",
        retryAfterSeconds: 5,
      },
    });
    renderBar([subscriber("one"), subscriber("two")]);

    act(() => button("Suppress").click());
    act(() => lastButton("Suppress").click());
    await flushAsync();
    act(() => button("Cancel automatic retry").click());
    await flushAsync();

    expect(document.body.textContent).toContain(
      "Automatic suppression retry cancelled",
    );
    expect(document.activeElement?.textContent).toContain(
      "Automatic suppression retry cancelled",
    );
    expect(button("Suppress retained scope (2)")).not.toBeNull();
    await advanceTime(10_000);
    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(1);
  });

  it("stops automatic 429 recovery at the bounded attempt limit", async () => {
    vi.useFakeTimers();
    mocks.bulkSuppress.mockResolvedValue({
      error: {
        kind: "http",
        status: 429,
        message: "still throttled",
        retryAfterSeconds: 1,
      },
    });
    renderBar([subscriber("one"), subscriber("two")]);

    act(() => button("Suppress").click());
    act(() => lastButton("Suppress").click());
    await flushAsync();
    await advanceTime(1_000);
    await flushAsync();
    await advanceTime(1_000);
    await flushAsync();

    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain(
      "Automatic retry stopped at the safety limit",
    );
    expect(button("Suppress retained scope (2)")).not.toBeNull();
    await advanceTime(10_000);
    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(3);
  });

  it("guards the same operation synchronously against repeat confirmation clicks", async () => {
    let resolveRequest:
      | ((value: { data: { affected: number; source: string } }) => void)
      | null = null;
    mocks.bulkSuppress.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar([subscriber("one"), subscriber("two")], { onDone });

    act(() => button("Suppress").click());
    const confirm = lastButton("Suppress");
    act(() => {
      confirm.click();
      confirm.click();
    });
    await flushAsync();
    expect(mocks.bulkSuppress).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest?.({ data: { affected: 2, source: "explicit_ids" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("retains only the unfinished tag steps after a partial sequenced failure", async () => {
    mocks.bulkTag
      .mockResolvedValueOnce({ data: { affected: 2 } })
      .mockResolvedValueOnce({
        error: { kind: "http", status: 500, message: "tag store offline" },
      })
      .mockResolvedValueOnce({ data: { affected: 2 } });
    const onDone = vi.fn((_skipReload?: boolean): void => undefined);
    renderBar([subscriber("one"), subscriber("two")], { onDone });

    act(() => button("Add tag").click());
    const input = document.querySelector<HTMLInputElement>("#bulk-tags");
    if (!input) throw new Error("Missing bulk tag input");
    setInput(input, "vip, beta-tester");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await waitFor(() => expect(mocks.bulkTag).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "1 of 2 tag steps completed for 2 subscribers",
      ),
    );
    expect(onDone).not.toHaveBeenCalled();

    act(() => button("Retry 1 remaining tag step for 2").click());
    await waitFor(() => expect(mocks.bulkTag).toHaveBeenCalledTimes(3));
    expect(mocks.bulkTag).toHaveBeenNthCalledWith(3, {
      subscriber_ids: ["one", "two"],
      tag: "beta-tester",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("distinguishes list-load failure from an empty workspace and retries it", async () => {
    mocks.listLists
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "lists unavailable" },
      })
      .mockResolvedValueOnce({
        data: { results: [{ id: "list-1", name: "Customers" }] },
      });
    renderBar([subscriber("one"), subscriber("two")]);

    act(() => button("More…").click());
    act(() => button("Add to list").click());
    await waitFor(() => expect(mocks.listLists).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Moosewave couldn't load lists. No list selection was assumed.",
      ),
    );
    expect(document.body.textContent).not.toContain("No lists found");

    act(() => button("Retry loading lists").click());
    await waitFor(() => expect(mocks.listLists).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLOptionElement>('option[value="list-1"]')
          ?.textContent,
      ).toBe("Customers"),
    );
    expect(lastButton("Add to list").disabled).toBe(false);
  });

  it("never automatically replays a rate-limited consent-ledger write", async () => {
    vi.useFakeTimers();
    mocks.bulkGrantConsent.mockResolvedValue({
      error: {
        kind: "http",
        status: 429,
        message: "slow down",
        retryAfterSeconds: 2,
      },
    });
    renderBar([subscriber("one"), subscriber("two")]);

    act(() => button("More…").click());
    act(() => button("Grant consent").click());
    fillConsentEvidence("bulk-consent", "GRANT 2");
    act(() => button("Grant").click());
    await flushAsync();

    expect(document.body.textContent).toContain(
      "No automatic retry occurred because replaying granting consent requires an operator decision.",
    );
    expect(button("Retry reviewed consent grant (2)")).not.toBeNull();
    await advanceTime(10_000);
    expect(mocks.bulkGrantConsent).toHaveBeenCalledTimes(1);
  });
});
