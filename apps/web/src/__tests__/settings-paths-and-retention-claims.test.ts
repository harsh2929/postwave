// SPDX-License-Identifier: AGPL-3.0-only
//
// Two claim families that legal and docs pages make about the product, both
// checked against the code that would have to honour them.
//
// 1. "Settings → X" wayfinding. Terms §2.3, the DPIA, the sub-processor
//    register, the quickstart, and a step-up prompt all send people to a named
//    settings tab. SETTINGS_NAV_SECTIONS is the only thing that decides what
//    tabs exist, so a claim naming a tab that isn't there is a dead end — the
//    refund policy already shipped one ("Settings → Billing", when Billing is
//    top-level) and needed __tests__/refund-policy-routes.test.ts to catch it.
//
//    Third-party instructions are excluded and must stay excluded: the
//    migration and integration guides say things like "ActiveCampaign Settings
//    -> Developer -> API Access" and "Mailgun → Settings → API Keys", which
//    describe someone else's UI. The filter is the sentence naming a vendor
//    immediately before "Settings", not a list of our own tabs — a denylist
//    would silently start passing whenever a vendor was added.
//
// 2. Retention figures. The DPIA states a default window, a configurable
//    range, and a full-fidelity boundary as numbers. Each has exactly one
//    source of truth in Go, and prose drifts where constants don't.
//
// The DPIA also claimed controllers could "disable open-tracking,
// click-tracking, and IP retention via Settings → Privacy". None of the three
// live there: tracking is a per-campaign tracking_settings field honoured in
// sendloop.go, and the observation IP is degraded on a timer rather than
// disableable. That sentence is now corrected; what is pinned below is the
// 90-day boundary it now cites.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { flattenSettingsNav } from "@/lib/settings-nav";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Read a named Go constant's integer value. */
function goConst(rel: string, name: string): number {
  const text = readFileSync(join(REPO, rel), "utf8");
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(text);
  expect(m, `${name} not found in ${rel}`).not.toBeNull();
  return Number(m![1]);
}

describe("Settings → X claims name a real tab", () => {
  const tabs = new Set(
    flattenSettingsNav().map((i) => i.label.toLowerCase()),
  );

  it("reads the nav", () => {
    // Guard the guard: an empty nav would make every claim look valid.
    expect(tabs.size).toBeGreaterThan(10);
    expect(tabs.has("privacy")).toBe(true);
  });

  it("points every own-product claim at a tab that exists", () => {
    // "<Vendor> Settings" / "Settings → …" preceded by a vendor name is
    // someone else's UI. Anything else is a claim about ours.
    const VENDOR_BEFORE =
      /(?:ActiveCampaign|Mailgun|Beehiiv|ConvertKit|Kit|Klaviyo|Mailchimp|Shopify|Stripe|Slack|HubSpot|Account)\s*(?:→|-&gt;|->|&rarr;)?\s*$/;
    const bad: string[] = [];
    let checked = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /Settings\s*(?:&rarr;|→|->)\s*(?:<strong>)?([A-Z][A-Za-z&;\s]{1,28}?)(?:<\/strong>)?\s*(?:&rarr;|→|->|[.,<(])/g,
      )) {
        const before = text.slice(Math.max(0, m.index! - 40), m.index!);
        if (VENDOR_BEFORE.test(before)) continue;
        const tab = m[1]!
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        checked += 1;
        if (!tabs.has(tab)) bad.push(`${file.slice(SRC.length + 1)}: "${tab}"`);
      }
    }
    expect(checked).toBeGreaterThan(5); // guard the guard
    expect([...new Set(bad)].sort()).toEqual([]);
  });
});

