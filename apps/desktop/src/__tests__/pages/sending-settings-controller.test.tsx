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
  apiUrl: "https://api-a.postwave.test",
  tenant: "tenant-1",
  user: "user-1",
  credentialSource: "session" as "session" | "api-key",
  credentialFingerprint: null as string | null,
  effectiveRole: "admin" as "admin" | "editor" | "viewer",
  roleStatus: "resolved" as "loading" | "resolved" | "unavailable",
  demo: false,
  tab: "limits" as "overview" | "limits" | "frequency" | "identity",
  setTab: vi.fn(),
  setSection: vi.fn(),
  get: vi.fn(),
  status: vi.fn(),
  put: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  SENDING_TIMEZONES: [
    { value: "Etc/UTC", label: "UTC" },
    { value: "Asia/Kolkata", label: "India" },
  ],
  sendingSettingsApi: {
    get: mocks.get,
    status: mocks.status,
    put: mocks.put,
  },
  getApiUrl: () => mocks.apiUrl,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useRoleStatus: () => mocks.roleStatus,
  useMe: () => ({
    tenant: mocks.tenant,
    user: mocks.user,
    credentialSource: mocks.credentialSource,
    credentialFingerprint: mocks.credentialFingerprint,
    role: "admin",
    effectiveRole: mocks.effectiveRole,
  }),
  setSection: mocks.setSection,
}));

vi.mock("../../lib/config", () => ({
  canonicalApiBaseUrl: (value: string | null | undefined) =>
    value?.replace(/\/+$/u, "") ?? null,
  get DEMO_DATA_FALLBACK_ENABLED() {
    return mocks.demo;
  },
}));

vi.mock("../../lib/desktop-router", () => ({
  useDesktopRouteTab: () => [mocks.tab, mocks.setTab] as const,
}));

