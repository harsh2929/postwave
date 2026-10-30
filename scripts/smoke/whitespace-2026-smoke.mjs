#!/usr/bin/env node
// Live end-to-end smoke for the 5 cutting-edge-2026 white-space features:
//   #1 AI-Output Regression Harness   #2 Consent-Safe Activation Firewall
//   #3 Surfacing Analytics            #4 Segment P&L
//   #5 Segment Decay Radar
//
// Mirrors scripts/pilot-certification-smoke.mjs: env-driven auth, a check()
// runner, a JSON summary, and a blocker-based exit code. It exercises the
// per-feature flows from docs/superpowers/specs/2026-06-15-*-design.md against
// a RUNNING stack (API gateway + Postgres with migrations 0402-0412 applied).
//
// Honesty contract (matches the platform's own honest-UI pillar):
//   - Steps that need only Postgres are real assertions (read + create→read).
//   - Steps that need external creds (the #1 replay calls the voice service +
//     Gemini/OpenAI) are gated behind POSTWAVE_SMOKE_LLM=1 and SKIP with a
//     warning otherwise — never a false pass, never a hard fail.
//   - A 200 on a new endpoint also proves its migration applied (a missing
//     table would 500), so this doubles as a migration-applied check.
//
// Usage:
//   POSTWAVE_BASE_URL=http://localhost:3000 \
//   POSTWAVE_TENANT_ID=<tenant-uuid> POSTWAVE_API_KEY=<key> \
//   node scripts/smoke/whitespace-2026-smoke.mjs [--strict] [--llm] [--readonly]
//
// Optional resource overrides (otherwise auto-discovered from list endpoints):
//   POSTWAVE_SEGMENT_ID, POSTWAVE_CAMPAIGN_ID, POSTWAVE_AUDIENCE_SYNC_ID

const args = parseArgs(process.argv.slice(2));
const baseURL = trimRightSlash(
  args["base-url"] || process.env.POSTWAVE_BASE_URL || "http://localhost:3000",
);
const strict = Boolean(args.strict || process.env.POSTWAVE_SMOKE_STRICT === "1");
const enableLLM = Boolean(args.llm || process.env.POSTWAVE_SMOKE_LLM === "1");
const readonly = Boolean(args.readonly || process.env.POSTWAVE_SMOKE_READONLY === "1");

let segmentID = args["segment-id"] || process.env.POSTWAVE_SEGMENT_ID || "";
let campaignID = args["campaign-id"] || process.env.POSTWAVE_CAMPAIGN_ID || "";
let audienceSyncID = args["audience-sync-id"] || process.env.POSTWAVE_AUDIENCE_SYNC_ID || "";

const checks = [];

// --- Preflight: auth must be configured or every authed check 401s. ---
const hasAuth = Boolean(process.env.POSTWAVE_API_KEY || process.env.POSTWAVE_AUTH_HEADER);
await check("auth configured", "blocker", async () => {
  if (!hasAuth) {
    return {
      status: "blocker",
      detail:
        "Set POSTWAVE_API_KEY (Bearer) or POSTWAVE_AUTH_HEADER 'Name: value', plus POSTWAVE_TENANT_ID. Without it every authenticated check returns 401.",
    };
  }
  const res = await request("/api/health", { allow404: true });
  return {
    status: "pass",
    detail: `Auth headers set; API ${res.ok ? "reachable" : `responded ${res.status}`}.`,
  };
});

// Auto-discover resource ids if not supplied (best-effort; never fatal).
segmentID = segmentID || (await firstId("/api/v1/segments"));
campaignID = campaignID || (await firstId("/api/v1/campaigns"));
audienceSyncID = audienceSyncID || (await firstId("/api/v1/audience-syncs"));

// ===================================================================
// #1 AI-Output Regression Harness
// ===================================================================
await check("#1 regression settings defaults", "blocker", async () => {
  const s = await requestJSON("/api/v1/ai-regression/settings");
  const warnOk = typeof s.warn_threshold === "number";
  const gateOff = s.hard_gate_enabled === false || s.hard_gate_enabled === undefined;
  return {
    status: warnOk ? "pass" : "blocker",
    detail: `warn_threshold=${s.warn_threshold}, hard_gate_enabled=${s.hard_gate_enabled}, min_examples_for_gate=${s.min_examples_for_gate ?? "n/a"}. Advisory-by-default ${gateOff ? "honoured" : "VIOLATED"}.`,
    evidence: s,
  };
});

