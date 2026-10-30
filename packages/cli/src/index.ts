#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import cac from "cac";
import { login } from "./auth/login.js";
import { deviceLogin } from "./auth/device-login.js";
import { logout } from "./auth/logout.js";
import { whoami } from "./auth/whoami.js";
import {
  migrateCommand,
  migrateSourceEventsStart,
  migrateSourceEventsStatus,
  migrateSourceEventsStop,
} from "./commands/migrate.js";
import { diagnoseCommand } from "./commands/diagnose.js";
import {
  sequencesList,
  sequencesGenerate,
  sequencesRegenerate,
} from "./commands/sequences.js";
import { templatesList, templatesGet } from "./commands/templates.js";
import {
  subscribersCreate,
  subscribersDelete,
  subscribersImport,
  subscribersList,
  subscribersSearch,
  subscribersSuppress,
  subscribersUpdate,
} from "./commands/subscribers.js";
import { listsCreate, listsDelete } from "./commands/lists.js";
import {
  campaignsCreate,
  campaignsDelete,
  campaignsQueue,
  campaignsSend,
  campaignsUpdate,
} from "./commands/campaigns.js";
import { formsList, formsCreate } from "./commands/forms.js";
import {
  inboxReport,
  inboxPredict,
  inboxReputation,
  inboxAuth,
} from "./commands/inbox.js";
import {
  assuranceApply,
  assuranceCancel,
  assuranceFindings,
  assuranceGet,
  assuranceOverride,
  assuranceRun,
} from "./commands/assurance.js";
import {
  automationTrigger,
  automationPause,
  automationResume,
} from "./commands/automation.js";
import {
  integrationsAudienceCreate,
  integrationsAudienceDisconnect,
  integrationsAudienceGet,
  integrationsAudienceJobDiagnostics,
  integrationsAudienceJobs,
  integrationsAudienceList,
  integrationsAudiencePreview,
  integrationsAudienceProviders,
  integrationsAudienceReadiness,
  integrationsAudienceSyncRuns,
  integrationsAudienceSync,
  integrationsAudienceUpdate,
  integrationsApplyRecipe,
  integrationsBackfill,
  integrationsChatCreate,
  integrationsChatDelete,
  integrationsChatList,
  integrationsChatUpdate,
  integrationsCatalog,
  integrationsConnections,
  integrationsConnectCallback,
  integrationsConnectStart,
  integrationsContract,
  integrationsCoverage,
  integrationsDetail,
  integrationsDisconnect,
  integrationsHealth,
  integrationsNativeBackfill,
  integrationsNativeCreate,
  integrationsNativeCrmOAuthAvailability,
  integrationsNativeCrmOAuthStartUrl,
  integrationsNativeDisconnect,
  integrationsNativeGet,
  integrationsNativeIngest,
  integrationsNativeList,
  integrationsNativePause,
  integrationsNativeProviders,
  integrationsNativeRuns,
  integrationsNativeSync,
  integrationsRecipe,
  integrationsRecipes,
  integrationsReadiness,
  integrationsStacks,
  integrationsSync,
  integrationsPause,
} from "./commands/integrations.js";
import { initCommand } from "./commands/init.js";
import {
  generateWebhookHandler,
  generateEmail,
  type WebhookFramework,
} from "./commands/generate.js";
import { devCommand } from "./commands/dev.js";
import { logsTailCommand } from "./commands/logs.js";
import { segmentsFromText, segmentsCreate } from "./commands/segments.js";
import { sendCommand, broadcastCommand } from "./commands/send.js";
import { warmupStatusCommand } from "./commands/warmup.js";
import {
  smsA2PBrandSubmit,
  smsA2PCampaignSubmit,
  smsA2PPoll,
  smsCampaignCancel,
  smsCampaignPause,
  smsCampaignReport,
  smsCampaignReportExport,
  smsCampaignResume,
  smsCampaignSchedule,
  smsCampaignSend,
  smsCampaignsCreate,
  smsCampaignsGet,
  smsCampaignsList,
  smsCompliance,
  smsConsentRecord,
  smsListsCreate,
  smsListsList,
  smsPilotReadiness,
  smsSenderPause,
  smsSenderPilotCertification,
  smsSenderResume,
  smsSenderUpsert,
  smsSendersList,
  smsSetup,
  smsSuppressionAdd,
  smsSuppressionRemove,
  smsSuppressionsList,
  smsTestSend,
} from "./commands/sms.js";
import {
  pushSuppressionAdd,
  pushSuppressionRemove,
  pushSuppressionsBulkImport,
  pushSuppressionsBulkRemove,
  pushSuppressionsList,
} from "./commands/push-suppressions.js";
import {
  developerMarketplaceAppCreate,
  developerMarketplaceAppGet,
  developerMarketplaceAppMonitoring,
  developerMarketplaceAppSubmitReview,
  developerMarketplaceAppUpdate,
  developerMarketplaceAppValidate,
  developerMarketplaceAppsList,
  developerMarketplaceAuditLogsList,
  developerMarketplaceCatalog,
  developerMarketplaceInstallApp,
  developerMarketplaceInstallationRevoke,
  developerMarketplaceInstallationsList,
  developerMarketplaceListingSubmitReview,
  developerMarketplaceListingUpsert,
  developerMarketplaceListingsList,
  developerMarketplaceOAuthAuthorize,
  developerMarketplaceOAuthClientCreate,
  developerMarketplaceOAuthClientRevoke,
  developerMarketplaceOAuthClientsList,
  developerMarketplaceOAuthRevoke,
  developerMarketplaceOAuthToken,
  developerMarketplacePartnerProfileSubmitReview,
  developerMarketplacePartnerProfileUpsert,
  developerMarketplacePartnerProfilesList,
  developerMarketplaceReviewAppDecision,
  developerMarketplaceReviewListingDecision,
  developerMarketplaceReviewPartnerProfileDecision,
  developerMarketplaceReviewQueue,
  developerMarketplaceTestAccountCreate,
  developerMarketplaceTestAccountsList,
  developerMarketplaceWebhookCreate,
  developerMarketplaceWebhooksList,
} from "./commands/developer-marketplace.js";
import {
  apiKeysCreate,
  apiKeysGet,
  apiKeysList,
  apiKeysRevoke,
  apiKeysRotate,
  inboundWebhooksCreate,
  inboundWebhooksDelete,
  inboundWebhooksEvents,
  inboundWebhooksGet,
  inboundWebhooksList,
  inboundWebhooksReplay,
  inboundWebhooksRotate,
  inboundWebhooksTriggerCreate,
  inboundWebhooksTriggers,
  inboundWebhooksUpdate,
  webhooksCreate,
  webhooksDelete,
  webhooksDeliveries,
  webhooksList,
  webhooksReplay,
  webhooksRotate,
  webhooksTest,
  webhooksUpdate,
} from "./commands/developer-tools.js";

const VERSION = "0.1.0";

const cli = cac("postwave");

cli.option("--api-key <key>", "API key (overrides stored credentials)");
cli.option("--base-url <url>", "API base URL");
cli.option("--tenant-id <id>", "Tenant ID");
cli.option("--output <fmt>", "Output format: json, table, yaml", {
  default: "table",
});
cli.option("--format <fmt>", "Alias for --output (json, table, yaml)");

cli
  .command("login", "Authenticate with Moosewave")
  .option("--no-browser", "Paste API key instead of browser flow")
  .option(
    "--device",
    "Sign in by scanning a QR on a device you're already signed in on",
  )
  .action((opts) => (opts.device ? deviceLogin(opts) : login(opts)));

