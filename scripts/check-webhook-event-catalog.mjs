#!/usr/bin/env node
// One webhook event catalog, checked across the languages that copy it.
//
// `AllowedEvents` in Go is the producer's list — subscribing to anything not in
// it is rejected. The desktop client keeps its own array, the desktop test
// asserts that array against a hard-coded literal, and the Zapier app hard-codes
// one event string per trigger file. Nothing compared any of them to Go.
//
// The comment above AllowedEvents says "Additions go here, the Zapier app, and
// the dashboard chip list — keep the three in sync." That instruction is the
// whole problem: three hand-maintained copies with a note asking people to
// remember. The failure is silent in the direction that matters — a client
// offering an event the server rejects turns into a subscription error the user
// cannot act on, and a client MISSING an event means a capability that ships and
// is never discoverable.
//
// This does not merge the lists. Go stays the producer and the authority; the
// clients stay free to describe fewer events than exist, because a deliberately
// narrow Zapier app is a real product decision. What is forbidden is a client
// offering an event the server does not produce, which is always a bug.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GO_CATALOG = "apps/api/internal/outbound_webhooks/outbound_webhooks.go";
const DESKTOP_CATALOG = "apps/desktop/src/lib/api/webhook-event-operations.ts";
// GUARD#10 — mobile keeps a FOURTH copy, used before the server catalog loads and
// as the offline fallback. It had a mobile-local test, which the root gate does not
// run, so CI compared Go against desktop and Zapier and never saw this one. A
// client offering an event the server will refuse is the same bug on every surface.
const MOBILE_CATALOG = "apps/mobile/src/lib/outboundWebhookForm.ts";

/**
 * The event strings Go will accept a subscription for.
 *
 * Parses the `AllowedEvents` slice, resolving `EventFoo` identifiers through
 * their `const EventFoo = "..."` declarations — otherwise every named constant
 * would silently drop out of the extracted set and the check would compare
 * against a shorter list than the server really has, passing over exactly the
 * drift it exists to catch.
 */
export function goAllowedEvents(source) {
  const consts = new Map();
  const constRe = /\b(Event[A-Za-z0-9_]*)\s*=\s*"([^"]+)"/gu;
  let m;
  while ((m = constRe.exec(source)) !== null) consts.set(m[1], m[2]);

  const start = source.indexOf("var AllowedEvents = []string{");
  if (start === -1) throw new Error(`${GO_CATALOG}: AllowedEvents not found`);
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error(`${GO_CATALOG}: AllowedEvents is unterminated`);
  const body = source.slice(start, end);

  const events = [];
  for (const rawLine of body.split("\n").slice(1)) {
    // Strip line comments before matching: the block is heavily commented and a
    // quoted event name inside prose is documentation, not a catalog entry.
    const line = rawLine.replace(/\/\/.*$/u, "").trim();
    if (line === "") continue;
    const quoted = line.match(/^"([^"]+)",?$/u);
    if (quoted) {
      events.push(quoted[1]);
      continue;
    }
    const ident = line.match(/^(Event[A-Za-z0-9_]*),?$/u);
    if (ident) {
      const value = consts.get(ident[1]);
      if (value == null) {
        throw new Error(
          `${GO_CATALOG}: AllowedEvents references ${ident[1]}, which has no string constant`,
        );
      }
      events.push(value);
    }
  }
  return events;
}

/** The events the desktop client offers. */
/**
 * The events mobile offers before the server catalog arrives.
 *
 * Parses `OUTBOUND_WEBHOOK_EVENT_FALLBACK`, which is a plain string array. Line
 * comments are stripped first for the same reason as the Go parser: the block is
 * annotated, and a quoted event inside prose is documentation.
 */
export function mobileEvents(source) {
  const start = source.indexOf("OUTBOUND_WEBHOOK_EVENT_FALLBACK");
  if (start === -1) {
    throw new Error(`${MOBILE_CATALOG}: OUTBOUND_WEBHOOK_EVENT_FALLBACK not found`);
  }
  // `= [` and not `[`: the declaration is `readonly string[] = [`, so the first
  // bracket after the identifier belongs to the TYPE. Matching it yielded an empty
  // slice — caught immediately by the vacuity floor below, which is what it is for.
  const assignment = source.indexOf("= [", start);
  const open = assignment === -1 ? -1 : assignment + 2;
  const end = source.indexOf("]", open);
  if (open === -1 || end === -1) {
    throw new Error(`${MOBILE_CATALOG}: fallback array is unterminated`);
  }
  const events = [];
  for (const rawLine of source.slice(open + 1, end).split("\n")) {
    const line = rawLine.replace(/\/\/.*$/u, "").trim();
    const quoted = line.match(/^"([^"]+)",?$/u);
    if (quoted) events.push(quoted[1]);
  }
  return events;
}

