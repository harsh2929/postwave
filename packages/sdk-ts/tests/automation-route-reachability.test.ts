// Every automations path the SDK calls must be a route the service registers.
//
// Three of these were not. `list` (GET /api/v1/automations), `create` (POST) and
// `update` (PATCH .../{id}) all proxy through apps/api to services/automation,
// whose Register() mounted nine routes and none of those three -- so each call
// 404'd at the upstream. The MCP automations tool uses three of those four verbs,
// which is why "an agent cannot drive the flows a user built in the GUI" was
// true. `list` is now routed; the other two are declared below.
//
// WHY A DECLARED GAP AND NOT A SKIP. create and update need request validation
// and a canonical AST round-trip, so they are a real build rather than a missing
// mount. Leaving them undeclared would mean this guard reported everything fine
// while two shipped SDK methods still 404. Naming them keeps the guard green AND
// keeps the gap legible -- and the last assertion fails if one is implemented
// without being removed from the list, so the declaration cannot outlive the gap.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const SDK = resolve(REPO, "packages/sdk-ts/src/resources/automations.ts");
const REGISTER = resolve(
  REPO,
  "services/automation/internal/handlers/automation.go",
);

/**
 * METHOD + path pairs the SDK calls, normalised to the service's `{id}` grammar.
 *
 * The verb is not optional detail here: after `list` landed, GET
 * /v1/automations exists and POST /v1/automations still does not. A path-only
 * comparison calls that route "registered" and excuses the missing `create` --
 * which is exactly what the first version of this guard did.
 */
function sdkCalls(): string[] {
  const src = readFileSync(SDK, "utf8");
  const calls: string[] = [];
  for (const m of src.matchAll(
    /"(GET|POST|PATCH|PUT|DELETE)"[\s\S]{0,400}?["`](\/api\/v1\/automations[^"`]*)/g,
  )) {
    const path = m[2]!
      .replace(/\$\{[^}]*$/, "{id}")
      .replace(/\$\{[^}]*\}/g, "{id}")
      .replace(/^\/api/, "")
      .replace(/\/$/, "");
    calls.push(`${m[1]} ${path}`);
  }
  if (calls.length === 0) throw new Error("no automations calls found in the SDK");
  return [...new Set(calls)].sort();
}

/** METHOD + path pairs services/automation actually mounts. */
function registeredCalls(): string[] {
  const src = readFileSync(REGISTER, "utf8");
  const calls = [
    ...src.matchAll(/r\.(Get|Post|Patch|Put|Delete)\("(\/v1\/automations[^"]*)"/g),
  ].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);
  if (calls.length === 0) {
    throw new Error("no routes found in Register() — the guard cannot see its subject");
  }
  return [...new Set(calls)].sort();
}

/**
 * Shipped SDK methods whose route does not exist yet. Each needs a real
 * implementation, not a mount. Remove an entry the moment its route lands.
 */
const KNOWN_UNROUTED: string[] = [
  // Empty since create and update landed. Kept as the place to declare a
  // shipped-but-unrouted SDK method if one ever appears again, because the
  // assertion below fails the moment an entry here outlives its gap.
];

describe("SDK automations paths are reachable", () => {
  it("every SDK path is either routed or a declared gap", () => {
    const registered = registeredCalls();
    const unreachable = sdkCalls().filter(
      (c) => !registered.includes(c) && !KNOWN_UNROUTED.includes(c),
    );
    expect(unreachable).toEqual([]);
  });

  it("the declared gaps are still gaps", () => {
    // An allowance that outlives what it allows is how a guard quietly loosens:
    // implement `create` without deleting its entry here and this guard would
    // keep excusing a route that now exists.
    const registered = registeredCalls();
    const stale = KNOWN_UNROUTED.filter((c) => registered.includes(c));
    expect(stale).toEqual([]);
  });

  it("list is routed, because that was the headline gap", () => {
    expect(registeredCalls()).toContain("GET /v1/automations");
  });

  it("can see both sides", () => {
    expect(sdkCalls().length).toBeGreaterThanOrEqual(5);
    expect(registeredCalls().length).toBeGreaterThanOrEqual(8);
  });
});