cli.command("logout", "Clear stored credentials").action(() => logout());

cli
  .command("whoami", "Show the authenticated tenant and user")
  .action((opts) => whoami(opts));

cli
  .command("init", "Interactive setup wizard for a new tenant")
  .action((opts) => initCommand(opts));

cli
  .command(
    "migrate source-events start <source> <jobId>",
    "Start incremental source-event monitoring for a migration job",
  )
  .option("--interval-seconds <seconds>", "Polling interval in seconds", {
    default: "3600",
  })
  .action((source, jobId, opts) =>
    migrateSourceEventsStart(source, jobId, opts),
  );

cli
  .command(
    "migrate source-events status <jobId>",
    "Show source-event monitor state and recent events",
  )
  .action((jobId, opts) => migrateSourceEventsStatus(jobId, opts));

cli
  .command(
    "migrate source-events stop <jobId>",
    "Stop incremental source-event monitoring for a migration job",
  )
  .option(
    "--post-pilot-cleanup",
    "Use only after durable cleanup authorization; HubSpot also deletes its local encrypted source session",
  )
  .action((jobId, opts) => migrateSourceEventsStop(jobId, opts));

cli
  .command("migrate [source]", "Run a migration from a source platform")
  .option(
    "--source-api-key <key>",
    "Source credential for API-key migrations (Beehiiv, HubSpot, Klaviyo, or Customer.io)",
  )
  .option(
    "--source-account-id <id>",
    "Optional explicit Klaviyo account ID, numeric HubSpot Hub ID, or numeric Customer.io workspace ID; required when the credential exposes multiple choices",
  )
  .option(
    "--source-region <region>",
    "Customer.io App API region: us (default) or eu",
  )
  .option(
    "--publication-id <id>",
    "Explicit Beehiiv publication ID (pub_…); no publication is auto-selected",
  )
  .option("--dry-run", "Read-only verification, do not commit")
  .option("--commit", "Commit the migration")
  .option("--rollback <jobId>", "Rollback a completed migration")
  .option("--status <jobId>", "Get migration job status")
  .action((source, opts) => migrateCommand(source, opts));

cli
  .command("diagnose <campaignId>", "Run the AI diagnostician on a campaign")
  .action((campaignId, opts) => diagnoseCommand(campaignId, opts));

cli
  .command("sequences list", "List sequences")
  .action((opts) => sequencesList(opts));

cli
  .command("sequences generate", "Generate a new sequence from a template")
  .option("--template-id <id>", "Template slug")
  .option("--variables <json>", "JSON object of template variables")
  .action((opts) => sequencesGenerate(opts));

cli
  .command(
    "sequences regenerate <sequenceId> <position>",
    "Regenerate a single email in a sequence",
  )
  .option("--hint <text>", "Optional natural-language hint")
  .action((sequenceId, position, opts) =>
    sequencesRegenerate(sequenceId, Number(position), opts),
  );

cli
  .command("templates list", "List voice templates")
  .option("--category <name>", "Filter by category")
  .action((opts) => templatesList(opts));

cli
  .command("templates get <id>", "Get a template by id")
  .action((id, opts) => templatesGet(id, opts));

cli
  .command("subscribers list", "List subscribers")
  .action((opts) => subscribersList(opts));

cli
  .command("subscribers search", "Search subscribers")
  .option("--query <text>", "Search query")
  .action((opts) => subscribersSearch(opts));

cli
  .command("subscribers suppress", "Add an email to the suppression list")
  .option("--email <address>", "Email to suppress")
  .action((opts) => subscribersSuppress(opts));

cli
  .command("subscribers create", "Create a subscriber")
  .option("--email <address>", "Subscriber email (required)")
  .option("--status <status>", "enabled, disabled, blocklisted, or unconfirmed")
  .option("--tags <list>", "Comma-separated tags")
  .option("--custom-fields <json>", "JSON object of custom fields")
  .action((opts) => subscribersCreate(opts));

cli
  .command("subscribers update <id>", "Update a subscriber")
  .option("--email <address>", "New email")
  .option("--status <status>", "enabled, disabled, blocklisted, or unconfirmed")
  .option(
    "--tags <list>",
    'Comma-separated tags (replaces existing; pass "" to clear)',
  )
  .option("--custom-fields <json>", "JSON object of custom fields")
  .action((id, opts) => subscribersUpdate(id, opts));

cli
  .command("subscribers delete <id>", "Delete a subscriber")
  .option("--yes", "Confirm the deletion (required)")
  .action((id, opts) => subscribersDelete(id, opts));

cli
  .command("subscribers import", "Import subscribers from a CSV file")
  .option("--file <path>", "Path to the CSV file")
  .action((opts) => subscribersImport(opts));

cli
  .command("lists create", "Create a list")
  .option("--name <name>", "List name (required)")
  .option("--type <type>", "private or public")
  .option("--optin <optin>", "single or double")
  .option("--tags <list>", "Comma-separated tags")
  .option("--description <text>", "List description")
  .action((opts) => listsCreate(opts));

cli
  .command("lists delete <id>", "Delete a list")
  .option("--yes", "Confirm the deletion (required)")
  .action((id, opts) => listsDelete(id, opts));

cli
  .command("campaigns create", "Create a draft campaign")
  .option("--name <name>", "Campaign name (required)")
  .option("--subject <text>", "Subject line (required)")
  .option("--body-html <html>", "Inline HTML body")
  .option("--body-mjml <mjml>", "Inline MJML body")
  .option(
    "--file <path>",
    "Read HTML / MJML body from a file (extension detects)",
  )
  .option("--segment-id <id>", "Target segment id")
  .option("--scheduled-at <iso>", "ISO-8601 schedule time")
  .action((opts) => campaignsCreate(opts));

cli
  .command("campaigns update <id>", "Update a draft campaign")
  .option("--name <name>", "Campaign name")
  .option("--subject <text>", "Subject line")
  .option("--body-html <html>", "Inline HTML body")
  .option("--body-mjml <mjml>", "Inline MJML body")
  .option(
    "--file <path>",
    "Read HTML / MJML body from a file (extension detects)",
  )
  .option("--segment-id <id>", "Target segment id")
  .option(
    "--scheduled-at <iso>",
    'ISO-8601 schedule time (pass "" to unschedule)',
  )
  .action((id, opts) => campaignsUpdate(id, opts));

cli
  .command(
    "campaigns queue <id>",
    "Queue a campaign through the production lifecycle",
  )
  .option("--yes", "Confirm the dispatch (required for non-interactive use)")
  .option("--sandbox", "Simulate the dispatch server-side without firing")
  .action((id, opts) => campaignsQueue(id, opts));

cli
  .command("campaigns send <id>", "Send a campaign immediately")
  .option("--yes", "Confirm the dispatch (required for non-interactive use)")
  .option("--sandbox", "Simulate the dispatch server-side without firing")
  .action((id, opts) => campaignsSend(id, opts));

cli
  .command("campaigns delete <id>", "Delete a draft campaign")
  .option("--yes", "Confirm the deletion (required)")
  .action((id, opts) => campaignsDelete(id, opts));

cli
  .command("send", "Send a one-off transactional / test email")
  .option("--to <email>", "Recipient email")
  .option("--subject <text>", "Subject line")
  .option("--body-html <html>", "Inline HTML body")
  .option("--body-mjml <mjml>", "Inline MJML body")
  .option(
    "--file <path>",
    "Read HTML / MJML body from a file (extension detects)",
  )
  .option("--campaign-id <id>", "Use an existing campaign's content")
  .action((opts) => sendCommand(opts));

