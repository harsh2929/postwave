// SPDX-License-Identifier: AGPL-3.0-only
//
// Records REAL API responses so contract tests assert against what the server
// actually sends.
//
// WHY THIS EXISTS. The suite already had 16 tests that stub fetch, and for this
// defect class they prove nothing: every stub body is a literal authored beside
// the client it tests, so when the server renames a field, the stub and the
// client stay consistently wrong together and the test still passes. That is
// exactly how ai-compose-api shipped reading `variants` when the server sends
// `subject_variants` — a page that rendered fine and always showed zero.
//
// Recorded fixtures break that symmetry: the body comes from the server, so a
// client reading a field the server does not send fails loudly.
//
// Usage (needs a signed-in session cookie jar and the dev proxy running):
//   node scripts/record-api-fixtures.mjs --base http://127.0.0.1:3100 --cookie /tmp/websess.txt
//
// Re-run it when the API changes; the diff on the fixture files IS the
// contract change, and reviewing that diff is the point.
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};

const BASE = argOf("--base", "http://127.0.0.1:3100");
const COOKIE_FILE = argOf("--cookie", "");
const OUT = resolve(process.cwd(), "src/__tests__/fixtures/api");

// NOTE: no hand-rolled cookie-jar parser here. The request loop below shells
// out to curl with `-b <jar>`, so curl reads the Netscape jar itself —
// including the `#HttpOnly_`-prefixed session line that a naive "# means
// comment" parser drops, which makes every request 401 and reads exactly like
// an expired login. The parser this file used to carry was already dead code:
// its result was assigned and never sent.

// GET endpoints whose live shape backs a client's parsing.
const ENDPOINTS = [
  "/api/v1/feature-flags",
  "/api/v1/exports/retention-policy",
  "/api/v1/email-blocks/catalog",
  "/api/v1/dns-health/issues",
  "/api/v1/domain-warmup",
  "/api/v1/engagement-scores/distribution",
  "/api/v1/deliverability/dmarc-reports",
  "/api/v1/deliverability/hub",
  "/api/v1/replies/summary",
  "/api/v1/replies/timeseries",
  "/api/v1/replies/top-senders",
  "/api/v1/retention-offers/winback-settings",
  "/api/v1/settings/sending/status",
  "/api/v1/send-settings",
  "/api/v1/blocklist/auto-suppress",
  "/api/v1/sender-reputation",
  "/api/v1/spam-trap-guard/hits",
  "/api/v1/reporting/metric-registry",
  "/api/v1/reporting/blocked-products",
  "/api/v1/reviews/catalog",
  "/api/v1/consent/events",
  "/api/v1/privacy/incidents",
  "/api/v1/push/suppressions",
  "/api/v1/subject-analyzer/buckets",
  "/api/v1/analytics/template-leaderboard",
  "/api/v1/ai-regression/runs/latest",
  "/api/v1/outbound-webhooks/playground/events",
  "/api/v1/cdp/transforms/ops",
  "/api/v1/audience-destinations/providers",
  "/api/v1/predictive/profiles",
  "/api/v1/service-suite/catalog",
  "/api/v1/api-usage/summary",
  "/api/v1/api-usage/keys",
  "/api/v1/api-usage/timeseries",
  "/api/v1/growth-source/timeseries",
  "/api/v1/inactive-keys",
  "/api/v1/verification/credits",
  "/api/v1/warehouse/connections",
  "/api/v1/sms/broadcasts",
  "/api/v1/mailchimp-compat/summary",
  "/api/v1/billing/state",
  "/api/v1/assets",
  "/api/v1/assets/folders",
  "/api/v1/assets/tags",
  "/api/v1/billing/usage",
  "/api/v1/limits/usage",
  "/api/v1/billing/plan-summary",
  "/api/v1/billing/invoices",
  "/api/v1/billing/overage",
  "/api/v1/settings/notifications",
  "/api/v1/campaigns",
];

/** Values that would make a fixture leak a real secret or churn every run. */
function redact(value, key = "", uuidAliases = new Map()) {
  if (Array.isArray(value))
    return value.map((v) => redact(v, "", uuidAliases));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = redact(v, k, uuidAliases);
    return out;
  }
  if (typeof value === "string") {
    if (/^pws_|^sk-|secret|token/i.test(key)) return "<redacted>";
    // Timestamps churn on every recording and would make every diff noise.
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?/.test(value)) return "<timestamp>";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) {
      let alias = uuidAliases.get(value);
      if (!alias) {
        alias = `00000000-0000-4000-8000-${String(uuidAliases.size + 1).padStart(12, "0")}`;
        uuidAliases.set(value, alias);
      }
      return alias;
    }
  }
  return value;
}

if (args.includes("--self-test")) {
  const source = {
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    campaigns: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ],
  };
  const result = redact(source);
  const ids = result.campaigns.map((campaign) => campaign.id);
  if (
    new Set(ids).size !== ids.length ||
    result.tenant_id !== result.campaigns[0].tenant_id ||
    result.tenant_id !== result.campaigns[1].tenant_id ||
    !ids.every((id) => /^[0-9a-f-]{36}$/u.test(id))
  ) {
    throw new Error("UUID redaction did not preserve unique relational aliases");
  }
  console.log("record-api-fixtures: UUID alias self-test passed");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

let ok = 0;
let failed = 0;
const index = {};

for (const path of ENDPOINTS) {
  try {
    // Shelled out to curl deliberately. Node's fetch sends a different header
    // set and the dev proxy answered 404/500 for four paths that curl gets 200
    // from — recording through the tool the responses were verified with keeps
    // the fixture honest rather than capturing a proxy quirk.
    const raw = execFileSync(
      "curl",
      [
        "-s",
        "-m",
        "20",
        ...(COOKIE_FILE ? ["-b", COOKIE_FILE] : []),
        "-w",
        "\n%{http_code}",
        BASE + path,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const cut = raw.lastIndexOf("\n");
    const status = Number(raw.slice(cut + 1).trim());
    if (status !== 200) {
      console.error(`  ${status} ${path}`);
      failed += 1;
      continue;
    }
    const body = redact(JSON.parse(raw.slice(0, cut)));
    const name = path.replace(/^\/api\/v1\//, "").replace(/[/.]/g, "_");
    const file = resolve(OUT, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    index[path] = `${name}.json`;
    ok += 1;
  } catch (err) {
    console.error(`  ERR ${path}: ${err.message}`);
    failed += 1;
  }
}

// Do NOT clobber a good index with an empty one. An expired session makes
// every request fail, and writing the empty result destroyed 47 working
// fixtures in one run — every fixture-backed test lost its data at once, and
// the failure looked like a code regression rather than a dead cookie.
if (ok === 0) {
  console.error(
    `recorded NOTHING (${failed} failed) — leaving the existing index alone. ` +
      `Check the session cookie is still valid.`,
  );
  process.exit(1);
}
writeFileSync(
  resolve(OUT, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
);
console.log(`recorded ${ok} fixtures, ${failed} failed -> ${OUT}`);