export function desktopEvents(source) {
  const m = source.match(
    /OUTBOUND_WEBHOOK_EVENTS\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/u,
  );
  if (m == null) {
    throw new Error(`${DESKTOP_CATALOG}: OUTBOUND_WEBHOOK_EVENTS not found`);
  }
  return [...m[1].matchAll(/"([^"]+)"/gu)].map((hit) => hit[1]);
}

export function compare(go, desktop) {
  const allowed = new Set(go);
  return {
    // Always a bug: the client offers something the server will refuse.
    offeredButNotProduced: desktop.filter((e) => !allowed.has(e)),
    // Not a bug by itself — a narrow client is a legitimate choice — but worth
    // naming, because "we forgot" and "we decided" look identical from here.
    producedButNotOffered: go.filter((e) => !desktop.includes(e)),
  };
}

// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${name}: expected ${e}, got ${a}`);
  };

  const goFixture = `
const (
	EventListSubscriberAdded = "list.subscriber.added"
	EventEmailBounced = "email.bounced"
)
var AllowedEvents = []string{
	"campaign.sent",
	// A commented event: "ghost.event" must not be picked up.
	EventListSubscriberAdded,
	EventEmailBounced,
}
`;
  check(
    "resolves named constants as well as literals",
    goAllowedEvents(goFixture),
    ["campaign.sent", "list.subscriber.added", "email.bounced"],
  );
  check(
    "ignores an event named only in a comment",
    goAllowedEvents(goFixture).includes("ghost.event"),
    false,
  );

  let threw = false;
  try {
    goAllowedEvents(`var AllowedEvents = []string{\n\tEventUnknown,\n}\n`);
  } catch {
    threw = true;
  }
  check("fails loudly on a constant it cannot resolve", threw, true);

  threw = false;
  try {
    goAllowedEvents("package x\n");
  } catch {
    threw = true;
  }
  check("fails loudly when the catalog is missing entirely", threw, true);

  check(
    "reads the desktop array",
    desktopEvents(`export const OUTBOUND_WEBHOOK_EVENTS = [\n  "campaign.sent",\n  "audit.created",\n] as const;`),
    ["campaign.sent", "audit.created"],
  );

  check(
    "an event the server does not produce is a failure",
    compare(["a"], ["a", "b"]).offeredButNotProduced,
    ["b"],
  );
  check(
    "an event the client does not offer is reported, not failed",
    compare(["a", "b"], ["a"]),
    { offeredButNotProduced: [], producedButNotOffered: ["b"] },
  );
  check("agreement is clean", compare(["a"], ["a"]), {
    offeredButNotProduced: [],
    producedButNotOffered: [],
  });

  if (failures.length > 0) {
    console.error("check-webhook-event-catalog self-test FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("check-webhook-event-catalog self-test OK (8 assertions)");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const go = goAllowedEvents(readFileSync(resolve(repoRoot, GO_CATALOG), "utf8"));
  const desktop = desktopEvents(readFileSync(resolve(repoRoot, DESKTOP_CATALOG), "utf8"));
  const mobile = mobileEvents(readFileSync(resolve(repoRoot, MOBILE_CATALOG), "utf8"));

  // A vacuity floor. If the parser silently returned nothing — a refactor moved
  // the slice, a rename broke the regex — every comparison below would be
  // trivially clean and this check would report success while measuring
  // nothing.
  if (go.length < 5) {
    console.error(
      `Parsed only ${go.length} event(s) from ${GO_CATALOG}; the catalog cannot ` +
        "be that short, so the parser is broken rather than the code.",
    );
    process.exit(1);
  }

  // The mobile parser gets the same vacuity floor as the Go one: a silently empty
  // result would make every comparison below trivially clean.
  if (mobile.length < 5) {
    console.error(
      `Parsed only ${mobile.length} event(s) from ${MOBILE_CATALOG}; the fallback ` +
        "cannot be that short, so the parser is broken rather than the code.",
    );
    process.exit(1);
  }

  let drifted = false;
  for (const [label, events] of [
    [DESKTOP_CATALOG, desktop],
    [MOBILE_CATALOG, mobile],
  ]) {
    const { offeredButNotProduced } = compare(go, events);
    if (offeredButNotProduced.length === 0) continue;
    if (!drifted) console.error("Webhook event catalog drift.\n");
    drifted = true;
    console.error(`${label} offers events the API will refuse a subscription for:`);
    for (const e of offeredButNotProduced) console.error(`  - ${e}`);
  }
  if (drifted) {
    console.error(
      `\nEither add them to AllowedEvents in ${GO_CATALOG} or remove them from the client.`,
    );
    process.exit(1);
  }
  const { producedButNotOffered } = compare(go, desktop);

  console.log(
    `Webhook event catalog OK: ${go.length} produced, ${desktop.length} offered by desktop, ${mobile.length} by mobile.`,
  );
  if (producedButNotOffered.length > 0) {
    console.log(
      `  Produced but not offered on desktop (not an error — a narrower client is a choice):\n` +
        producedButNotOffered.map((e) => `    - ${e}`).join("\n"),
    );
  }
}

main();