cli
  .command("broadcast", "Dispatch a draft campaign to its full audience")
  .option("--campaign-id <id>", "Campaign id")
  .option("--yes", "Confirm the dispatch (required for non-interactive use)")
  .option("--sandbox", "Simulate the dispatch server-side without firing")
  .action((opts) => broadcastCommand(opts));

cli
  .command("warmup status", "Show today's warmup cap + day in the curve")
  .action((opts) => warmupStatusCommand(opts));

cli.command("forms list", "List forms").action((opts) => formsList(opts));

cli
  .command("forms create", "Create a form from a JSON spec")
  .option("--spec <path>", "Path to a JSON file with the form spec")
  .action((opts) => formsCreate(opts));

cli
  .command("inbox report", "Get the Inbox Reality report for a campaign")
  .option("--campaign-id <id>", "Campaign id")
  .action((opts) => inboxReport(opts));

cli
  .command(
    "inbox predict",
    "Predict placement for a draft (HTML from --file or stdin)",
  )
  .option("--file <path>", "Path to an HTML file")
  .option("--subject <text>", "Subject line")
  .action((opts) => inboxPredict(opts));

cli
  .command("inbox reputation", "Get current reputation")
  .action((opts) => inboxReputation(opts));

cli
  .command("inbox auth", "Run SPF/DKIM/DMARC checks")
  .action((opts) => inboxAuth(opts));

cli
  .command(
    "assurance run",
    "Start durable Predicted Agent Comprehension for an exact frozen campaign plan",
  )
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (blueprint-compatible alias)")
  .option("--content-revision-id <id>", "Frozen content revision id")
  .option("--send-plan-id <id>", "Frozen send plan id")
  .option(
    "--profile <profile>",
    "Analyzer profile: fast, full, or calibration",
    {
      default: "full",
    },
  )
  .option("--request-id <uuid>", "Stable UUID for this logical run request")
  .option(
    "--seed",
    "Request controlled seed observation; fails closed when no adapter is configured",
  )
  .option(
    "--observed-surfaces <ids>",
    "Comma-separated controlled surface identifiers; requires --seed",
  )
  .option(
    "--idempotency-key <key>",
    "Stable key for retrying the exact unchanged request",
  )
  .action((opts) => assuranceRun(opts));

cli
  .command("assurance get", "Get the latest or one exact assurance receipt")
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (alias)")
  .option("--run-id <id>", "Exact run id; omit for the latest applicable run")
  .option("--run <id>", "Exact run id (alias)")
  .action((opts) => assuranceGet(opts));

cli
  .command(
    "assurance findings",
    "List immutable findings for one assurance run",
  )
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (alias)")
  .option("--run-id <id>", "Assurance run id")
  .option("--run <id>", "Assurance run id (alias)")
  .option("--limit <n>", "Page size, 1 to 200")
  .option("--offset <n>", "Page offset, 0 to 100000")
  .action((opts) => assuranceFindings(opts));

cli
  .command(
    "assurance override",
    "Record an owner/admin governed decision for one overridable finding",
  )
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (alias)")
  .option("--run-id <id>", "Assurance run id")
  .option("--run <id>", "Assurance run id (alias)")
  .option("--finding-id <id>", "Immutable finding id")
  .option("--finding <id>", "Immutable finding id (alias)")
  .option("--decision <decision>", "allow_send or reject", {
    default: "allow_send",
  })
  .option("--reason <text>", "Governed rationale, 10 to 2000 characters")
  .option("--expires-at <iso>", "Optional ISO-8601 expiry")
  .option("--request-id <uuid>", "Stable UUID for this governed decision")
  .option(
    "--idempotency-key <key>",
    "Stable key for retrying the exact unchanged request",
  )
  .action((opts) => assuranceOverride(opts));

cli
  .command(
    "assurance apply",
    "Apply one stored deterministic finding as a new immutable content revision",
  )
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (alias)")
  .option("--run-id <id>", "Assurance run id")
  .option("--run <id>", "Assurance run id (alias)")
  .option("--finding-id <id>", "Stored deterministic finding id")
  .option("--finding <id>", "Stored deterministic finding id (alias)")
  .option(
    "--if-match <etag>",
    "Exact strong ETag for the campaign draft version you reviewed",
  )
  .option("--request-id <uuid>", "Stable UUID for this application request")
  .option("--idempotency-key <key>", "Stable key for an exact retry")
  .option(
    "--yes",
    "Confirm creation of a new revision and staleness of the originating run",
  )
  .action((opts) => assuranceApply(opts));

cli
  .command("assurance cancel", "Cancel a queued or running assurance run")
  .option("--campaign-id <id>", "Campaign id")
  .option("--campaign <id>", "Campaign id (alias)")
  .option("--run-id <id>", "Assurance run id")
  .option("--run <id>", "Assurance run id (alias)")
  .option("--idempotency-key <key>", "Stable key for an exact retry")
  .option("--yes", "Confirm cancellation")
  .action((opts) => assuranceCancel(opts));

cli
  .command("automation trigger", "Trigger an automation for a subscriber")
  .option("--automation-id <id>", "Automation id")
  .option("--email <address>", "Subscriber email")
  .action((opts) => automationTrigger(opts));

cli
  .command("automation pause", "Pause an automation")
  .option("--automation-id <id>", "Automation id")
  .action((opts) => automationPause(opts));

cli
  .command("automation resume", "Resume an automation")
  .option("--automation-id <id>", "Automation id")
  .action((opts) => automationResume(opts));

cli
  .command("integrations catalog", "Search the public integrations catalog")
  .option("--query <text>", "Search by name, slug, or summary")
  .option("--category <key>", "Filter by integration category")
  .option(
    "--badge <badge>",
    "Filter by Native, Partner, Zapier, Webhook, API/SDK, Migration-only, or Planned badge",
  )
  .option("--capability <key>", "Filter by standardized connector capability")
  .action((opts) => integrationsCatalog(opts));

cli
  .command(
    "integrations connections",
    "List installed integration connection status",
  )
  .action((opts) => integrationsConnections(opts));

cli
  .command("integrations coverage", "Show category-level parity coverage")
  .action((opts) => integrationsCoverage(opts));

cli
  .command(
    "integrations stacks",
    "Show customer-stack coverage against parity goals",
  )
  .action((opts) => integrationsStacks(opts));

cli
  .command(
    "integrations readiness",
    "Audit whether integration parity claims are safe to ship",
  )
  .action((opts) => integrationsReadiness(opts));

cli
  .command(
    "integrations recipes",
    "Search bridge recipes for Zapier, webhooks, APIs, and partners",
  )
  .option("--query <text>", "Search by recipe name or summary")
  .option("--source <slug>", "Filter by source integration")
  .option("--target <slug>", "Filter by target integration")
  .option("--provider <name>", "Filter by recipe provider")
  .option("--badge <badge>", "Filter by badge")
  .option("--capability <key>", "Filter by capability")
  .option("--available", "Only include recipes available now")
  .action((opts) => integrationsRecipes(opts));

cli
  .command("integrations recipe <id>", "Get a bridge recipe with setup steps")
  .action((id, opts) => integrationsRecipe(id, opts));

cli
  .command(
    "integrations apply-recipe <id>",
    "Apply or delegate a bridge recipe",
  )
  .action((id, opts) => integrationsApplyRecipe(id, opts));

cli
  .command(
    "integrations detail <slug>",
    "Get an integration's setup, recipes, contract, and health",
  )
  .action((slug, opts) => integrationsDetail(slug, opts));

