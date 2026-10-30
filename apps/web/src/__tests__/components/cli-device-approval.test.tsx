// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  decide: vi.fn(),
  apiPost: vi.fn(),
  query: "user_code=BCDF-GHJK",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/lib/device-login", () => ({
  inspectDeviceGrant: mocks.inspect,
  decideDeviceGrant: mocks.decide,
  normalizeDeviceUserCode: (value: string) => {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return normalized.length > 4
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : normalized;
  },
  isCompleteDeviceUserCode: (value: string) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code = "http_error") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  api: { post: mocks.apiPost },
}));

import CliAuthPage from "@/app/cli/auth/page";
import { ApiError } from "@/lib/api";

let container: HTMLDivElement;
let root: Root;

const SESSION_DETAILS = {
  grantKind: "session" as const,
  account: {
    email: "ada@example.com",
    workspaceName: "Ada Labs",
    workspaceSlug: "ada-labs",
  },
  device: {
    label: "Chrome on Windows",
    type: "desktop",
    os: "Windows 11",
    client: "Chrome",
  },
  expiresIn: 480,
  remember: false,
  scopes: [],
  requiresMfa: false,
  consentToken: "opaque.session.bound.consent-token-1234567890",
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.query = "user_code=BCDF-GHJK";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(createElement(CliAuthPage));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

describe("/cli/auth device consent", () => {
  it("inspects before showing kind-specific consent and explicitly approves", async () => {
    mocks.inspect.mockResolvedValue(SESSION_DETAILS);
    mocks.decide.mockResolvedValue(SESSION_DETAILS);

    await renderPage();

    expect(mocks.inspect).toHaveBeenCalledWith("BCDF-GHJK");
    expect(container.textContent).toContain("Approve sign-in?");
    expect(container.textContent).toContain("Chrome on Windows");
    expect(container.textContent).toContain("Ada Labs");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("BCDF-GHJK");
    expect(container.textContent).not.toContain("requesting an API key");

    await act(async () => {
      button("Approve sign-in").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(mocks.decide).toHaveBeenCalledWith(
      "BCDF-GHJK",
      "approve",
      SESSION_DETAILS.consentToken,
    );
    expect(container.textContent).toContain("Sign-in approved");
  });

  it("keeps legacy API-key disclosure and provides a real deny mutation", async () => {
    const apiKeyDetails = {
      ...SESSION_DETAILS,
      grantKind: "api_key" as const,
      device: { label: "Moosewave CLI", type: "cli" },
      scopes: ["read:reports", "send:transactional"],
      consentToken: undefined,
    };
    mocks.inspect.mockResolvedValue(apiKeyDetails);
    mocks.decide.mockResolvedValue(apiKeyDetails);

    await renderPage();

    expect(container.textContent).toContain("Authorize the Moosewave CLI");
    expect(container.textContent).toContain("Read reports");
    expect(container.textContent).toContain("Send transactional email");

    await act(async () => {
      button("Deny request").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(mocks.decide).toHaveBeenCalledWith("BCDF-GHJK", "deny", undefined);
    expect(container.textContent).toContain("No API key was created");
  });

  it("re-inspects when the session-bound consent proof expires", async () => {
    const refreshed = {
      ...SESSION_DETAILS,
      consentToken: "opaque.session.bound.refreshed-consent-token-1234567890",
    };
    mocks.inspect
      .mockResolvedValueOnce(SESSION_DETAILS)
      .mockResolvedValueOnce(refreshed);
    mocks.decide
      .mockRejectedValueOnce(
        new ApiError("Review again", 400, "consent_required"),
      )
      .mockResolvedValueOnce(refreshed);

    await renderPage();
    await act(async () => {
      button("Approve sign-in").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Approve sign-in?");

    await act(async () => {
      button("Approve sign-in").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(mocks.decide).toHaveBeenLastCalledWith(
      "BCDF-GHJK",
      "approve",
      refreshed.consentToken,
    );
    expect(container.textContent).toContain("Sign-in approved");
  });
});
