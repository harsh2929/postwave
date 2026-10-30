/**
 * api/flowAbTests.ts — transport for IN-FLOW A/B tests.
 *
 * Routes and role floors were read off the chi mounts at
 * `apps/api/internal/flowabtests/flowabtests.go::MountRoutes` (:319) and the
 * middleware those mounts wrap them in — not off routeauth/manifest.json,
 * whose auto-generated rows are a lead rather than evidence:
 *
 *   GET  /api/v1/flow-builder/ab-tests            read:campaigns  → {items}
 *   GET  /api/v1/flow-builder/ab-tests/{id}       read:campaigns  → a BARE test
 *   GET  /api/v1/flow-builder/ab-tests/{id}/results read:campaigns → {results}
 *
 * THE GATE IS A SCOPE, NOT A ROLE. All three reads are
 * `apikeys.RequireScope(apikeys.ScopeReadCampaigns)` (flowabtests.go:320-326).
 * On the session-cookie path that middleware resolves the scope through two
 * tables: `read:campaigns` is in `readOnlyScopes` (apikeys/middleware.go:332),
 * so `requireAdminRoleForScopes` returns false and ANY authenticated dashboard
 * user may read — viewer included. Same floor as app/(tabs)/flows.
 *
 * THE FOUR WRITE ROUTES ARE DELIBERATELY ABSENT, and not for time:
 *   - POST /ab-tests — authoring a split needs an automation id, a node id
 *     inside that automation's graph, and at least two variants with traffic
 *     weights (`Create` rejects fewer, :371). None of those is knowable on a
 *     phone without the canvas that produced them.
 *   - PATCH /ab-tests/{id} — the same, plus it can silently replace the
 *     variant set the counters are keyed on.
 *   - DELETE /ab-tests/{id} — destroys the config; the counter rows in
 *     flow_ab_test_results survive it and then belong to nothing.
 *   - POST /ab-tests/{id}/evaluate — this is the one that looks like a read
 *     and is not. It computes the verdict AND writes `status='completed'`,
 *     `ended_at=now()` (`setWinner`, :205). Ending a live experiment is a
 *     one-way act; a phone is the wrong place to take it, and the screen says
 *     so rather than offering a button that quietly stops the test.
 *
 * Parsing lives in lib/flowAbTests so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseFlowAbResults,
  parseFlowAbTest,
  parseFlowAbTestList,
  type MobileFlowAbResult,
  type MobileFlowAbTest,
} from "@/lib/flowAbTests";

import { checkedApiResult, rawRequest } from "./request";

export const FLOW_AB_TESTS_PATH = "/api/v1/flow-builder/ab-tests";

export function flowAbTestPath(id: string): string {
  return `${FLOW_AB_TESTS_PATH}/${encodeURIComponent(id)}`;
}

export function flowAbTestResultsPath(id: string): string {
  return `${flowAbTestPath(id)}/results`;
}

/**
 * Every A/B test in the workspace, newest first (`ORDER BY created_at DESC`,
 * flowabtests.go:79).
 *
 * There is NO limit and NO cursor on this route — `Repo.List` selects the whole
 * table for the tenant. An `automation_id` narrows it to one automation, which
 * is the only filter the handler reads (`r.URL.Query().Get("automation_id")`,
 * :346). A workspace's split count is bounded by the number of `ab_test` nodes
 * its operators have authored, so this is small by construction rather than by
 * a limit we could ask for.
 */
export async function fetchFlowAbTests(options?: {
  automationId?: string | null;
}): Promise<readonly MobileFlowAbTest[]> {
  const automationId = options?.automationId?.trim();
  const query = automationId
    ? `?${new URLSearchParams({ automation_id: automationId }).toString()}`
    : "";
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${FLOW_AB_TESTS_PATH}${query}`),
  );
  return parseFlowAbTestList(res.data);
}

/**
 * One test. Answers a BARE object rather than an envelope — `Get` (:383)
 * writes the struct directly. A missing id answers 404, which
 * `checkedApiResult` turns into a thrown tagged Error, so this never resolves
 * to a hollow row.
 */
export async function fetchFlowAbTest(
  id: string,
): Promise<MobileFlowAbTest | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", flowAbTestPath(id)),
  );
  return parseFlowAbTest(res.data);
}

/**
 * The live per-variant counters, `{"results": [...]}`.
 *
 * `Results` (:441) re-reads the test first and aggregates on its
 * `(automation_id, node_id)` — so a test whose node was renamed answers an
 * EMPTY array rather than an error. The screen must render that as "no
 * assignments recorded", never as a set of zeroes.
 */
export async function fetchFlowAbResults(
  id: string,
): Promise<readonly MobileFlowAbResult[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", flowAbTestResultsPath(id)),
  );
  return parseFlowAbResults(res.data);
}