cli
  .command(
    "integrations contract <slug>",
    "Get the connector ownership and lifecycle contract",
  )
  .action((slug, opts) => integrationsContract(slug, opts));

cli
  .command(
    "integrations health <slug>",
    "Get health checks, sync history, retries, and audit trail",
  )
  .action((slug, opts) => integrationsHealth(slug, opts));

cli
  .command(
    "integrations connect-start <slug>",
    "Start OAuth or delegated setup for an integration",
  )
  .action((slug, opts) => integrationsConnectStart(slug, opts));

cli
  .command(
    "integrations connect-callback <slug>",
    "Complete an integration connection callback",
  )
  .action((slug, opts) => integrationsConnectCallback(slug, opts));

cli
  .command("integrations sync <slug>", "Queue a sync for an integration")
  .action((slug, opts) => integrationsSync(slug, opts));

cli
  .command(
    "integrations backfill <slug>",
    "Queue a backfill for an integration",
  )
  .action((slug, opts) => integrationsBackfill(slug, opts));

cli
  .command("integrations pause <slug>", "Pause an integration")
  .action((slug, opts) => integrationsPause(slug, opts));

cli
  .command("integrations disconnect <slug>", "Disconnect an integration")
  .action((slug, opts) => integrationsDisconnect(slug, opts));

cli
  .command(
    "integrations native providers <family>",
    "List provider metadata (support is static catalog only)",
  )
  .action((family, opts) => integrationsNativeProviders(family, opts));

cli
  .command(
    "integrations native list <family>",
    "List stored native connection projections (support is minimized/read-only)",
  )
  .option("--limit <n>", "Support rows to return (1-100; server default 50)")
  .option("--cursor <cursor>", "Opaque support-list next-page cursor")
  .action((family, opts) => integrationsNativeList(family, opts));

cli
  .command(
    "integrations native create <family>",
    "Create a native managed connection (support: support_integration_runtime_held)",
  )
  .option("--provider <key>", "Provider key, e.g. hubspot or typeform")
  .option("--name <name>", "Friendly connection name")
  .option("--shop-domain <domain>", "Commerce shop domain or store identifier")
  .option("--config <json>", "Provider config JSON object")
  .option(
    "--credentials <json>",
    "Raw credential JSON is rejected for managed native families; store secrets first and pass --credential-ref",
  )
  .option(
    "--credential-ref <ref>",
    "Vault credential reference for managed native connectors",
  )
  .option(
    "--scopes <csv>",
    "Comma-separated requested scopes; ignored by canonical ingest foundations until verified adapters attach provider scopes",
  )
  .option(
    "--objects <csv>",
    "Warehouse object selection, e.g. profiles,events,catalog",
  )
  .option(
    "--direction <direction>",
    "Warehouse sync direction: export, import, or bidirectional",
  )
  .option(
    "--cadence <cadence>",
    "Warehouse cadence: manual, hourly, daily, or weekly",
  )
  .option("--backfill-days <days>", "Warehouse backfill window in days")
  .option("--metadata <json>", "Metadata JSON object")
  .action((family, opts) => integrationsNativeCreate(family, opts));

cli
  .command(
    "integrations native get <family> <id>",
    "Get a stored native connection projection (support is minimized/read-only)",
  )
  .action((family, id, opts) => integrationsNativeGet(family, id, opts));

cli
  .command(
    "integrations native sync <family> <id>",
    "Run a native managed sync/import (support: support_integration_runtime_held)",
  )
  .option("--objects <csv>", "Warehouse object selection only")
  .option(
    "--payload <json>",
    "Optional canonical rows; omit when the configured provider exposes a native puller",
  )
  .option("--since <iso>", "Optional lower-bound timestamp")
  .option(
    "--cursor <cursor>",
    "Optional provider cursor (warehouse runs reject client-supplied cursors)",
  )
  .option("--full", "Request a full sync")
  .option("--reason <text>", "Operator reason")
  .option("--metadata <json>", "Metadata JSON object")
  .action((family, id, opts) => integrationsNativeSync(family, id, opts));

cli
  .command(
    "integrations native backfill <family> <id>",
    "Run a native managed backfill/import (support: support_integration_runtime_held)",
  )
  .option("--objects <csv>", "Warehouse object selection only")
  .option(
    "--payload <json>",
    "Optional canonical rows; omit when the configured provider exposes a native puller",
  )
  .option("--since <iso>", "Optional lower-bound timestamp")
  .option(
    "--cursor <cursor>",
    "Optional provider cursor (warehouse runs reject client-supplied cursors)",
  )
  .option("--full", "Request a full backfill")
  .option("--reason <text>", "Operator reason")
  .option("--metadata <json>", "Metadata JSON object")
  .action((family, id, opts) => integrationsNativeBackfill(family, id, opts));

cli
  .command(
    "integrations native ingest <family> <id>",
    "Ingest a canonical native payload (support: support_integration_runtime_held)",
  )
  .option(
    "--payload <json>",
    "Canonical row JSON object for the selected native family",
  )
  .action((family, id, opts) => integrationsNativeIngest(family, id, opts));

cli
  .command(
    "integrations native pause <family> <id>",
    "Pause a native connection (support: support_integration_runtime_held)",
  )
  .action((family, id, opts) => integrationsNativePause(family, id, opts));

cli
  .command(
    "integrations native disconnect <family> <id>",
    "Disconnect a native connection (support: support_integration_runtime_held)",
  )
  .action((family, id, opts) => integrationsNativeDisconnect(family, id, opts));

cli
  .command(
    "integrations native runs <family> <id>",
    "List native sync/backfill runs (support: support_integration_runtime_held)",
  )
  .option("--limit <n>", "Maximum run rows to return", { default: 25 })
  .action((family, id, opts) => integrationsNativeRuns(family, id, opts));

cli
  .command(
    "integrations native crm-oauth availability <provider>",
    "Show managed CRM OAuth availability for a provider",
  )
  .action((provider, opts) =>
    integrationsNativeCrmOAuthAvailability(provider, opts),
  );

cli
  .command(
    "integrations native crm-oauth start-url <provider>",
    "Print the managed CRM OAuth start URL for browser navigation",
  )
  .option("--name <name>", "Friendly connection name")
  .option("--redirect-to <url>", "Post-OAuth redirect target")
  .option(
    "--config <json>",
    "Scalar provider settings to forward as OAuth-start query params",
  )
  .action((provider, opts) =>
    integrationsNativeCrmOAuthStartUrl(provider, opts),
  );

cli
  .command(
    "integrations audiences providers",
    "List readiness-gated ad audience destination providers",
  )
  .action((opts) => integrationsAudienceProviders(opts));

cli
  .command(
    "integrations audiences list",
    "List adapter-backed ad audience destinations",
  )
  .option(
    "--provider <key>",
    "Filter by provider: meta, google_ads, tiktok, linkedin, or snap",
  )
  .action((opts) => integrationsAudienceList(opts));

cli
  .command(
    "integrations audiences create",
    "Create an adapter-backed ad audience destination",
  )
  .option(
    "--provider <key>",
    "Provider key: meta, google_ads, tiktok, linkedin, or snap",
  )
  .option("--list-id <id>", "Source list id")
  .option("--segment-id <id>", "Source segment id")
  .option("--external-audience-id <id>", "Platform audience id")
  .option("--config <json>", "Provider config JSON object")
  .action((opts) => integrationsAudienceCreate(opts));

cli
  .command(
    "integrations audiences get <id>",
    "Get an adapter-backed ad audience destination",
  )
  .action((id, opts) => integrationsAudienceGet(id, opts));

