// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { createClient } from "../lib/client.js";
import { spinner } from "../lib/spinner.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";
import type { MigrationJob, SourcePlatform } from "@postwave/sdk";

export interface MigrateOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  sourceApiKey?: string;
  sourceAccountId?: string;
  sourceRegion?: string;
  publicationId?: string;
  dryRun?: boolean;
  commit?: boolean;
  rollback?: string;
  status?: string;
  output?: OutputFormat;
}

export interface MigrateSourceEventsOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  intervalSeconds?: string | number;
  postPilotCleanup?: boolean;
  output?: OutputFormat;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MIGRATION_SOURCES = new Set<string>([
  "activecampaign",
  "klaviyo",
  "customerio",
  "constant-contact",
  "aweber",
  "drip",
  "campaign-monitor",
  "omnisend",
  "loops",
  "flodesk",
  "bento",
  "hubspot",
  "mailchimp",
  "convertkit",
  "brevo",
  "substack",
  "beehiiv",
  "mailerlite",
  "sendy",
  "csv",
]);
const SOURCE_EVENT_SOURCES = new Set<string>([
  "activecampaign",
  "hubspot",
  "klaviyo",
]);

export async function migrateCommand(
  source: string | undefined,
  opts: MigrateOpts,
): Promise<void> {
  const client = createClient(opts);

  if (opts.rollback) {
    const s = spinner(`Rolling back job ${opts.rollback}…`).start();
    try {
      await client.migrations.rollback(opts.rollback);
      const out = { job_id: opts.rollback, status: "rollback_started" };
      s.succeed(`Rollback initiated: ${opts.rollback}`);
      console.log(formatOutput(out, opts.output ?? "json"));
    } catch (err) {
      s.fail((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }

  if (opts.status) {
    const out = await client.migrations.get(opts.status);
    console.log(formatOutput(out, opts.output ?? "json"));
    return;
  }

  if (!source) {
    console.error(chalk.red(`Specify a source: ${migrationSourceList()}`));
    process.exitCode = 1;
    return;
  }

  if (!isMigrationSource(source)) {
    console.error(
      chalk.red(
        `Unsupported source "${source}". Use one of: ${migrationSourceList()}`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const start = spinner(`Starting ${source} migration…`).start();
  try {
    const sourcePlatform = source as SourcePlatform;
    if (
      sourcePlatform === "beehiiv" ||
      sourcePlatform === "klaviyo" ||
      sourcePlatform === "customerio" ||
      sourcePlatform === "hubspot"
    ) {
      const credentials =
        sourcePlatform === "beehiiv"
          ? beehiivCredentialInput(opts)
          : sourcePlatform === "klaviyo"
            ? klaviyoCredentialInput(opts)
            : sourcePlatform === "customerio"
              ? customerIOCredentialInput(opts)
              : hubSpotCredentialInput(opts);
      const connected = await client.migrations.credentials(
        sourcePlatform,
        credentials,
      );
      start.succeed(
        sourcePlatform === "beehiiv"
          ? `Beehiiv publication-bound migration job created: ${connected.job_id}`
          : sourcePlatform === "klaviyo"
            ? `Klaviyo account-bound migration job created: ${connected.job_id}`
            : sourcePlatform === "customerio"
              ? `Customer.io workspace-bound migration job created: ${connected.job_id}`
              : `HubSpot portal-bound migration job created: ${connected.job_id}`,
      );
      const discovery = await client.migrations.discover(
        sourcePlatform,
        connected.job_id,
      );
      if (!opts.dryRun && !opts.commit) {
        console.log(
          formatOutput(
            {
              job_id: connected.job_id,
              account_id: connected.account_id,
              discovery,
              next: "Run again with --dry-run, then --commit after reviewing the report.",
            },
            opts.output ?? "json",
          ),
        );
        return;
      }

      const dryRun = await client.migrations.dryRun(
        sourcePlatform,
        connected.job_id,
      );
      const reviewed = await pollJob(client, dryRun.job_id);
      if (!opts.commit) return;
      if (reviewed?.status !== "awaiting_confirmation") {
        throw new Error(
          `${sourcePlatform === "beehiiv" ? "Beehiiv" : sourcePlatform === "klaviyo" ? "Klaviyo" : sourcePlatform === "customerio" ? "Customer.io" : "HubSpot"} dry-run did not reach awaiting_confirmation; commit was not started`,
        );
      }
      const committed = await client.migrations.commit(
        sourcePlatform,
        connected.job_id,
      );
      const completed = await pollJob(client, committed.job_id);
      if (completed?.status === "completed") {
        const next =
          sourcePlatform === "beehiiv"
            ? "Continue in the web app: pause/retire source automations, run the frozen final delta, reconcile a clean shadow check, complete billing/rollback evidence, and require strict pilot acceptance before cutover. MCP distribution remains release-held."
            : sourcePlatform === "klaviyo"
              ? "Continue in the web app: reuse the original unrolled-back tenant/account job lineage for credential refreshes and delta/full snapshots because a second same-account job is rejected to prevent duplicate active identities after an email change; reconcile the mandatory secondary-email/per-address-consent source-archive record; treat audience counts/tags as the suppression-filtered send-targetable projection rather than raw membership; review nullable draft-message/flow definitions, IDs-only campaign tags, and eight unconditional static checklist rows as incomplete evidence rather than inventory; rebuild and review Klaviyo flows; run the full final delta (including any stable-profile email A→B move before replay resumes) and source-event reconciliation; verify a clean shadow check; complete consent, audience, channel, deliverability, ecosystem, rollback, and credential-cleanup reviews; and require strict pilot acceptance before cutover."
              : sourcePlatform === "customerio"
                ? 'Continue in the web app on this same unrolled-back tenant/workspace lineage. Freeze Customer.io changes, run a final full cio_id snapshot (there is no supported incremental profile-change feed), and reconcile duplicate-email identities, email moves/deletions, global plus email-channel plus applicable-topic preferences, ESP suppressions, profiles without usable email, and exact frozen segment memberships. Materialize only sent email newsletters that have an explicit language="" default and provably composable source HTML; for multiple empty-language A/B defaults, the lowest stable content ID is the warned representative and every variant remains evidence. Treat Design Studio HTML as exact source, never provider-rendered output, and treat API-broadcast trigger rows as IDs/timestamps rather than original payload, audience, or per-user context. Rebuild automations and transactional/non-email dependencies, reconcile ecosystem evidence, then require a clean same-count-sensitive shadow check, conflict-aware rollback rehearsal, all six Customer.io review gates, and strict pilot acceptance before cutover.'
                : "The initial HubSpot contact import is not cutover approval. Keep this same portal-bound job and private-app token, run contact-change polling for at least seven continuous days, then freeze contact/list/preference/primary-email changes and run the authoritative final full snapshot. Polling covers contact changes only: it does not prove standalone list-membership changes or preference-only changes, hard deletions, or loss/change of an email address. Reconcile exact preference coverage and conservative current-primary-email eligibility (all active definitions SUBSCRIBED, no scoped/wide opt-out or bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction); this is not exact HubSpot sendability parity. Reconcile final list/subscription tags and complete the 14-row CRM-bridge scope review for excluded identity/schema/rule evidence plus workflows, marketing email/archive, templates, reports, forms, landing pages, ecommerce, SMS, custom objects, and other CRM objects; then require a clean shadow check, rollback rehearsal, strict pilot acceptance, durable local-session cleanup, and external token cleanup evidence before cutover.";
        console.log(
          formatOutput(
            {
              job_id: committed.job_id,
              initial_import_completed: true,
              cutover_ready: false,
              source_archive_by_resource:
                completed.verification_report?.source_archive_by_resource ?? {},
              next,
            },
            opts.output ?? "json",
          ),
        );
      }
      return;
    }
    const init = await client.migrations.start(sourcePlatform);
    const authorizeURL = normalizeMigrationAuthorizeUrl(
      init.authorize_url,
      sourcePlatform,
    );
    if (!authorizeURL) {
      throw new Error(
        "Migration provider returned an unsafe authorization URL.",
      );
    }
    start.succeed(`Authorization URL: ${authorizeURL}`);

    if (opts.dryRun || opts.commit) {
      const job = opts.commit
        ? await client.migrations.commit(sourcePlatform, init.state)
        : await client.migrations.dryRun(sourcePlatform, init.state);
      console.log(`Job: ${job.job_id}`);
      await pollJob(client, job.job_id);
    }
  } catch (err) {
    start.fail((err as Error).message);
    process.exitCode = 1;
  }
}

export async function migrateSourceEventsStart(
  source: string | undefined,
  jobId: string | undefined,
  opts: MigrateSourceEventsOpts,
): Promise<void> {
  if (!source || !isMigrationSource(source)) {
    console.error(
      chalk.red(
        `Unsupported source "${source ?? ""}". Use one of: ${migrationSourceList()}`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (!SOURCE_EVENT_SOURCES.has(source)) {
    console.error(
      chalk.red(
        source === "customerio"
          ? "Customer.io does not expose a complete source-event feed. Use a source freeze, final full snapshot, and fresh shadow check instead."
          : `Source-event monitoring is supported only for: ${Array.from(SOURCE_EVENT_SOURCES).join(", ")}`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const normalizedJobID = normalizeMigrationJobID(jobId);
  if (!normalizedJobID) {
    console.error(chalk.red("Migration job ID is required."));
    process.exitCode = 1;
    return;
  }
  const intervalSeconds = parseSourceEventInterval(opts.intervalSeconds);
  if (intervalSeconds == null) {
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  try {
    const out = await client.migrations.startSourceEvents(
      source,
      normalizedJobID,
      intervalSeconds,
    );
    console.log(formatOutput(out, opts.output ?? "json"));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}

export async function migrateSourceEventsStatus(
  jobId: string | undefined,
  opts: MigrateSourceEventsOpts,
): Promise<void> {
  const normalizedJobID = normalizeMigrationJobID(jobId);
  if (!normalizedJobID) {
    console.error(chalk.red("Migration job ID is required."));
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  try {
    const out = await client.migrations.sourceEvents(normalizedJobID);
    console.log(formatOutput(out, opts.output ?? "json"));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}

export async function migrateSourceEventsStop(
  jobId: string | undefined,
  opts: MigrateSourceEventsOpts,
): Promise<void> {
  const normalizedJobID = normalizeMigrationJobID(jobId);
  if (!normalizedJobID) {
    console.error(chalk.red("Migration job ID is required."));
    process.exitCode = 1;
    return;
  }
  const client = createClient(opts);
  try {
    const out = await client.migrations.stopSourceEvents(
      normalizedJobID,
      Boolean(opts.postPilotCleanup),
    );
    console.log(formatOutput(out, opts.output ?? "json"));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}

export function isMigrationSource(source: string): source is SourcePlatform {
  return MIGRATION_SOURCES.has(source);
}

function migrationSourceList(): string {
  return Array.from(MIGRATION_SOURCES).join(", ");
}

function normalizeMigrationJobID(jobId: string | undefined): string {
  return (jobId ?? "").trim();
}

function parseSourceEventInterval(
  raw: string | number | undefined,
): number | null {
  if (raw == null || raw === "") return 3600;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(chalk.red("--interval-seconds must be a positive integer."));
    return null;
  }
  return value;
}

async function pollJob(
  client: ReturnType<typeof createClient>,
  jobId: string,
): Promise<MigrationJob | null> {
  const s = spinner("Polling job…").start();
  for (let i = 0; i < 600; i++) {
    const job = await client.migrations.get(jobId);
    s.text = `${jobId}: ${job.status} — ${summarize(job.progress)}`;
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "rolled_back" ||
      job.status === "awaiting_confirmation"
    ) {
      if (job.status === "failed") {
        s.fail(`Job failed: ${job.error ?? "unknown error"}`);
      } else {
        s.succeed(`Job ${job.status}.`);
      }
      return job;
    }
    await sleep(2000);
  }
  s.warn("Polling timed out after 20 minutes.");
  return null;
}

export function beehiivCredentialInput(
  opts: Pick<MigrateOpts, "sourceApiKey" | "publicationId">,
): {
  api_key: string;
  account_id: string;
  extra: { publication_id: string };
} {
  const apiKey = (opts.sourceApiKey ?? "").trim();
  const publicationID = (opts.publicationId ?? "").trim();
  if (!apiKey) {
    throw new Error("Beehiiv requires --source-api-key");
  }
  if (!/^pub_[0-9a-f-]+$/i.test(publicationID)) {
    throw new Error(
      "Beehiiv requires --publication-id with a valid pub_… publication ID",
    );
  }
  return {
    api_key: apiKey,
    account_id: publicationID,
    extra: { publication_id: publicationID },
  };
}

export function klaviyoCredentialInput(
  opts: Pick<MigrateOpts, "sourceApiKey" | "sourceAccountId">,
): {
  api_key: string;
  account_id?: string;
} {
  const apiKey = (opts.sourceApiKey ?? "").trim();
  const accountID = (opts.sourceAccountId ?? "").trim();
  if (!apiKey) {
    throw new Error("Klaviyo requires --source-api-key");
  }
  if (
    accountID &&
    (accountID.length > 512 ||
      CONTROL_RE.test(accountID) ||
      /\s/.test(accountID))
  ) {
    throw new Error(
      "Klaviyo --source-account-id must be a provider account ID without whitespace",
    );
  }
  return accountID
    ? { api_key: apiKey, account_id: accountID }
    : { api_key: apiKey };
}

export function customerIOCredentialInput(
  opts: Pick<MigrateOpts, "sourceApiKey" | "sourceAccountId" | "sourceRegion">,
): {
  api_key: string;
  account_id?: string;
  extra: { region: "us" | "eu" };
} {
  const apiKey = (opts.sourceApiKey ?? "").trim();
  const workspaceID = (opts.sourceAccountId ?? "").trim();
  const region = (opts.sourceRegion ?? "us").trim().toLowerCase();
  if (!apiKey) {
    throw new Error("Customer.io requires --source-api-key");
  }
  if (region !== "us" && region !== "eu") {
    throw new Error("Customer.io --source-region must be us or eu");
  }
  if (workspaceID && !/^\d{1,64}$/u.test(workspaceID)) {
    throw new Error(
      "Customer.io --source-account-id must be a numeric workspace ID of 1 to 64 digits",
    );
  }
  return workspaceID
    ? {
        api_key: apiKey,
        account_id: workspaceID,
        extra: { region },
      }
    : { api_key: apiKey, extra: { region } };
}

export function hubSpotCredentialInput(
  opts: Pick<MigrateOpts, "sourceApiKey" | "sourceAccountId">,
): {
  api_key: string;
  account_id?: string;
  extra?: { hub_id: string };
} {
  const apiKey = (opts.sourceApiKey ?? "").trim();
  const hubID = (opts.sourceAccountId ?? "").trim();
  if (!apiKey) {
    throw new Error("HubSpot requires --source-api-key");
  }
  if (hubID && !/^\d{1,64}$/u.test(hubID)) {
    throw new Error(
      "HubSpot --source-account-id must be a numeric Hub ID of 1 to 64 digits",
    );
  }
  return hubID
    ? {
        api_key: apiKey,
        account_id: hubID,
        extra: { hub_id: hubID },
      }
    : { api_key: apiKey };
}

function summarize(p?: MigrationJob["progress"]): string {
  if (!p) return "";
  const subs = `${p.subscribers_done ?? 0}/${p.subscribers_total ?? 0} subs`;
  const segs = `${p.segments_done ?? 0}/${p.segments_total ?? 0} segs`;
  return `${subs}, ${segs}`;
}

export function normalizeMigrationAuthorizeUrl(
  raw: string | null | undefined,
  source?: SourcePlatform,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (CONTROL_RE.test(trimmed)) return null;

  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return null;
    url.hash = "";

    if (url.protocol === "https:" && !isBlockedAuthorizeHost(url.hostname))
      return url.toString();
    if (
      url.protocol === "http:" &&
      LOCAL_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return url.toString();
    }
    if (url.protocol === "postwave:" && url.hostname === "migrations") {
      if (url.pathname !== "/api-key") return null;
      const linkSource = url.searchParams.get("source");
      if (!linkSource || !isMigrationSource(linkSource)) return null;
      return source === undefined || linkSource === source
        ? url.toString()
        : null;
    }
    if (url.protocol === "postwave:" && url.hostname === "migrate") {
      const expectedPrefix = source ? `/${source}/` : "/";
      return url.pathname.startsWith(expectedPrefix) &&
        isSafeDeepLinkPath(url.pathname)
        ? url.toString()
        : null;
    }
  } catch {
    return null;
  }

  return null;
}

function isBlockedAuthorizeHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number) as [number, number, number, number];
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (/^fe80:/i.test(host)) return true;
  }

  return false;
}

function isSafeDeepLinkPath(pathname: string): boolean {
  if (CONTROL_RE.test(pathname) || pathname.includes("\\")) return false;
  return pathname.split("/").every((segment) => {
    if (!segment) return true;
    let current = segment;
    for (let i = 0; i < 2; i += 1) {
      if (
        current === "." ||
        current === ".." ||
        CONTROL_RE.test(current) ||
        current.includes("\\")
      ) {
        return false;
      }
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
    return (
      current !== "." &&
      current !== ".." &&
      !CONTROL_RE.test(current) &&
      !current.includes("\\")
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
