/**
 * The projected off switch, driven end to end — refusal, projection,
 * rollback, invalidation — by a real QueryClient and MutationObserver.
 *
 * The render test proves the control is wired to a mutation carrying these
 * callbacks; this file proves what the callbacks DO, including the failure
 * path a render test cannot reach without a real cache.
 */
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INBOUND_ROUTES_KEY,
  inboundRouteEnabledMutation,
  inboundRoutesRulesKey,
  projectRouteEnabled,
  rollbackNotice,
  type InboundRouteEnabledVars,
} from "./inboundRouteOptimistic";
import { InboundRouteOfflineError } from "./inboundRouteToggle";
import type { InboundRoute } from "./inboundRoutes";
import type { OptimisticSnapshot } from "./optimisticQueries";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

/** Let every pending microtask (cancelQueries, onMutate) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function route(over: Partial<InboundRoute> = {}): InboundRoute {
  return {
    id: "r1",
    name: "Support replies",
    priority: 100,
    stopOnMatch: true,
    enabled: true,
    matchRecipient: "support@*",
    matchSubjectPrefix: "",
    matchFromDomain: "",
    actions: [],
    rawActions: [],
    lastMatchedAt: "2026-07-25T03:00:00Z",
    matchCount: 120,
    actionRetryMax: 3,
    ...over,
  };
}

function rows(): InboundRoute[] {
  return [route(), route({ id: "r2", name: "Bounces", priority: 200 })];
}

function pendingFailure() {
  let fail!: () => void;
  const promise = new Promise<void>((_resolve, reject) => {
    fail = () => reject(new Error("route not found"));
  });
  return { mutationFn: () => promise, fail };
}

function observer(
  qc: QueryClient,
  deps: Partial<{
    isOnline: () => boolean;
    patch: (route: InboundRoute, enabled: boolean) => Promise<void>;
  }> = {},
) {
  return new MutationObserver<
    void,
    Error,
    InboundRouteEnabledVars,
    OptimisticSnapshot
  >(
    qc,
    inboundRouteEnabledMutation(qc, "t1", {
      isOnline: deps.isOnline ?? (() => true),
      patch: deps.patch ?? (async () => undefined),
    }),
  );
}

describe("the key the projection addresses", () => {
  it("is the tenant-scoped rules list, null-normalised", () => {
    expect(inboundRoutesRulesKey("t1")).toEqual([
      "inbound-routes",
      "rules",
      "t1",
    ]);
    expect(inboundRoutesRulesKey(null)).toEqual(["inbound-routes", "rules", null]);
    expect(inboundRoutesRulesKey(undefined)).toEqual([
      "inbound-routes",
      "rules",
      null,
    ]);
  });

  it("is the key the list query in hooks/useInboundRoutes.ts actually uses", () => {
    // A projection aimed at the wrong key fails SILENTLY — setQueriesData
    // matching nothing is not an error — and the hook declares its key
    // inline, so the shape is pinned against its source.
    const source = readFileSync(
      join(__dirname, "..", "hooks", "useInboundRoutes.ts"),
      "utf8",
    );
    expect(source).toContain(
      `queryKey: ["${INBOUND_ROUTES_KEY}", "rules", gate.tenantId]`,
    );
  });
});

describe("projectRouteEnabled", () => {
  it("flips the addressed row only and leaves the server-computed fields alone", () => {
    const next = projectRouteEnabled(rows(), { route: route(), enabled: false });
    expect(next?.[0]?.enabled).toBe(false);
    expect(next?.[1]?.enabled).toBe(true);
    expect(next?.[0]?.matchCount).toBe(120);
    expect(next?.[0]?.lastMatchedAt).toBe("2026-07-25T03:00:00Z");
  });

  it("returns the SAME array for a rule that is not in the list", () => {
    const current = rows();
    expect(
      projectRouteEnabled(current, { route: route({ id: "zz" }), enabled: false }),
    ).toBe(current);
  });

  it("never fabricates a list for an unpopulated cache entry", () => {
    expect(
      projectRouteEnabled(undefined, { route: route(), enabled: false }),
    ).toBeUndefined();
  });
});

describe("inboundRouteEnabledMutation", () => {
  it("moves the row on tap and holds when the PATCH succeeds", async () => {
    const qc = client();
    qc.setQueryData(inboundRoutesRulesKey("t1"), rows());
    const calls: [string, boolean][] = [];
    await observer(qc, {
      patch: async (r, enabled) => {
        calls.push([r.id, enabled]);
      },
    }).mutate({ route: route(), enabled: false });

    const list = qc.getQueryData<InboundRoute[]>(inboundRoutesRulesKey("t1"));
    expect(list?.[0]?.enabled).toBe(false);
    expect(list?.[1]?.enabled).toBe(true);
    // The transport was handed the whole route, not an id.
    expect(calls).toEqual([["r1", false]]);
    // And the list is marked for a refetch so the row ends on the server's
    // answer rather than on ours.
    expect(qc.getQueryState(inboundRoutesRulesKey("t1"))?.isInvalidated).toBe(
      true,
    );
  });

  it("ROLLS BACK the row when the PATCH fails", async () => {
    const qc = client();
    const before = rows();
    qc.setQueryData(inboundRoutesRulesKey("t1"), before);
    const pending = pendingFailure();

    // Catch synchronously: the projection is asserted mid-flight, so the
    // rejection must already have a handler when the event loop turns.
    const settled = observer(qc, { patch: pending.mutationFn })
      .mutate({ route: route(), enabled: false })
      .catch((err: unknown) => err);
    await flush();
    // The row has already moved while the PATCH is still open.
    expect(
      qc.getQueryData<InboundRoute[]>(inboundRoutesRulesKey("t1"))?.[0]
        ?.enabled,
    ).toBe(false);

    pending.fail();
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("route not found");
    expect(qc.getQueryData(inboundRoutesRulesKey("t1"))).toEqual(before);
    expect(qc.getQueryState(inboundRoutesRulesKey("t1"))?.isInvalidated).toBe(
      true,
    );
  });

  it("refuses offline BEFORE projecting, so a refused write never moves the row", async () => {
    const qc = client();
    const before = rows();
    qc.setQueryData(inboundRoutesRulesKey("t1"), before);
    let sent = false;
    const err = await observer(qc, {
      isOnline: () => false,
      patch: async () => {
        sent = true;
      },
    })
      .mutate({ route: route(), enabled: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InboundRouteOfflineError);
    expect(sent).toBe(false);
    // Same reference: nothing was written and nothing was rolled back.
    expect(qc.getQueryData(inboundRoutesRulesKey("t1"))).toBe(before);
  });

  it("projects only its own tenant's list", async () => {
    const qc = client();
    const other = rows();
    qc.setQueryData(inboundRoutesRulesKey("t1"), rows());
    qc.setQueryData(inboundRoutesRulesKey("t2"), other);
    await observer(qc).mutate({ route: route(), enabled: false });
    expect(qc.getQueryData(inboundRoutesRulesKey("t2"))).toBe(other);
  });

  it("leaves an unloaded list alone rather than inventing one", async () => {
    const qc = client();
    await observer(qc).mutate({ route: route(), enabled: false });
    expect(qc.getQueryData(inboundRoutesRulesKey("t1"))).toBeUndefined();
  });
});

describe("rollbackNotice", () => {
  it("names the attempted direction, not the rule's prior state", () => {
    // Attempting to SET false is "switching off"; the verb pairs are keyed by
    // the state the rule was in, so the lookup has to be inverted.
    expect(rollbackNotice(new Error("route not found"), false)).toBe(
      "Couldn't switch the rule off — route not found",
    );
    expect(rollbackNotice(new Error("forbidden"), true)).toBe(
      "Couldn't switch the rule on — forbidden",
    );
  });

  it("stands alone when the failure carried no sentence", () => {
    expect(rollbackNotice(new Error(""), false)).toBe(
      "Couldn't switch the rule off.",
    );
    expect(rollbackNotice({ status: 500 }, true)).toBe(
      "Couldn't switch the rule on.",
    );
  });

  it("shows the offline refusal verbatim — nothing moved, so nothing moved back", () => {
    const err = new InboundRouteOfflineError();
    expect(rollbackNotice(err, false)).toBe(err.message);
  });
});