cli
  .command(
    "integrations audiences update <id>",
    "Update an adapter-backed ad audience destination",
  )
  .option(
    "--status <status>",
    "Destination status: draft, active, paused, syncing, or error",
  )
  .option("--external-audience-id <id>", "Platform audience id")
  .option("--config <json>", "Provider config JSON object")
  .action((id, opts) => integrationsAudienceUpdate(id, opts));

cli
  .command(
    "integrations audiences readiness <provider>",
    "Check provider config and driver readiness",
  )
  .option("--config <json>", "Provider config JSON object")
  .action((provider, opts) => integrationsAudienceReadiness(provider, opts));

cli
  .command(
    "integrations audiences preview <id>",
    "Preview consent exclusions before ad audience sync",
  )
  .action((id, opts) => integrationsAudiencePreview(id, opts));

cli
  .command(
    "integrations audiences sync <id>",
    "Attempt a readiness-gated ad audience sync",
  )
  .action((id, opts) => integrationsAudienceSync(id, opts));

cli
  .command("integrations audiences jobs <id>", "List ad audience sync jobs")
  .action((id, opts) => integrationsAudienceJobs(id, opts));

cli
  .command(
    "integrations audiences diagnostics <id> <job-id>",
    "Retrieve provider diagnostics for an ad audience sync job",
  )
  .action((id, jobId, opts) =>
    integrationsAudienceJobDiagnostics(id, jobId, opts),
  );

cli
  .command(
    "integrations audience-syncs runs <id>",
    "List audience-sync run history with provider telemetry",
  )
  .action((id, opts) => integrationsAudienceSyncRuns(id, opts));

cli
  .command(
    "integrations audiences disconnect <id>",
    "Delete an adapter-backed ad audience destination",
  )
  .action((id, opts) => integrationsAudienceDisconnect(id, opts));

cli
  .command(
    "integrations chat list <provider>",
    "List Slack, Discord, or Teams notification integrations",
  )
  .action((provider, opts) => integrationsChatList(provider, opts));

cli
  .command(
    "integrations chat create <provider>",
    "Create a Slack, Discord, or Teams notification integration",
  )
  .option("--url <url>", "Incoming webhook URL")
  .option("--events <csv>", "Comma-separated Moosewave event types")
  .option("--channel-hint <name>", "Operator-visible channel label")
  .action((provider, opts) => integrationsChatCreate(provider, opts));

cli
  .command(
    "integrations chat update <provider> <id>",
    "Update a Slack, Discord, or Teams notification integration",
  )
  .option("--url <url>", "Rotate incoming webhook URL")
  .option("--events <csv>", "Comma-separated Moosewave event types")
  .option("--channel-hint <name>", "Operator-visible channel label")
  .option("--enabled <bool>", "Enable or disable the integration")
  .action((provider, id, opts) => integrationsChatUpdate(provider, id, opts));

cli
  .command(
    "integrations chat delete <provider> <id>",
    "Delete a Slack, Discord, or Teams notification integration",
  )
  .option("--yes", "Confirm the deletion (required)")
  .action((provider, id, opts) => integrationsChatDelete(provider, id, opts));

cli
  .command("sms setup", "Read SMS sender setup status")
  .action((opts) => smsSetup(opts));

cli
  .command(
    "sms compliance",
    "Audit SMS consent, registration, and send readiness",
  )
  .action((opts) => smsCompliance(opts));

cli
  .command(
    "sms pilot-readiness",
    "Check whether SMS pilot traffic is safe to enable",
  )
  .action((opts) => smsPilotReadiness(opts));

cli
  .command("sms senders list", "List SMS sender profiles")
  .action((opts) => smsSendersList(opts));

cli
  .command("sms senders upsert", "Create or update an SMS sender profile")
  .option("--payload <json>", "Full sender JSON object")
  .option("--provider <key>", "Provider: twilio, telnyx, or bandwidth")
  .option("--country <code>", "Country: US or CA")
  .option(
    "--sender-type <type>",
    "Sender type: 10dlc, toll_free, or short_code",
  )
  .option("--phone-number <e164>", "Dedicated phone number")
  .option("--messaging-service-sid <sid>", "Provider messaging service id")
  .option(
    "--brand-registration-sid <sid>",
    "Unavailable: caller-supplied A2P evidence is rejected",
  )
  .option(
    "--campaign-registration-sid <sid>",
    "Unavailable: caller-supplied A2P evidence is rejected",
  )
  .option(
    "--registration-status <status>",
    "Draft state only: not_started or draft; certified states are unavailable",
  )
  .option("--capabilities <json>", "Sender capabilities JSON object")
  .option("--metadata <json>", "Metadata JSON object")
  .action((opts) => smsSenderUpsert(opts));

cli
  .command("sms senders pause <senderId>", "Pause an SMS sender profile")
  .option("--reason <text>", "Operator-visible pause reason")
  .action((senderId, opts) => smsSenderPause(senderId, opts));

cli
  .command("sms senders resume <senderId>", "Resume an SMS sender profile")
  .action((senderId, opts) => smsSenderResume(senderId, opts));

cli
  .command(
    "sms senders pilot-certification <senderId>",
    "Export pilot-certification evidence for a sender",
  )
  .action((senderId, opts) => smsSenderPilotCertification(senderId, opts));

cli
  .command(
    "sms a2p brand-submit <senderId>",
    "Release-held: A2P registration submission is unavailable",
  )
  .option(
    "--payload <json>",
    "Provider-specific brand registration JSON object",
  )
  .action((senderId, opts) => smsA2PBrandSubmit(senderId, opts));

cli
  .command(
    "sms a2p campaign-submit <senderId>",
    "Release-held: A2P registration submission is unavailable",
  )
  .option(
    "--payload <json>",
    "Provider-specific campaign registration JSON object",
  )
  .action((senderId, opts) => smsA2PCampaignSubmit(senderId, opts));

cli
  .command(
    "sms a2p poll <senderId>",
    "Release-held: A2P registration polling is unavailable",
  )
  .action((senderId, opts) => smsA2PPoll(senderId, opts));

cli
  .command("sms lists list", "List SMS audience lists")
  .action((opts) => smsListsList(opts));

cli
  .command("sms lists create", "Create an SMS audience list")
  .option("--payload <json>", "Full list JSON object")
  .option("--name <name>", "List name")
  .option("--description <text>", "List description")
  .option("--keyword <word>", "List keyword label; does not grant consent")
  .option("--sender-profile-id <id>", "Default sender profile id")
  .action((opts) => smsListsCreate(opts));

cli
  .command("sms consent record", "Record an operator SMS opt-out")
  .option("--payload <json>", "Operator revocation JSON object")
  .option("--list-id <id>", "SMS list id")
  .option("--phone <e164>", "Canonical US/Canada phone number")
  .option("--action <action>", "Required action: revoked")
  .option("--source <source>", "Required source: manual")
  .option("--proof-text <text>", "Required operator revocation reason")
  .action((opts) => smsConsentRecord(opts));

cli
  .command(
    "sms suppressions list",
    "Exact-admin: read one bounded suppression page",
  )
  .option("--reason <reason>", "Exact frozen reason filter")
  .option(
    "--phone <e164>",
    "Exact phone; sent only in the body-query endpoint, never the URL",
  )
  .option("--cursor <cursor>", "Opaque continuation from the prior page")
  .option("--limit <n>", "Page size from 1 to 200")
  .option("--tenant-uuid <uuid>", "Exact response tenant UUID binding")
  .action((opts) => smsSuppressionsList(opts));

