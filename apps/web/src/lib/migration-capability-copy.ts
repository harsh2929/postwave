import type { AdapterCapabilities } from "./types";

export function migrationAutomationCapabilityLabel(
  cap: AdapterCapabilities,
): string {
  if (cap.source === "mailchimp") {
    if (cap.supports.automation_mode === "runtime") {
      return "Validated Classic welcome series (runtime)";
    }
    if (cap.supports.automation_mode === "rebuild_review") {
      return "Classic Automation rebuild review";
    }
    return "Classic Automations";
  }
  if (cap.source === "klaviyo") {
    return cap.supports.automation_mode === "rebuild_review"
      ? "Flow rebuild review"
      : "Flows";
  }
  if (cap.source === "customerio") {
    return cap.supports.automation_mode === "rebuild_review"
      ? "Campaign/API-broadcast rebuild review"
      : "Campaigns and API broadcasts";
  }
  return cap.supports.automation_mode === "rebuild_review" ||
    cap.source === "activecampaign"
    ? "Automation rebuild review"
    : "Automations";
}

export function migrationCapabilityDescription(
  cap: AdapterCapabilities,
): string {
  if (cap.source === "substack") {
    return "Imports subscriber CSV or Substack export ZIP files, membership-tier details, matching post HTML, and available aggregate statistics. Review consent and arrange paid billing separately.";
  }
  if (cap.auth_method === "csv_upload") {
    return "Imports subscriber records, explicit email statuses, tags, and custom fields from a CSV export. Missing or unknown statuses remain unconfirmed. Automations, campaign history, and paid billing require separate work.";
  }
  if (cap.source === "convertkit") {
    return "Imports subscribers and available audience and broadcast data. Sequence definitions require rebuild review. Contact creation dates do not establish opt-in; optional Stripe records are billing evidence, not transferred subscriptions.";
  }
  if (cap.source === "brevo") {
    return "Imports contacts, email suppression state, list audiences, saved-segment evidence, and sent email campaign history. Automations require a separate inventory and rebuild. Contact creation dates do not establish opt-in.";
  }
  if (cap.source === "mailerlite") {
    return "Imports MailerLite Connect subscribers, statuses, fields, and groups, plus campaign metadata, plain text, and available reports. Dynamic segments and automations require rebuild review. MailerLite Classic and rendered campaign HTML are unsupported.";
  }
  if (cap.source === "hubspot") {
    return "Imports a portal-bound 2026-03 snapshot of email contacts, exact per-type/wide preferences, conservative current-primary-email eligibility, populated non-sensitive properties, and frozen list/subscription tags. Enabled requires all active definitions SUBSCRIBED with no scoped/wide opt-out, hard-bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction; this is not exact HubSpot sendability parity. Non-email/additional-email identities stay non-sendable evidence; dynamic-list predicates are deliberately not requested or persisted because they can contain sensitive literals, and workflows/marketing assets stay out of scope. Discovery fails closed above its 1,000,000-contact, 10,000-page, 64 MiB snapshot, 10,000-search-result, or reserved daily-quota limits.";
  }
  if (cap.source === "mailchimp") {
    const classicAutomationCopy =
      cap.supports.automation_mode === "runtime"
        ? "The validated Classic welcomeSeries subset can migrate to the Moosewave runtime, paused; other trigger or runtime-window semantics remain rebuild-review items."
        : cap.supports.automation_mode === "rebuild_review"
          ? "Classic Automations import as rebuild-review evidence."
          : "No Classic Automation mode is advertised by this server.";
    return `${classicAutomationCopy} Customer Journeys require manual rebuild; audience selection is explicit.`;
  }
  if (cap.source === "beehiiv") {
    return "Imports subscribers, custom fields, static segment and newsletter-list membership snapshots, and the sent-post archive. Dynamic segment predicates and automations are preserved for rebuild review; premium membership metadata is archived, but Stripe billing continuity and portable consent timestamps are not imported.";
  }
  if (cap.source === "klaviyo") {
    return "Imports the primary email identity and available consent/suppression state exposed by Klaviyo's stable Get Profiles response, plus profile and predictive properties, the exact enumerated send-targetable list/segment projection after validated list-level suppressions are excluded, editable templates, and sent email campaign archive rows. Raw Klaviyo audience membership counts are not exposed separately. Profile reads request predictive_analytics and respect its stricter 10 requests/second and 150 requests/minute tier. Unnamed audiences receive deterministic `Klaviyo list <id>` or `Klaviyo segment <id>` labels. Klaviyo secondary email addresses and their independent per-address consent/suppression state are not exposed by that response, so automatic profile-identity or consent parity is unavailable and a source-archive/manual review is mandatory. Incremental replay fails closed when a stable profile ID changes from email A to B while the source-owned A destination remains active; the full final snapshot must materialize B and disable A before replay resumes. An unrolled-back tenant/account lineage must reuse its original Klaviyo migration job for credential refreshes and delta/full snapshots; a second job for the same tenant/account is rejected to prevent duplicate active identities after an email change. Sent SMS and push records remain non-executable source-archive evidence and never become email campaigns. Draft campaign-message definitions and flow definitions may be null and are preserved as explicitly incomplete rebuild evidence; campaign tag relationships retain provider IDs only, not resolved tag names. The adapter always emits eight static product-area checklist records: source_total=1 means one checklist, not detected source inventory. Dynamic segment predicates and Klaviyo flows are preserved for rebuild review; reporting metrics and non-email-only profiles are not imported as Moosewave runtime resources.";
  }
  if (cap.source === "customerio") {
    return 'Imports one explicitly bound US/EU Customer.io workspace using an App API key, never a Track API site key. Complete email-addressable profile snapshots preserve immutable cio_id identity, authoritative profile fields, subscription-center topic/channel preferences, ESP suppressions, exact frozen segment and subscription-topic membership, exact-source Design Studio HTML templates, and eligible sent email newsletters. Email is enabled only when global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default, and the applicable topic is subscribed explicitly or by configured default. Sent-newsletter history requires at least one explicit language="" default and provably composable source HTML; the lowest stable content ID represents a multi-default/A-B set with an explicit warning, translations are never silently selected, and neither newsletter nor Design Studio HTML is provider-rendered output. Profiles without email, multiple profiles sharing an email, publisher-ID changes, email moves/deletions, GDPR-suppressed identifiers, non-email newsletters, transactional definitions, sender-specific SMS/WhatsApp /v1/optouts, object-type metadata, and ecosystem gaps remain explicit source-archive/review evidence. /v1/optouts is separate from subscription-center channel preferences and never determines email eligibility. Campaign automations and API-triggered broadcasts are rebuild-only and no runtime workflow is activated. Customer.io has no supported incremental profile-change feed, so cutover requires a source freeze, final full snapshot, fresh shadow check, rollback rehearsal, all six manual evidence gates, and credential cleanup.';
  }
  if (cap.source === "activecampaign") {
    return "Imports fail-closed email contacts, tags/lists, and hydrated sent campaigns; saved segments and enriched automation definitions are rebuild-only, while phone-only, CRM, SMS broadcasts, custom objects, forms, and ecommerce stay review evidence.";
  }
  return "Review the supported resources and dry-run report before importing.";
}

export function migrationAvailabilityDescription(
  cap: AdapterCapabilities,
): string | null {
  if (cap.intake_available === false) {
    if (cap.intake_unavailable_code === "oauth_app_not_configured") {
      return "Connection setup is pending. Moosewave must configure this platform before you can connect.";
    }
    return cap.auth_method === "csv_upload"
      ? "Uploads are unavailable in this environment. Moosewave must finish file storage setup."
      : "Connections are unavailable in this environment.";
  }
  if (cap.commit_available === false) {
    return "Preview only. Moosewave must finish this workspace’s import setup before you can complete a migration.";
  }
  return null;
}
