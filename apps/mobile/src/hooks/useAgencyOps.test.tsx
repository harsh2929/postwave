/**
 * The Agency overview hook, executed for real.
 *
 * TESTS-1. `jest.routes.config.cjs` maps `@/hooks/useAgencyOps` to the generic
 * query stub, and no vitest file imported it, so the module ran on neither
 * runner: a `throw` at its top left every agency suite green. The retry policy,
 * the 403 verdicts, the role gate, the cursor guard, the authority-rotation
 * cleanup and the refetch collapse were all unexercised.
 *
 * WHAT STAYS REAL, AND WHY. TanStack's QueryClient is real because the refetch
 * collapse and the rotation cleanup ARE cache behaviour: capturing the options
 * object instead (the useSendingOps idiom) would make those two assertions read
 * back the code under test. `lib/agencyAccess`, `lib/agencyWire` and
 * `lib/mobileRouteManifest` are real because they are the policy. Only the two
 * transports and the online gate are stand-ins.
 *
 * `retryDelay: 0`, NOT `retry: false`: the hook's own `retryAgencyRead` is
 * under test, so a policy that retried a 403 shows up here as an extra
 * transport call instead of a timeout.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAgencyBranding, MobileAgencyChild } from "@/api/agencyReads";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "33333333-3333-4333-8333-333333333333";

type Gate = {
  enabled: boolean;
  baseUrl: string;
  tenantId: string | null;
  userId: string;
  effectiveRole: string | null;
  credentialScope: string;
  canReadOfflineSnapshots: boolean;
  isOnline: boolean;
};

const m = vi.hoisted(() => ({
  gate: {} as Gate,
  branding: vi.fn(),
  children: vi.fn(),
}));

vi.mock("@/api/agencyReads", () => ({
  getMobileAgencyBranding: (...args: unknown[]) => m.branding(...args),
  listMobileAgencyChildrenPage: (...args: unknown[]) => m.children(...args),
}));

/** The same tuple the real owner builds; the hook keys its cache by it. */
function ownerOf(gate: Gate): string {
  return JSON.stringify([
    gate.baseUrl,
    gate.tenantId,
    gate.userId,
    gate.effectiveRole,
    gate.credentialScope,
  ]);
}

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
  onlineQueryAuthorityOwner: (gate: Gate) => ownerOf(gate),
}));

const { useMobileAgencyOverview } = await import("./useAgencyOps");

const BRANDING: MobileAgencyBranding = {
  whitelabel_enabled: true,
  brand_name: "Acme Agency",
  custom_domain: "",
  logo_url: "",
  primary_color: "#1D4ED8",
  support_email: "",
  legal_entity: "",
  updated_at: "2026-09-01T00:00:00Z",
  etag: `"agency-branding:${TENANT_A}:v1"`,
};