cli
  .command(
    "sms suppressions add",
    "Exact-admin: add or reassert a reversible manual workspace hold",
  )
  .option("--phone <e164>", "Required exact US/Canada E.164 number")
  .action((opts) => smsSuppressionAdd(opts));

cli
  .command(
    "sms suppressions remove <id>",
    "Exact-admin: remove one reversible manual hold; never restores consent",
  )
  .option("--yes", "Confirm manual-hold removal (required)")
  .option(
    "--tenant-uuid <uuid>",
    "Required exact tenant binding for the deletion receipt",
  )
  .action((id, opts) => smsSuppressionRemove(id, opts));

cli
  .command(
    "push suppressions list",
    "Exact-admin: read one private authority snapshot page",
  )
  .option("--tenant-uuid <uuid>", "Required exact response tenant binding")
  .option("--platform <platform>", "Exact platform: apns, fcm, or web")
  .option("--reason <reason>", "Exact finite authority reason")
  .option("--hash-prefix <hex>", "8–16 lowercase-hex fingerprint prefix")
  .option("--cursor <cursor>", "Opaque continuation from the prior page")
  .option("--limit <n>", "Page size from 1 to 100")
  .action((opts) => pushSuppressionsList(opts));

cli
  .command(
    "push suppressions add",
    "Exact-admin: add or reassert one reversible manual authority",
  )
  .option("--tenant-uuid <uuid>", "Required exact response tenant binding")
  .option("--platform <platform>", "Required platform: apns, fcm, or web")
  .option(
    "--token-file <path>",
    "Required exact token file; raw tokens are never accepted in argv",
  )
  .action((opts) => pushSuppressionAdd(opts));

cli
  .command(
    "push suppressions remove <id>",
    "Exact-admin: CAS-remove one reviewed manual authority",
  )
  .option("--tenant-uuid <uuid>", "Required exact response tenant binding")
  .option("--expected-version <n>", "Required version reviewed from the row")
  .option("--yes", "Confirm manual-authority removal (required)")
  .action((id, opts) => pushSuppressionRemove(id, opts));

cli
  .command(
    "push suppressions bulk-import",
    "Exact-admin: atomically add 1–100 manual authorities",
  )
  .option("--tenant-uuid <uuid>", "Required exact response tenant binding")
  .option(
    "--payload-file <path>",
    "Strict JSON array or {items}; keeps raw tokens out of argv",
  )
  .action((opts) => pushSuppressionsBulkImport(opts));

cli
  .command(
    "push suppressions bulk-remove",
    "Exact-admin: atomically CAS-remove 1–100 reviewed manual authorities",
  )
  .option("--tenant-uuid <uuid>", "Required exact response tenant binding")
  .option("--payload-file <path>", "Strict JSON array or {items}")
  .option("--yes", "Confirm atomic manual-authority removal (required)")
  .action((opts) => pushSuppressionsBulkRemove(opts));

cli
  .command("sms campaigns list", "List SMS campaigns")
  .action((opts) => smsCampaignsList(opts));

cli
  .command("sms campaigns get <campaignId>", "Get one SMS campaign")
  .action((campaignId, opts) => smsCampaignsGet(campaignId, opts));

cli
  .command("sms campaigns create", "Create an SMS campaign")
  .option("--payload <json>", "Full campaign JSON object")
  .option("--sender-profile-id <id>", "Sender profile id")
  .option("--list-id <id>", "SMS list id")
  .option("--name <name>", "Campaign name")
  .option("--body <text>", "Message body")
  .option("--media-url <url>", "Optional MMS media URL")
  .option("--status <status>", "Initial status: draft or paused")
  .option(
    "--scheduled-at <iso>",
    "Unavailable: SMS campaign scheduling is release-held",
  )
  .option("--metadata <json>", "Metadata JSON object")
  .action((opts) => smsCampaignsCreate(opts));

cli
  .command(
    "sms campaigns report <campaignId>",
    "Release-held: SMS campaign evidence is unavailable",
  )
  .action((campaignId, opts) => smsCampaignReport(campaignId, opts));

cli
  .command(
    "sms campaigns export-report <campaignId>",
    "Release-held: SMS recipient export is unavailable",
  )
  .option(
    "--export-status <status>",
    "Filter: all, blocked, failed, problems, or undelivered",
  )
  .option("--limit <n>", "Maximum CSV rows")
  .action((campaignId, opts) => smsCampaignReportExport(campaignId, opts));

cli
  .command(
    "sms campaigns send <campaignId>",
    "Release-held: SMS campaign dispatch is unavailable",
  )
  .option("--payload <json>", "Broadcast options JSON object")
  .option("--limit <n>", "Maximum recipients")
  .option("--link-tracking <bool>", "Enable or disable link tracking")
  .action((campaignId, opts) => smsCampaignSend(campaignId, opts));

cli
  .command(
    "sms campaigns schedule <campaignId>",
    "Release-held: SMS campaign scheduling is unavailable",
  )
  .option("--scheduled-at <iso>", "Scheduled timestamp")
  .action((campaignId, opts) => smsCampaignSchedule(campaignId, opts));

cli
  .command("sms campaigns pause <campaignId>", "Pause an SMS campaign")
  .action((campaignId, opts) => smsCampaignPause(campaignId, opts));

cli
  .command(
    "sms campaigns resume <campaignId>",
    "Release-held: SMS campaign resume is unavailable",
  )
  .action((campaignId, opts) => smsCampaignResume(campaignId, opts));

cli
  .command("sms campaigns cancel <campaignId>", "Cancel an SMS campaign")
  .action((campaignId, opts) => smsCampaignCancel(campaignId, opts));

cli
  .command("sms test-send", "Release-held: SMS test dispatch is unavailable")
  .option("--payload <json>", "Full test-send JSON object")
  .option("--sender-profile-id <id>", "Sender profile id")
  .option("--list-id <id>", "SMS list id")
  .option("--phone <e164>", "Recipient phone in E.164 format")
  .option("--body <text>", "Message body")
  .option("--media-url <url>", "Optional MMS media URL")
  .option("--metadata <json>", "Metadata JSON object")
  .action((opts) => smsTestSend(opts));

cli
  .command(
    "developer-marketplace catalog",
    "Read developer marketplace runtime catalogs",
  )
  .action((opts) => developerMarketplaceCatalog(opts));

cli
  .command("developer-marketplace apps list", "List marketplace apps")
  .option("--status <status>", "Filter by app status")
  .action((opts) => developerMarketplaceAppsList(opts));

cli
  .command(
    "developer-marketplace apps validate",
    "Validate a marketplace app draft JSON payload",
  )
  .option("--payload <json>", "Marketplace app JSON object")
  .action((opts) => developerMarketplaceAppValidate(opts));

cli
  .command("developer-marketplace apps create", "Create a marketplace app")
  .option("--payload <json>", "Marketplace app JSON object")
  .action((opts) => developerMarketplaceAppCreate(opts));

cli
  .command("developer-marketplace apps get <appId>", "Get a marketplace app")
  .action((appId, opts) => developerMarketplaceAppGet(appId, opts));

cli
  .command(
    "developer-marketplace apps update <appId>",
    "Update a marketplace app",
  )
  .option("--payload <json>", "Marketplace app JSON object")
  .action((appId, opts) => developerMarketplaceAppUpdate(appId, opts));

cli
  .command(
    "developer-marketplace apps submit-review <appId>",
    "Submit a marketplace app for review",
  )
  .action((appId, opts) => developerMarketplaceAppSubmitReview(appId, opts));

