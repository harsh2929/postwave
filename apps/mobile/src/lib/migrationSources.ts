import type { MobileMigrationSource } from "../api/ops";

type MigrationSourceLike = Pick<
  MobileMigrationSource,
  "source" | "supports" | "auth_method"
>;

export function supportedMigrationCapabilityLabels(
  source: MigrationSourceLike,
): string[] {
  const supports = source.supports ?? {};
  return Object.entries(supports).flatMap(([key, value]) => {
    if (key === "automation_mode" || value !== true) return [];
    if (key === "automations") return [automationCapabilityLabel(source)];
    if (key === "campaign_archive" && source.source === "klaviyo") {
      return ["sent email campaign archive"];
    }
    if (key === "campaign_archive" && source.source === "customerio") {
      return ["sent email one-time-send archive"];
    }
    if (key === "campaigns" && source.source === "customerio") {
      return ["campaign/broadcast rebuild evidence"];
    }
    if (key === "segments" && source.source === "customerio") {
      return ["frozen segment/topic snapshots"];
    }
    return [key.replace(/_/g, " ")];
  });
}

export function migrationSourceAuthLabel(source: MigrationSourceLike): string {
  if (source.source === "activecampaign") return "API token";
  if (source.source === "hubspot") return "Private app token";
  if (source.source === "customerio") return "App API key";
  const method = String(source.auth_method ?? "");
  switch (method) {
    case "oauth2":
      return "OAuth";
    case "api_key":
      return "API key";
    case "csv_upload":
      return "CSV upload";
    default:
      return method.replace(/_/g, " ").trim();
  }
}

export function migrationSourceAutomationNote(
  source: MigrationSourceLike,
): string | null {
  if (source.source === "hubspot") {
    return "HubSpot remains the CRM system of record. The 2026-03 bridge imports exact email-addressable contacts, exact per-type plus wide communication preferences, conservative current-primary-email eligibility, and frozen list/subscription tags; non-email contacts and additional addresses remain explicit non-sendable evidence. Enabled requires every active definition SUBSCRIBED with no scoped/wide opt-out, hard-bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction; NOT_SPECIFIED remains unconfirmed. This is not exact HubSpot sendability parity. A primary-email change requires a fresh full snapshot. List identity and allowlisted structural metadata are retained, but filter predicates are deliberately not fetched or stored because they can contain sensitive literals; inspect and rebuild, retain, or retire those rules in HubSpot. Changed-contact polling misses list/preference-only changes, deletions, and lost-email contacts, so a retained overlap and authoritative final full snapshot still gate cutover.";
  }
  if (source.source === "klaviyo") {
    return "Klaviyo flows are rebuild-only and never activated automatically. Sent email campaigns are campaign-archive-only; sent SMS/push history is non-executable source-archive evidence. Stable profile retrieval exposes only the primary email, so secondary addresses and independent per-address consent require multi-email source-archive, consent, and ecosystem review. Membership counts/tags are the enumerated send-targetable projection after validated list-level suppressions, not a separately exposed raw count; unnamed audiences use deterministic Klaviyo list/segment ID labels. Predictive profile reads use the stricter 10/second, 150/minute tier. Draft campaign-message and flow definitions may be null and then require recovery or retirement; campaign tags retain IDs only. Eight unconditional source_total=1 static checklist rows do not prove product inventory. A stable-ID email A→B change blocks replay until the full snapshot materializes B and disables source-owned A. A completed import is not cutover approval; freeze Klaviyo changes, run the final full-snapshot delta, and complete manual review in web.";
  }
  if (source.source === "beehiiv") {
    return "Automations are rebuild-only. A completed import is not cutover approval; finish the frozen final delta, source-automation retirement, billing handoff, shadow, and strict pilot gates in web.";
  }
  if (source.source === "customerio") {
    return 'Customer.io automations are rebuild-only and never activated automatically. The import is bound to one US/EU workspace and immutable cio_id identities. Email requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default; ESP suppressions still block. Sender-specific SMS/WhatsApp /v1/optouts remain separate non-email evidence, not subscription-center channel preferences. Sent-newsletter history requires an explicit language="" default; the lowest stable ID represents a multi-default/A-B set, all variants remain evidence, and newsletter/Design Studio HTML is source content/composition rather than provider-rendered output. Profiles without email, duplicate profiles sharing an email, non-email runtime, and ecosystem dependencies remain explicit review surfaces. Customer.io exposes no supported incremental profile-change feed, so freeze changes and finish a full final snapshot, fresh shadow check, rollback rehearsal, and strict pilot gates in web.';
  }
  if (source.source !== "mailchimp") return null;
  const mode = source.supports?.automation_mode;
  if (mode === "runtime") {
    return "The validated Classic welcomeSeries subset migrates paused; other Classic workflows and Customer Journeys require manual rebuild.";
  }
  if (mode === "rebuild_review") {
    return "Classic Automations import for rebuild review; Customer Journeys remain manual.";
  }
  return "Classic Automations are not advertised for import; Customer Journeys require manual rebuild.";
}