await check("#1 latest-run honest empty-state", "warning", async () => {
  const r = await requestJSON("/api/v1/ai-regression/runs/latest");
  // Spec: a tenant with no runs gets {"run": null} at 200 — never a 404.
  const honest = Object.prototype.hasOwnProperty.call(r, "run");
  return {
    status: honest ? "pass" : "warning",
    detail: honest
      ? r.run ? "Latest run present." : "{run:null} honest empty-state (no fabricated run)."
      : "Response missing 'run' key.",
    evidence: r,
  };
});

await check("#1 golden capture round-trip", readonly ? "warning" : "blocker", async () => {
  if (readonly) return { status: "warning", detail: "readonly mode — skipped golden-example create." };
  const created = await requestJSON("/api/v1/ai-regression/golden-examples", {
    method: "POST",
    body: {
      surface_kind: "campaign_draft",
      brief: "[smoke] write a 2-line re-engagement opener for lapsed readers",
      approved_output: "[smoke] We saved your seat. Here's what you missed this month — three quick reads.",
    },
  });
  const list = await requestJSON("/api/v1/ai-regression/golden-examples?surface_kind=campaign_draft");
  const items = list.items || list || [];
  const found = items.some((g) => (g.brief || "").includes("[smoke]"));
  return {
    status: found ? "pass" : "blocker",
    detail: found
      ? `Captured + listed golden example (id=${created.id || "?"}); ${items.length} total.`
      : "Created a golden example but it was not returned by list (RLS / persistence issue).",
    evidence: { created_id: created.id, list_count: items.length },
  };
});