cli
  .command(
    "developer-marketplace apps monitoring <appId>",
    "Read marketplace app monitoring and readiness",
  )
  .action((appId, opts) => developerMarketplaceAppMonitoring(appId, opts));

cli
  .command(
    "developer-marketplace oauth-clients list <appId>",
    "List OAuth clients for an app",
  )
  .action((appId, opts) => developerMarketplaceOAuthClientsList(appId, opts));

cli
  .command(
    "developer-marketplace oauth-clients create <appId>",
    "Create an OAuth client for an app",
  )
  .option("--payload <json>", "OAuth client JSON object")
  .action((appId, opts) => developerMarketplaceOAuthClientCreate(appId, opts));

cli
  .command(
    "developer-marketplace oauth-clients revoke <appId> <clientId>",
    "Revoke an app OAuth client",
  )
  .action((appId, clientId, opts) =>
    developerMarketplaceOAuthClientRevoke(appId, clientId, opts),
  );

cli
  .command(
    "developer-marketplace test-accounts list <appId>",
    "List marketplace app test accounts",
  )
  .action((appId, opts) => developerMarketplaceTestAccountsList(appId, opts));

cli
  .command(
    "developer-marketplace test-accounts create <appId>",
    "Create a marketplace app test account",
  )
  .option("--payload <json>", "Test account JSON object")
  .action((appId, opts) => developerMarketplaceTestAccountCreate(appId, opts));

cli
  .command("developer-marketplace listings list", "List marketplace listings")
  .option("--category <category>", "Filter by listing category")
  .action((opts) => developerMarketplaceListingsList(opts));

cli
  .command(
    "developer-marketplace listings upsert <appId>",
    "Create or update a marketplace listing",
  )
  .option("--payload <json>", "Listing JSON object")
  .action((appId, opts) => developerMarketplaceListingUpsert(appId, opts));

cli
  .command(
    "developer-marketplace listings submit-review <appId>",
    "Submit a marketplace listing for review",
  )
  .action((appId, opts) =>
    developerMarketplaceListingSubmitReview(appId, opts),
  );

cli
  .command(
    "developer-marketplace installations list",
    "List marketplace app installations",
  )
  .option("--status <status>", "Filter by installation status")
  .action((opts) => developerMarketplaceInstallationsList(opts));

cli
  .command(
    "developer-marketplace installations install <appId>",
    "Create a marketplace app installation",
  )
  .option("--payload <json>", "Installation JSON object")
  .action((appId, opts) => developerMarketplaceInstallApp(appId, opts));

cli
  .command(
    "developer-marketplace installations revoke <installationId>",
    "Revoke a marketplace app installation",
  )
  .action((installationId, opts) =>
    developerMarketplaceInstallationRevoke(installationId, opts),
  );

cli
  .command(
    "developer-marketplace webhooks list <appId>",
    "List app webhook subscriptions",
  )
  .action((appId, opts) => developerMarketplaceWebhooksList(appId, opts));

cli
  .command(
    "developer-marketplace webhooks create <appId>",
    "Create an app webhook subscription",
  )
  .option("--payload <json>", "App webhook subscription JSON object")
  .action((appId, opts) => developerMarketplaceWebhookCreate(appId, opts));

cli
  .command(
    "developer-marketplace partner-profiles list",
    "List marketplace partner profiles",
  )
  .option("--profile-type <type>", "Filter by profile type")
  .action((opts) => developerMarketplacePartnerProfilesList(opts));

cli
  .command(
    "developer-marketplace partner-profiles upsert",
    "Create or update the current tenant's partner profile",
  )
  .option("--payload <json>", "Partner profile JSON object")
  .action((opts) => developerMarketplacePartnerProfileUpsert(opts));

cli
  .command(
    "developer-marketplace partner-profiles submit-review",
    "Submit the current tenant's partner profile for review",
  )
  .action((opts) => developerMarketplacePartnerProfileSubmitReview(opts));

cli
  .command(
    "developer-marketplace review queue",
    "List marketplace review queue items",
  )
  .option("--review-secret <secret>", "Marketplace review operator secret")
  .option("--kind <kind>", "Filter: all, app, listing, or partner_profile")
  .option("--state <state>", "Filter: pending, resolved, or all")
  .option("--limit <n>", "Maximum review rows")
  .action((opts) => developerMarketplaceReviewQueue(opts));

cli
  .command(
    "developer-marketplace review app-decision <appId>",
    "Approve or reject a marketplace app",
  )
  .option("--review-secret <secret>", "Marketplace review operator secret")
  .option("--payload <json>", "Review decision JSON object")
  .option("--tenant-id <id>", "App owner tenant id")
  .option("--decision <decision>", "Decision: approve or reject")
  .option("--notes <text>", "Review notes")
  .option("--partner-level <level>", "Partner level to apply")
  .action((appId, opts) => developerMarketplaceReviewAppDecision(appId, opts));

cli
  .command(
    "developer-marketplace review listing-decision <appId>",
    "Approve or reject a marketplace listing",
  )
  .option("--review-secret <secret>", "Marketplace review operator secret")
  .option("--payload <json>", "Review decision JSON object")
  .option("--tenant-id <id>", "App owner tenant id")
  .option("--decision <decision>", "Decision: approve or reject")
  .option("--notes <text>", "Review notes")
  .option("--partner-level <level>", "Partner level to apply")
  .action((appId, opts) =>
    developerMarketplaceReviewListingDecision(appId, opts),
  );

cli
  .command(
    "developer-marketplace review partner-profile-decision <tenantId>",
    "Approve or reject a partner profile",
  )
  .option("--review-secret <secret>", "Marketplace review operator secret")
  .option("--payload <json>", "Review decision JSON object")
  .option("--decision <decision>", "Decision: approve or reject")
  .option("--notes <text>", "Review notes")
  .option("--partner-level <level>", "Partner level to apply")
  .action((tenantId, opts) =>
    developerMarketplaceReviewPartnerProfileDecision(tenantId, opts),
  );

cli
  .command(
    "developer-marketplace oauth authorize",
    "Run marketplace OAuth authorization",
  )
  .option("--payload <json>", "OAuth authorize request JSON object")
  .action((opts) => developerMarketplaceOAuthAuthorize(opts));

cli
  .command(
    "developer-marketplace oauth token",
    "Exchange a marketplace OAuth code for an access token",
  )
  .option("--payload <json>", "OAuth token request JSON object")
  .action((opts) => developerMarketplaceOAuthToken(opts));

cli
  .command(
    "developer-marketplace oauth revoke",
    "Revoke a marketplace OAuth access token",
  )
  .option("--payload <json>", "OAuth revoke request JSON object")
  .action((opts) => developerMarketplaceOAuthRevoke(opts));

cli
  .command(
    "developer-marketplace audit-logs list [appId]",
    "List developer marketplace audit logs",
  )
  .action((appId, opts) => developerMarketplaceAuditLogsList(appId, opts));

cli
  .command("api-keys list", "List API keys without plaintext")
  .action((opts) => apiKeysList(opts));

cli
  .command("api-keys get <keyId>", "Get API key metadata without plaintext")
  .action((keyId, opts) => apiKeysGet(keyId, opts));

cli
  .command("api-keys create", "Create an API key; plaintext is returned once")
  .option("--payload <json>", "Full API-key create JSON object")
  .option("--label <label>", "API key label")
  .option("--scopes <csv>", "Comma-separated scopes")
  .option("--sandbox-only <bool>", "Restrict key to sandbox-only routes")
  .action((opts) => apiKeysCreate(opts));