describe("published retention figures match the code", () => {
  const dpia = readFileSync(
    join(SRC, "app/(marketing)/legal/dpia/page.tsx"),
    "utf8",
  );

  it("states the configurable range the API enforces", () => {
    const page = readFileSync(
      join(SRC, "app/(dashboard)/app/settings/privacy/page.tsx"),
      "utf8",
    );
    const min = /EMAIL_EVENT_MIN\s*=\s*(\d+)/.exec(page);
    const max = /EMAIL_EVENT_MAX\s*=\s*(\d+)/.exec(page);
    expect(min).not.toBeNull();
    expect(max).not.toBeNull();
    // "from 30 days up to 7 years"
    expect(dpia).toContain(`from ${min![1]} days`);
    expect(Number(max![1])).toBe(7 * 365);
    expect(dpia).toContain("7 years");
  });

  it("states the default the server applies", () => {
    // Derive the month count from the constant rather than asserting a shape
    // that stays true as the constant moves: 365 → "12-month", and a change to
    // 730 demands "24-month" instead of quietly still passing.
    const days = goConst(
      "apps/api/internal/settings/privacy.go",
      "defaultEmailEventRetentionDays",
    );
    const months = Math.round(days / 30.44);
    expect(dpia).toContain(`${months}-month retention window`);
  });

  it("states the audit-log default the sweeper uses, on every page that states one", () => {
    // Three documents published 365 days against a 90-day default — wrong by
    // 4x, in the direction where a customer investigating an incident is told
    // a personnel-access trail exists that audit.Trim purged months earlier.
    // audit_log is the only such table (actor_type carries
    // 'platform_operator'), swept on settings.PrivacyRepo.AuditLogRetentionDays.
    //
    // Checked across the whole legal surface, not one file: the first version
    // of this guard pinned the privacy policy alone, and the identical claim
    // was sitting in the DPA's Annex 2 TOMs — the document that PREVAILS over
    // the rest of the Agreement per DPA §16 — and in the DPIA.
    const days = goConst(
      "apps/api/internal/settings/privacy.go",
      "defaultAuditLogRetentionDays",
    );
    const settings = readFileSync(
      join(REPO, "apps/api/internal/settings/privacy.go"),
      "utf8",
    );
    const range = /audit_log_retention_days must be between (\d+) and (\d+)/.exec(
      settings,
    );
    expect(range, "audit-log range message not found").not.toBeNull();
    expect(Number(range![2])).toBe(7 * 365);

    const stale: string[] = [];
    let stating = 0;
    for (const file of walk(join(SRC, "app/(marketing)/legal"))) {
      // Prettier wraps JSX prose, so "(default\n  90 days" is one phrase split
      // across lines. Compare on whitespace-normalised text or the guard
      // reports a page that says exactly the right thing.
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      // Only pages that actually make an audit-retention claim.
      if (!/[Aa]udit log(?:ging|s)?.{0,220}?retain/.test(text)) continue;
      stating += 1;
      const rel = file.slice(SRC.length + 1);
      if (!new RegExp(`[Dd]efault ${days} days`).test(text)) {
        stale.push(`${rel}: does not state the ${days}-day default`);
      }
      if (!text.includes(`from ${range![1]} days`)) {
        stale.push(`${rel}: does not state it is configurable from ${range![1]} days`);
      }
    }
    expect(stating, "no page makes an audit-retention claim").toBeGreaterThan(2);
    expect(stale.sort()).toEqual([]);
  });

  it("names UI actions the Subscribers screen actually offers", () => {
    // The DPIA cited a "Forget this subscriber" action for Art. 17. The
    // capability is real and does everything claimed — wipes engagement
    // history, retains a hashed suppression entry so re-import is blocked —
    // but no control has ever carried that name. The buttons are Erase and
    // Archive, and a controller reading a compliance document to find the
    // erasure control has to be able to find it.
    const dpia = readFileSync(
      join(SRC, "app/(marketing)/legal/dpia/page.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    const table = readFileSync(
      join(SRC, "app/(dashboard)/app/subscribers/subscribers-table.tsx"),
      "utf8",
    );
    for (const label of ["Erase", "Archive"]) {
      expect(dpia, `DPIA should name the ${label} action`).toContain(
        `<strong>${label}</strong>`,
      );
      expect(table, `${label} missing from the subscribers table`).toContain(
        label,
      );
    }
    expect(dpia).not.toContain("Forget this subscriber");
  });

  it("states one sub-processor objection deadline across the legal surface", () => {
    // DPA §7.4 gives 15 days to object; the sub-processor register — which
    // "forms Annex 3" of that same DPA — told customers they had the full
    // 30-day notice window, so anyone relying on the published page and
    // objecting on day 20 had already missed the deadline that governs them.
    const dpa = readFileSync(
      join(SRC, "app/(marketing)/legal/dpa/page.tsx"),
      "utf8",
    );
    const days = /object on reasonable data protection grounds within (\d+) days/.exec(
      dpa,
    );
    expect(days, "DPA §7.4 objection window not found").not.toBeNull();
    const register = readFileSync(
      join(SRC, "app/(marketing)/legal/sub-processors/page.tsx"),
      "utf8",
    );
    expect(register).toContain(`within ${days![1]} days of the notice`);
  });

  it("states the full-fidelity boundary the degradation worker uses", () => {
    // DefaultFullFidelityWindow = 90 * 24 * time.Hour. The DPIA now says IP,
    // headers, and the TLS fingerprint are erased at that boundary.
    const retention = readFileSync(
      join(REPO, "apps/api/internal/engagementclassification/retention.go"),
      "utf8",
    );
    const m = /DefaultFullFidelityWindow\s*=\s*(\d+)\s*\*\s*24\s*\*\s*time\.Hour/.exec(
      retention,
    );
    expect(m, "DefaultFullFidelityWindow not found").not.toBeNull();
    expect(dpia.replace(/\s+/g, " ")).toContain(
      `${m![1]} days after the event`,
    );
  });

  it("does not send controllers to Settings → Privacy for tracking toggles", () => {
    // The three controls that sentence promised do not exist there:
    // privacy.go carries retention windows only.
    const privacy = readFileSync(
      join(REPO, "apps/api/internal/settings/privacy.go"),
      "utf8",
    );
    expect(privacy).not.toMatch(/open_tracking|click_tracking/);
    expect(dpia).not.toMatch(
      /disable open-tracking, click-tracking, and IP retention via Settings/,
    );
  });
});