function child(n: number): MobileAgencyChild {
  return {
    id: `c${n}`,
    slug: `child-${n}`,
    name: `Child ${n}`,
    tier: "pro",
    parent_tenant_id: TENANT_A,
    billing_mode: "self",
    reseller_markup_bps: 0,
    whitelabel_enabled: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

const ok = <T,>(data: T) => ({ data, error: null });
const forbidden = (code: string) => ({
  data: null,
  error: { status: 403, code, message: `403 ${code}` },
});

type Overview = ReturnType<typeof useMobileAgencyOverview>;
let latest: Overview;
let client: QueryClient | undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined;

function Probe() {
  latest = useMobileAgencyOverview();
  return null;
}

function tree(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>
  );
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  client = queryClient;
  await act(async () => {
    renderer = TestRenderer.create(tree(queryClient));
  });
  return queryClient;
}

/** Let every queued fetch, retry and effect settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The `[tenant, cursor]` pairs the roster transport was asked for. */
function childrenRequests(): unknown[][] {
  return m.children.mock.calls.map((call) => call.slice(0, 2));
}

beforeEach(() => {
  m.gate = {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: TENANT_A,
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "admin",
    credentialScope: "session",
    canReadOfflineSnapshots: false,
    isOnline: true,
  };
  m.branding.mockReset();
  m.children.mockReset();
  m.branding.mockResolvedValue(ok(BRANDING));
});

afterEach(async () => {
  const current = renderer;
  renderer = undefined;
  if (current) await act(async () => current.unmount());
  client?.clear();
  client = undefined;
});

describe("useMobileAgencyOverview roster paging", () => {
  it("stops paging, and never re-requests, a cursor the server echoed back", async () => {
    m.children.mockImplementation(async (_tenant: string, cursor?: string) =>
      cursor === undefined
        ? ok({ children: [child(1)], count: 1, has_more: true, next_cursor: "k1" })
        : ok({ children: [child(2)], count: 1, has_more: true, next_cursor: "k1" }),
    );
    await mount();
    await settle();
    expect(latest.hasNextPage).toBe(true);

    await act(async () => {
      await latest.fetchNextPage();
    });
    await settle();

    expect(latest.hasNextPage).toBe(false);
    expect(latest.data?.errors.map((error) => error.message)).toContain(
      "The child roster repeated a pagination cursor.",
    );
    expect(latest.data?.children).toEqual([]);

    // A stray load-more (onEndReached racing the re-render) must not ask for
    // the echoed cursor a second time.
    await act(async () => {
      await latest.fetchNextPage();
    });
    await settle();
    expect(childrenRequests()).toEqual([
      [TENANT_A, undefined],
      [TENANT_A, "k1"],
    ]);
  });

  it("collapses a paged roster to page one before a refetch", async () => {
    m.children.mockImplementation(async (_tenant: string, cursor?: string) =>
      cursor === undefined
        ? ok({ children: [child(1)], count: 1, has_more: true, next_cursor: "k1" })
        : ok({ children: [child(2)], count: 1, has_more: false }),
    );
    await mount();
    await settle();
    await act(async () => {
      await latest.fetchNextPage();
    });
    await settle();
    expect(latest.data?.children.map((row) => row.id)).toEqual(["c1", "c2"]);

    m.children.mockClear();
    await act(async () => {
      await latest.refetch();
    });
    await settle();

    // One request, for page one; the second page is dropped, not re-walked.
    expect(childrenRequests()).toEqual([[TENANT_A, undefined]]);
    expect(latest.data?.children.map((row) => row.id)).toEqual(["c1"]);
    expect(latest.hasNextPage).toBe(true);
  });
});

describe("useMobileAgencyOverview 403 verdicts", () => {
  it("reads not_agency as 'not an agency', once, with no retry", async () => {
    m.children.mockResolvedValue(forbidden("not_agency"));
    await mount();
    await settle();

    expect(latest.data?.notAgency).toBe(true);
    expect(latest.data?.accessRestricted).toBe(false);
    expect(latest.data?.childrenUnavailable).toBe(false);
    // A recognised 403 becomes the verdict, never a surface error as well.
    expect(latest.data?.errors).toEqual([]);
    expect(m.children).toHaveBeenCalledTimes(1);
  });

  it("reads not_authorized as 'restricted', never 'not an agency'", async () => {
    m.children.mockResolvedValue(forbidden("not_authorized"));
    await mount();
    await settle();

    expect(latest.data?.accessRestricted).toBe(true);
    expect(latest.data?.notAgency).toBe(false);
    expect(latest.data?.children).toEqual([]);
    expect(latest.hasNextPage).toBe(false);
    expect(m.children).toHaveBeenCalledTimes(1);
  });
});

describe("useMobileAgencyOverview authority", () => {
  it("issues no agency read at all for a viewer", async () => {
    m.gate.effectiveRole = "viewer";
    m.children.mockResolvedValue(
      ok({ children: [child(1)], count: 1, has_more: false }),
    );
    await mount();
    await settle();

    expect(m.branding).not.toHaveBeenCalled();
    expect(m.children).not.toHaveBeenCalled();
    expect(latest.data).toBeUndefined();
    expect(latest.isLoading).toBe(false);
  });

  it("drops the previous authority's cached roster when the tenant rotates", async () => {
    m.children.mockResolvedValue(
      ok({ children: [child(1)], count: 1, has_more: false }),
    );
    const queryClient = await mount();
    await settle();
    const previousOwner = ownerOf(m.gate);
    const cachedUnder = (owner: string) =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["mobile-agency-overview", owner] }).length;
    // Guard the guard: the key really is the one the hook cached under.
    expect(cachedUnder(previousOwner)).toBe(2);

    m.gate = { ...m.gate, tenantId: TENANT_B };
    await act(async () => {
      renderer?.update(tree(queryClient));
    });
    await settle();

    expect(cachedUnder(previousOwner)).toBe(0);
    expect(m.children).toHaveBeenLastCalledWith(
      TENANT_B,
      undefined,
      expect.anything(),
    );
  });
});
