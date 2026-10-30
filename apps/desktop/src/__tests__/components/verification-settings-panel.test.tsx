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
  roleStatus: "resolved" as "loading" | "resolved" | "unavailable",
  listProviders: vi.fn(),
  getPolicy: vi.fn(),
  credits: vi.fn(),
  saveProvider: vi.fn(),
  savePolicy: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  verificationApi: {
    listProviders: mocks.listProviders,
    getPolicy: mocks.getPolicy,
    credits: mocks.credits,
    saveProvider: mocks.saveProvider,
    savePolicy: mocks.savePolicy,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useRoleStatus: () => mocks.roleStatus,
}));

import {
  credentialRefError,
  VerificationPanel,
} from "../../components/deliverability/VerificationPanel";

const PRIVATE_DETAIL =
  "Bearer private-upstream-token at https://internal.example.test";

const ZEROBOUNCE = {
  provider: "zerobounce",
  credential_ref: "zerobounce-primary",
  enabled: true,
  settings: { cache_ttl_days: 30 },
  last_balance: 250,
  last_balance_at: "2026-08-02T09:00:00.000Z",
};

const KICKBOX = {
  provider: "kickbox",
  credential_ref: "kickbox-primary",
  enabled: false,
  settings: { cache_ttl_days: 45, degrade_on_failure: true },
  last_balance: 125,
  last_balance_at: "2026-08-01T09:00:00.000Z",
};

const PROVIDERS = {
  providers: [ZEROBOUNCE, KICKBOX],
  available: ["zerobounce", "kickbox"],
};

const POLICY = {
  forms_mode: "local",
  forms_reject_statuses: ["invalid", "spamtrap"],
  forms_suggest_typos: true,
  import_mode: "off",
  updated_at: "2026-08-02T10:00:00.000Z",
};

const POLICY_ENVELOPE = {
  policy: POLICY,
  modes: ["off", "local", "full"],
  rejectable_statuses: [
    "invalid",
    "catch_all",
    "spamtrap",
    "abuse",
    "do_not_mail",
    "unknown",
  ],
};

