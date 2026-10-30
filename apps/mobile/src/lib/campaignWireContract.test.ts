/**
 * campaignWireContract — the guard that stops the mobile campaign types from
 * silently drifting away from the Go structs they mirror.
 *
 * `Campaign` and `CampaignReport` in src/hooks/useCampaigns.ts are hand-copied
 * from apps/api/internal/campaigns/types.go and
 * apps/api/internal/analytics/analytics.go. They HAD already drifted: the list
 * endpoint attaches `open_rate`/`click_rate` to every row and the report ships
 * nine `human_*` fields, and neither set existed on the TS side — which is why
 * the list read open rate through an `as unknown as` cast, click rate was
 * unreachable, and the phone's open rate disagreed with the desktop's.
 *
 * This test re-reads the Go source and fails when a field the mobile screens
 * are documented to consume disappears from — or is renamed in — the struct.
 * It is deliberately a ONE-WAY check over a named, curated set rather than
 * "every tag must exist in TS": mobile is a monitor surface and does not
 * render template lineage or content blocks, and asserting the full struct
 * would turn every backend addition into a mobile test failure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

/** Every `json:"name..."` tag inside the named Go struct. */
function jsonTags(source: string, structName: string): Set<string> {
  const start = source.indexOf(`type ${structName} struct {`);
  if (start < 0) throw new Error(`struct ${structName} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`struct ${structName} not terminated`);
  const body = source.slice(start, end);
  const tags = new Set<string>();
  for (const match of body.matchAll(/json:"([^",]+)/g)) {
    const name = match[1];
    if (name && name !== "-") tags.add(name);
  }
  return tags;
}

/** Property names declared on the named TS interface. */
function tsFields(source: string, interfaceName: string): Set<string> {
  const start = source.indexOf(`export interface ${interfaceName}`);
  if (start < 0) throw new Error(`interface ${interfaceName} not found`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  if (end < 0) throw new Error(`interface ${interfaceName} not terminated`);
  const body = source.slice(open, end);
  const fields = new Set<string>();
  for (const match of body.matchAll(/^\s{2}([a-z_][A-Za-z0-9_]*)\??:/gm)) {
    if (match[1]) fields.add(match[1]);
  }
  return fields;
}

const goCampaign = repoFile("apps/api/internal/campaigns/types.go");
const goAnalytics = repoFile("apps/api/internal/analytics/analytics.go");
const mobileHook = repoFile("apps/mobile/src/hooks/useCampaigns.ts");

/**
 * The fields the mobile campaign screens actually read. Each one has a
 * consumer today; adding to this list is a deliberate act.
 */
const CAMPAIGN_FIELDS_CONSUMED = [
  "id",
  "name",
  "subject",
  "status",
  "body_html",
  "body_mjml",
  "plain_text",
  "preview_text",
  // Structured semantic nodes drive the read-only poll-receipt handoff.
  "content_blocks",
  "source_mode",
  "content_schema_version",
  "from_name",
  "reply_to",
  "list_id",
  "segment_id",
  "scheduled_at",
  "sent_at",
  "created_at",
  "updated_at",
  "delivery_settings",
  // Attached to EVERY list row by attachListRates (repo.go). Their absence
  // from the TS mirror is the drift that forced an unsafe cast at the one
  // call site that read them.
  "open_rate",
  "click_rate",
  // Public web-version sharing (useCampaignShare + lib/campaignShare.ts).
  "archive_public",
  "archive_slug",
  // Desktop-configured per-recipient send time; the schedule sheet warns
  // before a fixed time overwrites it.
  "per_recipient_optimize",
  "send_window_start",
  "send_window_end",
] as const;

const REPORT_FIELDS_CONSUMED = [
  "campaign_id",
  "sent",
  "delivered",
  "opens",
  "unique_opens",
  "clicks",
  "unique_clicks",
  "bounces",
  "complaints",
  "unsubscribes",
  "open_rate",
  "click_rate",
  "click_to_open_rate",
  "bounce_rate",
  "unsub_rate",
  "top_links",
  // MPP-stripped engagement — the reason the phone used to disagree with the
  // desktop by default (see lib/campaignEngagement.ts).
  "human_opens",
  "human_unique_opens",
  "human_clicks",
  "human_unique_clicks",
  "human_open_rate",
  "human_click_rate",
  "human_click_to_open_rate",
  "human_top_links",
  "bot_signatures_applied",
] as const;

describe("campaign wire contract", () => {
  const campaignTags = jsonTags(goCampaign, "Campaign");
  const reportTags = jsonTags(goAnalytics, "CampaignReport");
  const mobileCampaign = new Set([
    ...tsFields(mobileHook, "Campaign"),
    ...tsFields(mobileHook, "CampaignDetail"),
  ]);
  const mobileReport = tsFields(mobileHook, "CampaignReport");

  it.each(CAMPAIGN_FIELDS_CONSUMED)(
    "Go campaigns.Campaign still ships %s",
    (field) => {
      expect(campaignTags.has(field)).toBe(true);
    },
  );

  it.each(CAMPAIGN_FIELDS_CONSUMED)(
    "mobile Campaign/CampaignDetail still declares %s",
    (field) => {
      expect(mobileCampaign.has(field)).toBe(true);
    },
  );

  it.each(REPORT_FIELDS_CONSUMED)(
    "Go analytics.CampaignReport still ships %s",
    (field) => {
      expect(reportTags.has(field)).toBe(true);
    },
  );

  it.each(REPORT_FIELDS_CONSUMED)(
    "mobile CampaignReport still declares %s",
    (field) => {
      expect(mobileReport.has(field)).toBe(true);
    },
  );

  it("does not declare TS fields the Go structs never send", () => {
    // The other direction of drift: a field invented on the client renders as
    // undefined forever and no type error ever fires. Only fields that are
    // genuinely absent from the struct are reported.
    const invented = [...mobileCampaign].filter(
      (field) => !campaignTags.has(field),
    );
    // Two deliberate exceptions, both documented on the interface itself:
    //   is_ab_test  — a flattened convenience flag some deployments add ahead
    //                 of the struct; isCampaignAbTest() reads
    //                 delivery_settings.ab_test.is_parent first.
    //   from_email  — carried inside delivery_settings, never top-level; read
    //                 through campaignFromEmail() in lib/campaignSender.ts.
    // ANY OTHER entry here is a field the client invented, which renders as
    // undefined forever with no type error. When this list grows, the fix is
    // to delete the field or find where the gateway really carries it — that
    // is exactly how the dead `from_email` "From:" line was found.
    expect(
      invented.slice().sort(),
      `mobile Campaign fields absent from Go: ${invented.join(", ")}`,
    ).toEqual(["from_email", "is_ab_test"]);
  });

  it("does not declare report fields the Go struct never sends", () => {
    const invented = [...mobileReport].filter((field) => !reportTags.has(field));
    expect(invented, `mobile CampaignReport fields absent from Go: ${invented.join(", ")}`)
      .toEqual([]);
  });
});