export function mobileMigrationCutoverNote(job: {
  source?: string | null;
  status?: string | null;
}): string | null {
  const source = String(job.source ?? "").toLowerCase();
  const status = String(job.status ?? "").toLowerCase();
  if (source === "klaviyo" && status === "completed") {
    return "Initial import completed; Klaviyo cutover is not certified. Only the primary email identity imported; secondary addresses and independent per-address consent require multi-email source-archive evidence tied to consent and ecosystem review. Confirm each stable-ID email A→B change materialized B and disabled source-owned A in the full snapshot before replay resumes. Treat list/segment counts and tags as the post-list-suppression send-targetable projection, not raw membership. Recover or retire nullable flow/draft-message definitions, resolve campaign tag IDs where taxonomy matters, and close all eight static checklist obligations without treating them as source inventory. Only sent email campaigns entered campaign history; SMS/push sends remain source-archive evidence. Complete fresh verification/shadow checks and manual review in the web app.";
  }
  if (source === "customerio" && status === "completed") {
    return 'Initial import completed; Customer.io cutover is not certified. Freeze source changes and run the final full email-addressable cio_id snapshot, then prove email enablement requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default and no ESP suppression. Reconcile sender-specific SMS/WhatsApp /v1/optouts separately from subscription-center channel preferences, plus duplicate-email ownership, email moves/deletions, profiles without email, exact frozen segment memberships, and sent email one-time-send fidelity: an explicit language="" default, lowest-stable-ID A/B representative with all variants retained, provable source layout/body composition, and no provider-rendering claim for newsletter or Design Studio HTML. Also reconcile automation and non-email rebuild evidence, fresh shadow, rollback rehearsal, and all six Customer.io review gates in the web app.';
  }
  if (source === "hubspot" && status === "completed") {
    return "Initial import completed; HubSpot cutover is not certified. Keep the provider-verified portal-bound job through at least seven days of changed-contact replay, then freeze contact/list/preference edits and run the authoritative full snapshot. Reconcile complete preference and current-primary-email eligibility coverage, non-email and additional-email identities, property-definition evidence, the combined list/subscription targeting count, source-owned dynamic-list rules whose predicates are not fetched or stored, polling gaps, fingerprint shadow proof, hard scope review, rollback rehearsal, strict pilot pass, local source-session deletion, rollback, and external private-app-token cleanup through the strict certification workflow.";
  }
  if (source !== "beehiiv" || status !== "completed") {
    return null;
  }
  return "Initial import completed; Beehiiv cutover is not certified. Continue the final-delta and strict acceptance workflow in the web app.";
}

function automationCapabilityLabel(source: MigrationSourceLike): string {
  const mode = source.supports?.automation_mode;
  if (mode === "rebuild_review") {
    if (source.source === "customerio") return "workflow rebuild review";
    return source.source === "mailchimp"
      ? "Classic Automation rebuild review"
      : "automation rebuild review";
  }
  if (mode === "runtime") {
    return source.source === "mailchimp"
      ? "Validated Classic welcome series (runtime)"
      : "automations";
  }
  if (source.source === "activecampaign") return "automation rebuild review";
  return "automations";
}