const CREDITS = {
  usage: [
    {
      day: "2026-08-02",
      provider: "zerobounce",
      verified: 14,
      credits_spent: 2,
      local_filtered: 7,
      cache_hits: 3,
    },
  ],
  totals: {
    verified: 14,
    credits_spent: 2,
    local_filtered: 7,
    cache_hits: 3,
    credits_saved: 12,
  },
  provider: "zerobounce",
  balance: 250,
  balance_checked_at: "2026-08-02T09:00:00.000Z",
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
  mocks.roleStatus = "resolved";
  mocks.listProviders.mockReset().mockResolvedValue({ data: PROVIDERS });
  mocks.getPolicy.mockReset().mockResolvedValue({ data: POLICY_ENVELOPE });
  mocks.credits.mockReset().mockResolvedValue({ data: CREDITS });
  mocks.saveProvider.mockReset().mockResolvedValue({ data: ZEROBOUNCE });
  mocks.savePolicy.mockReset().mockResolvedValue({ data: { policy: POLICY } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function render(
  node: ReactElement = <VerificationPanel />,
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  await settle();
}

async function rerender(
  node: ReactElement = <VerificationPanel />,
): Promise<void> {
  act(() => root?.render(node));
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

function input(id: string): HTMLInputElement {
  const match = document.getElementById(id);
  if (!(match instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return match;
}

function select(id: string): HTMLSelectElement {
  const match = document.getElementById(id);
  if (!(match instanceof HTMLSelectElement)) {
    throw new Error(`Select not found: ${id}`);
  }
  return match;
}

function setText(field: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(field: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(target: HTMLElement): void {
  act(() => target.click());
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

describe("verification tenant-credential validation", () => {
  it("accepts opaque tenant-local IDs and rejects global refs, blanks, live keys, bounds, and controls", () => {
    for (const value of [
      "cred_verification_primary",
      "zerobounce-production",
      "71000000-0000-4000-8000-000000000001",
    ]) {
      expect(credentialRefError(value)).toBeNull();
    }

    for (const value of [
      "",
      "vault://verification/zerobounce",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret/postwave",
      "projects/postwave/secrets/kickbox",
      "sk_live_private_value",
      "SG.private-value",
      '{"api_key":"private"}',
      "opaque\u0000unsafe",
      "opaque\tunsafe",
      "opaque\nunsafe",
      "opaque\u202eunsafe",
      "a".repeat(129),
    ]) {
      expect(credentialRefError(value)).not.toBeNull();
    }
  });
});

describe("verification settings role and response containment", () => {
  it("never requests or reveals admin state while authority is loading, unavailable, or viewer", async () => {
    mocks.roleStatus = "loading";
    await render();
    expect(document.body.textContent).toContain(
      "Loading verification permissions",
    );
    expect(mocks.listProviders).not.toHaveBeenCalled();

    mocks.roleStatus = "unavailable";
    await rerender();
    expect(document.body.textContent).toContain(
      "Verification permissions are unavailable",
    );

    mocks.roleStatus = "resolved";
    mocks.canAdmin = false;
    await rerender();
    expect(document.body.textContent).toContain("Admin access required");
    expect(mocks.listProviders).not.toHaveBeenCalled();
    expect(mocks.getPolicy).not.toHaveBeenCalled();
    expect(mocks.credits).not.toHaveBeenCalled();
  });

  it("contains a malformed provider response without hiding valid policy or accounting", async () => {
    mocks.listProviders.mockResolvedValue({
      data: {
        providers: [{ ...ZEROBOUNCE, credential_ref: "safe\u0000unsafe" }],
        available: ["zerobounce", "kickbox"],
      },
    });
    await render();

    expect(document.body.textContent).toContain(
      "Provider settings could not be verified",
    );
    expect(document.body.textContent).toContain("Public signup forms");
    expect(document.body.textContent).toContain("Addresses checked");
    expect(document.body.textContent).toContain("14");
  });

  it("reduces server/provider failures to generic UI and keeps raw details out of text and attributes", async () => {
    mocks.listProviders.mockResolvedValue({
      data: {
        ...PROVIDERS,
        providers: [{ ...ZEROBOUNCE, last_error: PRIVATE_DETAIL }, KICKBOX],
      },
    });
    mocks.getPolicy.mockResolvedValue({
      data: { ...POLICY_ENVELOPE, warning: PRIVATE_DETAIL },
    });
    mocks.credits.mockResolvedValue({
      data: { ...CREDITS, last_error: PRIVATE_DETAIL },
    });
    await render();

    expect(document.body.textContent).toContain(
      "Provider connection needs attention",
    );
    expect(document.body.textContent).toContain(
      "Latest provider balance check failed",
    );
    expect(document.documentElement.outerHTML).not.toContain(PRIVATE_DETAIL);
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("ignores an older admin response after a role transition and clears the restricted DOM", async () => {
    const first = deferred<{ data: typeof PROVIDERS }>();
    mocks.listProviders.mockReset().mockReturnValueOnce(first.promise);
    await render();

    mocks.canAdmin = false;
    await rerender();
    expect(document.body.textContent).toContain("Admin access required");
    expect(document.getElementById("verification-credential-ref")).toBeNull();

    const current = {
      providers: [{ ...KICKBOX, enabled: true }],
      available: ["zerobounce", "kickbox"],
    };
    mocks.listProviders.mockResolvedValueOnce({ data: current });
    mocks.canAdmin = true;
    await rerender();
    expect(input("verification-provider-kickbox").checked).toBe(true);

    first.resolve({ data: PROVIDERS });
    await settle();
    expect(input("verification-provider-kickbox").checked).toBe(true);
    expect(input("verification-credential-ref").value).toBe(
      KICKBOX.credential_ref,
    );
  });
});

describe("verification provider draft lifecycle", () => {
  it("retains independent provider drafts and switches with the selected provider settings", async () => {
    await render();

    click(input("verification-provider-kickbox"));
    expect(input("verification-credential-ref").value).toBe(
      KICKBOX.credential_ref,
    );
    setText(
      input("verification-credential-ref"),
      "kickbox-next",
    );
    click(input("verification-provider-zerobounce"));
    expect(input("verification-credential-ref").value).toBe(
      ZEROBOUNCE.credential_ref,
    );
    click(input("verification-provider-kickbox"));
    expect(input("verification-credential-ref").value).toBe(
      "kickbox-next",
    );
    expect(document.body.textContent).toContain(
      "activate Kickbox and deactivate ZeroBounce only after",
    );
    expect(document.body.textContent).toContain(
      "failed check leaves the former configuration untouched",
    );

    mocks.listProviders.mockResolvedValueOnce({
      data: {
        providers: [
          { ...ZEROBOUNCE, enabled: false },
          {
            ...KICKBOX,
            enabled: true,
            credential_ref: "kickbox-next",
          },
        ],
        available: ["zerobounce", "kickbox"],
      },
    });
    const switchProvider = button("Switch provider");
    await act(async () => {
      switchProvider.click();
      switchProvider.click();
      await Promise.resolve();
    });
    await settle();

    expect(mocks.saveProvider).toHaveBeenCalledTimes(1);
    expect(mocks.saveProvider).toHaveBeenCalledWith("kickbox", {
      credential_ref: "kickbox-next",
      enabled: true,
      settings: KICKBOX.settings,
    });
    expect(document.body.textContent).toContain("Active provider switched");
    expect(input("verification-provider-kickbox").checked).toBe(true);
  });

  it("focuses and explains an invalid reference without submitting or echoing it as copy", async () => {
    await render();
    const reference = input("verification-credential-ref");
    setText(reference, "sk_live_should_never_be_submitted");
    click(button("Save provider"));

    expect(mocks.saveProvider).not.toHaveBeenCalled();
    expect(reference.getAttribute("aria-invalid")).toBe("true");
    expect(reference.getAttribute("aria-describedby")).toContain(
      "verification-credential-error",
    );
    expect(document.activeElement).toBe(reference);
    expect(document.body.textContent).toContain("looks like a live secret");
    expect(document.body.textContent).not.toContain(
      "sk_live_should_never_be_submitted",
    );
  });

  it("requires a fresh acknowledgement when a first provider activates an existing full policy", async () => {
    mocks.listProviders.mockResolvedValue({
      data: {
        providers: [],
        available: ["zerobounce", "kickbox"],
      },
    });
    mocks.getPolicy.mockResolvedValue({
      data: {
        ...POLICY_ENVELOPE,
        policy: { ...POLICY, forms_mode: "full" },
      },
    });
    await render();

    setText(
      input("verification-credential-ref"),
      "zerobounce-primary",
    );
    const save = button("Save provider");
    expect(save.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "activates an existing full-mode policy",
    );
    const acknowledgement = document.querySelector(
      '.verification-card--connection .verification-acknowledgement input[type="checkbox"]',
    );
    if (!(acknowledgement instanceof HTMLInputElement)) {
      throw new Error("Provider activation acknowledgement not found");
    }
    click(acknowledgement);
    expect(save.disabled).toBe(false);

    mocks.listProviders.mockResolvedValueOnce({
      data: {
        providers: [ZEROBOUNCE],
        available: ["zerobounce", "kickbox"],
      },
    });
    click(save);
    await settle();
    expect(mocks.saveProvider).toHaveBeenCalledTimes(1);
  });

  it("preserves all three last-verified sections when post-save refreshes fail", async () => {
    await render();
    setText(
      input("verification-credential-ref"),
      "zerobounce-next",
    );
    mocks.listProviders.mockResolvedValueOnce({
      error: { message: PRIVATE_DETAIL },
    });
    mocks.credits.mockResolvedValueOnce({
      error: { message: PRIVATE_DETAIL },
    });
    click(button("Save provider"));
    await settle();

    expect(document.body.textContent).toContain(
      "Latest connection refresh failed",
    );
    expect(document.body.textContent).toContain("ZeroBounce");
    expect(document.body.textContent).toContain("Public signup forms");
    expect(document.body.textContent).toContain("Latest credit refresh failed");
    expect(document.body.textContent).toContain("Addresses checked");
    expect(document.documentElement.outerHTML).not.toContain(PRIVATE_DETAIL);
  });

  it("uses generic copy for an explicit save rejection and never renders transport detail", async () => {
    mocks.saveProvider.mockResolvedValue({
      error: { message: PRIVATE_DETAIL },
    });
    await render();
    setText(
      input("verification-credential-ref"),
      "zerobounce-next",
    );
    click(button("Save provider"));
    await settle();

    expect(document.body.textContent).toContain(
      "Provider change was not confirmed",
    );
    expect(document.documentElement.outerHTML).not.toContain(PRIVATE_DETAIL);
  });
});

describe("verification policy draft lifecycle", () => {
  it("discards a multi-field draft without a request", async () => {
    await render();
    setSelect(select("verification-forms-mode"), "full");
    click(input("verification-reject-catch_all"));
    click(input("verification-suggest-typos"));

    expect(document.body.textContent).toContain("Unsaved changes");
    expect(button("Save enforcement policy").disabled).toBe(true);
    click(button("Discard policy changes"));

    expect(select("verification-forms-mode").value).toBe("local");
    expect(input("verification-reject-catch_all").checked).toBe(false);
    expect(input("verification-suggest-typos").checked).toBe(true);
    expect(button("Save enforcement policy").disabled).toBe(true);
    expect(mocks.savePolicy).not.toHaveBeenCalled();
  });

  it("requires the full-mode acknowledgement and saves only the reviewed bounded draft", async () => {
    await render();
    setSelect(select("verification-forms-mode"), "full");
    click(input("verification-reject-catch_all"));
    click(input("verification-suggest-typos"));
    const save = button("Save enforcement policy");
    expect(save.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Full mode changes cost and continuity behavior",
    );

    const acknowledgement = document.querySelector(
      '.verification-card--policy .verification-acknowledgement input[type="checkbox"]',
    );
    if (!(acknowledgement instanceof HTMLInputElement)) {
      throw new Error("Policy acknowledgement not found");
    }
    click(acknowledgement);
    expect(save.disabled).toBe(false);

    const savedPolicy = {
      forms_mode: "full",
      forms_reject_statuses: ["invalid", "spamtrap", "catch_all"],
      forms_suggest_typos: false,
      import_mode: "off",
      updated_at: "2026-08-02T11:00:00.000Z",
    };
    mocks.savePolicy.mockResolvedValueOnce({
      data: { policy: savedPolicy, warning: PRIVATE_DETAIL },
    });
    click(save);
    await settle();

    expect(mocks.savePolicy).toHaveBeenCalledWith({
      forms_mode: "full",
      forms_reject_statuses: ["invalid", "spamtrap", "catch_all"],
      forms_suggest_typos: false,
      import_mode: "off",
    });
    expect(document.body.textContent).toContain("Enforcement policy saved");
    expect(document.documentElement.outerHTML).not.toContain(PRIVATE_DETAIL);
  });

  it("blocks an empty refusal set instead of allowing the server to substitute hidden defaults", async () => {
    await render();
    click(input("verification-reject-invalid"));
    click(input("verification-reject-spamtrap"));

    expect(document.body.textContent).toContain(
      "Choose at least one refused verdict",
    );
    expect(button("Save enforcement policy").disabled).toBe(true);
    expect(mocks.savePolicy).not.toHaveBeenCalled();
  });

  it("refreshes after an untrusted save outcome and never exposes the thrown detail", async () => {
    await render();
    setSelect(select("verification-import-mode"), "local");
    mocks.savePolicy.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));
    mocks.getPolicy.mockResolvedValueOnce({ data: POLICY_ENVELOPE });
    click(button("Save enforcement policy"));
    await settle();

    expect(document.body.textContent).toContain(
      "Policy save was not confirmed",
    );
    expect(select("verification-import-mode").value).toBe("off");
    expect(document.documentElement.outerHTML).not.toContain(PRIVATE_DETAIL);
  });
});

describe("verification settings accessibility semantics", () => {
  it("exposes labeled native controls, grouped choices, live receipts, and no hover-only content", async () => {
    await render();

    expect(document.querySelectorAll("section[aria-labelledby]")).toHaveLength(
      3,
    );
    expect(
      document.querySelector(".verification-provider-picker legend")
        ?.textContent,
    ).toBe("Choose provider");
    expect(
      document.querySelector(".verification-rejection-fieldset legend")
        ?.textContent,
    ).toBe("Signup verdicts to refuse");
    expect(
      document.querySelectorAll(
        '.verification-provider-picker input[type="radio"]',
      ),
    ).toHaveLength(2);
    expect(input("verification-credential-ref").labels?.length).toBe(1);
    expect(input("verification-suggest-typos").labels?.length).toBe(1);
    expect(
      document.querySelector(
        '.verification-policy-receipt[aria-live="polite"]',
      ),
    ).not.toBeNull();
    expect(document.querySelector("[title]")).toBeNull();
  });
});
