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
  state: {
    loading: false,
    isAdmin: false,
    scopes: new Set<string>(),
    error: null as string | null,
  },
  refresh: vi.fn().mockResolvedValue(undefined),
  controller: vi.fn(),
}));

vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    ...mocks.state,
    hasScope: (scope: string) =>
      mocks.state.scopes.has("admin") || mocks.state.scopes.has(scope),
    refresh: mocks.refresh,
  }),
}));

vi.mock("../../pages/audit/useAuditPageController", () => ({
  useAuditPageController: () => {
    mocks.controller();
    return {};
  },
}));

vi.mock("../../pages/audit/AuditPagePresentation", () => ({
  AuditPagePresentation: () => (
    <div data-testid="audit-workspace">Workspace</div>
  ),
}));

vi.mock("../../pages/audit/AuditAccessPanels", () => ({
  AuditBlockedAccess: ({ error }: { error: string | null }) => (
    <div data-testid="audit-read-blocked">{error ?? "denied"}</div>
  ),
}));

import { Audit } from "../../pages/Audit";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.state = {
    loading: false,
    isAdmin: false,
    scopes: new Set<string>(),
    error: null,
  };
  mocks.refresh.mockClear();
  mocks.controller.mockClear();
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

describe("Audit route private-data boundary", () => {
  it.each([
    {
      label: "scope resolution",
      state: { loading: true, scopes: new Set<string>(), error: null },
    },
    {
      label: "a non-PII audit reader",
      state: {
        loading: false,
        scopes: new Set(["audit:read"]),
        error: null,
      },
    },
    {
      label: "a failed PII scope check",
      state: {
        loading: false,
        scopes: new Set(["audit:read"]),
        error: "scope service unavailable",
      },
    },
    {
      label: "an admin role without an explicit PII grant",
      state: {
        loading: false,
        isAdmin: true,
        scopes: new Set<string>(["audit:read"]),
        error: null,
      },
    },
  ])("never mounts the data controller for $label", ({ state }) => {
    mocks.state = { ...mocks.state, ...state };
    render(<Audit />);
    expect(mocks.controller).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="audit-workspace"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "No audit rows, statistics, live events, or evidence tools have loaded.",
    );
  });

  it("keeps missing read access separate from the private-data hold", () => {
    render(<Audit />);
    expect(mocks.controller).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="audit-read-blocked"]'),
    ).not.toBeNull();
  });

  it("mounts the workspace only after both read scopes verify", () => {
    mocks.state.scopes = new Set(["audit:read", "audit:read_pii"]);
    render(<Audit />);
    expect(mocks.controller).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="audit-workspace"]'),
    ).not.toBeNull();
  });
});