cli
  .command(
    "api-keys rotate <keyId>",
    "Rotate an API key; new plaintext is returned once",
  )
  .action((keyId, opts) => apiKeysRotate(keyId, opts));

cli
  .command("api-keys revoke <keyId>", "Revoke an API key")
  .action((keyId, opts) => apiKeysRevoke(keyId, opts));

cli
  .command("webhooks list", "List canonical outbound webhook destinations")
  .option("--limit <n>", "Page size (1-500)")
  .option("--cursor <cursor>", "Pagination cursor")
  .action((opts) => webhooksList(opts));

cli
  .command("webhooks create", "Create an outbound webhook subscription")
  .option("--payload <json>", "Full webhook subscription JSON object")
  .option("--url <url>", "Webhook endpoint URL")
  .option("--events <csv>", "Comma-separated event types")
  .action((opts) => webhooksCreate(opts));

cli
  .command(
    "webhooks update <webhookId>",
    "Update an outbound webhook subscription",
  )
  .option("--payload <json>", "Webhook subscription patch JSON object")
  .option("--url <url>", "Webhook endpoint URL")
  .option("--events <csv>", "Comma-separated event types")
  .action((webhookId, opts) => webhooksUpdate(webhookId, opts));

cli
  .command(
    "webhooks delete <webhookId>",
    "Delete an outbound webhook subscription",
  )
  .option("--yes", "Confirm the deletion (required)")
  .action((webhookId, opts) => webhooksDelete(webhookId, opts));

cli
  .command("webhooks test <webhookId>", "Fire the canonical webhook.test probe")
  .action((webhookId, opts) => webhooksTest(webhookId, opts));

cli
  .command(
    "webhooks deliveries <webhookId>",
    "List outbound webhook delivery attempts",
  )
  .option("--cursor <cursor>", "Delivery pagination cursor")
  .option("--limit <n>", "Page size (1-500)")
  .action((webhookId, opts) => webhooksDeliveries(webhookId, opts));

cli
  .command(
    "webhooks replay <deliveryId>",
    "Create a pending child delivery while preserving the original",
  )
  .option("--idempotency-key <key>", "Stable logical replay key (required)")
  .action((deliveryId, opts) => webhooksReplay(deliveryId, opts));

cli
  .command(
    "webhooks rotate <webhookId>",
    "Rotate signing material and return the replacement once",
  )
  .option("--grace-minutes <n>", "Prior-key grace window (1-10080)", {
    default: 1440,
  })
  .action((webhookId, opts) => webhooksRotate(webhookId, opts));

cli
  .command("inbound-webhooks list", "List inbound webhook endpoints")
  .option("--limit <n>", "Page size (1-500)")
  .option("--cursor <cursor>", "Pagination cursor")
  .action((opts) => inboundWebhooksList(opts));

cli
  .command(
    "inbound-webhooks create",
    "Create an inbound webhook endpoint; secret is returned once",
  )
  .option("--name <name>", "Endpoint name")
  .option("--transform-jq <jq>", "Optional constrained JQ transform")
  .action((opts) => inboundWebhooksCreate(opts));

cli
  .command(
    "inbound-webhooks get <endpointId>",
    "Get value-free endpoint metadata",
  )
  .action((endpointId, opts) => inboundWebhooksGet(endpointId, opts));

cli
  .command(
    "inbound-webhooks update <endpointId>",
    "Update endpoint metadata or transform",
  )
  .option("--name <name>", "Endpoint name")
  .option("--enabled <bool>", "Enable or disable ingestion")
  .option("--transform-jq <jq>", "Constrained JQ transform")
  .option("--payload <json>", "Full endpoint patch JSON")
  .action((endpointId, opts) => inboundWebhooksUpdate(endpointId, opts));

cli
  .command(
    "inbound-webhooks rotate <endpointId>",
    "Rotate the sender signing secret; replacement is returned once",
  )
  .action((endpointId, opts) => inboundWebhooksRotate(endpointId, opts));

cli
  .command(
    "inbound-webhooks events <endpointId>",
    "List retained authenticated events",
  )
  .option("--limit <n>", "Page size (1-500)")
  .option("--cursor <cursor>", "Pagination cursor")
  .action((endpointId, opts) => inboundWebhooksEvents(endpointId, opts));

cli
  .command(
    "inbound-webhooks replay <endpointId> <eventId>",
    "Queue a durable replay of retained trigger actions",
  )
  .option("--idempotency-key <key>", "Stable logical replay key (required)")
  .action((endpointId, eventId, opts) =>
    inboundWebhooksReplay(endpointId, eventId, opts),
  );

cli
  .command(
    "inbound-webhooks triggers <endpointId>",
    "List configured trigger actions",
  )
  .action((endpointId, opts) => inboundWebhooksTriggers(endpointId, opts));

cli
  .command(
    "inbound-webhooks trigger-create <endpointId>",
    "Create a trigger from the complete JSON contract",
  )
  .option("--payload <json>", "Complete trigger JSON object (required)")
  .action((endpointId, opts) => inboundWebhooksTriggerCreate(endpointId, opts));

cli
  .command(
    "inbound-webhooks delete <endpointId>",
    "Delete an inbound webhook endpoint",
  )
  .option("--yes", "Confirm the deletion (required)")
  .action((endpointId, opts) => inboundWebhooksDelete(endpointId, opts));

cli
  .command(
    "generate webhook-handler",
    "Scaffold a webhook handler that verifies the Moosewave HMAC signature",
  )
  .option(
    "--framework <name>",
    "Target framework: express, hono, or next-route",
  )
  .option("--out <path>", "Write to file instead of stdout")
  .option("--force", "Overwrite --out if it already exists")
  .action(
    (opts: { framework?: WebhookFramework; out?: string; force?: boolean }) =>
      generateWebhookHandler(opts),
  );

cli
  .command(
    "generate email",
    "Scaffold a starter email component using @postwave/email-react",
  )
  .option("--name <Name>", "PascalCase component name (e.g. Welcome)")
  .option(
    "--out <path>",
    "Write to a specific path. Defaults to <Name>.tsx in cwd",
  )
  .option("--force", "Overwrite --out if it already exists")
  .action((opts: { name?: string; out?: string; force?: boolean }) =>
    generateEmail(opts),
  );

cli
  .command("dev", "Start the local Moosewave preview server")
  .option("--port <port>", "Port to listen on", { default: 4321 })
  .option("--no-browser", "Don't auto-open browser")
  .action((opts) => devCommand(opts));

cli
  .command("logs tail", "Stream live email events to the terminal")
  .option("--filter <kv>", "Filter events, e.g. event_type=opened")
  .action((opts) => logsTailCommand(opts));

cli
  .command(
    "segments from-text",
    "Compile a natural-language query into a segment",
  )
  .option(
    "--query <text>",
    "Natural-language description (otherwise read from stdin)",
  )
  .option("--name <name>", "Segment name (auto-generated if omitted)")
  .option("--yes", "Skip the confirmation prompt")
  .action((opts) => segmentsFromText(opts));

cli
  .command("segments create", "Create a segment from an explicit AST")
  .option("--name <name>", "Segment name")
  .option("--ast <json>", "JSON AST (otherwise read from stdin)")
  .action((opts) => segmentsCreate(opts));

cli.help();
cli.version(VERSION);

cli.parse();

if (
  !cli.matchedCommand &&
  !process.argv
    .slice(2)
    .some(
      (a) => a === "--help" || a === "-h" || a === "--version" || a === "-v",
    )
) {
  cli.outputHelp();
}