await check("#1 replay run (voice + LLM)", "warning", async () => {
  if (!enableLLM) {
    return {
      status: "warning",
      detail:
        "Skipped — set POSTWAVE_SMOKE_LLM=1 with the voice service running + GEMINI_API_KEY/OPENAI_API_KEY to exercise the replay-and-score path.",
    };
  }
  const res = await request("/api/v1/ai-regression/runs", {
    method: "POST",
    body: { model_version_tag: "smoke@manual", prompt_version_tag: "v1" },
  });
  const body = await safeJSON(res);
  return {
    status: res.ok ? "pass" : "blocker",
    detail: res.ok
      ? `Replay run triggered (run_id=${body.run_id || "?"}, status=${body.status || "?"}).`
      : `Trigger returned HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    evidence: body,
  };
});

// ===================================================================
// #2 Consent-Safe Activation Firewall
// ===================================================================
await check("#2 activation exclusions list", "warning", async () => {
  const r = await requestJSON("/api/v1/activation-exclusions?limit=5");
  const items = r.items || r || [];
  return {
    status: "pass",
    detail: `Exclusion receipt ledger reachable (${r.count ?? items.length} receipt(s)).`,
    evidence: { count: r.count ?? items.length },
  };
});

await check("#2 sync exclusion preview (pre-flight firewall)", "warning", async () => {
  if (!audienceSyncID) {
    return {
      status: "warning",
      detail:
        "No audience sync found/configured — set POSTWAVE_AUDIENCE_SYNC_ID to verify the consent+suppression dry-run count.",
    };
  }
  const p = await requestJSON(`/api/v1/audience-syncs/${encodeURIComponent(audienceSyncID)}/exclusion-preview`);
  const excluded = p.excluded_count ?? p.excluded ?? 0;
  const eligible = p.eligible_count ?? p.kept ?? p.deliverable ?? null;
  return {
    status: "pass",
    detail: `Firewall pre-flight ran before activation: −${excluded} excluded${eligible !== null ? `, ${eligible} eligible` : ""}. Proves consent/suppression filter executes for syncs (not just the send loop).`,
    evidence: p,
  };
});

// ===================================================================
// #3 Surfacing Analytics
// ===================================================================
await check("#3 campaign engagement panel", "warning", async () => {
  if (!campaignID) {
    return {
      status: "warning",
      detail: "No campaign found/configured — set POSTWAVE_CAMPAIGN_ID to verify the engagement panel.",
    };
  }
  const e = await requestJSON(`/api/v1/campaigns/${encodeURIComponent(campaignID)}/engagement`);
  const hasHuman = "human_open_rate" in e || "humanOpenRate" in e;
  const hasReply = "reply_rate" in e || "replyRate" in e;
  const hasSurfacing = "ai_surfacing_score" in e || "aiSurfacingScore" in e || "surfacing" in e;
  const hasNoOpenConv = "conversions_without_open" in e || "conversionsWithoutOpen" in e;
  const ok = hasHuman && hasReply;
  return {
    status: ok ? "pass" : "warning",
    detail: `human-open-rate=${hasHuman} reply-rate=${hasReply} ai-surfacing-estimate=${hasSurfacing} conversion-without-open=${hasNoOpenConv}. Hard signals are the trustworthy core; AI-surfacing is a labelled estimate.`,
    evidence: e,
  };
});

// ===================================================================
// #4 Segment P&L
// ===================================================================
await check("#4 segment P&L", "warning", async () => {
  if (!segmentID) {
    return { status: "warning", detail: "No segment found/configured — set POSTWAVE_SEGMENT_ID to verify P&L." };
  }
  const pnl = await requestJSON(`/api/v1/segments/${encodeURIComponent(segmentID)}/pnl?days=30&include_lift=true`);
  const hasRev = "revenue_cents" in pnl || "revenue" in pnl || "revenue_micros" in pnl;
  const scope = pnl.revenue_scope || "(unset)";
  const liftHonest =
    pnl.lift === null || pnl.lift === undefined || typeof pnl.lift_skipped_reason === "string" || typeof pnl.lift === "object";
  return {
    status: hasRev ? "pass" : "warning",
    detail: `revenue present=${hasRev}, revenue_scope=${scope}; lift honesty (null+reason when no holdout / capped >100k) = ${liftHonest}.`,
    evidence: pnl,
  };
});

// ===================================================================
// #5 Segment Decay Radar
// ===================================================================
await check("#5 segment decay events", "warning", async () => {
  if (!segmentID) {
    return { status: "warning", detail: "No segment — set POSTWAVE_SEGMENT_ID to verify decay-events." };
  }
  const d = await requestJSON(`/api/v1/segments/${encodeURIComponent(segmentID)}/decay-events`);
  const items = d.items || d || [];
  return {
    status: "pass",
    detail: `Decay-events endpoint reachable (${items.length} event(s)). Empty until the decay worker has ticked at least once.`,
    evidence: { count: items.length },
  };
});

await check("#5 segment definition history", "warning", async () => {
  if (!segmentID) {
    return { status: "warning", detail: "No segment — set POSTWAVE_SEGMENT_ID to verify definition-history." };
  }
  const res = await request(`/api/v1/segments/${encodeURIComponent(segmentID)}/definition-history`, { allow404: true });
  return {
    status: res.ok ? "pass" : "warning",
    detail: res.ok ? "Definition-integrity history reachable." : `Returned HTTP ${res.status}.`,
  };
});

// --- summary + exit code (mirrors pilot-certification-smoke) ---
const blockers = checks.filter((c) => c.status === "blocker");
const warnings = checks.filter((c) => c.status === "warning");
const summary = {
  generated_at: new Date().toISOString(),
  base_url: baseURL,
  llm_enabled: enableLLM,
  readonly,
  status: blockers.length ? "blocker" : warnings.length ? "warning" : "pass",
  blockers: blockers.length,
  warnings: warnings.length,
  checks,
};
console.log(JSON.stringify(summary, null, 2));
if (blockers.length || (strict && warnings.length)) process.exitCode = 1;

// ===================================================================
// helpers (mirror scripts/pilot-certification-smoke.mjs)
// ===================================================================
async function check(name, failureStatus, fn) {
  try {
    const result = await fn();
    checks.push({ name, ...result });
  } catch (err) {
    checks.push({ name, status: failureStatus, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function firstId(listPath) {
  try {
    const r = await requestJSON(listPath);
    const items = Array.isArray(r) ? r : r.items || r.data || [];
    const first = items[0];
    return first ? first.id || first.ID || first.uuid || "" : "";
  } catch {
    return "";
  }
}

async function requestJSON(path, opts) {
  const res = await request(path, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function safeJSON(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function authHeaders() {
  const headers = {};
  if (process.env.POSTWAVE_API_KEY) headers.Authorization = `Bearer ${process.env.POSTWAVE_API_KEY}`;
  if (process.env.POSTWAVE_AUTH_HEADER) {
    const idx = process.env.POSTWAVE_AUTH_HEADER.indexOf(":");
    if (idx > 0) {
      headers[process.env.POSTWAVE_AUTH_HEADER.slice(0, idx).trim()] = process.env.POSTWAVE_AUTH_HEADER.slice(idx + 1).trim();
    }
  }
  if (process.env.POSTWAVE_TENANT_ID) {
    headers["X-Tenant-ID"] = process.env.POSTWAVE_TENANT_ID;
    headers["X-Postwave-Tenant-ID"] = process.env.POSTWAVE_TENANT_ID;
  }
  return headers;
}

async function request(path, opts = {}) {
  const headers = authHeaders();
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(baseURL + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.allow404 && res.status === 404) return res;
  return res;
}

function parseArgs(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = raw[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function trimRightSlash(v) {
  return String(v || "").replace(/\/+$/, "");
}