vi.mock("../../components/deliverability/FrequencyCapsCard", () => ({
  FrequencyCapsCard: ({ readOnly }: { readOnly?: boolean }) => (
    <div
      data-testid="frequency-caps"
      data-read-only={String(Boolean(readOnly))}
    />
  ),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SendingSettings } from "../../pages/SendingSettings";
import {
  useSendingSettingsController,
  type SendingSettingsController,
} from "../../pages/useSendingSettingsController";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const BASELINE = {
  tenant_id: "tenant-1",
  max_sends_per_hour: 120,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "Asia/Kolkata",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: 16,
  ip_pool: { name: "Primary pool", dedicated: true },
  updated_at: "2026-08-30T06:00:00Z",
};

const REMOTE = {
  ...BASELINE,
  max_sends_per_hour: 180,
  updated_at: "2026-08-30T06:30:00Z",
};

const CLEARED = {
  ...BASELINE,
  max_sends_per_hour: null,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  updated_at: "2026-08-30T07:00:00Z",
};

const APPLIED = {
  ...BASELINE,
  max_sends_per_hour: 275,
  updated_at: "2026-08-30T07:15:00Z",
};

const STATUS = {
  tenant_id: "tenant-1",
  max_sends_per_hour: 120,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "Asia/Kolkata",
  quiet_hours_per_recipient: true,
  bucket_count: 14,
  window_start: "2026-08-30T06:00:00Z",
  window_resets_at: "2026-08-30T07:00:00Z",
  in_quiet_hours: false,
  quiet_changes_at: "2026-08-30T16:30:00Z",
  counter_authoritative: true,
  counter_source: "qualified_shared_limiter",
  counter_scope: "shared",
  cap_coordination_state: "ready",
  cap_coordination_ready: true,
  cap_coordination_cap: 120,
  cap_coordination_matches_settings: true,
  cap_coordination_fence_started_at: null,
};

const NO_ROW_STATUS = {
  ...STATUS,
  max_sends_per_hour: null,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  cap_coordination_cap: null,
};

function statusFor(
  settings: typeof BASELINE,
  overrides: Record<string, unknown> = {},
): typeof STATUS {
  return {
    ...STATUS,
    tenant_id: settings.tenant_id,
    max_sends_per_hour: settings.max_sends_per_hour ?? 120,
    quiet_hours_start: settings.quiet_hours_start,
    quiet_hours_end: settings.quiet_hours_end,
    quiet_hours_tz: settings.quiet_hours_tz,
    quiet_hours_per_recipient: settings.quiet_hours_per_recipient,
    cap_coordination_cap: settings.max_sends_per_hour ?? 120,
    ...overrides,
  } as typeof STATUS;
}

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observedController: SendingSettingsController | null = null;

function ControllerProbe(): ReactElement {
  observedController = useSendingSettingsController();
  return <div data-testid="controller-probe" />;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  observedController = null;
  mocks.canAdmin = true;
  mocks.apiUrl = "https://api-a.postwave.test";
  mocks.tenant = "tenant-1";
  mocks.user = "user-1";
  mocks.credentialSource = "session";
  mocks.credentialFingerprint = null;
  mocks.effectiveRole = "admin";
  mocks.roleStatus = "resolved";
  mocks.demo = false;
  mocks.tab = "limits";
  for (const mock of [
    mocks.setTab,
    mocks.setSection,
    mocks.get,
    mocks.status,
    mocks.put,
    mocks.toastError,
    mocks.toastSuccess,
  ]) {
    mock.mockReset();
  }
  mocks.get.mockResolvedValue({ data: BASELINE });
  mocks.status.mockResolvedValue({ data: STATUS });
  mocks.put.mockResolvedValue({ data: BASELINE });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function capInput(): HTMLInputElement {
  const found = document.querySelector("#sending-hourly-cap");
  if (!(found instanceof HTMLInputElement)) {
    throw new Error("Expected hourly-cap input");
  }
  return found;
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

describe("SendingSettings authority and controller convergence", () => {
  it("does not issue protected reads while role authority is unresolved or viewer-denied", async () => {
    mocks.roleStatus = "loading";
    render(<SendingSettings />);
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Verifying access");

    mocks.roleStatus = "resolved";
    mocks.canAdmin = false;
    act(() => root?.render(<SendingSettings />));
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Admin access required");
  });

  it("fails closed across same-principal API-key rotations without a credential fingerprint", async () => {
    mocks.credentialSource = "api-key";
    mocks.credentialFingerprint = null;
    render(<SendingSettings />);
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Credential identity not verified",
    );
    expect(document.body.textContent).toContain(
      "Re-enter or reconnect the key",
    );

    // A second key generation can resolve to the same actor, tenant, role,
    // scopes, and API origin. Neither key may own local state without its
    // collision-resistant fingerprint.
    act(() => root?.render(<SendingSettings />));
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("releases a first-write retry only after quiescence and an exact canonical no-row reread", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const noRow = {
      tenant_id: "tenant-1",
      quiet_hours_per_recipient: true,
      updated_at: "0001-01-01T00:00:00Z",
    };
    mocks.get.mockResolvedValue({ data: noRow });
    mocks.status.mockResolvedValue({ data: NO_ROW_STATUS });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<ControllerProbe />);
    await waitFor(() =>
      expect(observedController?.baseline?.canonical_no_row_revision).toBe(
        true,
      ),
    );

    let applied = true;
    await act(async () => {
      applied = (await observedController?.save()) ?? true;
    });

    expect(applied).toBe(false);
    expect(mocks.put).toHaveBeenCalledWith({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: "",
    });
    expect(observedController?.mutationUncertain).toBe(true);
    expect(observedController?.mutationError).toContain(
      "mutation window has not quiesced",
    );

    monotonicNow.mockReturnValue(36_000);
    await act(async () => observedController?.refresh());

    expect(observedController?.mutationUncertain).toBe(false);
    expect(observedController?.mutationError).toContain(
      "canonical no-row state is verified after the mutation window",
    );
  });

  it("keeps the editor closed after the initial settings read fails", async () => {
    mocks.get.mockResolvedValueOnce({
      error: { status: 503, message: "settings unavailable" },
    });
    render(<SendingSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No verified policy to edit"),
    );
    expect(document.querySelector("#sending-hourly-cap")).toBeNull();
    expect(document.body.textContent).toContain(
      "Moosewave will not substitute a blank draft",
    );
  });

  it("rejects a valid settings projection for a different tenant", async () => {
    mocks.get.mockResolvedValueOnce({
      data: { ...BASELINE, tenant_id: "tenant-2" },
    });
    render(<SendingSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No verified policy to edit"),
    );

    expect(document.querySelector("#sending-hourly-cap")).toBeNull();
    expect(document.body.textContent).toContain("Reference: invalid_response");
  });

  it("does not carry a draft across an exact-principal switch in one tenant", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: REMOTE });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "250");
    expect(document.body.textContent).toContain("Save changes");

    mocks.user = "user-2";
    act(() => root?.render(<SendingSettings />));

    // Ownership changes synchronously hide the old baseline; the next exact
    // principal gets only its own freshly verified row, never user-1's draft.
    expect(document.querySelector("#sending-hourly-cap")).toBeNull();
    await waitFor(() => expect(capInput().value).toBe("180"));
    expect(document.body.textContent).not.toContain("Save changes");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("does not carry a session draft across API origins with the same IDs", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: REMOTE });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "250");
    expect(document.body.textContent).toContain("Save changes");

    mocks.apiUrl = "https://api-b.postwave.test/gateway/";
    act(() => root?.render(<SendingSettings />));

    expect(document.querySelector("#sending-hourly-cap")).toBeNull();
    await waitFor(() => expect(capInput().value).toBe("180"));
    expect(document.body.textContent).not.toContain("Save changes");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects operational status owned by a different tenant", async () => {
    mocks.tab = "overview";
    mocks.status.mockResolvedValueOnce({
      data: { ...STATUS, tenant_id: "tenant-2" },
    });
    render(<SendingSettings />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Reference: invalid_response",
      ),
    );
    expect(document.body.textContent).toContain("Verification unavailable");
    expect(document.body.textContent).not.toContain("14 counted");
  });

  it("labels identity context unverified when no settings read succeeded", async () => {
    mocks.tab = "identity";
    mocks.get.mockResolvedValueOnce({
      error: { status: 503, message: "settings unavailable" },
    });
    render(<SendingSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Unverified"),
    );
    expect(document.body.textContent).toContain(
      "has not verified a settings response",
    );
    expect(document.body.textContent).not.toContain(
      "verified settings response did not include",
    );
    await flush();
  });

  it("renders editable fields only after adopting a verified baseline", async () => {
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    expect(document.body.textContent).toContain("Legacy fallback preserved");
    expect(document.body.textContent).toContain("16:00 UTC");
  });

  it("retains a dirty draft and exposes a newer baseline after stale refresh", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: REMOTE });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "250");
    act(() => button("Refresh").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "A newer server version is available",
      ),
    );
    expect(capInput().value).toBe("250");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("retains the draft and surfaces the remote revision after a conflict", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: REMOTE });
    mocks.put.mockResolvedValueOnce({
      error: { status: 409, message: "revision mismatch" },
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "250");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "A newer settings version exists",
      ),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "A newer server version is available",
      ),
    );
    expect(capInput().value).toBe("250");
    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({
        max_sends_per_hour: 250,
        expected_updated_at: BASELINE.updated_at,
      }),
    );
  });

  it("distinguishes shared-cap contention from a settings revision conflict", async () => {
    mocks.put.mockResolvedValueOnce({
      error: {
        status: 409,
        code: "sending_cap_change_in_progress",
        message: "cap change already fenced",
      },
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Another sending-cap change is already in progress. No settings were written",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(capInput().value).toBe("275");
    expect(button("Save changes").disabled).toBe(false);
  });

  it("explains when Deliverability Hub owns the cap without inventing a stale revision", async () => {
    mocks.put.mockResolvedValueOnce({
      error: {
        status: 409,
        code: "deliverability_throttle_active",
        message: "active repair owns the cap",
      },
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Deliverability protection currently owns the hourly cap. No settings were written",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "A newer settings version exists",
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(capInput().value).toBe("275");
    expect(button("Save changes").disabled).toBe(false);
  });

  it("retains a dirty draft after an ordinary save failure", async () => {
    mocks.put.mockResolvedValueOnce({
      error: { status: 400, message: "settings rejected" },
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The server rejected these settings",
      ),
    );
    expect(capInput().value).toBe("275");
    expect(button("Save changes").disabled).toBe(false);
  });

  it("releases an exact HTTP 503 not-committed receipt without reconciliation", async () => {
    mocks.put.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 503,
        code: "sending_cap_coordination_unavailable",
        message: "settings were not changed",
      },
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service could not save these settings",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(capInput().value).toBe("275");
    expect(button("Save changes").disabled).toBe(false);
  });

  it("holds a headerless HTTP 503 for reconciliation", async () => {
    mocks.get.mockResolvedValueOnce({ data: BASELINE }).mockResolvedValueOnce({
      error: { status: 503, message: "verification unavailable" },
    });
    mocks.put.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 503,
        code: "service_unavailable",
        message: "upstream unavailable",
      },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain("request outcome is unknown"),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(button("Save changes").disabled).toBe(true);
  });

  it("verifies a valid but non-matching success projection before accepting it", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValueOnce({ data: APPLIED });
    mocks.put.mockResolvedValueOnce({ data: BASELINE });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusFor(APPLIED) });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(capInput().value).toBe("275");
  });

  for (const [label, receipt] of [
    [
      "missing revision",
      (): Record<string, unknown> => {
        const row: Record<string, unknown> = { ...APPLIED };
        delete row.updated_at;
        return row;
      },
    ],
    [
      "Go-zero revision",
      () => ({ ...APPLIED, updated_at: "0001-01-01T00:00:00Z" }),
    ],
    [
      "fractional Go-zero revision",
      () => ({ ...APPLIED, updated_at: "0001-01-01T00:00:00.0Z" }),
    ],
    ["malformed revision", () => ({ ...APPLIED, updated_at: "not-a-time" })],
    [
      "unchanged baseline revision",
      () => ({ ...APPLIED, updated_at: BASELINE.updated_at }),
    ],
    [
      "older revision",
      () => ({ ...APPLIED, updated_at: "2026-08-30T05:59:59.999999999Z" }),
    ],
    [
      "equal instant in another offset",
      () => ({ ...APPLIED, updated_at: "2026-08-30T07:00:00+01:00" }),
    ],
  ] as const) {
    it(`holds a save with a ${label} until canonical reconciliation`, async () => {
      mocks.get
        .mockResolvedValueOnce({ data: BASELINE })
        .mockResolvedValueOnce({
          error: { status: 503, message: "verification unavailable" },
        });
      mocks.put.mockResolvedValueOnce({ data: receipt() });
      render(<SendingSettings />);
      await waitFor(() => expect(capInput().value).toBe("120"));
      setInput(capInput(), "275");
      act(() => button("Save changes").click());

      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "request outcome is unknown",
        ),
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
          ?.disabled,
      ).toBe(true);
      expect(mocks.get).toHaveBeenCalledTimes(2);
    });
  }

  it("never accepts a wrong-tenant mutation response without a same-tenant verification read", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValueOnce({ data: APPLIED });
    mocks.put.mockResolvedValueOnce({
      data: { ...APPLIED, tenant_id: "tenant-2" },
    });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusFor(APPLIED) });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(capInput().value).toBe("275");
  });

  it("blocks editing when both a mutation response and its verification read carry the wrong tenant", async () => {
    mocks.get.mockResolvedValueOnce({ data: BASELINE }).mockResolvedValueOnce({
      data: { ...APPLIED, tenant_id: "tenant-2" },
    });
    mocks.put.mockResolvedValueOnce({
      data: { ...APPLIED, tenant_id: "tenant-2" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain("request outcome is unknown"),
    );
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(true);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("releases an unchanged prior revision only after the monotonic quiescence window", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    mocks.get.mockResolvedValue({ data: BASELINE });
    mocks.put.mockResolvedValueOnce({
      error: { status: 503, message: "response unavailable" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "mutation window has not quiesced",
      ),
    );
    expect(capInput().value).toBe("275");
    expect(button("Save changes").disabled).toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(2);

    monotonicNow.mockReturnValue(36_000);
    act(() => button("Refresh to reconcile").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The prior server revision is verified after the mutation window",
      ),
    );
    expect(button("Save changes").disabled).toBe(false);
  });

  it("ignores an independently changed IP projection when proving the prior CAS revision", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const priorWithNewPool = {
      ...BASELINE,
      ip_pool: { name: "Rotated pool", dedicated: true },
    };
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: priorWithNewPool });
    mocks.status.mockResolvedValue({ data: STATUS });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "mutation window has not quiesced",
      ),
    );

    monotonicNow.mockReturnValue(36_000);
    act(() => button("Refresh to reconcile").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "prior server revision is verified after the mutation window",
      ),
    );
    expect(button("Save changes").disabled).toBe(false);
  });

  it("never treats the same revision with changed CAS-owned policy as the prior state", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const corruptSameRevision = {
      ...BASELINE,
      max_sends_per_hour: 999,
    };
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: corruptSameRevision });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusFor(corruptSameRevision) });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "canonical revision does not prove either a later committed write",
      ),
    );

    monotonicNow.mockReturnValue(36_000);
    act(() => button("Refresh to reconcile").click());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(document.body.textContent).toContain(
      "canonical revision does not prove either a later committed write",
    );
    expect(button("Save changes").disabled).toBe(true);
  });

  it("does not release from a read dispatched before quiescence even when it finishes after the boundary", async () => {
    let monotonicNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValueOnce({ data: BASELINE })
      .mockImplementation(async () => {
        // The refresh began at 34.9 seconds elapsed, but its settings read
        // completes after the 35-second boundary.
        monotonicNow = 36_001;
        return { data: BASELINE };
      });
    mocks.status.mockResolvedValue({ data: STATUS });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<ControllerProbe />);
    await waitFor(() => expect(observedController?.baseline).not.toBeNull());
    const currentForm = observedController?.form;
    if (!currentForm) throw new Error("Expected a verified controller form");
    act(() =>
      observedController?.setForm({ ...currentForm, rateLimit: "275" }),
    );
    await act(async () => {
      await observedController?.save();
    });
    await waitFor(() =>
      expect(observedController?.mutationError).toContain(
        "mutation window has not quiesced",
      ),
    );

    monotonicNow = 35_900;
    await act(async () => observedController?.refresh());
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(observedController?.mutationError).toContain(
      "mutation window has not quiesced",
    );
    expect(observedController?.mutationUncertain).toBe(true);

    // A subsequent pair dispatched after the boundary can prove absence.
    await act(async () => observedController?.refresh());
    await waitFor(() =>
      expect(observedController?.mutationError).toContain(
        "prior server revision is verified after the mutation window",
      ),
    );
    expect(observedController?.mutationUncertain).toBe(false);
  });

  it("keeps the unchanged prior revision held after quiescence while cap authority is fenced", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const fencedPriorStatus = statusFor(BASELINE, {
      cap_coordination_state: "conservatively_fenced",
      cap_coordination_ready: false,
      cap_coordination_matches_settings: false,
      cap_coordination_fence_started_at: "2026-08-30T06:00:01Z",
    });
    mocks.get.mockResolvedValue({ data: BASELINE });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: fencedPriorStatus });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "mutation window has not quiesced",
      ),
    );

    monotonicNow.mockReturnValue(36_000);
    act(() => button("Refresh to reconcile").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "shared sending-cap authority is not ready and matching",
      ),
    );
    expect(button("Save changes").disabled).toBe(true);
  });

  it("reconciles a malformed success response before allowing a retry", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValueOnce({ data: APPLIED });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "parse", message: "invalid JSON" },
    });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusFor(APPLIED) });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("keeps an offline preflight editable because nothing was sent", async () => {
    mocks.put.mockResolvedValueOnce({
      error: {
        kind: "network",
        code: "offline",
        message: "You are offline",
      },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "You are offline. Nothing was sent",
      ),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(capInput().disabled).toBe(false);
    expect(button("Save changes").disabled).toBe(false);
    expect(button("Discard").disabled).toBe(false);
  });

  it("locks editing until an unknown mutation outcome is verified", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValueOnce({
        error: { status: 503, message: "verification unavailable" },
      })
      .mockResolvedValueOnce({ data: APPLIED });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusFor(APPLIED) });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain("request outcome is unknown"),
    );
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(true);
    expect(button("Save changes").disabled).toBe(true);
    expect(button("Discard").disabled).toBe(true);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([
      expect.objectContaining({
        level: "blocking",
        canSave: false,
        canDiscard: false,
      }),
    ]);
    act(() => button("Refresh to reconcile").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(capInput().value).toBe("275");
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(false);
    expect(document.body.textContent).not.toContain(
      "request outcome is unknown",
    );
  });

  for (const [label, revision, message] of [
    ["missing revision", null, "verification read also failed"],
    [
      "Go-zero revision on non-default settings",
      "0001-01-01T00:00:00Z",
      "verification read also failed",
    ],
    [
      "unchanged baseline revision",
      BASELINE.updated_at,
      "canonical revision does not prove either a later committed write",
    ],
    [
      "older revision",
      "2026-08-30T05:59:59.999999999Z",
      "canonical revision does not prove either a later committed write",
    ],
    [
      "equal instant in another offset",
      "2026-08-30T07:00:00+01:00",
      "canonical revision does not prove either a later committed write",
    ],
  ] as const) {
    it(`keeps an ambiguous matching save locked when reconciliation returns a ${label}`, async () => {
      const unproven = { ...APPLIED, updated_at: revision };
      mocks.get
        .mockResolvedValueOnce({ data: BASELINE })
        .mockResolvedValueOnce({ data: unproven })
        .mockResolvedValueOnce({ data: APPLIED });
      mocks.put.mockResolvedValueOnce({
        error: { kind: "network", message: "connection lost" },
      });
      mocks.status
        .mockResolvedValueOnce({ data: STATUS })
        .mockResolvedValue({ data: statusFor(APPLIED) });
      render(<SendingSettings />);
      await waitFor(() => expect(capInput().value).toBe("120"));
      setInput(capInput(), "275");
      act(() => button("Save changes").click());

      await waitFor(() => expect(document.body.textContent).toContain(message));
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
          ?.disabled,
      ).toBe(true);

      act(() => button("Refresh to reconcile").click());
      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          "Sending settings saved and verified",
        ),
      );
      expect(capInput().value).toBe("275");
    });
  }

  it("accepts an ambiguity reconciliation revision one nanosecond after the baseline", async () => {
    const baseline = {
      ...BASELINE,
      updated_at: "2026-08-30T06:00:00.000000001Z",
    };
    const applied = {
      ...APPLIED,
      updated_at: "2026-08-30T06:00:00.000000002Z",
    };
    mocks.get
      .mockResolvedValueOnce({ data: baseline })
      .mockResolvedValue({ data: applied });
    mocks.status
      .mockResolvedValueOnce({ data: statusFor(baseline) })
      .mockResolvedValue({ data: statusFor(applied) });
    mocks.put.mockResolvedValueOnce({
      error: { kind: "network", message: "connection lost" },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(capInput().value).toBe("275");
  });

  it("keeps a persisted save locked until shared cap convergence is proven", async () => {
    const fencedStatus = statusFor(APPLIED, {
      cap_coordination_state: "conservatively_fenced",
      cap_coordination_ready: false,
      cap_coordination_matches_settings: false,
      cap_coordination_fence_started_at: "2026-08-30T07:15:01Z",
    });
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: APPLIED });
    mocks.status
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: fencedStatus })
      .mockResolvedValue({ data: statusFor(APPLIED) });
    mocks.put.mockResolvedValueOnce({
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "durable commit is conservatively fenced",
      },
    });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "settings are persisted, but shared sending-cap convergence is not yet verified",
      ),
    );
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(true);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    act(() => button("Refresh to reconcile").click());
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Sending settings saved and verified",
      ),
    );
    expect(capInput().value).toBe("275");
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(false);
  });

  it("does not combine stale operational status with a different policy", async () => {
    mocks.tab = "overview";
    mocks.get.mockResolvedValueOnce({ data: REMOTE });
    mocks.status.mockResolvedValueOnce({ data: STATUS });
    render(<SendingSettings />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Operational status has not caught up to this policy",
      ),
    );
    expect(document.body.textContent).toContain("Configuration only");
    expect(document.body.textContent).not.toContain("14 counted");
  });

  it("shows an active shared-cap fence without presenting it as synchronized", async () => {
    mocks.tab = "overview";
    mocks.status.mockResolvedValueOnce({
      data: {
        ...STATUS,
        cap_coordination_state: "conservatively_fenced",
        cap_coordination_ready: false,
        cap_coordination_matches_settings: false,
        cap_coordination_fence_started_at: "2026-08-30T06:05:00Z",
      },
    });
    render(<SendingSettings />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Conservatively fenced"),
    );
    expect(document.body.textContent).not.toContain("Policy synchronized");
    expect(document.body.textContent).toContain(
      "new send admission fails closed",
    );
  });

  it("suppresses categorical operational state after a status refresh fails", async () => {
    mocks.tab = "overview";
    mocks.status.mockResolvedValueOnce({ data: STATUS }).mockResolvedValueOnce({
      error: { status: 503, message: "status unavailable" },
    });
    render(<SendingSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Outside quiet hours"),
    );

    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Showing last verified sending status",
      ),
    );
    expect(document.body.textContent).toContain("Configuration only");
    expect(document.body.textContent).not.toContain("Outside quiet hours");
    expect(document.body.textContent).not.toContain("14 counted");
  });

  it("does not carry an older IP projection through an unverified mutation receipt", async () => {
    const appliedWithoutPool = { ...APPLIED, ip_pool: undefined };
    mocks.get.mockResolvedValueOnce({ data: BASELINE }).mockResolvedValueOnce({
      error: { status: 503, message: "projection unavailable" },
    });
    mocks.put.mockResolvedValueOnce({ data: appliedWithoutPool });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    setInput(capInput(), "275");
    act(() => button("Save changes").click());
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Sending settings saved"),
    );

    mocks.tab = "identity";
    act(() => root?.render(<SendingSettings />));
    expect(document.body.textContent).toContain("Not reported");
    expect(document.body.textContent).not.toContain("Primary pool");
  });

  it("marks demo operational evidence as illustrative rather than live", async () => {
    mocks.demo = true;
    mocks.tab = "overview";
    render(<SendingSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Illustrative demo snapshot"),
    );
    expect(document.body.textContent).toContain("Illustrative fixture");
    expect(document.body.textContent).not.toContain("Shared counter verified");
  });

  it("describes a null cap as no workspace ceiling without inventing a gateway default", async () => {
    mocks.tab = "overview";
    mocks.get.mockResolvedValueOnce({ data: CLEARED });
    mocks.status.mockResolvedValueOnce({
      data: {
        ...STATUS,
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        cap_coordination_cap: null,
      },
    });
    render(<SendingSettings />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("No workspace ceiling"),
    );
    expect(document.body.textContent).toContain(
      "provider, quota, and safety controls still apply",
    );
    expect(document.body.textContent).not.toContain("Gateway default");
  });

  it("clears only the revision-checked limit and quiet-hour scope", async () => {
    mocks.get
      .mockResolvedValueOnce({ data: BASELINE })
      .mockResolvedValue({ data: CLEARED });
    mocks.put.mockResolvedValueOnce({ data: CLEARED });
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    act(() => button("Clear limit & quiet hours").click());
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Expected clear confirmation dialog");
    }
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.trim() === "Clear limit & quiet hours",
    );
    if (!confirm) throw new Error("Expected clear confirmation button");
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    const payload = mocks.put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: BASELINE.updated_at,
    });
    expect(payload).not.toHaveProperty("fallback_hour_utc");
    await waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
    );
  });

  for (const [label, receipt] of [
    [
      "missing revision",
      (): Record<string, unknown> => {
        const row: Record<string, unknown> = { ...CLEARED };
        delete row.updated_at;
        return row;
      },
    ],
    [
      "Go-zero revision",
      () => ({ ...CLEARED, updated_at: "0001-01-01T00:00:00Z" }),
    ],
    [
      "fractional Go-zero revision",
      () => ({ ...CLEARED, updated_at: "0001-01-01T00:00:00.0Z" }),
    ],
    ["malformed revision", () => ({ ...CLEARED, updated_at: "not-a-time" })],
    [
      "unchanged baseline revision",
      () => ({ ...CLEARED, updated_at: BASELINE.updated_at }),
    ],
    [
      "older revision",
      () => ({ ...CLEARED, updated_at: "2026-08-30T05:59:59.999999999Z" }),
    ],
    [
      "equal instant in another offset",
      () => ({ ...CLEARED, updated_at: "2026-08-30T07:00:00+01:00" }),
    ],
  ] as const) {
    it(`holds a clear with a ${label} until canonical reconciliation`, async () => {
      mocks.get
        .mockResolvedValueOnce({ data: BASELINE })
        .mockResolvedValueOnce({
          error: { status: 503, message: "verification unavailable" },
        });
      mocks.put.mockResolvedValueOnce({ data: receipt() });
      render(<SendingSettings />);
      await waitFor(() => expect(capInput().value).toBe("120"));
      act(() => button("Clear limit & quiet hours").click());
      const dialog = document.querySelector('[role="alertdialog"]');
      if (!(dialog instanceof HTMLElement)) {
        throw new Error("Expected clear confirmation dialog");
      }
      const confirm = Array.from(dialog.querySelectorAll("button")).find(
        (candidate) =>
          candidate.textContent?.trim() === "Clear limit & quiet hours",
      );
      if (!confirm) throw new Error("Expected clear confirmation button");
      act(() => confirm.click());

      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "request outcome is unknown",
        ),
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
          ?.disabled,
      ).toBe(true);
      expect(mocks.get).toHaveBeenCalledTimes(2);
    });
  }

  it("keeps demo controls and the frequency-cap child read-only", async () => {
    mocks.demo = true;
    render(<SendingSettings />);
    await waitFor(() => expect(capInput().value).toBe("120"));
    expect(document.body.textContent).toContain("Read-only demo");
    expect(
      document.querySelector<HTMLFieldSetElement>(".sending-policy-fieldset")
        ?.disabled,
    ).toBe(true);
    expect(button("Clear limit & quiet hours").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Save changes");

    mocks.tab = "frequency";
    act(() => root?.render(<SendingSettings />));
    const frequency = document.querySelector('[data-testid="frequency-caps"]');
    expect(frequency?.getAttribute("data-read-only")).toBe("true");
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
