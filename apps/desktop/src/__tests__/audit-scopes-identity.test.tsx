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
  me: null as {
    user: string;
    tenant: string;
    effectiveRole: "owner" | "admin" | "editor" | "viewer";
  } | null,
  getMyAuditScopes: vi.fn(),
}));

vi.mock("../lib/store", () => ({
  useMe: () => mocks.me,
}));

vi.mock("../lib/api-client", () => ({
  api: { getMyAuditScopes: mocks.getMyAuditScopes },
}));

import {
  resetAuditScopesCacheForTests,
  useAuditScopes,
} from "../lib/auditScopes";
import {
  observeContextEpoch,
  resetContextEpoch,
} from "../lib/context-epoch";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.me = {
    user: "user-a",
    tenant: "tenant-a",
    effectiveRole: "admin",
  };
  mocks.getMyAuditScopes.mockReset();
  resetAuditScopesCacheForTests();
  resetContextEpoch();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetAuditScopesCacheForTests();
  resetContextEpoch();
});

function scopeData(scopes: string[], isAdmin = false) {
  return {
    scopes,
    auditScopes: scopes.filter((scope) => scope.startsWith("audit:")),
    isAdmin,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe({ id }: { id: string }): ReactElement {
  const audit = useAuditScopes();
  return (
    <output data-testid={id}>
      {audit.loading
        ? "loading"
        : audit.hasScope("audit:read")
          ? "allowed"
          : audit.error
            ? "error"
            : "denied"}
    </output>
  );
}

function render(probes = 1): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <>
        {Array.from({ length: probes }, (_, index) => (
          <Probe key={index} id={`probe-${index}`} />
        ))}
      </>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("audit scope identity boundary", () => {
  it("coalesces subscribers and never reuses an earlier identity's grant", async () => {
    const first = deferred<{
      data: ReturnType<typeof scopeData>;
    }>();
    const second = deferred<{
      data: ReturnType<typeof scopeData>;
    }>();
    const returning = deferred<{
      data: ReturnType<typeof scopeData>;
    }>();
    mocks.getMyAuditScopes
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(returning.promise);

    render(2);
    expect(mocks.getMyAuditScopes).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toBe("loadingloading");

    first.resolve({ data: scopeData(["audit:read"]) });
    await settle();
    expect(document.body.textContent).toBe("allowedallowed");

    mocks.me = {
      user: "user-b",
      tenant: "tenant-b",
      effectiveRole: "viewer",
    };
    render(2);
    expect(document.body.textContent).toBe("loadingloading");
    expect(mocks.getMyAuditScopes).toHaveBeenCalledTimes(2);
    second.resolve({ data: scopeData([]) });
    await settle();
    expect(document.body.textContent).toBe("denieddenied");

    mocks.me = {
      user: "user-a",
      tenant: "tenant-a",
      effectiveRole: "admin",
    };
    render(2);
    expect(document.body.textContent).toBe("loadingloading");
    expect(mocks.getMyAuditScopes).toHaveBeenCalledTimes(3);
    returning.resolve({ data: scopeData([]) });
    await settle();
    expect(document.body.textContent).toBe("denieddenied");
  });

  it("keeps a late response from a previous identity out of the active state", async () => {
    const first = deferred<{
      data: ReturnType<typeof scopeData>;
    }>();
    const second = deferred<{
      data: ReturnType<typeof scopeData>;
    }>();
    mocks.getMyAuditScopes
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render();
    mocks.me = {
      user: "user-b",
      tenant: "tenant-b",
      effectiveRole: "viewer",
    };
    render();
    second.resolve({ data: scopeData([]) });
    await settle();
    expect(document.body.textContent).toBe("denied");

    first.resolve({ data: scopeData(["audit:read"], true) });
    await settle();
    expect(document.body.textContent).toBe("denied");
  });

  it("re-resolves grants when only the effective role changes", async () => {
    mocks.getMyAuditScopes
      .mockResolvedValueOnce({ data: scopeData(["audit:read"], true) })
      .mockResolvedValueOnce({ data: scopeData([]) });

    render();
    await settle();
    expect(document.body.textContent).toBe("allowed");

    mocks.me = {
      user: "user-a",
      tenant: "tenant-a",
      effectiveRole: "viewer",
    };
    render();
    expect(document.body.textContent).toBe("loading");
    await settle();

    expect(mocks.getMyAuditScopes).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toBe("denied");
  });

  it("re-resolves same-role grants after the authorization context epoch changes", async () => {
    observeContextEpoch("epoch-1");
    mocks.getMyAuditScopes
      .mockResolvedValueOnce({ data: scopeData(["audit:read"]) })
      .mockResolvedValueOnce({ data: scopeData([]) });

    render();
    await settle();
    expect(document.body.textContent).toBe("allowed");

    act(() => {
      observeContextEpoch("epoch-2");
    });
    expect(document.body.textContent).toBe("loading");
    await settle();

    expect(mocks.getMyAuditScopes).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toBe("denied");
  });

  it("does not turn the presentation-only isAdmin flag into a scope wildcard", async () => {
    mocks.getMyAuditScopes.mockResolvedValue({ data: scopeData([], true) });

    render();
    await settle();

    expect(document.body.textContent).toBe("denied");
  });
});
