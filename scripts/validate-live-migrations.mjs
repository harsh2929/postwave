#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { migrationSources, exportSources, exportPaths, candidateError, lifecycleCoverageErrors } from "./lib/migration-qualification.mjs";

const baseURL = trimEnd(
  process.env.POSTWAVE_MIGRATION_URL ||
    process.env.MIGRATION_SERVICE_URL ||
    "http://localhost:8081",
);
const tenantID =
  process.env.POSTWAVE_TENANT_ID ||
  process.env.POSTWAVE_TEST_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001";
const token = process.env.POSTWAVE_INTERNAL_API_TOKEN || "";
const postwaveAPIBaseURL = trimEnd(process.env.POSTWAVE_API_URL || "");
const postwaveAPIKey = process.env.POSTWAVE_API_KEY || "";
const requireLive = process.env.REQUIRE_LIVE_MIGRATIONS === "1";
const activeCampaignFailOnDiscoveryWarnings =
  process.env.ACTIVECAMPAIGN_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const activeCampaignFailOnSourceArchiveWarnings =
  process.env.ACTIVECAMPAIGN_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS === "1" ||
  activeCampaignFailOnDiscoveryWarnings;
const hubSpotFailOnDiscoveryWarnings =
  process.env.HUBSPOT_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const beehiivFailOnDiscoveryWarnings =
  process.env.BEEHIIV_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const beehiivFailOnSourceArchiveWarnings =
  process.env.BEEHIIV_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS === "1";
const mailerLiteFailOnDiscoveryWarnings =
  process.env.MAILERLITE_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const mailerLiteFailOnSourceArchiveWarnings =
  process.env.MAILERLITE_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS === "1" ||
  mailerLiteFailOnDiscoveryWarnings;
const klaviyoFailOnDiscoveryWarnings =
  process.env.KLAVIYO_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const klaviyoFailOnSourceArchiveWarnings =
  process.env.KLAVIYO_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS === "1" ||
  klaviyoFailOnDiscoveryWarnings;
const customerIOFailOnDiscoveryWarnings =
  process.env.CUSTOMERIO_LIVE_FAIL_ON_DISCOVERY_WARNINGS === "1";
const customerIOFailOnSourceArchiveWarnings =
  process.env.CUSTOMERIO_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS === "1";
const liveWaitMs = positiveNumberEnv("MIGRATION_LIVE_WAIT_MS", 900000);
const liveRateLimitMaxExtensionMs = positiveNumberEnv(
  "MIGRATION_LIVE_RATE_LIMIT_MAX_WAIT_MS",
  1800000,
);
const liveRateLimitGraceMs = positiveNumberEnv(
  "MIGRATION_LIVE_RATE_LIMIT_GRACE_MS",
  60000,
);
const minimumSourceEventOverlapMs = 7 * 24 * 60 * 60 * 1000;
const sourceEventOverlapGapGraceMs = 60 * 1000;
const activeCampaignPostPilotCleanupEvidenceKey =
  "activecampaign_post_pilot_cleanup";
const activeCampaignPostPilotCleanupStartedAtKey =
  "activecampaign_post_pilot_cleanup_started_at";
const hubSpotPostPilotCleanupEvidenceKey = "hubspot_post_pilot_cleanup";
const hubSpotPostPilotCleanupStartedAtKey =
  "hubspot_post_pilot_cleanup_started_at";
const hubSpotPostPilotSourceSessionClearedAtKey =
  "hubspot_post_pilot_source_session_cleared_at";
const activeCampaignManualReviewEvidenceKeys = new Set([
  "activecampaign_automation_rebuild_review",
  "activecampaign_segments_review",
  "activecampaign_audience_schema_review",
  "activecampaign_campaign_archive_fidelity_review",
  "activecampaign_templates_review",
  "activecampaign_forms_review",
  "activecampaign_custom_objects_review",
  "activecampaign_ecommerce_review",
  "activecampaign_crm_archive_review",
]);
const activeCampaignBlockerSignoffEvidenceKeys = new Set([
  "activecampaign_segments_review",
  "activecampaign_audience_schema_review",
  "activecampaign_campaign_archive_fidelity_review",
  "source_discovery_warnings",
  "source_archive_warnings",
]);
const customerIOManualReviewEvidenceKeys = [
  "customerio_consent_subscription_review",
  "customerio_identity_audience_review",
  "customerio_automation_rebuild_review",
  "customerio_channel_dependency_review",
  "customerio_deliverability_review",
  "customerio_ecosystem_dependencies_review",
];
const artifactDir =
  process.env.POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR ||
  process.env.MIGRATION_LIVE_ARTIFACT_DIR ||
  "";
const artifactRunID =
  process.env.MIGRATION_LIVE_ARTIFACT_RUN_ID ||
  new Date().toISOString().replace(/[:.]/gu, "-");
let artifactSeq = 0;

const results = [];
const candidateSHA256 = String(process.env.MIGRATION_CANDIDATE_SHA256 || "").trim().toLowerCase();
let observedCandidateSHA256 = "";
const requireLifecycle = process.env.REQUIRE_MIGRATION_LIFECYCLE === "1";

if (process.argv.includes("--self-test")) {
  await runSelfTest();
  process.exit(0);
}

if ((requireLive || requireLifecycle) && (!/^[a-f0-9]{64}$/u.test(candidateSHA256) || !artifactDir)) {
  console.error("FAIL preflight: set MIGRATION_CANDIDATE_SHA256 to the expected executable SHA-256 and configure the artifact directory before live qualification");
  process.exit(1);
}
await checkSources();
// A mismatched service must not receive any credential or mutation request.
if (results.some(r => r.id === "sources" && r.status === "fail")) {
  await writeArtifact("summary", "preflight", { results });
  console.error("FAIL preflight: migration inventory or executable identity is unavailable");
  process.exit(1);
}
await maybeOAuthTokenSource("mailchimp", {
  accessToken: process.env.MAILCHIMP_ACCESS_TOKEN,
  accountID: process.env.MAILCHIMP_DC || process.env.MAILCHIMP_ACCOUNT_ID,
  envNames: ["MAILCHIMP_ACCESS_TOKEN", "MAILCHIMP_DC"],
  selectedAudienceIDs: splitCSV(process.env.MAILCHIMP_AUDIENCE_IDS),
  dryRun: process.env.MAILCHIMP_LIVE_DRY_RUN === "1",
  commit: process.env.MAILCHIMP_LIVE_COMMIT === "1",
  rollback: process.env.MAILCHIMP_LIVE_ROLLBACK === "1",
});
await maybeCredentialSource("activecampaign", {
  apiKey:
    process.env.ACTIVECAMPAIGN_API_TOKEN || process.env.ACTIVECAMPAIGN_API_KEY,
  accountID: process.env.ACTIVECAMPAIGN_API_URL,
  extra: {
    api_url: process.env.ACTIVECAMPAIGN_API_URL,
  },
  envNames: ["ACTIVECAMPAIGN_API_URL"],
  anyEnvNames: [["ACTIVECAMPAIGN_API_TOKEN", "ACTIVECAMPAIGN_API_KEY"]],
  dryRun: process.env.ACTIVECAMPAIGN_LIVE_DRY_RUN === "1",
  commit: process.env.ACTIVECAMPAIGN_LIVE_COMMIT === "1",
  rollback: process.env.ACTIVECAMPAIGN_LIVE_ROLLBACK === "1",
  shadowCheck: process.env.ACTIVECAMPAIGN_LIVE_SHADOW_CHECK === "1",
  sourceEvents: process.env.ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS === "1",
  sourceEventPhase: String(
    process.env.ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE || "",
  )
    .trim()
    .toLowerCase(),
  sourceEventJobID: String(
    process.env.ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID || "",
  ).trim(),
  deltaImport: process.env.ACTIVECAMPAIGN_LIVE_DELTA_IMPORT === "1",
  pilotAcceptance: process.env.ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE === "1",
  rollbackRehearsal: process.env.ACTIVECAMPAIGN_LIVE_ROLLBACK_REHEARSAL === "1",
  deliverabilityReview:
    process.env.ACTIVECAMPAIGN_LIVE_DELIVERABILITY_REVIEW === "1",
  consentExclusionReview:
    process.env.ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW === "1",
  consentExclusionEvidenceRef:
    process.env.ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF,
  manualReviewSignoff:
    process.env.ACTIVECAMPAIGN_LIVE_MANUAL_REVIEW_SIGNOFF === "1",
  smsReadiness: process.env.ACTIVECAMPAIGN_LIVE_SMS_READINESS === "1",
  credentialCleanupReview:
    process.env.ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW === "1",
  credentialCleanupEvidenceRef:
    process.env.ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF,
  failOnDiscoveryWarnings: activeCampaignFailOnDiscoveryWarnings,
  failOnSourceArchiveWarnings: activeCampaignFailOnSourceArchiveWarnings,
  sourceEventIntervalSeconds: Number(
    process.env.ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_INTERVAL_SECONDS || 900,
  ),
});
await maybeCredentialSource("hubspot", {
  apiKey:
    process.env.HUBSPOT_SERVICE_KEY || process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN,
  accountID: process.env.HUBSPOT_HUB_ID || process.env.HUBSPOT_ACCOUNT_ID,
  extra: {
    hub_id: process.env.HUBSPOT_HUB_ID || process.env.HUBSPOT_ACCOUNT_ID,
  },
  anyEnvNames: [["HUBSPOT_SERVICE_KEY", "HUBSPOT_PRIVATE_APP_TOKEN", "HUBSPOT_ACCESS_TOKEN"]],
  requireFullCertification:
    process.env.HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION === "1",
  dryRun: process.env.HUBSPOT_LIVE_DRY_RUN === "1",
  commit: process.env.HUBSPOT_LIVE_COMMIT === "1",
  rollback: process.env.HUBSPOT_LIVE_ROLLBACK === "1",
  shadowCheck: process.env.HUBSPOT_LIVE_SHADOW_CHECK === "1",
  sourceEvents: process.env.HUBSPOT_LIVE_SOURCE_EVENTS === "1",
  sourceEventPhase: String(process.env.HUBSPOT_LIVE_SOURCE_EVENT_PHASE || "")
    .trim()
    .toLowerCase(),
  sourceEventJobID: String(
    process.env.HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID || "",
  ).trim(),
  deltaImport: process.env.HUBSPOT_LIVE_DELTA_IMPORT === "1",
  pilotAcceptance: process.env.HUBSPOT_LIVE_PILOT_ACCEPTANCE === "1",
  rollbackRehearsal: process.env.HUBSPOT_LIVE_ROLLBACK_REHEARSAL === "1",
  manualReviewSignoff: process.env.HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF === "1",
  manualReviewEvidenceRef: process.env.HUBSPOT_LIVE_MANUAL_REVIEW_EVIDENCE_REF,
  credentialCleanupReview:
    process.env.HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW === "1",
  credentialCleanupEvidenceRef:
    process.env.HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF,
  failOnDiscoveryWarnings: hubSpotFailOnDiscoveryWarnings,
  sourceEventIntervalSeconds: Number(
    process.env.HUBSPOT_LIVE_SOURCE_EVENT_INTERVAL_SECONDS || 900,
  ),
});
await maybeCredentialSource("klaviyo", {
  apiKey: process.env.KLAVIYO_API_KEY,
  accountID: process.env.KLAVIYO_ACCOUNT_ID,
  extra: {
    klaviyo_account_id: process.env.KLAVIYO_ACCOUNT_ID,
  },
  envNames: ["KLAVIYO_API_KEY"],
  dryRun: process.env.KLAVIYO_LIVE_DRY_RUN === "1",
  commit: process.env.KLAVIYO_LIVE_COMMIT === "1",
  rollback: process.env.KLAVIYO_LIVE_ROLLBACK === "1",
  shadowCheck: process.env.KLAVIYO_LIVE_SHADOW_CHECK === "1",
  sourceEvents: process.env.KLAVIYO_LIVE_SOURCE_EVENTS === "1",
  deltaImport: process.env.KLAVIYO_LIVE_DELTA_IMPORT === "1",
  pilotAcceptance: process.env.KLAVIYO_LIVE_PILOT_ACCEPTANCE === "1",
  rollbackRehearsal: process.env.KLAVIYO_LIVE_ROLLBACK_REHEARSAL === "1",
  manualReviewSignoff: process.env.KLAVIYO_LIVE_MANUAL_REVIEW_SIGNOFF === "1",
  manualReviewEvidenceRef: process.env.KLAVIYO_LIVE_MANUAL_REVIEW_EVIDENCE_REF,
  credentialCleanupReview:
    process.env.KLAVIYO_LIVE_CREDENTIAL_CLEANUP_REVIEW === "1",
  credentialCleanupEvidenceRef:
    process.env.KLAVIYO_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF,
  failOnDiscoveryWarnings: klaviyoFailOnDiscoveryWarnings,
  failOnSourceArchiveWarnings: klaviyoFailOnSourceArchiveWarnings,
  sourceEventIntervalSeconds: Number(
    process.env.KLAVIYO_LIVE_SOURCE_EVENT_INTERVAL_SECONDS || 900,
  ),
});
await maybeCredentialSource("customerio", {
  apiKey: process.env.CUSTOMERIO_API_KEY,
  accountID: process.env.CUSTOMERIO_WORKSPACE_ID,
  extra: {
    customerio_workspace_id: process.env.CUSTOMERIO_WORKSPACE_ID,
    region: process.env.CUSTOMERIO_REGION,
  },
  envNames: [
    "CUSTOMERIO_API_KEY",
    "CUSTOMERIO_WORKSPACE_ID",
    "CUSTOMERIO_REGION",
  ],
  requireFullCertification:
    process.env.CUSTOMERIO_LIVE_REQUIRE_FULL_CERTIFICATION === "1",
  dryRun: process.env.CUSTOMERIO_LIVE_DRY_RUN === "1",
  commit: process.env.CUSTOMERIO_LIVE_COMMIT === "1",
  rollback: process.env.CUSTOMERIO_LIVE_ROLLBACK === "1",
  shadowCheck: process.env.CUSTOMERIO_LIVE_SHADOW_CHECK === "1",
  sourceEvents: process.env.CUSTOMERIO_LIVE_SOURCE_EVENTS === "1",
  deltaImport: process.env.CUSTOMERIO_LIVE_DELTA_IMPORT === "1",
  pilotAcceptance: process.env.CUSTOMERIO_LIVE_PILOT_ACCEPTANCE === "1",
  rollbackRehearsal: process.env.CUSTOMERIO_LIVE_ROLLBACK_REHEARSAL === "1",
  manualReviewSignoff:
    process.env.CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF === "1",
  manualReviewEvidenceRef:
    process.env.CUSTOMERIO_LIVE_MANUAL_REVIEW_EVIDENCE_REF,
  credentialCleanupReview:
    process.env.CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_REVIEW === "1",
  credentialCleanupEvidenceRef:
    process.env.CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF,
  failOnDiscoveryWarnings: customerIOFailOnDiscoveryWarnings,
  failOnSourceArchiveWarnings: customerIOFailOnSourceArchiveWarnings,
});
await maybeOAuthStart("mailchimp", [
  "MAILCHIMP_CLIENT_ID",
  "MAILCHIMP_CLIENT_SECRET",
]);
await maybeOAuthStart("convertkit", [
  "CONVERTKIT_CLIENT_ID",
  "CONVERTKIT_CLIENT_SECRET",
]);
await maybeCredentialSource("beehiiv", {
  apiKey: process.env.BEEHIIV_API_KEY,
  accountID: process.env.BEEHIIV_PUBLICATION_ID,
  extra: {
    publication_id: process.env.BEEHIIV_PUBLICATION_ID,
  },
  envNames: ["BEEHIIV_API_KEY", "BEEHIIV_PUBLICATION_ID"],
  dryRun: process.env.BEEHIIV_LIVE_DRY_RUN === "1",
  commit: process.env.BEEHIIV_LIVE_COMMIT === "1",
  rollback: process.env.BEEHIIV_LIVE_ROLLBACK === "1",
  shadowCheck: process.env.BEEHIIV_LIVE_SHADOW_CHECK === "1",
  deltaImport: process.env.BEEHIIV_LIVE_DELTA_IMPORT === "1",
  pilotAcceptance: process.env.BEEHIIV_LIVE_PILOT_ACCEPTANCE === "1",
  rollbackRehearsal: process.env.BEEHIIV_LIVE_ROLLBACK_REHEARSAL === "1",
  manualReviewSignoff: process.env.BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF === "1",
  manualReviewEvidenceRef: process.env.BEEHIIV_LIVE_MANUAL_REVIEW_EVIDENCE_REF,
  credentialCleanupReview:
    process.env.BEEHIIV_LIVE_CREDENTIAL_CLEANUP_REVIEW === "1",
  credentialCleanupEvidenceRef:
    process.env.BEEHIIV_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF,
  failOnDiscoveryWarnings: beehiivFailOnDiscoveryWarnings,
  failOnSourceArchiveWarnings: beehiivFailOnSourceArchiveWarnings,
});
await maybeCredentialSource("mailerlite", {
  apiKey: process.env.MAILERLITE_API_KEY,
  envNames: ["MAILERLITE_API_KEY"],
  dryRun: process.env.MAILERLITE_LIVE_DRY_RUN === "1",
  commit: process.env.MAILERLITE_LIVE_COMMIT === "1",
  rollback: process.env.MAILERLITE_LIVE_ROLLBACK === "1",
  failOnDiscoveryWarnings: mailerLiteFailOnDiscoveryWarnings,
  failOnSourceArchiveWarnings: mailerLiteFailOnSourceArchiveWarnings,
});

await maybeCredentialSource("brevo", {
  apiKey: process.env.BREVO_API_KEY, envNames: ["BREVO_API_KEY"],
  dryRun: process.env.BREVO_LIVE_DRY_RUN === "1", commit: process.env.BREVO_LIVE_COMMIT === "1", rollback: process.env.BREVO_LIVE_ROLLBACK === "1",
});
await maybeOAuthTokenSource("convertkit", {
  accessToken: process.env.CONVERTKIT_ACCESS_TOKEN, refreshToken: process.env.CONVERTKIT_REFRESH_TOKEN,
  accountID: process.env.CONVERTKIT_ACCOUNT_ID, envNames: ["CONVERTKIT_ACCESS_TOKEN","CONVERTKIT_ACCOUNT_ID"],
  dryRun: process.env.CONVERTKIT_LIVE_DRY_RUN === "1", commit: process.env.CONVERTKIT_LIVE_COMMIT === "1", rollback: process.env.CONVERTKIT_LIVE_ROLLBACK === "1",
});
let paths = {};
try { paths = exportPaths(process.env.MIGRATION_EXPORT_PATHS_JSON); } catch (err) { fail("export_manifest",err.message); }
for (const source of exportSources) await maybeExportSource(source, paths[source]);
if (requireLifecycle) {
  for (const id of lifecycleCoverageErrors(results)) fail(id+"_required", "Full qualification requires preview, commit, rollback and stored-source cleanup for every path; smoke checks and retained prepare runs are incomplete");
}

const failures = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
for (const result of results) {
  const prefix =
    result.status === "pass"
      ? "PASS"
      : result.status === "skip"
        ? "SKIP"
        : "FAIL";
  console.log(`${prefix} ${result.id}: ${result.message}`);
}
await writeArtifact("summary", "results", {
  base_url: baseURL,
  tenant_id: tenantID,
  completed_at: new Date().toISOString(),
  results,
});

if (failures.length > 0 || (requireLive && skipped.length > 0)) {
  process.exit(1);
}

async function requireRetainedCandidateEvidence(source, jobID) {
  if (!requireLifecycle) return;
  const dir = process.env.MIGRATION_RETAINED_EVIDENCE_DIR;
  if (!dir) throw new Error("Set MIGRATION_RETAINED_EVIDENCE_DIR to the retained prepare-run artifacts for full lifecycle qualification");
  const files = await readdir(dir);
  const evidence=[];
  for(const filename of files.filter(name=>name.endsWith(".json"))) {
    const file=path.join(dir,filename);
    if((await stat(file)).size>16*1024*1024) throw new Error("Retained evidence file is too large");
    const artifact=JSON.parse(await readFile(file,"utf8"));
    if(artifact.source===source && artifact.payload?.job_id===jobID) evidence.push(artifact);
  }
  for(const name of ["dry-run","commit"]) {
    const found=evidence.find(a=>a.artifact_schema==="postwave.live_migration_certification.v2" && a.name===name && a.candidate_sha256===candidateSHA256 && a.observed_executable_sha256===candidateSHA256 && a.payload?.status===(name==="commit"?"completed":"awaiting_confirmation"));
    if(!found) throw new Error("Retained preview/commit evidence is missing, from a different job, or from a different executable");
  }
  await writeArtifact(source,"retained-candidate-evidence",{job_id:jobID,phases:["dry-run","commit"],candidate_sha256:candidateSHA256});
  pass(`${source}_live_dry_run`,"Retained preview and commit artifacts match this job and executable");
}

async function runStoredSourceCleanup(source, jobID) {
  const result = await request(`/v1/migrations/${jobID}/source-session`, {method:"DELETE"});
  if (result.stored_source_data_removed !== true || result.provider_access_revoked !== false) throw new Error("Stored-source cleanup did not return a truthful completion receipt");
  await writeArtifact(source,"stored-source-cleanup",{job_id:jobID,stored_source_data_removed:true,provider_access_revoked:false});
  pass(`${source}_source_cleanup`, "Stored credentials and uploads removed; provider-side revocation remains separate");
}

async function maybeExportSource(source, filename) {
  if (!filename) { skip(`${source}_live_upload`, "Provide an authorized export path in MIGRATION_EXPORT_PATHS_JSON"); return; }
  const prefix = source.toUpperCase().replaceAll("-","_");
  const opts = {dryRun:true,commit:process.env[`${prefix}_LIVE_COMMIT`]==="1",rollback:process.env[`${prefix}_LIVE_ROLLBACK`]==="1"};
  if (!opts.commit || !opts.rollback) { fail(`${source}_live_upload`, `Set ${prefix}_LIVE_COMMIT=1 and ${prefix}_LIVE_ROLLBACK=1 to authorize the complete export rehearsal`); return; }
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size === 0 || info.size > 200*1024*1024) throw new Error("Export must be a regular nonempty file no larger than 200 MiB");
    const bytes = await readFile(filename);
    const uploadID = `qualification-${randomUUID()}`;
    const uploadPath = `/v1/migrations/${source}/uploads/${uploadID}`;
    const fileName = source === "substack" && path.extname(filename).toLowerCase()===".zip" ? "export.zip" : "export.csv";
    for(let offset=0;offset<bytes.length;offset+=4*1024*1024) {
      const part=bytes.subarray(offset,Math.min(offset+4*1024*1024,bytes.length));
      await request(`${uploadPath}?filename=${fileName}`,{method:"PUT",rawBody:part,headers:{"Content-Type":"application/octet-stream","Content-Range":`bytes ${offset}-${offset+part.length-1}/${bytes.length}`}});
    }
    const auth=await request(`${uploadPath}/complete`,{method:"POST"});
    if(!auth.job_id) throw new Error("Completed upload did not return job identity");
    await writeArtifact(source,"upload",{job_id:auth.job_id,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),fixture_origin:"operator_supplied_export"});
    pass(`${source}_live_upload`,"Export uploaded and sealed");
    const discovery=await request(`/v1/migrations/${source}/discover`,{method:"POST",body:{job_id:auth.job_id}});
    await writeArtifact(source,"discovery",{job_id:auth.job_id,discovery:discoveryArtifact(discovery)});
    const preview=await runDryRunCertification(source,auth.job_id,undefined,opts,discovery);
    if(!preview) return;
    await runCommitRollbackCertification(source,auth.job_id,undefined,opts,discovery);
  } catch(err) { fail(`${source}_live_upload`,err.message); }
}

async function checkSources() {
  try {
    const sources = await request("/v1/migrations/sources");
    await writeArtifact("sources", "capabilities", sources);
    const names = new Set(sources.map((s) => s.source));
    const expected = migrationSources;
    const missing = expected.filter((source) => !names.has(source));
    if (missing.length) {
      fail("sources", `missing sources: ${missing.join(", ")}`);
      return;
    }
    pass("sources", "all migration adapters are registered");
  } catch (err) {
    fail("sources", err.message);
  }
}

async function maybeOAuthStart(source, envNames) {
  const missing = envNames.filter((name) => !process.env[name]);
  if (missing.length) {
    skip(
      `${source}_oauth`,
      `set ${missing.join(", ")} to validate OAuth start`,
    );
    return;
  }
  try {
    const body = await request(`/v1/migrations/${source}/oauth/start`, {
      method: "POST",
      body: {},
    });
    if (!body.authorize_url || !body.state) {
      fail(
        `${source}_oauth`,
        "OAuth start did not return authorize_url and state",
      );
      return;
    }
    pass(`${source}_oauth`, "OAuth start returns an authorization URL");
  } catch (err) {
    fail(`${source}_oauth`, err.message);
  }
}

async function maybeCredentialSource(source, opts) {
  if (
    (source === "activecampaign" || source === "hubspot") &&
    ["finish", "cleanup"].includes(opts.sourceEventPhase)
  ) {
    const artifactGuardMessage = liveArtifactGuardMessage(source, opts);
    if (artifactGuardMessage) {
      fail(`${source}_live_artifacts`, artifactGuardMessage);
      return;
    }
    const guardMessage =
      source === "activecampaign"
        ? activeCampaignSourceEventPhaseGuardMessage(opts)
        : hubSpotSourceEventPhaseGuardMessage(opts);
    if (guardMessage) {
      fail(
        `${source}_live_source_events_${opts.sourceEventPhase}`,
        guardMessage,
      );
      return;
    }
    const fullCertificationMessage = hubSpotFullCertificationGuardMessage(
      source,
      opts,
    );
    if (fullCertificationMessage) {
      fail(`${source}_live_full_certification`, fullCertificationMessage);
      return;
    }
    try {
      if (source === "hubspot") {
        if (opts.sourceEventPhase === "cleanup") {
          await runHubSpotSourceEventCleanup(opts);
        } else {
          await runHubSpotSourceEventFinish(opts);
        }
      } else if (opts.sourceEventPhase === "cleanup") {
        await runActiveCampaignSourceEventCleanup(opts);
      } else {
        await runActiveCampaignSourceEventFinish(opts);
      }
    } catch (err) {
      fail(
        `${source}_live_source_events_${opts.sourceEventPhase}`,
        err.message,
      );
    }
    return;
  }
  const unsupportedSourceEventMessage = customerIOSourceEventGuardMessage(
    source,
    opts,
  );
  if (unsupportedSourceEventMessage) {
    fail(`${source}_live_source_events`, unsupportedSourceEventMessage);
    return;
  }
  const missing = missingEnvNames(opts);
  if (missing.length) {
    const liveCredentialError = missingLiveCredentialGuardMessage(
      source,
      opts,
      missing,
    );
    if (liveCredentialError) {
      fail(`${source}_credentials`, liveCredentialError);
      return;
    }
    skip(
      `${source}_credentials`,
      `set ${missing.join(", ")} to validate live credentials`,
    );
    return;
  }
  const preflightGuard = liveCredentialSourcePreflightGuard(source, opts);
  if (preflightGuard) {
    fail(preflightGuard.id, preflightGuard.message);
    return;
  }
  try {
    if (
      (source === "customerio" || source === "hubspot") &&
      opts.requireFullCertification
    ) {
      await writeArtifact(source, "certification-mode", {
        profile: source === "hubspot" ? "full-retained-overlap" : "full",
        ...(source === "hubspot"
          ? { phase: opts.sourceEventPhase || "missing" }
          : {}),
        dry_run: opts.dryRun,
        commit: opts.commit,
        final_full_snapshot_delta: opts.deltaImport,
        post_delta_shadow_check: opts.shadowCheck,
        rollback_rehearsal: opts.rollbackRehearsal,
        pilot_acceptance: opts.pilotAcceptance,
        rollback: opts.rollback,
        manual_review_signoff: opts.manualReviewSignoff,
        credential_cleanup_review: opts.credentialCleanupReview,
        fail_on_discovery_warnings: opts.failOnDiscoveryWarnings,
        fail_on_source_archive_warnings: opts.failOnSourceArchiveWarnings,
        source_events: opts.sourceEvents,
        ...(source === "hubspot"
          ? {
              retained_job_id_present: Boolean(opts.sourceEventJobID),
              minimum_overlap_days: 7,
            }
          : {}),
      });
    }
    const auth = await request(`/v1/migrations/${source}/credentials`, {
      method: "POST",
      body: {
        api_key: opts.apiKey,
        account_id: opts.accountID,
        extra: compact(opts.extra || {}),
      },
    });
    if (!auth.job_id) {
      fail(`${source}_credentials`, "credentials call did not return job_id");
      return;
    }
    if (
      source === "customerio" &&
      String(auth.account_id || "") !== String(opts.accountID || "")
    ) {
      fail(
        `${source}_credentials`,
        "Customer.io credentials response did not preserve the selected numeric workspace ID",
      );
      return;
    }
    if (source === "hubspot") {
      const bindingError = hubSpotCredentialResponseError(auth);
      if (bindingError) {
        fail(`${source}_credentials`, bindingError);
        return;
      }
    }
    await writeArtifact(
      source,
      "credentials",
      credentialArtifact(auth, source),
    );
    const discovery = await request(`/v1/migrations/${source}/discover`, {
      method: "POST",
      body: { job_id: auth.job_id },
    });
    await writeArtifact(source, "discovery", {
      job_id: auth.job_id,
      discovery: discoveryArtifact(discovery),
    });
    if (
      !Array.isArray(discovery.resource_metadata) ||
      discovery.resource_metadata.length === 0
    ) {
      fail(`${source}_discover`, "discovery did not return resource_metadata");
      return;
    }
    if (source === "klaviyo") {
      const capabilityError = klaviyoCapabilityContractError(
        discovery.capabilities,
      );
      if (capabilityError) {
        fail(`${source}_capabilities`, capabilityError);
        return;
      }
      const inventoryError = klaviyoDiscoveryCountContractError(discovery);
      if (inventoryError) {
        fail(`${source}_discovery_inventory`, inventoryError);
        return;
      }
      const staticChecklistError =
        klaviyoStaticChecklistContractError(discovery);
      if (staticChecklistError) {
        fail(`${source}_static_checklists`, staticChecklistError);
        return;
      }
      const multiEmailProfileError =
        klaviyoMultiEmailProfileContractError(discovery);
      if (multiEmailProfileError) {
        fail(`${source}_multi_email_profiles`, multiEmailProfileError);
        return;
      }
    }
    if (source === "customerio") {
      const capabilityError = customerIOCapabilityContractError(
        discovery.capabilities,
      );
      if (capabilityError) {
        fail(`${source}_capabilities`, capabilityError);
        return;
      }
      const inventoryError = customerIODiscoveryCountContractError(discovery);
      if (inventoryError) {
        fail(`${source}_discovery_inventory`, inventoryError);
        return;
      }
      const completenessError =
        customerIODiscoveryCompletenessContractError(discovery);
      if (completenessError) {
        fail(`${source}_resource_completeness`, completenessError);
        return;
      }
    }
    if (!handleDiscoveryWarnings(source, discovery, opts)) {
      return;
    }
    const pilotGuardMessage = livePilotAcceptanceGuardMessage(source, opts);
    if (pilotGuardMessage) {
      fail(`${source}_live_pilot_acceptance`, pilotGuardMessage);
      return;
    }
    const artifactGuardMessage = liveArtifactGuardMessage(source, opts);
    if (artifactGuardMessage) {
      fail(`${source}_live_artifacts`, artifactGuardMessage);
      return;
    }
    let dryRunJobID = "";
    let committedJobID = "";
    // Commit is deliberately gated by a completed dry-run on the same job.
    // Run that prerequisite even when the operator requested only the broader
    // commit certification so the live harness exercises the production
    // lifecycle instead of relying on stale verification evidence.
    if (shouldRunDryRun(opts)) {
      const dryRunJob = await runDryRunCertification(
        source,
        auth.job_id,
        undefined,
        opts,
        discovery,
      );
      if (!dryRunJob) return;
      dryRunJobID = dryRunJob.job_id || dryRunJob.id || "";
      if (opts.pilotAcceptance && !opts.commit) {
        await runPilotAcceptanceCertification(source, dryRunJobID);
      }
    }
    if (opts.commit) {
      const guardMessage = liveCommitGuardMessage(source, opts);
      if (guardMessage) {
        fail(`${source}_live_commit`, guardMessage);
        return;
      }
      const committedJob = await runCommitRollbackCertification(
        source,
        auth.job_id,
        undefined,
        {
          pilotAcceptance: opts.pilotAcceptance,
          rollbackRehearsal: opts.rollbackRehearsal,
          failOnSourceArchiveWarnings: opts.failOnSourceArchiveWarnings,
          shadowCheck: opts.shadowCheck,
          sourceEvents: opts.sourceEvents,
          deltaImport: opts.deltaImport,
          consentExclusionReview: opts.consentExclusionReview,
          consentExclusionEvidenceRef: opts.consentExclusionEvidenceRef,
          deliverabilityReview: opts.deliverabilityReview,
          manualReviewSignoff: opts.manualReviewSignoff,
          manualReviewEvidenceRef: opts.manualReviewEvidenceRef,
          credentialCleanupReview: opts.credentialCleanupReview,
          credentialCleanupEvidenceRef: opts.credentialCleanupEvidenceRef,
          smsReadiness: opts.smsReadiness,
          sourceEventIntervalSeconds: opts.sourceEventIntervalSeconds,
          sourceEventPhase: opts.sourceEventPhase,
          requireFullCertification: opts.requireFullCertification,
        },
        discovery,
      );
      if (!committedJob) return;
      committedJobID = committedJob.job_id || committedJob.id || "";
    } else if (opts.rollbackRehearsal) {
      fail(
        `${source}_live_rollback_rehearsal`,
        `set ${sourceEnvPrefix(source)}_LIVE_COMMIT=1 to certify rollback rehearsal`,
      );
      return;
    } else if (liveSourceEventGuardMessage(source, opts)) {
      fail(
        `${source}_live_source_events`,
        liveSourceEventGuardMessage(source, opts),
      );
      return;
    } else if (liveDeltaImportGuardMessage(source, opts)) {
      fail(
        `${source}_live_delta_import`,
        liveDeltaImportGuardMessage(source, opts),
      );
      return;
    } else if (liveCredentialCleanupGuardMessage(source, opts)) {
      fail(
        `${source}_live_credential_cleanup_review`,
        liveCredentialCleanupGuardMessage(source, opts),
      );
      return;
    } else if (liveConsentExclusionGuardMessage(source, opts)) {
      fail(
        `${source}_live_consent_exclusion_review`,
        liveConsentExclusionGuardMessage(source, opts),
      );
      return;
    } else if (opts.pilotAcceptance && !dryRunJobID) {
      fail(
        `${source}_live_pilot_acceptance`,
        `set ${sourceEnvPrefix(source)}_LIVE_DRY_RUN=1 or ${sourceEnvPrefix(source)}_LIVE_COMMIT=1 to certify pilot acceptance`,
      );
      return;
    }
    if (opts.shadowCheck && !committedJobID) {
      const shadowJobID = dryRunJobID;
      const guardMessage = liveShadowCheckGuardMessage(
        source,
        opts,
        dryRunJobID,
        committedJobID,
      );
      if (guardMessage) {
        fail(`${source}_live_shadow_check`, guardMessage);
        return;
      }
      await runShadowCheckCertification(source, shadowJobID);
    }
    pass(
      `${source}_credentials`,
      `connected and discovered ${discovery.subscribers_count ?? 0} subscribers`,
    );
  } catch (err) {
    fail(`${source}_credentials`, err.message);
  }
}

async function maybeOAuthTokenSource(source, opts) {
  const missing = opts.envNames.filter((name) => {
    if (name === "MAILCHIMP_DC" && process.env.MAILCHIMP_ACCOUNT_ID) {
      return false;
    }
    return !process.env[name];
  });
  if (missing.length) {
    skip(
      `${source}_live_discovery`,
      `set ${missing.join(", ")} to validate live discovery`,
    );
    return;
  }
  try {
    const auth = await request(`/v1/migrations/${source}/credentials`, {
      method: "POST",
      body: {
        access_token: opts.accessToken,
        account_id: opts.accountID,
        refresh_token: opts.refreshToken,
      },
    });
    if (!auth.job_id) {
      fail(
        `${source}_live_discovery`,
        "direct-token credentials call did not return job_id",
      );
      return;
    }
    await writeArtifact(
      source,
      "credentials",
      credentialArtifact(auth, source),
    );
    const discovery = await request(`/v1/migrations/${source}/discover`, {
      method: "POST",
      body: { job_id: auth.job_id },
    });
    await writeArtifact(source, "discovery", {
      job_id: auth.job_id,
      discovery: discoveryArtifact(discovery),
    });
    if (
      !Array.isArray(discovery.resource_metadata) ||
      discovery.resource_metadata.length === 0
    ) {
      fail(
        `${source}_live_discovery`,
        "discovery did not return resource_metadata",
      );
      return;
    }
    if (!handleDiscoveryWarnings(source, discovery, opts)) {
      return;
    }
    const audienceIDs = selectedAudienceIDsFor(
      discovery,
      opts.selectedAudienceIDs,
    );
    if (source === "mailchimp" && shouldRunDryRun(opts) && !audienceIDs?.length) {
      fail(
        `${source}_live_audience_scope`,
        "set MAILCHIMP_AUDIENCE_IDS to one or more explicitly reviewed audience IDs before live dry-run or commit certification",
      );
      return;
    }
    // A live commit is valid only after the same job has produced and exposed
    // a dry-run verification report. Treat that as part of commit
    // certification rather than requiring a second, easy-to-miss flag.
    if (shouldRunDryRun(opts)) {
      const dryRunJob = await runDryRunCertification(
        source,
        auth.job_id,
        audienceIDs,
        opts,
        discovery,
      );
      if (!dryRunJob) return;
    }
    if (opts.commit) {
      const guardMessage = liveCommitGuardMessage(source, opts);
      if (guardMessage) {
        fail(`${source}_live_commit`, guardMessage);
        return;
      }
      const committed = await runCommitRollbackCertification(
        source,
        auth.job_id,
        audienceIDs,
        opts,
        discovery,
      );
      if (!committed) return;
    }
    pass(
      `${source}_live_discovery`,
      `connected and discovered ${discovery.subscribers_count ?? 0} subscribers`,
    );
  } catch (err) {
    fail(`${source}_live_discovery`, err.message);
  }
}

async function runDryRunCertification(
  source,
  jobID,
  selectedAudienceIDs,
  opts = {},
  discovery,
) {
  const started = await request(`/v1/migrations/${source}/dry-run`, {
    method: "POST",
    body: compact({
      job_id: jobID,
      selected_audience_ids: selectedAudienceIDs,
    }),
  });
  const job = await waitForJob(
    started.job_id,
    new Set(["awaiting_confirmation", "failed"]),
    { source, phase: "dry-run" },
  );
  await writeArtifact(source, "dry-run-job", {
    job_id: job.id || started.job_id,
    status: job.status,
    error: errorArtifact(job.error),
    verification_report: verificationReportArtifact(job.verification_report),
  });
  if (job.status === "failed") {
    throw new Error(`dry-run failed: ${job.error || "unknown error"}`);
  }
  if (!job.verification_report) {
    throw new Error("dry-run completed without verification_report");
  }
  if (source === "customerio") {
    const archiveError = customerIOSourceArchiveInventoryContractError(
      job.verification_report,
      discovery,
    );
    if (archiveError) throw new Error(archiveError);
  }
  await writeArtifact(source, "dry-run", {
    job_id: job.id || started.job_id,
    status: job.status,
    verification_report: verificationReportArtifact(job.verification_report),
  });
  if (!handleSourceArchiveWarnings(source, job.verification_report, opts)) {
    return null;
  }
  pass(
    `${source}_live_dry_run`,
    `dry-run verified ${job.verification_report.subscribers_imported ?? 0} imported subscribers in selected scope`,
  );
  return { ...job, job_id: job.id || started.job_id };
}

async function runCommitRollbackCertification(
  source,
  jobID,
  selectedAudienceIDs,
  opts = {},
  discovery,
) {
  const started = await request(`/v1/migrations/${source}/commit`, {
    method: "POST",
    body: compact({
      job_id: jobID,
      selected_audience_ids: selectedAudienceIDs,
    }),
  });
  const committed = await waitForJob(
    started.job_id,
    new Set(["completed", "failed"]),
    { source, phase: "commit" },
  );
  await writeArtifact(source, "commit-job", {
    job_id: committed.id || started.job_id,
    status: committed.status,
    error: errorArtifact(committed.error),
    rollback_until: committed.rollback_until,
    verification_report: verificationReportArtifact(
      committed.verification_report,
    ),
  });
  if (committed.status === "failed") {
    throw new Error(`commit failed: ${committed.error || "unknown error"}`);
  }
  if (!committed.rollback_until) {
    throw new Error("commit completed without rollback window");
  }
  if (!committed.verification_report) {
    throw new Error("commit completed without verification_report");
  }
  if (source === "customerio") {
    const archiveError = customerIOSourceArchiveInventoryContractError(
      committed.verification_report,
      discovery,
    );
    if (archiveError) throw new Error(archiveError);
    const snapshotError = customerIOFullSnapshotContractError(committed);
    if (snapshotError) throw new Error(snapshotError);
  }
  await writeArtifact(source, "commit", {
    job_id: committed.id || started.job_id,
    status: committed.status,
    rollback_until: committed.rollback_until,
    verification_report: verificationReportArtifact(
      committed.verification_report,
    ),
  });
  let postCommitError;
  if (
    !handleSourceArchiveWarnings(source, committed.verification_report, opts)
  ) {
    postCommitError =
      sourceArchiveWarningsPostCommitError(
        source,
        committed.verification_report,
        opts,
      ) ||
      new Error(
        `${source} commit failed strict source archive warning certification`,
      );
  }
  const retainForSourceEventOverlap =
    (source === "activecampaign" || source === "hubspot") &&
    opts.sourceEventPhase === "prepare";
  if (!postCommitError && retainForSourceEventOverlap) {
    try {
      await runRetainedSourceEventPreparation(
        source,
        started.job_id,
        opts.sourceEventIntervalSeconds,
      );
      return { ...committed, job_id: committed.id || started.job_id };
    } catch (err) {
      postCommitError = err;
    }
  }
  const shouldRunPostCommitGates =
    opts.shadowCheck ||
    opts.sourceEvents ||
    opts.deltaImport ||
    opts.consentExclusionReview ||
    opts.deliverabilityReview ||
    opts.manualReviewSignoff ||
    opts.smsReadiness ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal;
  if (
    !postCommitError &&
    shouldRunPostCommitGates &&
    !retainForSourceEventOverlap
  ) {
    try {
      if (opts.sourceEvents) {
        await runSourceEventCertification(
          source,
          started.job_id,
          opts.sourceEventIntervalSeconds,
        );
      }
      if (opts.deltaImport) {
        const deltaJob = await runDeltaImportCertification(
          source,
          started.job_id,
        );
        if (source === "customerio") {
          const rotationError = customerIOImportEpochRotationError(
            committed,
            deltaJob,
          );
          if (rotationError) throw new Error(rotationError);
        }
      }
      // Beehiiv's automation and review evidence must be persisted before the
      // shadow check so rebuild-only resources can be resolved by that check.
      if (opts.manualReviewSignoff) {
        await runManualReviewSignoffCertification(
          source,
          started.job_id,
          opts.manualReviewEvidenceRef,
        );
      }
      const smsReadinessGuard = activeCampaignSMSReadinessGuardMessage(
        source,
        committed.verification_report,
        opts,
      );
      if (smsReadinessGuard) {
        throw new Error(smsReadinessGuard);
      }
      if (
        source === "activecampaign" &&
        opts.smsReadiness &&
        activeCampaignSMSInventoryDetected(committed.verification_report)
      ) {
        await runActiveCampaignSMSReadinessCertification(
          source,
          started.job_id,
        );
      }
      if (opts.shadowCheck) {
        await runShadowCheckCertification(source, started.job_id, {
          expectNoDeltaImport: opts.deltaImport,
        });
      }
      if (opts.rollbackRehearsal) {
        await runRollbackRehearsalCertification(source, started.job_id);
      }
      if (opts.consentExclusionReview) {
        await runActiveCampaignConsentExclusionCertification(
          source,
          started.job_id,
          opts.consentExclusionEvidenceRef,
        );
      }
      if (opts.deliverabilityReview) {
        await runDeliverabilityReviewCertification(source, started.job_id);
      }
      if (opts.pilotAcceptance) {
        await runPilotAcceptanceCertification(source, started.job_id, {
          requirePass:
            source === "activecampaign" ||
            source === "hubspot" ||
            source === "beehiiv" ||
            source === "klaviyo" ||
            source === "customerio",
        });
      }
    } catch (err) {
      postCommitError = err;
    }
  }
  let rollbackError;
  try {
    await runRollbackCleanup(source, started.job_id);
  } catch (err) {
    rollbackError = err;
  }
  let credentialCleanupError;
  if (opts.credentialCleanupReview) {
    try {
      await runCredentialCleanupReviewCertification(
        source,
        started.job_id,
        opts.credentialCleanupEvidenceRef,
      );
    } catch (err) {
      credentialCleanupError = err;
    }
  }
  const error = combinedCertificationError(
    postCommitError,
    rollbackError,
    credentialCleanupError,
  );
  if (error) throw error;
  await runStoredSourceCleanup(source, started.job_id);
  return { ...committed, job_id: committed.id || started.job_id };
}

async function runRollbackCleanup(source, jobID) {
  try {
    await request(`/v1/migrations/${jobID}/rollback`, { method: "POST" });
  } catch (err) {
    await writeArtifact(
      source,
      "rollback-cleanup-start-error",
      rollbackCleanupFailureArtifact(jobID, err),
    );
    throw err;
  }
  const rollback = await waitForRollback(jobID, source);
  await writeArtifact(source, "rollback-cleanup", {
    job_id: jobID,
    rollback: rollbackArtifact(rollback),
  });
  if (rollback.state !== "completed") {
    throw new Error(`rollback failed: ${rollback.error || "unknown error"}`);
  }
  pass(
    `${source}_live_commit_rollback`,
    "commit completed and rollback cleanup completed",
  );
}

function combinedCertificationError(
  postCommitError,
  rollbackError,
  credentialCleanupError,
) {
  let combined = postCommitError || rollbackError || null;
  if (postCommitError && rollbackError) {
    combined = new Error(
      `${postCommitError.message}; rollback cleanup also failed: ${rollbackError.message}`,
    );
  }
  if (combined && credentialCleanupError) {
    return new Error(
      `${combined.message}; credential cleanup review also failed: ${credentialCleanupError.message}`,
    );
  }
  return combined || credentialCleanupError;
}

function handleDiscoveryWarnings(source, discovery, opts = {}) {
  const warnings = Array.isArray(discovery.warnings)
    ? discovery.warnings.filter(Boolean)
    : [];
  if (warnings.length === 0) return true;
  const message = `discovery returned ${warnings.length} warning(s): ${warnings.slice(0, 3).join("; ")}`;
  if (opts.failOnDiscoveryWarnings) {
    fail(`${source}_discovery_warnings`, message);
    return false;
  }
  pass(`${source}_discovery_warnings`, message);
  return true;
}

function handleSourceArchiveWarnings(source, report, opts = {}) {
  const warnings = sourceArchiveWarnings(report);
  if (warnings.length === 0) return true;
  const message = `verification report returned ${warnings.length} source archive warning(s): ${warnings
    .slice(0, 3)
    .map(resourceWarningSummary)
    .join("; ")}`;
  if (opts.failOnSourceArchiveWarnings) {
    fail(`${source}_source_archive_warnings`, message);
    return false;
  }
  pass(`${source}_source_archive_warnings`, message);
  return true;
}

function sourceArchiveWarnings(report) {
  return Array.isArray(report?.source_archive_warnings)
    ? report.source_archive_warnings.filter(Boolean)
    : [];
}

function sourceArchiveWarningsPostCommitError(source, report, opts = {}) {
  if (!opts.failOnSourceArchiveWarnings) return null;
  const warnings = sourceArchiveWarnings(report);
  if (warnings.length === 0) return null;
  return new Error(
    `${source} commit produced ${warnings.length} source archive warning(s) under strict certification; rollback cleanup will still be attempted`,
  );
}

function resourceWarningSummary(warning) {
  const label =
    warning?.name ||
    warning?.source_id ||
    warning?.resource ||
    "source_archive";
  return `${label}: ${warning?.warning || "warning"}`;
}

function activeCampaignManualReviewEvidenceItems(report) {
  if (!Array.isArray(report?.items)) return [];
  return report.items.filter(
    (item) =>
      (item?.status === "warning" &&
        activeCampaignManualReviewEvidenceKeys.has(item?.key)) ||
      (item?.status === "blocker" &&
        activeCampaignBlockerSignoffEvidenceKeys.has(item?.key)),
  );
}

function activeCampaignSMSInventoryDetected(report) {
  const rows = Array.isArray(report?.resource_completeness)
    ? report.resource_completeness
    : [];
  const smsRow = rows.find((row) => row?.resource === "sms");
  if (Number(smsRow?.source_total || 0) > 0) return true;
  return (
    Number(
      report?.source_archive_by_resource?.activecampaign_sms_broadcast || 0,
    ) > 0
  );
}

function activeCampaignSMSReadinessGuardMessage(
  source,
  report,
  opts = {},
  apiConfig = { baseURL: postwaveAPIBaseURL, apiKey: postwaveAPIKey },
) {
  if (
    source !== "activecampaign" ||
    !activeCampaignSMSInventoryDetected(report)
  ) {
    return "";
  }
  if (!opts.smsReadiness) {
    if (!opts.pilotAcceptance && !opts.shadowCheck) return "";
    return "set ACTIVECAMPAIGN_LIVE_SMS_READINESS=1 when ActiveCampaign SMS inventory is detected so the harness verifies /api/v1/sms/pilot-readiness before recording sms_readiness evidence";
  }
  if (!apiConfig.baseURL) {
    return "set POSTWAVE_API_URL with ACTIVECAMPAIGN_LIVE_SMS_READINESS=1 so the harness can query /api/v1/sms/pilot-readiness";
  }
  if (!apiConfig.apiKey) {
    return "set POSTWAVE_API_KEY to a tenant API key with read:reports scope; sms_readiness evidence is recorded only after /api/v1/sms/pilot-readiness passes";
  }
  return "";
}

function smsPilotReadinessCertificationError(readiness) {
  if (!readiness || typeof readiness !== "object") {
    return "SMS pilot readiness did not return a report";
  }
  if (!Array.isArray(readiness.items) || readiness.items.length === 0) {
    return "SMS pilot readiness did not return readiness items";
  }
  const nonPassing = readiness.items.filter((item) => item?.status !== "pass");
  if (readiness.can_pilot !== true || nonPassing.length > 0) {
    const keys = nonPassing
      .map((item) => String(item?.key || "unknown"))
      .slice(0, 5)
      .join(", ");
    return `SMS pilot readiness must pass before sms_readiness evidence is recorded${keys ? `; non-passing checks: ${keys}` : ""}`;
  }
  return "";
}

function pilotAcceptanceCertificationError(source, report, opts = {}) {
  if (!Array.isArray(report.items)) {
    return "pilot-acceptance did not return review items";
  }
  if (!["pass", "warning", "blocker"].includes(report.status)) {
    return "pilot-acceptance returned an unknown status";
  }
  if (report.status === "blocker") {
    return `pilot acceptance has ${report.blockers ?? 0} blocker(s); resolve before live certification`;
  }
  if (opts.requirePass && report.status !== "pass") {
    const label = sourceDisplayName(source);
    return `${label} pilot acceptance must be pass for live certification; got ${report.status} with ${report.warnings ?? 0} warning(s)`;
  }
  return "";
}

async function runPilotAcceptanceCertification(source, jobID, opts = {}) {
  const report = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  const error = pilotAcceptanceCertificationError(source, report, opts);
  if (error) {
    await writeArtifact(source, "pilot-acceptance", {
      job_id: jobID,
      report: pilotAcceptanceArtifact(report),
    });
    throw new Error(error);
  }
  await writeArtifact(source, "pilot-acceptance", {
    job_id: jobID,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_pilot_acceptance`,
    `pilot acceptance returned ${report.status} with ${report.warnings ?? 0} warning(s)`,
  );
}

async function runManualReviewSignoffCertification(source, jobID, evidenceRef) {
  if (source === "hubspot") {
    return runHubSpotManualReviewSignoffCertification(
      source,
      jobID,
      evidenceRef,
    );
  }
  if (source === "customerio") {
    return runCustomerIOManualReviewSignoffCertification(
      source,
      jobID,
      evidenceRef,
    );
  }
  if (source === "klaviyo") {
    return runKlaviyoManualReviewSignoffCertification(
      source,
      jobID,
      evidenceRef,
    );
  }
  if (source === "beehiiv") {
    return runBeehiivManualReviewSignoffCertification(
      source,
      jobID,
      evidenceRef,
    );
  }
  if (source !== "activecampaign") return;
  const before = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  if (!Array.isArray(before.items)) {
    throw new Error("pilot-acceptance did not return review items");
  }
  const items = activeCampaignManualReviewEvidenceItems(before);
  const recordedKeys = [];
  let report = before;
  for (const item of items) {
    report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
      method: "PATCH",
      body: {
        key: item.key,
        status: "pass",
        detail: `Live certification operator reviewed ${item.label || item.key} after final delta import.`,
        evidence: [
          "ACTIVECAMPAIGN_LIVE_MANUAL_REVIEW_SIGNOFF=1",
          "Operator-held rebuild/out-of-scope evidence is attached to the confidential cutover record.",
        ],
      },
    });
    if (!Array.isArray(report.items)) {
      throw new Error("cutover-evidence did not return pilot acceptance items");
    }
    const recorded = report.items.find((entry) => entry?.key === item.key);
    if (!recorded || recorded.status !== "pass") {
      await writeArtifact(source, "manual-review-signoff", {
        job_id: jobID,
        before_report: pilotAcceptanceArtifact(before),
        attempted_key: item.key,
        report: pilotAcceptanceArtifact(report),
      });
      throw new Error(
        `manual review sign-off evidence did not pass pilot acceptance for ${item.key}`,
      );
    }
    recordedKeys.push(item.key);
  }
  await writeArtifact(source, "manual-review-signoff", {
    job_id: jobID,
    before_report: pilotAcceptanceArtifact(before),
    recorded_keys: recordedKeys,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_manual_review_signoff`,
    recordedKeys.length > 0
      ? `recorded ${recordedKeys.length} manual-review sign-off item(s)`
      : "no warning-level manual-review items needed sign-off",
  );
}

async function runHubSpotManualReviewSignoffCertification(
  source,
  jobID,
  evidenceRef,
) {
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceError = manualReviewEvidenceRefError(source, evidenceReference);
  if (evidenceError) throw new Error(evidenceError);
  const report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: "hubspot_crm_bridge_scope_review",
      status: "pass",
      detail:
        "Operator reviewed all 14 post-final-snapshot HubSpot bridge scope rows: excluded non-email/additional-email identities, non-materialized contact-property definitions, source-owned dynamic-list predicates that Moosewave deliberately does not fetch or store, workflows, marketing email/archive, templates, reports, forms, landing pages, ecommerce, SMS, custom objects, and other CRM objects; complete communication-preference and current-primary-email eligibility coverage passed separately, and every scope dependency has rebuild, export, retention, or retirement ownership.",
      evidence: [
        `evidence_ref=${evidenceReference}`,
        "HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF=1",
        "The eleven unsupported/rule-boundary source_total=1 rows are non-additive static checklist items, not provider inventory or proof of absence; three additional identity/property boundary rows carry exact discovery counts.",
      ],
    },
  });
  if (!Array.isArray(report?.items)) {
    throw new Error("cutover-evidence did not return pilot acceptance items");
  }
  const item = report.items.find(
    (candidate) => candidate?.key === "hubspot_crm_bridge_scope_review",
  );
  if (!item || item.status !== "pass") {
    await writeArtifact(source, "manual-review-signoff", {
      job_id: jobID,
      evidence_ref: evidenceReference,
      report: pilotAcceptanceArtifact(report),
    });
    throw new Error(
      "HubSpot CRM-bridge scope review evidence did not pass pilot acceptance",
    );
  }
  await writeArtifact(source, "manual-review-signoff", {
    job_id: jobID,
    evidence_ref: evidenceReference,
    recorded_keys: ["hubspot_crm_bridge_scope_review"],
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_manual_review_signoff`,
    "recorded the post-final-snapshot HubSpot CRM-bridge scope review",
  );
}

async function runBeehiivManualReviewSignoffCertification(
  source,
  jobID,
  evidenceRef,
) {
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceError = manualReviewEvidenceRefError(source, evidenceReference);
  if (evidenceError) throw new Error(evidenceError);

  const before = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  if (!Array.isArray(before.items)) {
    throw new Error("pilot-acceptance did not return review items");
  }
  const reviewKeys = new Set([
    "beehiiv_consent_reconciliation",
    "beehiiv_segment_rules_review",
    "beehiiv_campaign_archive_fidelity",
    "beehiiv_automation_retirement_review",
    "beehiiv_website_capture_rebuild_review",
    "beehiiv_boosts_recommendations_rebuild_review",
    "beehiiv_ad_network_review",
  ]);
  const recordedKeys = [];
  let report = before;
  for (const item of before.items.filter(
    (candidate) =>
      reviewKeys.has(candidate?.key) && candidate?.status !== "pass",
  )) {
    report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
      method: "PATCH",
      body: {
        key: item.key,
        status: "pass",
        detail:
          item.key === "beehiiv_automation_retirement_review"
            ? "Operator inventoried every running Beehiiv automation, paused or retired the source flow, captured the final journey snapshot, and assigned destination activation ownership after final delta reconciliation."
            : `Operator completed ${item.label || item.key} against the final Beehiiv export after delta reconciliation.`,
        evidence: [
          `evidence_ref=${evidenceReference}`,
          "BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF=1",
        ],
      },
    });
    const recorded = report?.items?.find(
      (candidate) => candidate?.key === item.key,
    );
    if (!recorded || recorded.status !== "pass") {
      throw new Error(`Beehiiv review evidence did not pass ${item.key}`);
    }
    recordedKeys.push(item.key);
  }

  const rebuildResponse = await request(
    `/v1/migrations/${jobID}/automation-rebuilds`,
  );
  if (!Array.isArray(rebuildResponse?.items)) {
    throw new Error("automation-rebuilds did not return review items");
  }
  const rebuilds = rebuildResponse.items;
  for (const rebuild of rebuilds) {
    if (
      ["test_passed", "approved_not_needed"].includes(rebuild?.status) &&
      String(rebuild?.test_evidence || "").trim()
    ) {
      continue;
    }
    const updated = await request(
      `/v1/migrations/${jobID}/automation-rebuilds`,
      {
        method: "PATCH",
        body: {
          rank: rebuild.rank,
          name: rebuild.name,
          source_id: rebuild.source_id || undefined,
          status: "test_passed",
          owner: "live-migration-operator",
          notes:
            "Beehiiv API metadata was rebuilt or deliberately retired; no source workflow was activated automatically.",
          test_evidence: `evidence_ref=${evidenceReference}`,
        },
      },
    );
    if (
      updated?.rank !== rebuild.rank ||
      updated?.status !== "test_passed" ||
      !String(updated?.test_evidence || "").trim()
    ) {
      throw new Error(
        `Beehiiv automation rebuild evidence did not pass rank ${rebuild.rank}`,
      );
    }
    recordedKeys.push(`automation_rank_${rebuild.rank}`);
  }

  const finalRebuildResponse = await request(
    `/v1/migrations/${jobID}/automation-rebuilds`,
  );
  const rebuildError =
    beehiivAutomationRebuildsCertificationError(finalRebuildResponse);
  if (rebuildError) throw new Error(rebuildError);

  report = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  await writeArtifact(source, "manual-review-signoff", {
    job_id: jobID,
    evidence_ref: evidenceReference,
    recorded_keys: recordedKeys,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_manual_review_signoff`,
    `recorded ${recordedKeys.length} Beehiiv consent, campaign, segment, or automation review item(s)`,
  );
}

async function runCustomerIOManualReviewSignoffCertification(
  source,
  jobID,
  evidenceRef,
) {
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceError = manualReviewEvidenceRefError(source, evidenceReference);
  if (evidenceError) throw new Error(evidenceError);

  const before = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  const contractError = customerIOCutoverReviewContractError(before);
  if (contractError) throw new Error(contractError);

  const details = {
    customerio_consent_subscription_review:
      "Operator proved email enablement requires global subscribed state, resolved email-channel subscribed/default state, and the applicable topic subscribed/default state after the final Customer.io snapshot; ESP blocks/bounces/spam reports/invalid emails and GDPR suppression/export gaps were reconciled, profile creation time was not treated as consent, and sender-specific SMS/WhatsApp /v1/optouts remained separate non-email evidence.",
    customerio_identity_audience_review:
      "Operator reconciled immutable cio_id ownership, duplicate-email profiles, email moves, deletions and profiles that lost email, final segment/topic memberships, and rebuild or retirement of every dynamic audience rule after the final Customer.io snapshot.",
    customerio_automation_rebuild_review:
      "Operator rebuilt, tested, retained, or retired every required Customer.io Automation/Campaign, API Broadcast, action graph, transactional trigger, and Design Studio dependency; no preserved definition was activated automatically.",
    customerio_channel_dependency_review:
      "Operator inventoried and migrated, retained, or retired SMS, push, in-app, Slack, WhatsApp, webhook, phone/device identity, sender registration, consent, quiet-hour, and routing dependencies.",
    customerio_deliverability_review:
      "Operator verified destination sender identities, domains, DNS, branded links, SSL, dedicated-IP routing and warmup, bounce/complaint handling, suppression continuity, and rollback ownership.",
    customerio_ecosystem_dependencies_review:
      "Operator reconciled Customer.io objects/relationships, events and Data Pipelines, reporting webhooks, connected destinations, forms, commerce, content libraries, retained analytics/export access, and every static checklist without treating checklist rows as provider inventory.",
  };
  const evidenceMarkers = {
    customerio_consent_subscription_review:
      "global_topic_esp_channel_consent=reviewed",
    customerio_identity_audience_review:
      "cio_id_duplicate_email_snapshot=reviewed",
    customerio_automation_rebuild_review:
      "automation_broadcast_transactional_rebuild=reviewed",
    customerio_channel_dependency_review: "non_email_channels=reviewed",
    customerio_deliverability_review: "sender_domain_suppression=reviewed",
    customerio_ecosystem_dependencies_review:
      "object_event_export_dependencies=reviewed",
  };

  const recordedKeys = [];
  let report = before;
  for (const key of customerIOManualReviewEvidenceKeys) {
    report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
      method: "PATCH",
      body: {
        key,
        status: "pass",
        detail: details[key],
        evidence: [
          `evidence_ref=${evidenceReference}`,
          "CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF=1",
          "final_full_snapshot=reviewed",
          evidenceMarkers[key],
          ...(key === "customerio_ecosystem_dependencies_review"
            ? [
                "static_checklist_count=8",
                "static_checklists_are_inventory=false",
              ]
            : []),
        ],
      },
    });
    const recorded = report?.items?.find((item) => item?.key === key);
    if (!recorded || recorded.status !== "pass") {
      throw new Error(`Customer.io review evidence did not pass ${key}`);
    }
    recordedKeys.push(key);
  }

  report = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  const recordedContractError = customerIOCutoverReviewContractError(report, {
    requireRecordedEvidence: true,
  });
  if (recordedContractError) throw new Error(recordedContractError);
  await writeArtifact(source, "manual-review-signoff", {
    job_id: jobID,
    evidence_ref: evidenceReference,
    recorded_keys: recordedKeys,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_manual_review_signoff`,
    "recorded all six post-final-snapshot Customer.io cutover reviews",
  );
}

async function runKlaviyoManualReviewSignoffCertification(
  source,
  jobID,
  evidenceRef,
) {
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceError = manualReviewEvidenceRefError(source, evidenceReference);
  if (evidenceError) throw new Error(evidenceError);

  const rebuildResponse = await request(
    `/v1/migrations/${jobID}/automation-rebuilds`,
  );
  if (!Array.isArray(rebuildResponse?.items)) {
    throw new Error("automation-rebuilds did not return review items");
  }
  const recordedKeys = [];
  for (const rebuild of rebuildResponse.items) {
    if (
      ["test_passed", "approved_not_needed"].includes(rebuild?.status) &&
      String(rebuild?.test_evidence || "").trim()
    ) {
      continue;
    }
    const updated = await request(
      `/v1/migrations/${jobID}/automation-rebuilds`,
      {
        method: "PATCH",
        body: {
          rank: rebuild.rank,
          name: rebuild.name,
          source_id: rebuild.source_id || undefined,
          status: "test_passed",
          owner: "live-migration-operator",
          notes:
            "Klaviyo flow evidence was rebuilt and tested or deliberately retired; no source flow was activated automatically.",
          test_evidence: `evidence_ref=${evidenceReference}`,
        },
      },
    );
    if (
      updated?.rank !== rebuild.rank ||
      updated?.status !== "test_passed" ||
      !String(updated?.test_evidence || "").trim()
    ) {
      throw new Error(
        `Klaviyo flow rebuild evidence did not pass rank ${rebuild.rank}`,
      );
    }
    recordedKeys.push(`automation_rank_${rebuild.rank}`);
  }

  const finalRebuildResponse = await request(
    `/v1/migrations/${jobID}/automation-rebuilds`,
  );
  const rebuildError =
    klaviyoAutomationRebuildsCertificationError(finalRebuildResponse);
  if (rebuildError) throw new Error(rebuildError);

  const before = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  if (!Array.isArray(before.items)) {
    throw new Error("pilot-acceptance did not return review items");
  }
  const multiEmailReviewError = klaviyoMultiEmailReviewContractError(before);
  if (multiEmailReviewError) throw new Error(multiEmailReviewError);
  const reviewKeys = new Set([
    "klaviyo_consent_suppression_review",
    "klaviyo_audience_snapshot_review",
    "klaviyo_flow_rebuild_review",
    "klaviyo_channel_identity_review",
    "klaviyo_deliverability_review",
    "klaviyo_ecosystem_dependencies_review",
    "source_discovery_warnings",
    "source_archive_warnings",
  ]);
  const multiEmailReviewKeys = new Set([
    "klaviyo_consent_suppression_review",
    "klaviyo_ecosystem_dependencies_review",
  ]);
  let report = before;
  for (const item of before.items.filter(
    (candidate) =>
      reviewKeys.has(candidate?.key) &&
      (candidate?.status !== "pass" ||
        multiEmailReviewKeys.has(candidate?.key)),
  )) {
    const isMultiEmailReview = multiEmailReviewKeys.has(item.key);
    const isEcosystemReview =
      item.key === "klaviyo_ecosystem_dependencies_review";
    report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
      method: "PATCH",
      body: {
        key: item.key,
        status: "pass",
        detail: isEcosystemReview
          ? `Operator reconciled Klaviyo Multi-Email Profile secondary identities against a provider export or retained Klaviyo access, reviewed nullable flow/draft-message definitions and campaign tag IDs, and closed all eight unconditional static checklist obligations without treating them as source inventory after the frozen final delta.`
          : isMultiEmailReview
            ? `Operator reconciled Klaviyo Multi-Email Profile secondary identities and independent per-address consent/suppression against a provider export or retained Klaviyo access after the frozen final delta, and attached that review to ${item.label || item.key}.`
            : `Operator completed ${item.label || item.key} against the frozen final Klaviyo snapshot after delta reconciliation.`,
        evidence: [
          `evidence_ref=${evidenceReference}`,
          "KLAVIYO_LIVE_MANUAL_REVIEW_SIGNOFF=1",
          ...(isMultiEmailReview
            ? ["source_archive_resource=multi_email_profiles"]
            : []),
          ...(isEcosystemReview
            ? [
                "static_checklist_count=8",
                "static_checklists_are_inventory=false",
                "nullable_definitions=reviewed",
                "campaign_tags=id_only",
              ]
            : []),
        ],
      },
    });
    const recorded = report?.items?.find(
      (candidate) => candidate?.key === item.key,
    );
    if (!recorded || recorded.status !== "pass") {
      throw new Error(`Klaviyo review evidence did not pass ${item.key}`);
    }
    recordedKeys.push(item.key);
  }

  report = await request(`/v1/migrations/${jobID}/pilot-acceptance`);
  const recordedMultiEmailReviewError = klaviyoMultiEmailReviewContractError(
    report,
    { requireRecordedEvidence: true },
  );
  if (recordedMultiEmailReviewError) {
    throw new Error(recordedMultiEmailReviewError);
  }
  const recordedEcosystemGapError =
    klaviyoEcosystemGapReviewContractError(report);
  if (recordedEcosystemGapError) {
    throw new Error(recordedEcosystemGapError);
  }
  await writeArtifact(source, "manual-review-signoff", {
    job_id: jobID,
    evidence_ref: evidenceReference,
    recorded_keys: recordedKeys,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_manual_review_signoff`,
    `recorded ${recordedKeys.length} Klaviyo audience, identity/consent, flow, channel, deliverability, or ecosystem review item(s)`,
  );
}

function beehiivAutomationRebuildsCertificationError(response) {
  return automationRebuildsCertificationError("Beehiiv automation", response);
}

function klaviyoAutomationRebuildsCertificationError(response) {
  return automationRebuildsCertificationError("Klaviyo flow", response);
}

function automationRebuildsCertificationError(label, response) {
  if (!Array.isArray(response?.items)) {
    return "automation-rebuilds did not return review items";
  }
  const incomplete = response.items.filter(
    (item) =>
      !["test_passed", "approved_not_needed"].includes(item?.status) ||
      !String(item?.test_evidence || "").trim(),
  );
  if (incomplete.length > 0) {
    const ranks = incomplete
      .map((item) => String(item?.rank || "unknown"))
      .slice(0, 10)
      .join(", ");
    return `${label} rebuild review remains incomplete for rank(s): ${ranks}`;
  }
  return "";
}

async function runActiveCampaignSMSReadinessCertification(source, jobID) {
  if (source !== "activecampaign") return;
  const readiness = await postwaveAPIRequest("/api/v1/sms/pilot-readiness");
  await writeArtifact(source, "sms-pilot-readiness", {
    job_id: jobID,
    readiness: smsPilotReadinessArtifact(readiness),
  });
  const readinessError = smsPilotReadinessCertificationError(readiness);
  if (readinessError) {
    throw new Error(readinessError);
  }

  // Do not move this PATCH above the readiness validation. sms_readiness is
  // provider/runtime evidence, not an operator waiver or blanket sign-off.
  const passingKeys = readiness.items.map((item) => String(item.key)).sort();
  const report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: "sms_readiness",
      status: "pass",
      detail:
        "Moosewave SMS pilot readiness returned can_pilot=true after final delta import.",
      evidence: [
        "ACTIVECAMPAIGN_LIVE_SMS_READINESS=1",
        `passing_readiness_checks=${passingKeys.join(",")}`,
      ],
    },
  });
  if (!Array.isArray(report.items)) {
    throw new Error("cutover-evidence did not return pilot acceptance items");
  }
  const item = report.items.find((entry) => entry?.key === "sms_readiness");
  if (!item || item.status !== "pass") {
    await writeArtifact(source, "sms-readiness-evidence", {
      job_id: jobID,
      report: pilotAcceptanceArtifact(report),
    });
    throw new Error(
      "verified SMS readiness evidence did not pass pilot acceptance",
    );
  }
  await writeArtifact(source, "sms-readiness-evidence", {
    job_id: jobID,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_sms_readiness`,
    "SMS pilot readiness passed before sms_readiness cutover evidence was recorded",
  );
}

async function runDeliverabilityReviewCertification(source, jobID) {
  const report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: "activecampaign_deliverability_review",
      status: "pass",
      detail:
        "Live certification operator verified sending domains, tracking links, suppression policy, forms, webhooks, and sender readiness after final delta import.",
      evidence: [
        "ACTIVECAMPAIGN_LIVE_DELIVERABILITY_REVIEW=1",
        "Operator-held DNS/sender evidence is attached to the confidential cutover record.",
      ],
    },
  });
  if (!Array.isArray(report.items)) {
    throw new Error("cutover-evidence did not return pilot acceptance items");
  }
  const item = report.items.find(
    (entry) => entry?.key === "activecampaign_deliverability_review",
  );
  if (!item || item.status !== "pass") {
    await writeArtifact(source, "deliverability-review", {
      job_id: jobID,
      report: pilotAcceptanceArtifact(report),
    });
    throw new Error(
      "deliverability review evidence did not pass pilot acceptance",
    );
  }
  await writeArtifact(source, "deliverability-review", {
    job_id: jobID,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_deliverability_review`,
    "deliverability review evidence recorded after final delta import",
  );
}

async function runActiveCampaignConsentExclusionCertification(
  source,
  jobID,
  evidenceRef,
) {
  if (source !== "activecampaign") return;
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceReferenceError =
    activeCampaignConsentExclusionEvidenceRefError(evidenceReference);
  if (evidenceReferenceError) throw new Error(evidenceReferenceError);
  const report = await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: "activecampaign_consent_exclusion_review",
      status: "pass",
      detail:
        "Live certification operator reconciled email/SMS consent by channel, ActiveCampaign exclusions, email-less contact handling, and the final source-ID-to-email plus source-owned tag/list mappings after the overlap/final-delta window.",
      evidence: [
        "ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1",
        `evidence_ref=${evidenceReference}`,
        "Unknown-consent contacts remain unconfirmed; phone-only contacts are review evidence and were not fabricated into email subscribers.",
        "Previously imported source-ID-to-email and source-owned tag/list mappings were compared with the reviewed final source export/audit; destination identities for removed contacts or stale pre-change emails were disabled, exactly one current identity remained per source ID, and exclusion-covered targeting tags were removed.",
      ],
    },
  });
  if (!Array.isArray(report.items)) {
    throw new Error("cutover-evidence did not return pilot acceptance items");
  }
  const item = report.items.find(
    (entry) => entry?.key === "activecampaign_consent_exclusion_review",
  );
  if (!item || item.status !== "pass") {
    await writeArtifact(source, "consent-exclusion-review", {
      job_id: jobID,
      report: pilotAcceptanceArtifact(report),
    });
    throw new Error(
      "consent/exclusion review evidence did not pass pilot acceptance",
    );
  }
  await writeArtifact(source, "consent-exclusion-review", {
    job_id: jobID,
    evidence_ref: evidenceReference,
    report: pilotAcceptanceArtifact(report),
  });
  pass(
    `${source}_live_consent_exclusion_review`,
    "channel consent and exclusion reconciliation evidence recorded after final delta import",
  );
}

async function runCredentialCleanupReviewCertification(
  source,
  jobID,
  evidenceRef,
) {
  if (
    source !== "activecampaign" &&
    source !== "hubspot" &&
    source !== "beehiiv" &&
    source !== "klaviyo" &&
    source !== "customerio"
  )
    return;
  const evidenceReference = String(evidenceRef || "").trim();
  const evidenceReferenceError = credentialCleanupEvidenceRefError(
    source,
    evidenceReference,
  );
  if (evidenceReferenceError) {
    throw new Error(evidenceReferenceError);
  }
  await writeArtifact(source, "credential-cleanup-review", {
    job_id: jobID,
    reviewed: true,
    evidence_ref: evidenceReference,
    evidence: credentialCleanupEvidenceLines(source),
  });
  pass(
    `${source}_live_credential_cleanup_review`,
    "credential cleanup/reset evidence recorded after rollback cleanup",
  );
}

function credentialCleanupEvidenceLines(source) {
  const prefix = sourceEnvPrefix(source);
  if (source === "hubspot") {
    return [
      `${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1`,
      "Operator revoked or rotated the dedicated HubSpot private app access token after bridge cutover rehearsal.",
      "Operator verified follow-up source access fails safely or shows reconnect guidance and attached proof to the confidential bridge record.",
    ];
  }
  if (source === "beehiiv") {
    return [
      `${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1`,
      "Operator revoked or rotated the dedicated Beehiiv migration API key after rollback certification.",
      "Operator verified the retired key cannot access the bound workspace/publication and attached proof to the confidential cutover record.",
    ];
  }
  if (source === "klaviyo") {
    return [
      `${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1`,
      "Operator revoked or rotated the dedicated Klaviyo private API key after rollback certification.",
      "Operator verified the retired key cannot access the bound Klaviyo account and attached proof to the confidential cutover record.",
    ];
  }
  if (source === "customerio") {
    return [
      `${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1`,
      "Operator revoked or rotated the dedicated Customer.io App API key after rollback certification.",
      "Operator verified the retired key cannot access the bound US/EU workspace and attached proof to the confidential cutover record.",
    ];
  }
  return [
    `${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1`,
    "Operator reset or revoked the dedicated ActiveCampaign migration user's API token after cutover rehearsal.",
    "Operator verified follow-up source access fails safely and reconnect guidance is attached to the confidential cutover record.",
  ];
}

async function runRollbackRehearsalCertification(source, jobID) {
  const report = await request(`/v1/migrations/${jobID}/rollback-rehearsal`);
  const error = rollbackRehearsalCertificationError(source, report);
  if (error) {
    await writeArtifact(source, "rollback-rehearsal", {
      job_id: jobID,
      report: rollbackRehearsalArtifact(report),
    });
    throw new Error(error);
  }
  await writeArtifact(source, "rollback-rehearsal", {
    job_id: jobID,
    report: rollbackRehearsalArtifact(report),
  });
  pass(
    `${source}_live_rollback_rehearsal`,
    `rollback rehearsal returned ${report.status}`,
  );
}

async function runShadowCheckCertification(source, jobID, opts = {}) {
  const check = await request(`/v1/migrations/${source}/shadow-check`, {
    method: "POST",
    body: { job_id: jobID },
  });
  if (!Array.isArray(check.deltas)) {
    throw new Error("shadow-check did not return resource deltas");
  }
  if (!check.recommended_action) {
    throw new Error("shadow-check did not return recommended_action");
  }
  await writeArtifact(source, "shadow-check", {
    job_id: jobID,
    check: shadowCheckArtifact(check),
  });
  const deltaError = shadowCheckDeltaError(check, opts, source);
  if (deltaError) throw new Error(deltaError);
  pass(
    `${source}_live_shadow_check`,
    `shadow check returned ${check.deltas.length} resource deltas with action ${check.recommended_action}`,
  );
}

async function runRetainedSourceEventPreparation(
  source,
  jobID,
  intervalSeconds,
) {
  if (source !== "activecampaign" && source !== "hubspot") {
    throw new Error(
      `retained source-event preparation is not supported for ${source}`,
    );
  }
  const label = sourceDisplayName(source);
  const prefix = sourceEnvPrefix(source);
  let monitorStarted = false;
  let preparationError;
  try {
    const response = await request(`/v1/migrations/${source}/source-events`, {
      method: "POST",
      body: {
        job_id: jobID,
        interval_seconds: intervalSeconds,
      },
    });
    monitorStarted = true;
    const responseError = sourceEventResponseError(response, jobID);
    if (responseError) throw new Error(responseError);
    await writeArtifact(source, "source-events-prepare", {
      job_id: jobID,
      response: sourceEventArtifact(response),
      finish_env: {
        [`${prefix}_LIVE_SOURCE_EVENT_PHASE`]: "finish",
        [`${prefix}_LIVE_SOURCE_EVENT_JOB_ID`]: jobID,
      },
    });
    const monitorError = sourceEventMonitorError(response);
    if (monitorError) throw new Error(monitorError);
    const preparationMessage = sourceEventPreparationError(
      response,
      intervalSeconds,
      source,
    );
    if (preparationMessage) throw new Error(preparationMessage);
    pass(
      `${source}_live_source_events_prepare`,
      `retained an enabled ${label} contact-change monitor; retrieve the job ID only from the confidential prepare artifact, wait at least seven days, resolve pending manual-review rows, then run finish with the same interval`,
    );
    return response;
  } catch (err) {
    preparationError = err;
  }

  let cleanupError;
  if (monitorStarted) {
    try {
      await cleanupSourceEventCertificationMonitor(source, jobID);
    } catch (err) {
      await writeArtifact(
        source,
        "source-events-cleanup-error",
        sourceEventCleanupFailureArtifact(jobID, err),
      );
      cleanupError = err;
    }
  }
  throw combinedSourceEventCertificationError(preparationError, cleanupError);
}

async function runActiveCampaignSourceEventFinish(opts) {
  await requireRetainedCandidateEvidence("activecampaign", opts.sourceEventJobID);
  const source = "activecampaign";
  const jobID = String(opts.sourceEventJobID || "").trim();
  const job = await request(`/v1/migrations/${jobID}`);
  if (job?.id !== jobID || job?.source !== source) {
    throw new Error(
      "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID did not resolve to the retained ActiveCampaign migration job",
    );
  }
  if (job.status !== "completed" || !job.verification_report) {
    throw new Error(
      `retained ActiveCampaign job must be completed with a verification report before finish; got ${job.status || "unknown"}`,
    );
  }
  const rollbackWindowMessage = activeCampaignFinishRollbackWindowError(job);
  if (rollbackWindowMessage) throw new Error(rollbackWindowMessage);

  const before = await request(`/v1/migrations/${jobID}/source-events`);
  await writeArtifact(source, "source-events-finish-preflight", {
    job_id: jobID,
    response: sourceEventArtifact(before),
  });
  assertSourceEventFinishReady(
    before,
    jobID,
    opts.sourceEventIntervalSeconds,
    source,
  );

  await request(`/v1/migrations/${source}/source-events`, {
    method: "POST",
    body: {
      job_id: jobID,
      interval_seconds: opts.sourceEventIntervalSeconds,
    },
  });
  const synced = await request(`/v1/migrations/${jobID}/source-events`);
  await writeArtifact(source, "source-events-finish-sync", {
    job_id: jobID,
    response: sourceEventArtifact(synced),
  });
  assertSourceEventFinishReady(
    synced,
    jobID,
    opts.sourceEventIntervalSeconds,
    source,
  );
  pass(
    `${source}_live_source_events`,
    "the retained job proved at least seven days of continuous successful source-event polling and a clean final sync",
  );

  let postCommitError;
  try {
    const deltaJob = await runDeltaImportCertification(source, jobID);
    const finalReport =
      deltaJob?.verification_report || job.verification_report;
    const smsReadinessGuard = activeCampaignSMSReadinessGuardMessage(
      source,
      finalReport,
      opts,
    );
    if (smsReadinessGuard) throw new Error(smsReadinessGuard);
    if (opts.smsReadiness && activeCampaignSMSInventoryDetected(finalReport)) {
      await runActiveCampaignSMSReadinessCertification(source, jobID);
    }
    await runShadowCheckCertification(source, jobID, {
      expectNoDeltaImport: true,
    });
    await runRollbackRehearsalCertification(source, jobID);
    await runActiveCampaignConsentExclusionCertification(
      source,
      jobID,
      opts.consentExclusionEvidenceRef,
    );
    await runDeliverabilityReviewCertification(source, jobID);
    await runActiveCampaignManualReviewSignoffCertification(source, jobID);
    await runPilotAcceptanceCertification(source, jobID, {
      requirePass: true,
    });
    await recordActiveCampaignPostPilotCleanupAuthorization(jobID);
  } catch (err) {
    postCommitError = err;
  }

  if (!sourceEventFinishCleanupAllowed(postCommitError)) {
    await writeArtifact(
      source,
      "source-events-finish-retryable",
      sourceEventFinishRetryArtifact(jobID, postCommitError),
    );
    throw postCommitError;
  }
  await completeActiveCampaignPostPilotCleanup(opts);
  await runStoredSourceCleanup("activecampaign", opts.sourceEventJobID);
  pass(
    `${source}_live_source_events_finish`,
    "captured final-delta/pilot evidence, completed rollback, disabled source-event polling, and recorded credential-cleanup evidence",
  );
}

async function runActiveCampaignSourceEventCleanup(opts) {
  await completeActiveCampaignPostPilotCleanup(opts);
  await runStoredSourceCleanup("activecampaign", opts.sourceEventJobID);
  pass(
    "activecampaign_live_source_events_cleanup",
    "resumed post-pilot cleanup without rerunning source overlap or final delta",
  );
}

async function runHubSpotSourceEventFinish(opts) {
  await requireRetainedCandidateEvidence("hubspot", opts.sourceEventJobID);
  const source = "hubspot";
  const jobID = String(opts.sourceEventJobID || "").trim();
  const job = await request(`/v1/migrations/${jobID}`);
  if (job?.id !== jobID || job?.source !== source) {
    throw new Error(
      "HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID did not resolve to the retained HubSpot migration job",
    );
  }
  if (job.status !== "completed" || !job.verification_report) {
    throw new Error(
      `retained HubSpot job must be completed with a verification report before finish; got ${job.status || "unknown"}`,
    );
  }
  const rollbackWindowMessage = retainedFinishRollbackWindowError(source, job);
  if (rollbackWindowMessage) throw new Error(rollbackWindowMessage);

  const before = await request(`/v1/migrations/${jobID}/source-events`);
  await writeArtifact(source, "source-events-finish-preflight", {
    job_id: jobID,
    response: sourceEventArtifact(before),
  });
  assertSourceEventFinishReady(
    before,
    jobID,
    opts.sourceEventIntervalSeconds,
    source,
  );

  await request(`/v1/migrations/${source}/source-events`, {
    method: "POST",
    body: {
      job_id: jobID,
      interval_seconds: opts.sourceEventIntervalSeconds,
    },
  });
  const synced = await request(`/v1/migrations/${jobID}/source-events`);
  await writeArtifact(source, "source-events-finish-sync", {
    job_id: jobID,
    response: sourceEventArtifact(synced),
  });
  assertSourceEventFinishReady(
    synced,
    jobID,
    opts.sourceEventIntervalSeconds,
    source,
  );
  pass(
    `${source}_live_source_events`,
    "the retained job proved at least seven days of continuous successful contact-change polling and a clean final sync",
  );

  let postCommitError;
  try {
    await runDeltaImportCertification(source, jobID);
    await runShadowCheckCertification(source, jobID, {
      expectNoDeltaImport: true,
    });
    await runRollbackRehearsalCertification(source, jobID);
    await runManualReviewSignoffCertification(
      source,
      jobID,
      opts.manualReviewEvidenceRef,
    );
    await runPilotAcceptanceCertification(source, jobID, {
      requirePass: true,
    });
    await recordHubSpotPostPilotCleanupAuthorization(jobID);
  } catch (err) {
    postCommitError = err;
  }
  if (postCommitError) {
    await writeArtifact(
      source,
      "source-events-finish-retryable",
      sourceEventFinishRetryArtifact(jobID, postCommitError),
    );
    throw postCommitError;
  }

  await completeHubSpotPostPilotCleanup(opts);
  await runStoredSourceCleanup("hubspot", opts.sourceEventJobID);
  pass(
    `${source}_live_source_events_finish`,
    "captured final full-snapshot/pilot evidence, completed rollback, disabled contact-change polling, and recorded credential-cleanup evidence",
  );
}

async function runHubSpotSourceEventCleanup(opts) {
  await completeHubSpotPostPilotCleanup(opts);
  await runStoredSourceCleanup("hubspot", opts.sourceEventJobID);
  pass(
    "hubspot_live_source_events_cleanup",
    "resumed post-pilot cleanup without rerunning retained overlap or final full-snapshot evidence",
  );
}

async function completeHubSpotPostPilotCleanup(opts) {
  const source = "hubspot";
  const jobID = String(opts.sourceEventJobID || "").trim();
  const job = await request(`/v1/migrations/${jobID}`);
  if (job?.id !== jobID || job?.source !== source) {
    throw new Error(
      "HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID did not resolve to the retained HubSpot migration job",
    );
  }
  const plan = hubSpotSourceEventCleanupPlan(job.status, {
    cleanupAuthorized: hubSpotPostPilotCleanupAuthorizationError(job) === "",
  });
  if (plan.error) throw new Error(plan.error);
  await writeArtifact(source, "source-events-cleanup-preflight", {
    job_id: jobID,
    job_status: job.status,
    pilot_revalidation_required: plan.verifyPilot,
    monitor_disable_required_before_rollback: true,
    local_source_session_cleanup_required: true,
    rollback_retry_required: plan.runRollback,
  });

  if (plan.verifyPilot) {
    await runPilotAcceptanceCertification(source, jobID, {
      requirePass: true,
    });
    await recordHubSpotPostPilotCleanupAuthorization(jobID);
  }
  try {
    await cleanupSourceEventCertificationMonitor(source, jobID, {
      postPilotCleanup: true,
      requireSourceSessionCleared: true,
    });
    await requireDurableHubSpotCleanupStart(jobID);
  } catch (err) {
    await writeArtifact(
      source,
      "source-events-cleanup-error",
      sourceEventCleanupFailureArtifact(jobID, err),
    );
    await writeArtifact(
      source,
      "source-events-cleanup-retryable",
      sourceEventCleanupRetryArtifact(
        jobID,
        "monitor_and_session_cleanup",
        err,
        { rollbackCompleted: !plan.runRollback },
      ),
    );
    throw err;
  }
  try {
    if (plan.runRollback) {
      await runRollbackCleanup(source, jobID);
    }
    await requireDurableHubSpotRollbackCompletion(jobID);
  } catch (err) {
    await writeArtifact(
      source,
      "source-events-cleanup-retryable",
      sourceEventCleanupRetryArtifact(jobID, "rollback", err),
    );
    throw err;
  }
  await runCredentialCleanupReviewCertification(
    source,
    jobID,
    opts.credentialCleanupEvidenceRef,
  );
}

function hubSpotSourceEventCleanupPlan(
  status,
  { cleanupAuthorized = false } = {},
) {
  switch (status) {
    case "completed":
      return {
        verifyPilot: !cleanupAuthorized,
        runRollback: true,
        error: "",
      };
    case "rolling_back":
      return cleanupAuthorized
        ? { verifyPilot: false, runRollback: true, error: "" }
        : {
            verifyPilot: false,
            runRollback: false,
            error:
              "rolling-back HubSpot cleanup is missing durable post-pilot authorization",
          };
    case "rolled_back":
      return cleanupAuthorized
        ? { verifyPilot: false, runRollback: false, error: "" }
        : {
            verifyPilot: false,
            runRollback: false,
            error:
              "rolled-back HubSpot cleanup is missing durable post-pilot authorization",
          };
    default:
      return {
        verifyPilot: false,
        runRollback: false,
        error: `retained HubSpot cleanup requires a completed, rolling_back, or rolled_back job; got ${status || "unknown"}`,
      };
  }
}

async function completeActiveCampaignPostPilotCleanup(opts) {
  const source = "activecampaign";
  const jobID = String(opts.sourceEventJobID || "").trim();
  const job = await request(`/v1/migrations/${jobID}`);
  if (job?.id !== jobID || job?.source !== source) {
    throw new Error(
      "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID did not resolve to the retained ActiveCampaign migration job",
    );
  }
  const plan = activeCampaignSourceEventCleanupPlan(job.status, {
    cleanupAuthorized:
      activeCampaignPostPilotCleanupAuthorizationError(job) === "",
  });
  if (plan.error) throw new Error(plan.error);
  await writeArtifact(source, "source-events-cleanup-preflight", {
    job_id: jobID,
    job_status: job.status,
    pilot_revalidation_required: plan.verifyPilot,
    rollback_retry_required: plan.runRollback,
    monitor_disable_required_before_rollback: true,
  });
  if (plan.verifyPilot) {
    await runPilotAcceptanceCertification(source, jobID, {
      requirePass: true,
    });
    await recordActiveCampaignPostPilotCleanupAuthorization(jobID);
  }
  try {
    await cleanupSourceEventCertificationMonitor(source, jobID, {
      postPilotCleanup: true,
    });
    await requireDurableActiveCampaignCleanupStart(jobID);
  } catch (err) {
    await writeArtifact(
      source,
      "source-events-cleanup-error",
      sourceEventCleanupFailureArtifact(jobID, err),
    );
    await writeArtifact(
      source,
      "source-events-cleanup-retryable",
      sourceEventCleanupRetryArtifact(jobID, "monitor_disable", err, {
        rollbackCompleted: !plan.runRollback,
      }),
    );
    throw err;
  }
  try {
    if (plan.runRollback) {
      await runRollbackCleanup(source, jobID);
    }
    await requireDurableActiveCampaignRollbackCompletion(jobID);
  } catch (err) {
    await writeArtifact(
      source,
      "source-events-cleanup-retryable",
      sourceEventCleanupRetryArtifact(jobID, "rollback", err),
    );
    throw err;
  }
  await runCredentialCleanupReviewCertification(
    source,
    jobID,
    opts.credentialCleanupEvidenceRef,
  );
}

function activeCampaignSourceEventCleanupPlan(
  status,
  { cleanupAuthorized = false } = {},
) {
  switch (status) {
    case "completed":
      return {
        verifyPilot: !cleanupAuthorized,
        runRollback: true,
        error: "",
      };
    case "rolling_back":
      return cleanupAuthorized
        ? { verifyPilot: false, runRollback: true, error: "" }
        : {
            verifyPilot: false,
            runRollback: false,
            error:
              "rolling-back ActiveCampaign cleanup is missing durable post-pilot authorization",
          };
    case "rolled_back":
      return cleanupAuthorized
        ? { verifyPilot: false, runRollback: false, error: "" }
        : {
            verifyPilot: false,
            runRollback: false,
            error:
              "rolled-back ActiveCampaign cleanup is missing durable post-pilot authorization",
          };
    default:
      return {
        verifyPilot: false,
        runRollback: false,
        error: `retained ActiveCampaign cleanup requires a completed, rolling_back, or rolled_back job; got ${status || "unknown"}`,
      };
  }
}

function activeCampaignCleanupOnlyContractError() {
  const implementation = completeActiveCampaignPostPilotCleanup.toString();
  const forbidden = [
    "runSourceEventCertification",
    "runDeltaImportCertification",
    "runShadowCheckCertification",
    "runRollbackRehearsalCertification",
    "runActiveCampaignConsentExclusionCertification",
    "runDeliverabilityReviewCertification",
    "runActiveCampaignManualReviewSignoffCertification",
  ];
  const found = forbidden.filter((name) => implementation.includes(name));
  return found.length > 0
    ? `cleanup-only implementation contains forbidden operation(s): ${found.join(", ")}`
    : "";
}

async function recordActiveCampaignPostPilotCleanupAuthorization(jobID) {
  await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: activeCampaignPostPilotCleanupEvidenceKey,
      status: "pass",
      detail:
        "Strict ActiveCampaign pilot acceptance passed; rollback and monitor cleanup are authorized without rerunning final delta.",
      evidence: ["live-harness:strict-pilot-pass"],
    },
  });
}

async function recordHubSpotPostPilotCleanupAuthorization(jobID) {
  await request(`/v1/migrations/${jobID}/cutover-evidence`, {
    method: "PATCH",
    body: {
      key: hubSpotPostPilotCleanupEvidenceKey,
      status: "pass",
      detail:
        "Strict HubSpot pilot acceptance passed; local source-session deletion, rollback, and external private-app token cleanup are authorized without rerunning the final full snapshot.",
      evidence: ["live-harness:strict-pilot-pass"],
    },
  });
}

function hubSpotPostPilotCleanupAuthorizationError(job) {
  const cursor = job?.cursor || {};
  const prefix =
    "hubspot_cutover_evidence_" + hubSpotPostPilotCleanupEvidenceKey;
  if (cursor[`${prefix}_status`] !== "pass") {
    return "durable HubSpot post-pilot cleanup authorization is missing";
  }
  const reviewedAtMs = Date.parse(
    String(cursor[`${prefix}_reviewed_at`] || ""),
  );
  const completedAtMs = Date.parse(String(job?.completed_at || ""));
  if (
    !Number.isFinite(reviewedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    reviewedAtMs < completedAtMs
  ) {
    return "durable HubSpot post-pilot cleanup authorization is stale for the latest final full snapshot";
  }
  if (!cursor.source_event_overlap_snapshot_v1) {
    return "durable HubSpot post-pilot cleanup authorization is missing source-event overlap binding";
  }
  return "";
}

async function requireDurableHubSpotCleanupStart(jobID) {
  const job = await request(`/v1/migrations/${jobID}`);
  const error = durableHubSpotCleanupStartError(job, jobID);
  if (error) throw new Error(error);
}

function durableHubSpotCleanupStartError(job, jobID) {
  if (job?.id !== jobID || job?.source !== "hubspot") {
    return "cleanup start could not be bound to the retained HubSpot job";
  }
  const authorizationError = hubSpotPostPilotCleanupAuthorizationError(job);
  if (authorizationError) return authorizationError;
  for (const [key, label] of [
    [hubSpotPostPilotCleanupStartedAtKey, "cleanup-start"],
    [
      hubSpotPostPilotSourceSessionClearedAtKey,
      "local source-session deletion",
    ],
  ]) {
    if (!Number.isFinite(Date.parse(String(job?.cursor?.[key] || "")))) {
      return `HubSpot ${label} was not durably recorded; do not begin rollback or external token cleanup`;
    }
  }
  if (job.source_session_expires_at) {
    return "HubSpot local source session still appears available after post-pilot cleanup";
  }
  return "";
}

async function requireDurableHubSpotRollbackCompletion(jobID) {
  const job = await request(`/v1/migrations/${jobID}`);
  const error = durableHubSpotRollbackCompletionError(job, jobID);
  if (error) throw new Error(error);
}

function durableHubSpotRollbackCompletionError(job, jobID) {
  if (job?.id !== jobID || job?.source !== "hubspot") {
    return "rollback completion could not be bound to the retained HubSpot job";
  }
  const cleanupError = durableHubSpotCleanupStartError(job, jobID);
  if (cleanupError) return cleanupError;
  if (job.status !== "rolled_back" || job.rollback_until) {
    return "HubSpot rollback progress completed but durable job state is not rolled_back with its rollback deadline cleared; retry cleanup before recording credential-cleanup evidence";
  }
  return "";
}

function activeCampaignPostPilotCleanupAuthorizationError(job) {
  const cursor = job?.cursor || {};
  const prefix =
    "activecampaign_cutover_evidence_" +
    activeCampaignPostPilotCleanupEvidenceKey;
  if (cursor[`${prefix}_status`] !== "pass") {
    return "durable post-pilot cleanup authorization is missing";
  }
  const reviewedAtMs = Date.parse(
    String(cursor[`${prefix}_reviewed_at`] || ""),
  );
  const completedAtMs = Date.parse(String(job?.completed_at || ""));
  if (
    !Number.isFinite(reviewedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    reviewedAtMs < completedAtMs
  ) {
    return "durable post-pilot cleanup authorization is stale for the latest final delta";
  }
  if (!cursor.source_event_overlap_snapshot_v1) {
    return "durable post-pilot cleanup authorization is missing source-event overlap binding";
  }
  return "";
}

async function requireDurableActiveCampaignCleanupStart(jobID) {
  const job = await request(`/v1/migrations/${jobID}`);
  const error = durableActiveCampaignCleanupStartError(job, jobID);
  if (error) throw new Error(error);
}

function durableActiveCampaignCleanupStartError(job, jobID) {
  if (job?.id !== jobID || job?.source !== "activecampaign") {
    return "cleanup start could not be bound to the retained ActiveCampaign job";
  }
  const authorizationError =
    activeCampaignPostPilotCleanupAuthorizationError(job);
  if (authorizationError) return authorizationError;
  const startedAtMs = Date.parse(
    String(job?.cursor?.[activeCampaignPostPilotCleanupStartedAtKey] || ""),
  );
  if (!Number.isFinite(startedAtMs)) {
    return "source-event monitor was disabled without a durable ActiveCampaign cleanup-start claim; do not begin rollback";
  }
  return "";
}

async function requireDurableActiveCampaignRollbackCompletion(jobID) {
  const job = await request(`/v1/migrations/${jobID}`);
  const error = durableActiveCampaignRollbackCompletionError(job, jobID);
  if (error) throw new Error(error);
}

function durableActiveCampaignRollbackCompletionError(job, jobID) {
  if (job?.id !== jobID || job?.source !== "activecampaign") {
    return "rollback completion could not be bound to the retained ActiveCampaign job";
  }
  if (job.status !== "rolled_back" || job.rollback_until) {
    return "rollback progress completed but durable job state is not rolled_back with its rollback deadline cleared; retry cleanup before recording credential-cleanup evidence";
  }
  return "";
}

function sourceEventCleanupRetryArtifact(
  jobID,
  stage,
  error,
  { rollbackCompleted = false } = {},
) {
  return {
    job_id: jobID,
    stage,
    cleanup_only_retry: true,
    monitor_verified_disabled: stage === "rollback",
    monitor_disable_retry_required: stage === "monitor_disable",
    rollback_completed: rollbackCompleted,
    overlap_and_final_delta_reuse: true,
    error: errorArtifact(error?.message || error),
  };
}

function sourceEventFinishCleanupAllowed(postCommitError) {
  return !postCommitError;
}

function activeCampaignFinishRequiredRollbackHeadroomMs(
  waitMs = liveWaitMs,
  rateLimitExtensionMs = liveRateLimitMaxExtensionMs,
  rateLimitGraceMs = liveRateLimitGraceMs,
) {
  const finalDeltaBudgetMs = waitMs + rateLimitExtensionMs + rateLimitGraceMs;
  const rollbackCleanupBudgetMs = waitMs;
  return finalDeltaBudgetMs + rollbackCleanupBudgetMs;
}

function activeCampaignFinishRollbackWindowError(
  job,
  referenceTimeMs = Date.now(),
  requiredHeadroomMs = activeCampaignFinishRequiredRollbackHeadroomMs(),
) {
  return retainedFinishRollbackWindowError(
    "activecampaign",
    job,
    referenceTimeMs,
    requiredHeadroomMs,
  );
}

function retainedFinishRollbackWindowError(
  source,
  job,
  referenceTimeMs = Date.now(),
  requiredHeadroomMs = activeCampaignFinishRequiredRollbackHeadroomMs(),
) {
  const label = sourceDisplayName(source);
  const rollbackUntilMs = Date.parse(String(job?.rollback_until || ""));
  if (!Number.isFinite(rollbackUntilMs)) {
    return `retained ${label} job has no valid rollback deadline; do not start final delta on an unrollbackable base import`;
  }
  if (rollbackUntilMs - referenceTimeMs < requiredHeadroomMs) {
    return `retained ${label} job does not have enough rollback-window headroom for final delta; do not mutate it, and start a new isolated prepare run or follow the recovery runbook`;
  }
  return "";
}

function sourceEventFinishRetryArtifact(jobID, error) {
  return {
    job_id: jobID,
    monitor_retained: true,
    rollback_deferred: true,
    retry_after_resolution: true,
    error: errorArtifact(error?.message || error),
  };
}

function assertSourceEventFinishReady(
  response,
  jobID,
  intervalSeconds,
  source = "activecampaign",
) {
  const responseError = sourceEventResponseError(response, jobID);
  if (responseError) throw new Error(responseError);
  const configuredInterval =
    normalizeSourceEventIntervalSeconds(intervalSeconds);
  if (response.monitor.interval_seconds !== configuredInterval) {
    const prefix = sourceEnvPrefix(source);
    throw new Error(
      `retained source-event monitor interval is ${response.monitor.interval_seconds}s; rerun finish with ${prefix}_LIVE_SOURCE_EVENT_INTERVAL_SECONDS=${response.monitor.interval_seconds} so overlap evidence is not reset`,
    );
  }
  const monitorError = sourceEventMonitorError(response);
  if (monitorError) throw new Error(monitorError);
  const overlapError = sourceEventContinuousOverlapError(source, response);
  if (overlapError) throw new Error(overlapError);
  const resolutionError = sourceEventResolutionError(response, source);
  if (resolutionError) throw new Error(resolutionError);
}

function sourceEventResponseError(response, jobID) {
  if (!response?.monitor || response.monitor.job_id !== jobID) {
    return "source-events did not return the requested monitor";
  }
  if (!Array.isArray(response.events)) {
    return "source-events did not return event results";
  }
  return "";
}

function sourceEventPreparationError(
  response,
  intervalSeconds,
  source = "activecampaign",
) {
  const label = sourceDisplayName(source);
  const monitor = response?.monitor;
  if (!monitor?.enabled) {
    return `${label} source-event prepare did not leave the monitor enabled`;
  }
  if (
    monitor.interval_seconds !==
    normalizeSourceEventIntervalSeconds(intervalSeconds)
  ) {
    return `${label} source-event prepare returned an unexpected monitor interval`;
  }
  const enabledSince = Date.parse(String(monitor.enabled_since || ""));
  const firstSync = Date.parse(String(monitor.first_successful_sync_at || ""));
  const lastSync = Date.parse(String(monitor.last_synced_at || ""));
  if (
    !Number.isFinite(enabledSince) ||
    !Number.isFinite(firstSync) ||
    !Number.isFinite(lastSync) ||
    Number(monitor.successful_sync_count) < 1
  ) {
    return `${label} source-event prepare did not persist its initial successful-sync evidence`;
  }
  return "";
}

function sourceEventResolutionError(response, source = "activecampaign") {
  const label = sourceDisplayName(source);
  const events = Array.isArray(response?.events) ? response.events : [];
  let automaticFailures = 0;
  let pendingManualReviews = 0;
  for (const event of events) {
    if (event?.applied === true && !event?.error) continue;
    const manualReview =
      event?.applied !== true && event?.action === "manual_review";
    if (manualReview && sourceEventManualReviewComplete(event)) continue;
    if (manualReview) pendingManualReviews += 1;
    else automaticFailures += 1;
  }
  if (automaticFailures > 0) {
    return `${label} source-event finish found ${automaticFailures} unresolved automatic replay failure(s); fix replay and retry finish without disabling the retained monitor`;
  }
  if (pendingManualReviews > 0) {
    return `${label} source-event finish found ${pendingManualReviews} pending manual-review row(s); record non-secret reconciliation evidence with PATCH /v1/migrations/{job}/source-events/{result UUID}/review, then retry finish`;
  }
  return "";
}

function sourceEventManualReviewComplete(event) {
  return (
    event?.review_status === "reviewed" &&
    Boolean(event?.reviewed_at) &&
    String(event?.review_detail || "").trim().length > 0 &&
    Array.isArray(event?.review_evidence) &&
    event.review_evidence.length > 0
  );
}

function normalizeSourceEventIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) return 300;
  if (seconds < 60) return 60;
  if (seconds > 24 * 60 * 60) return 24 * 60 * 60;
  return seconds;
}

async function runSourceEventCertification(source, jobID, intervalSeconds) {
  let monitorStarted = false;
  let certificationError;
  try {
    const response = await request(`/v1/migrations/${source}/source-events`, {
      method: "POST",
      body: compact({
        job_id: jobID,
        interval_seconds: intervalSeconds,
      }),
    });
    if (!response.monitor || response.monitor.job_id !== jobID) {
      throw new Error("source-events did not return the requested monitor");
    }
    monitorStarted = true;
    if (!Array.isArray(response.events)) {
      throw new Error("source-events did not return event results");
    }
    await writeArtifact(source, "source-events", {
      job_id: jobID,
      response: sourceEventArtifact(response),
    });
    const monitorError = sourceEventMonitorError(response);
    if (monitorError) {
      throw new Error(monitorError);
    }
    pass(
      `${source}_live_source_events`,
      `source-event monitor synced ${response.monitor.events_seen ?? 0} source events and applied ${response.monitor.events_applied ?? 0}`,
    );
  } catch (err) {
    certificationError = err;
  }

  let cleanupError;
  if (monitorStarted) {
    try {
      await cleanupSourceEventCertificationMonitor(source, jobID);
    } catch (err) {
      await writeArtifact(
        source,
        "source-events-cleanup-error",
        sourceEventCleanupFailureArtifact(jobID, err),
      );
      cleanupError = err;
    }
  }
  const error = combinedSourceEventCertificationError(
    certificationError,
    cleanupError,
  );
  if (error) throw error;
}

async function cleanupSourceEventCertificationMonitor(
  source,
  jobID,
  { postPilotCleanup = false, requireSourceSessionCleared = false } = {},
) {
  let disableRequestError;
  let disableResponse;
  try {
    const cleanupQuery = postPilotCleanup ? "?post_pilot_cleanup=1" : "";
    disableResponse = await request(
      `/v1/migrations/${jobID}/source-events${cleanupQuery}`,
      {
        method: "DELETE",
      },
    );
  } catch (err) {
    // The response can be lost after the server commits the disable. Resolve
    // the ambiguity with a read instead of re-enabling or failing prematurely.
    disableRequestError = err;
  }
  let response;
  try {
    response = await request(`/v1/migrations/${jobID}/source-events`);
  } catch (verifyErr) {
    if (disableRequestError) {
      throw new Error(
        `${disableRequestError.message}; source-event monitor disable verification also failed: ${verifyErr.message}`,
      );
    }
    throw verifyErr;
  }
  const verificationError = sourceEventMonitorDisableVerificationError(
    response,
    jobID,
  );
  if (verificationError) {
    throw new Error(
      disableRequestError
        ? `${disableRequestError.message}; ${verificationError}`
        : verificationError,
    );
  }
  if (
    requireSourceSessionCleared &&
    !disableRequestError &&
    disableResponse?.source_session_cleared !== true
  ) {
    throw new Error(
      "HubSpot post-pilot monitor cleanup did not confirm local source-session deletion",
    );
  }
  await writeArtifact(source, "source-events-cleanup", {
    job_id: jobID,
    disabled: true,
    verified_disabled: true,
    source_session_cleared:
      disableResponse?.source_session_cleared === true ||
      (requireSourceSessionCleared && Boolean(disableRequestError)),
    disable_response_lost: Boolean(disableRequestError),
  });
  pass(
    `${source}_live_source_events_cleanup`,
    "source-event monitor disabled after certification sync",
  );
}

function sourceEventMonitorDisableVerificationError(response, jobID) {
  if (response?.monitor?.job_id !== jobID) {
    return "source-event monitor disable verification returned the wrong job";
  }
  if (response.monitor.enabled !== false) {
    return "source-event monitor disable was not durably observable; cleanup remains incomplete";
  }
  return "";
}

function combinedSourceEventCertificationError(
  certificationError,
  cleanupError,
) {
  if (certificationError && cleanupError) {
    return new Error(
      `${certificationError.message}; source-event monitor cleanup also failed: ${cleanupError.message}`,
    );
  }
  return certificationError || cleanupError;
}

async function runDeltaImportCertification(source, jobID) {
  const started = await request(`/v1/migrations/${source}/delta-import`, {
    method: "POST",
    body: { job_id: jobID },
  });
  const job = await waitForJob(
    started.job_id || jobID,
    new Set(["completed", "failed"]),
    { source, phase: "delta-import" },
  );
  await writeArtifact(source, "delta-import-job", {
    job_id: job.id || started.job_id || jobID,
    status: job.status,
    cursor: cursorArtifact(job.cursor),
    error: errorArtifact(job.error),
    verification_report: verificationReportArtifact(job.verification_report),
  });
  if (job.status === "failed") {
    throw new Error(`delta import failed: ${job.error || "unknown error"}`);
  }
  if (
    job.error &&
    String(job.error).toLowerCase().includes("delta import failed")
  ) {
    throw new Error(job.error);
  }
  if (job.cursor?.delta_import_last_error) {
    throw new Error(job.cursor.delta_import_last_error);
  }
  if (!job.verification_report) {
    throw new Error("delta import completed without verification_report");
  }
  if (source === "customerio") {
    const snapshotError = customerIOFullSnapshotContractError(job);
    if (snapshotError) throw new Error(snapshotError);
  }
  await writeArtifact(source, "delta-import", {
    job_id: job.id || started.job_id || jobID,
    status: job.status,
    cursor: cursorArtifact(job.cursor),
    error: errorArtifact(job.error),
    verification_report: verificationReportArtifact(job.verification_report),
  });
  pass(
    `${source}_live_delta_import`,
    `delta import completed with ${job.verification_report.subscribers_imported ?? 0} imported subscribers`,
  );
  return { ...job, job_id: job.id || started.job_id || jobID };
}

async function waitForJob(jobID, terminalStatuses, opts = {}) {
  const startedAt = Date.now();
  let deadline = startedAt + liveWaitMs;
  const maxDeadline = deadline + liveRateLimitMaxExtensionMs;
  let last;
  while (Date.now() < deadline) {
    last = await request(`/v1/migrations/${jobID}`);
    if (terminalStatuses.has(last.status)) return last;
    const pause = rateLimitPauseFromJob(last);
    if (pause && pause.retry_at_ms > Date.now()) {
      const retryDeadline = Math.min(
        maxDeadline,
        pause.retry_at_ms + liveRateLimitGraceMs,
      );
      if (retryDeadline > deadline) {
        deadline = retryDeadline;
      }
    }
    await sleep(2000);
  }
  await writeArtifact(opts.source || "job", `${opts.phase || "job"}-timeout`, {
    job_id: jobID,
    status: last?.status || "unknown",
    cursor: cursorArtifact(last?.cursor),
    error: errorArtifact(last?.error),
    rate_limit: rateLimitPauseArtifact(last),
  });
  throw new Error(jobTimeoutMessage(jobID, last));
}

async function waitForRollback(jobID, source = "rollback") {
  const deadline = Date.now() + liveWaitMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await request(`/v1/migrations/${jobID}/rollback-status`);
    } catch (err) {
      await writeArtifact(
        source,
        "rollback-cleanup-poll-error",
        rollbackCleanupFailureArtifact(jobID, err, last),
      );
      throw err;
    }
    if (last.state === "completed" || last.state === "failed") return last;
    await sleep(2000);
  }
  await writeArtifact(source, "rollback-cleanup-timeout", {
    job_id: jobID,
    last_state: last?.state || "unknown",
    rollback: rollbackArtifact(last),
  });
  throw new Error(
    `timed out waiting for rollback ${jobID}; last state ${last?.state || "unknown"}`,
  );
}

function selectedAudienceIDsFor(discovery, configured) {
  const selected = [
    ...new Set(
      (configured || []).map((id) => String(id || "").trim()).filter(Boolean),
    ),
  ].sort();
  if (selected.length === 0) return undefined;
  const audiences = Array.isArray(discovery.audiences)
    ? discovery.audiences
    : [];
  const available = new Set(
    audiences.map((audience) => String(audience?.id || "").trim()),
  );
  const missing = selected.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(
      `configured Mailchimp audience ID(s) were not discovered: ${missing.join(", ")}`,
    );
  }
  return selected;
}

function shouldRunDryRun(opts = {}) {
  return opts.dryRun === true || opts.commit === true;
}

function liveCommitGuardMessage(source, opts) {
  if (
    (source === "activecampaign" || source === "hubspot") &&
    opts.sourceEventPhase === "prepare"
  ) {
    return "";
  }
  return opts.commit && !opts.rollback
    ? liveRollbackRequiredMessageFor(source)
    : "";
}

function liveRollbackRequiredMessageFor(source) {
  const prefix = sourceEnvPrefix(source);
  return `set ${prefix}_LIVE_ROLLBACK=1 with ${prefix}_LIVE_COMMIT=1 so live certification proves cleanup`;
}

function liveSourceEventGuardMessage(source, opts) {
  if (!opts.sourceEvents || opts.commit) return "";
  return `set ${sourceEnvPrefix(source)}_LIVE_COMMIT=1 so source-event certification runs against a completed import`;
}

function customerIOSourceEventGuardMessage(source, opts = {}) {
  if (source !== "customerio" || !opts.sourceEvents) return "";
  return "Customer.io does not expose a complete incremental profile change feed for migration certification; unset CUSTOMERIO_LIVE_SOURCE_EVENTS and use CUSTOMERIO_LIVE_DELTA_IMPORT=1 for the authoritative final full snapshot";
}

function customerIOCredentialConfigError(source, opts = {}) {
  if (source !== "customerio") return "";
  const workspaceID = String(opts.accountID || "").trim();
  if (!/^[0-9]{1,64}$/u.test(workspaceID)) {
    return "CUSTOMERIO_WORKSPACE_ID must be an explicit numeric workspace ID returned by /v1/workspaces";
  }
  const region = String(opts.extra?.region || "").trim();
  if (!["us", "eu"].includes(region)) {
    return "CUSTOMERIO_REGION must be exactly us or eu";
  }
  if (
    String(opts.extra?.customerio_workspace_id || "").trim() !== workspaceID
  ) {
    return "Customer.io account_id and customerio_workspace_id must select the same numeric workspace";
  }
  return "";
}

function hubSpotCredentialConfigError(source, opts = {}) {
  if (source !== "hubspot") return "";
  const accountID = String(opts.accountID || "").trim();
  if (accountID && !/^[0-9]{1,64}$/u.test(accountID)) {
    return "HUBSPOT_HUB_ID must be a numeric Hub ID of 1 to 64 digits";
  }
  const extraHubID = String(opts.extra?.hub_id || "").trim();
  if (accountID && extraHubID !== accountID) {
    return "HubSpot account_id and extra.hub_id must select the same Hub ID";
  }
  return "";
}

function hubSpotCredentialResponseError(auth) {
  return String(auth?.account_id || "") === "[redacted-hubspot-portal]"
    ? ""
    : "HubSpot credentials response did not confirm a provider-verified, redacted portal binding";
}

function activeCampaignSourceEventPhaseGuardMessage(opts = {}) {
  const phase = String(opts.sourceEventPhase || "")
    .trim()
    .toLowerCase();
  const jobID = String(opts.sourceEventJobID || "").trim();
  if (!phase) {
    if (jobID) {
      return "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=finish when ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID is provided";
    }
    if (opts.sourceEvents) {
      return "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume a post-pilot rollback/monitor cleanup";
    }
    return "";
  }
  if (!["prepare", "finish", "cleanup"].includes(phase)) {
    return "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE must be prepare, finish, or cleanup";
  }
  if (!opts.sourceEvents) {
    return `set ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1 with ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=${phase}`;
  }
  if (
    !Number.isInteger(opts.sourceEventIntervalSeconds) ||
    opts.sourceEventIntervalSeconds <= 0
  ) {
    return "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_INTERVAL_SECONDS must be a positive whole number of seconds";
  }
  if (phase === "prepare") {
    if (!opts.commit) {
      return "set ACTIVECAMPAIGN_LIVE_COMMIT=1 for the source-event prepare phase";
    }
    if (opts.rollback) {
      return "unset ACTIVECAMPAIGN_LIVE_ROLLBACK during the prepare phase so the committed job and monitor remain available for the overlap";
    }
    if (jobID) {
      return "unset ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID during prepare; the new retained job ID is written to the prepare artifact";
    }
    if (
      opts.deltaImport ||
      opts.shadowCheck ||
      opts.rollbackRehearsal ||
      opts.consentExclusionReview ||
      opts.deliverabilityReview ||
      opts.manualReviewSignoff ||
      opts.smsReadiness ||
      opts.pilotAcceptance ||
      opts.credentialCleanupReview
    ) {
      return "the ActiveCampaign prepare phase accepts only discovery/dry-run/commit/source-event flags; run final delta, reviews, pilot acceptance, cleanup, and rollback in the finish phase";
    }
    return "";
  }
  if (!jobID) {
    return "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID to the retained job ID emitted by the prepare phase";
  }
  if (opts.commit || opts.dryRun) {
    return `unset ACTIVECAMPAIGN_LIVE_COMMIT and ACTIVECAMPAIGN_LIVE_DRY_RUN during ${phase}; ${phase} reuses ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID`;
  }
  if (!opts.rollback) {
    return `set ACTIVECAMPAIGN_LIVE_ROLLBACK=1 for the ${phase} phase`;
  }
  if (phase === "cleanup") {
    if (
      opts.deltaImport ||
      opts.shadowCheck ||
      opts.rollbackRehearsal ||
      opts.consentExclusionReview ||
      opts.deliverabilityReview ||
      opts.manualReviewSignoff ||
      opts.smsReadiness ||
      opts.pilotAcceptance
    ) {
      return "cleanup is retry-only: unset final-delta, shadow, review, SMS, rehearsal, and pilot flags so certified overlap/final-delta work is not rerun";
    }
    if (!opts.credentialCleanupReview) {
      return "set ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 for cleanup after rollback succeeds";
    }
    return credentialCleanupEvidenceRefError(
      "activecampaign",
      opts.credentialCleanupEvidenceRef,
    );
  }
  if (!opts.pilotAcceptance) {
    return "set ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 for the source-event finish phase";
  }
  const pilotMessage = livePilotAcceptanceGuardMessage("activecampaign", {
    ...opts,
    commit: true,
  });
  if (pilotMessage) return pilotMessage;
  return "";
}

function hubSpotSourceEventPhaseGuardMessage(opts = {}) {
  const phase = String(opts.sourceEventPhase || "")
    .trim()
    .toLowerCase();
  const jobID = String(opts.sourceEventJobID || "").trim();
  if (!phase) {
    if (jobID) {
      return "set HUBSPOT_LIVE_SOURCE_EVENT_PHASE=finish when HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID is provided";
    }
    if (opts.sourceEvents) {
      return "set HUBSPOT_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume rollback/monitor cleanup";
    }
    return "";
  }
  if (!["prepare", "finish", "cleanup"].includes(phase)) {
    return "HUBSPOT_LIVE_SOURCE_EVENT_PHASE must be prepare, finish, or cleanup";
  }
  if (!opts.sourceEvents) {
    return `set HUBSPOT_LIVE_SOURCE_EVENTS=1 with HUBSPOT_LIVE_SOURCE_EVENT_PHASE=${phase}`;
  }
  if (
    !Number.isInteger(opts.sourceEventIntervalSeconds) ||
    opts.sourceEventIntervalSeconds <= 0
  ) {
    return "HUBSPOT_LIVE_SOURCE_EVENT_INTERVAL_SECONDS must be a positive whole number of seconds";
  }
  if (phase === "prepare") {
    if (!opts.commit) {
      return "set HUBSPOT_LIVE_COMMIT=1 for the source-event prepare phase";
    }
    if (opts.rollback) {
      return "unset HUBSPOT_LIVE_ROLLBACK during the prepare phase so the committed job and monitor remain available for the overlap";
    }
    if (jobID) {
      return "unset HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID during prepare; the retained job ID is written to the prepare artifact";
    }
    if (
      opts.deltaImport ||
      opts.shadowCheck ||
      opts.rollbackRehearsal ||
      opts.pilotAcceptance ||
      opts.credentialCleanupReview
    ) {
      return "the HubSpot prepare phase accepts only discovery/dry-run/commit/source-event flags; run final delta, shadow, rehearsal, pilot acceptance, cleanup, and rollback in the finish phase";
    }
    return "";
  }
  if (!jobID) {
    return "set HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID to the retained job ID emitted by the prepare phase";
  }
  if (opts.commit || opts.dryRun) {
    return `unset HUBSPOT_LIVE_COMMIT and HUBSPOT_LIVE_DRY_RUN during ${phase}; ${phase} reuses HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID`;
  }
  if (!opts.rollback) {
    return `set HUBSPOT_LIVE_ROLLBACK=1 for the ${phase} phase`;
  }
  if (phase === "cleanup") {
    if (
      opts.deltaImport ||
      opts.shadowCheck ||
      opts.rollbackRehearsal ||
      opts.pilotAcceptance
    ) {
      return "cleanup is retry-only: unset final-delta, shadow, rehearsal, and pilot flags so retained overlap/final-delta work is not rerun";
    }
    if (!opts.credentialCleanupReview) {
      return "set HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 for cleanup after rollback succeeds";
    }
    return credentialCleanupEvidenceRefError(
      "hubspot",
      opts.credentialCleanupEvidenceRef,
    );
  }
  if (
    !opts.deltaImport ||
    !opts.shadowCheck ||
    !opts.rollbackRehearsal ||
    !opts.pilotAcceptance
  ) {
    return "HubSpot finish requires HUBSPOT_LIVE_DELTA_IMPORT=1, HUBSPOT_LIVE_SHADOW_CHECK=1, HUBSPOT_LIVE_ROLLBACK_REHEARSAL=1, and HUBSPOT_LIVE_PILOT_ACCEPTANCE=1";
  }
  if (!opts.credentialCleanupReview) {
    return "set HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 for finish after rollback cleanup";
  }
  if (!opts.manualReviewSignoff) {
    return "set HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF=1 after reviewing all 14 CRM-bridge scope rows (11 rule/unsupported checklists plus 3 exact identity/property boundaries) against the final full snapshot";
  }
  const manualEvidenceError = manualReviewEvidenceRefError(
    "hubspot",
    opts.manualReviewEvidenceRef,
  );
  if (manualEvidenceError) return manualEvidenceError;
  return credentialCleanupEvidenceRefError(
    "hubspot",
    opts.credentialCleanupEvidenceRef,
  );
}

function liveDeltaImportGuardMessage(source, opts) {
  if (!opts.deltaImport || opts.commit) return "";
  return `set ${sourceEnvPrefix(source)}_LIVE_COMMIT=1 so final delta import certification runs against a completed import`;
}

function liveCredentialCleanupGuardMessage(source, opts) {
  const prefix = sourceEnvPrefix(source);
  if (!opts.credentialCleanupReview) return "";
  if (!opts.commit || !opts.rollback) {
    return `set ${prefix}_LIVE_COMMIT=1 and ${prefix}_LIVE_ROLLBACK=1 so credential cleanup review runs after a completed isolated cutover and rollback cleanup`;
  }
  return credentialCleanupEvidenceRefError(
    source,
    opts.credentialCleanupEvidenceRef,
  );
}

function liveConsentExclusionGuardMessage(source, opts) {
  if (source !== "activecampaign" || !opts.consentExclusionReview) return "";
  if (!opts.commit || !opts.deltaImport) {
    return "set ACTIVECAMPAIGN_LIVE_COMMIT=1 and ACTIVECAMPAIGN_LIVE_DELTA_IMPORT=1 so consent/exclusion review is recorded after the final source freeze";
  }
  return activeCampaignConsentExclusionEvidenceRefError(
    opts.consentExclusionEvidenceRef,
  );
}

function activeCampaignConsentExclusionEvidenceRefError(evidenceRef) {
  const value = String(evidenceRef || "").trim();
  if (!value) {
    return "set ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for channel-consent and exclusion reconciliation";
  }
  if (redactSensitiveText(value) !== value) {
    return "ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials";
  }
  return "";
}

function credentialCleanupEvidenceRefError(source, evidenceRef) {
  const prefix = sourceEnvPrefix(source);
  const value = String(evidenceRef || "").trim();
  if (!value) {
    return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for the ${credentialCleanupProofLabel(source)}`;
  }
  if (redactSensitiveText(value) !== value) {
    return `${prefix}_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials`;
  }
  return "";
}

function credentialCleanupProofLabel(source) {
  if (source === "activecampaign") return "API-token reset/disconnect proof";
  if (source === "hubspot") {
    return "private-app-token revocation/rotation proof";
  }
  return "API-key reset/disconnect proof";
}

function liveCredentialSourcePreflightGuard(
  source,
  opts,
  artifactPath = artifactDir,
) {
  const artifactMessage = liveArtifactGuardMessage(source, opts, artifactPath);
  if (artifactMessage) {
    return { id: `${source}_live_artifacts`, message: artifactMessage };
  }
  const customerIOSourceEventMessage = customerIOSourceEventGuardMessage(
    source,
    opts,
  );
  if (customerIOSourceEventMessage) {
    return {
      id: `${source}_live_source_events`,
      message: customerIOSourceEventMessage,
    };
  }
  const customerIOCredentialMessage = customerIOCredentialConfigError(
    source,
    opts,
  );
  if (customerIOCredentialMessage) {
    return {
      id: `${source}_credentials`,
      message: customerIOCredentialMessage,
    };
  }
  const hubSpotCredentialMessage = hubSpotCredentialConfigError(source, opts);
  if (hubSpotCredentialMessage) {
    return {
      id: `${source}_credentials`,
      message: hubSpotCredentialMessage,
    };
  }
  const customerIOFullCertificationMessage =
    customerIOFullCertificationGuardMessage(source, opts);
  if (customerIOFullCertificationMessage) {
    return {
      id: `${source}_live_full_certification`,
      message: customerIOFullCertificationMessage,
    };
  }
  const hubSpotFullCertificationMessage = hubSpotFullCertificationGuardMessage(
    source,
    opts,
  );
  if (hubSpotFullCertificationMessage) {
    return {
      id: `${source}_live_full_certification`,
      message: hubSpotFullCertificationMessage,
    };
  }
  if (source === "activecampaign") {
    const phaseMessage = activeCampaignSourceEventPhaseGuardMessage(opts);
    if (phaseMessage) {
      return { id: `${source}_live_source_events`, message: phaseMessage };
    }
  }
  if (source === "hubspot") {
    const phaseMessage = hubSpotSourceEventPhaseGuardMessage(opts);
    if (phaseMessage) {
      return { id: `${source}_live_source_events`, message: phaseMessage };
    }
  }
  const commitMessage = liveCommitGuardMessage(source, opts);
  if (commitMessage) {
    return { id: `${source}_live_commit`, message: commitMessage };
  }
  if (opts.rollbackRehearsal && !opts.commit) {
    return {
      id: `${source}_live_rollback_rehearsal`,
      message: `set ${sourceEnvPrefix(source)}_LIVE_COMMIT=1 to certify rollback rehearsal`,
    };
  }
  const sourceEventMessage = liveSourceEventGuardMessage(source, opts);
  if (sourceEventMessage) {
    return { id: `${source}_live_source_events`, message: sourceEventMessage };
  }
  const deltaImportMessage = liveDeltaImportGuardMessage(source, opts);
  if (deltaImportMessage) {
    return { id: `${source}_live_delta_import`, message: deltaImportMessage };
  }
  const credentialCleanupMessage = liveCredentialCleanupGuardMessage(
    source,
    opts,
  );
  if (credentialCleanupMessage) {
    return {
      id: `${source}_live_credential_cleanup_review`,
      message: credentialCleanupMessage,
    };
  }
  const consentExclusionMessage = liveConsentExclusionGuardMessage(
    source,
    opts,
  );
  if (consentExclusionMessage) {
    return {
      id: `${source}_live_consent_exclusion_review`,
      message: consentExclusionMessage,
    };
  }
  const shadowMessage = liveShadowCheckGuardMessage(
    source,
    opts,
    opts.dryRun ? "preflight-dry-run" : "",
    opts.commit ? "preflight-commit" : "",
  );
  if (shadowMessage) {
    return { id: `${source}_live_shadow_check`, message: shadowMessage };
  }
  const pilotMessage = livePilotAcceptanceGuardMessage(source, opts);
  if (pilotMessage) {
    return { id: `${source}_live_pilot_acceptance`, message: pilotMessage };
  }
  return null;
}

function customerIOFullCertificationGuardMessage(source, opts = {}) {
  if (source !== "customerio" || !opts.requireFullCertification) return "";
  const required = [
    ["CUSTOMERIO_LIVE_DRY_RUN", opts.dryRun],
    ["CUSTOMERIO_LIVE_COMMIT", opts.commit],
    ["CUSTOMERIO_LIVE_DELTA_IMPORT", opts.deltaImport],
    ["CUSTOMERIO_LIVE_SHADOW_CHECK", opts.shadowCheck],
    ["CUSTOMERIO_LIVE_ROLLBACK_REHEARSAL", opts.rollbackRehearsal],
    ["CUSTOMERIO_LIVE_PILOT_ACCEPTANCE", opts.pilotAcceptance],
    ["CUSTOMERIO_LIVE_ROLLBACK", opts.rollback],
    ["CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF", opts.manualReviewSignoff],
    ["CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_REVIEW", opts.credentialCleanupReview],
    [
      "CUSTOMERIO_LIVE_FAIL_ON_DISCOVERY_WARNINGS",
      opts.failOnDiscoveryWarnings,
    ],
    [
      "CUSTOMERIO_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS",
      opts.failOnSourceArchiveWarnings,
    ],
  ];
  const missing = required
    .filter(([, enabled]) => !enabled)
    .map(([name]) => `${name}=1`);
  if (missing.length > 0) {
    return `CUSTOMERIO_LIVE_REQUIRE_FULL_CERTIFICATION=1 requires ${missing.join(", ")}; a credentials/discovery-only run is not a Customer.io certification`;
  }
  return "";
}

function hubSpotFullCertificationGuardMessage(source, opts = {}) {
  if (source !== "hubspot" || !opts.requireFullCertification) return "";
  const phase = String(opts.sourceEventPhase || "")
    .trim()
    .toLowerCase();
  if (!phase) {
    return "HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION=1 requires HUBSPOT_LIVE_SOURCE_EVENT_PHASE=prepare, finish, or cleanup; credentials/discovery and one-shot source-event runs are not HubSpot certification";
  }
  const required =
    phase === "prepare"
      ? [
          ["HUBSPOT_LIVE_DRY_RUN", opts.dryRun],
          ["HUBSPOT_LIVE_COMMIT", opts.commit],
          ["HUBSPOT_LIVE_SOURCE_EVENTS", opts.sourceEvents],
          [
            "HUBSPOT_LIVE_FAIL_ON_DISCOVERY_WARNINGS",
            opts.failOnDiscoveryWarnings,
          ],
        ]
      : phase === "finish"
        ? [
            ["HUBSPOT_LIVE_SOURCE_EVENTS", opts.sourceEvents],
            ["HUBSPOT_LIVE_DELTA_IMPORT", opts.deltaImport],
            ["HUBSPOT_LIVE_SHADOW_CHECK", opts.shadowCheck],
            ["HUBSPOT_LIVE_ROLLBACK_REHEARSAL", opts.rollbackRehearsal],
            ["HUBSPOT_LIVE_PILOT_ACCEPTANCE", opts.pilotAcceptance],
            ["HUBSPOT_LIVE_ROLLBACK", opts.rollback],
            ["HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF", opts.manualReviewSignoff],
            [
              "HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW",
              opts.credentialCleanupReview,
            ],
            [
              "HUBSPOT_LIVE_FAIL_ON_DISCOVERY_WARNINGS",
              opts.failOnDiscoveryWarnings,
            ],
          ]
        : phase === "cleanup"
          ? [
              ["HUBSPOT_LIVE_SOURCE_EVENTS", opts.sourceEvents],
              ["HUBSPOT_LIVE_ROLLBACK", opts.rollback],
              [
                "HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW",
                opts.credentialCleanupReview,
              ],
            ]
          : [];
  if (required.length === 0) {
    return "HUBSPOT_LIVE_SOURCE_EVENT_PHASE must be prepare, finish, or cleanup";
  }
  const missing = required
    .filter(([, enabled]) => !enabled)
    .map(([name]) => `${name}=1`);
  if (missing.length > 0) {
    return `HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION=1 with phase=${phase} requires ${missing.join(", ")}; credentials/discovery and one-shot source-event runs are not HubSpot certification`;
  }
  return "";
}

function livePilotAcceptanceGuardMessage(source, opts) {
  if (!opts.pilotAcceptance) return "";
  if (source === "customerio") {
    const prefix = sourceEnvPrefix(source);
    if (opts.sourceEvents) {
      return customerIOSourceEventGuardMessage(source, opts);
    }
    if (
      !opts.commit ||
      !opts.rollback ||
      !opts.deltaImport ||
      !opts.shadowCheck ||
      !opts.rollbackRehearsal
    ) {
      return `set ${prefix}_LIVE_COMMIT=1, ${prefix}_LIVE_ROLLBACK=1, ${prefix}_LIVE_DELTA_IMPORT=1, ${prefix}_LIVE_SHADOW_CHECK=1, and ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 so Customer.io pilot acceptance is bound to a final authoritative full snapshot, post-delta fingerprint shadow check, rollback rehearsal, and cleanup; do not enable ${prefix}_LIVE_SOURCE_EVENTS`;
    }
    if (!opts.manualReviewSignoff) {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_SIGNOFF=1 after proving Customer.io email enablement requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default, keeping sender-specific SMS/WhatsApp /v1/optouts separate, and recording all six consent/subscription, cio_id/audience, automation/transactional, non-email channel, deliverability, and ecosystem reviews after the final full snapshot`;
    }
    const manualEvidenceError = manualReviewEvidenceRefError(
      source,
      opts.manualReviewEvidenceRef,
    );
    if (manualEvidenceError) return manualEvidenceError;
    if (!opts.credentialCleanupReview) {
      return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 so the dedicated Customer.io App API key is rotated or revoked after rollback certification`;
    }
    return credentialCleanupEvidenceRefError(
      source,
      opts.credentialCleanupEvidenceRef,
    );
  }
  if (source === "klaviyo") {
    const prefix = sourceEnvPrefix(source);
    if (
      !opts.commit ||
      !opts.rollback ||
      !opts.sourceEvents ||
      !opts.deltaImport ||
      !opts.shadowCheck ||
      !opts.rollbackRehearsal
    ) {
      return `set ${prefix}_LIVE_COMMIT=1, ${prefix}_LIVE_ROLLBACK=1, ${prefix}_LIVE_SOURCE_EVENTS=1, ${prefix}_LIVE_DELTA_IMPORT=1, ${prefix}_LIVE_SHADOW_CHECK=1, and ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 so Klaviyo pilot acceptance is bound to changed-profile replay, a final full source snapshot that materializes changed addresses, disables prior source-owned identities, and verifies post-list-suppression send-targetable membership projections, clean shadow evidence, and rollback proof`;
    }
    if (
      !Number.isInteger(opts.sourceEventIntervalSeconds) ||
      opts.sourceEventIntervalSeconds <= 0
    ) {
      return `${prefix}_LIVE_SOURCE_EVENT_INTERVAL_SECONDS must be a positive whole number of seconds`;
    }
    if (!opts.manualReviewSignoff) {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_SIGNOFF=1 so Klaviyo final post-list-suppression membership projections, Multi-Email Profile secondary identities and per-address consent, nullable flow/draft-message definitions, campaign tag IDs, non-email channels, deliverability, and all eight static checklist obligations receive explicit post-delta review without treating checklists as source inventory`;
    }
    const manualEvidenceError = manualReviewEvidenceRefError(
      source,
      opts.manualReviewEvidenceRef,
    );
    if (manualEvidenceError) return manualEvidenceError;
    if (!opts.credentialCleanupReview) {
      return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 so the dedicated Klaviyo private API key is rotated or revoked after rollback certification`;
    }
    return credentialCleanupEvidenceRefError(
      source,
      opts.credentialCleanupEvidenceRef,
    );
  }
  if (source === "beehiiv") {
    const prefix = sourceEnvPrefix(source);
    if (
      !opts.commit ||
      !opts.deltaImport ||
      !opts.shadowCheck ||
      !opts.rollbackRehearsal
    ) {
      return `set ${prefix}_LIVE_COMMIT=1, ${prefix}_LIVE_DELTA_IMPORT=1, ${prefix}_LIVE_SHADOW_CHECK=1, and ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 so Beehiiv pilot acceptance is bound to a final full snapshot, deletion reconciliation, shadow check, and durable rollback rehearsal`;
    }
    if (!opts.manualReviewSignoff) {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_SIGNOFF=1 so Beehiiv consent provenance, campaign archive fidelity, dynamic segment rules, and automation rebuilds are explicitly reviewed after final delta`;
    }
    const manualEvidenceError = manualReviewEvidenceRefError(
      source,
      opts.manualReviewEvidenceRef,
    );
    if (manualEvidenceError) return manualEvidenceError;
    if (!opts.credentialCleanupReview) {
      return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 so the dedicated Beehiiv API key is rotated or revoked after rollback certification`;
    }
    return credentialCleanupEvidenceRefError(
      source,
      opts.credentialCleanupEvidenceRef,
    );
  }
  if (source === "hubspot") {
    const prefix = sourceEnvPrefix(source);
    if (!opts.commit) {
      return `set ${prefix}_LIVE_COMMIT=1, ${prefix}_LIVE_SOURCE_EVENTS=1, ${prefix}_LIVE_DELTA_IMPORT=1, ${prefix}_LIVE_SHADOW_CHECK=1, and ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 so HubSpot bridge pilot acceptance includes source-event replay, final-delta, shadow-check, and rollback evidence`;
    }
    if (!opts.sourceEvents) {
      return `set ${prefix}_LIVE_SOURCE_EVENTS=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes source-event replay evidence`;
    }
    if (!opts.deltaImport) {
      return `set ${prefix}_LIVE_DELTA_IMPORT=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes final-delta evidence`;
    }
    if (!opts.shadowCheck) {
      return `set ${prefix}_LIVE_SHADOW_CHECK=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes clean shadow-check evidence`;
    }
    if (!opts.rollbackRehearsal) {
      return `set ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes rollback rehearsal evidence`;
    }
    if (!opts.manualReviewSignoff) {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_SIGNOFF=1 so all 14 CRM-bridge scope rows are explicitly reviewed after the final full snapshot`;
    }
    const manualEvidenceError = manualReviewEvidenceRefError(
      source,
      opts.manualReviewEvidenceRef,
    );
    if (manualEvidenceError) return manualEvidenceError;
    if (!opts.credentialCleanupReview) {
      return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge certification includes private-app-token revocation/rotation evidence`;
    }
    const credentialCleanupEvidenceRefMessage =
      credentialCleanupEvidenceRefError(
        source,
        opts.credentialCleanupEvidenceRef,
      );
    if (credentialCleanupEvidenceRefMessage) {
      return opts.credentialCleanupEvidenceRef
        ? credentialCleanupEvidenceRefMessage
        : `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so HubSpot credential cleanup evidence is traceable`;
    }
    return "";
  }
  if (source !== "activecampaign") return "";
  const prefix = sourceEnvPrefix(source);
  if (!opts.commit) {
    return `set ${prefix}_LIVE_COMMIT=1, ${prefix}_LIVE_SOURCE_EVENTS=1, ${prefix}_LIVE_DELTA_IMPORT=1, and ${prefix}_LIVE_SHADOW_CHECK=1 so ActiveCampaign pilot acceptance includes source-event replay, final delta, and post-delta shadow evidence`;
  }
  if (!opts.deltaImport) {
    return `set ${prefix}_LIVE_DELTA_IMPORT=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes final delta evidence`;
  }
  if (!opts.sourceEvents) {
    return `set ${prefix}_LIVE_SOURCE_EVENTS=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes source-event replay evidence`;
  }
  if (!opts.shadowCheck) {
    return `set ${prefix}_LIVE_SHADOW_CHECK=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes post-delta shadow-check evidence`;
  }
  if (!opts.rollbackRehearsal) {
    return `set ${prefix}_LIVE_ROLLBACK_REHEARSAL=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes rollback rehearsal evidence`;
  }
  if (!opts.consentExclusionReview) {
    return `set ${prefix}_LIVE_CONSENT_EXCLUSION_REVIEW=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes channel-consent and exclusion reconciliation evidence`;
  }
  const consentExclusionEvidenceRefMessage =
    activeCampaignConsentExclusionEvidenceRefError(
      opts.consentExclusionEvidenceRef,
    );
  if (consentExclusionEvidenceRefMessage) {
    return consentExclusionEvidenceRefMessage;
  }
  if (!opts.deliverabilityReview) {
    return `set ${prefix}_LIVE_DELIVERABILITY_REVIEW=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes deliverability sign-off evidence`;
  }
  if (!opts.manualReviewSignoff) {
    return `set ${prefix}_LIVE_MANUAL_REVIEW_SIGNOFF=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes manual review sign-off evidence`;
  }
  if (!opts.credentialCleanupReview) {
    return `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign live certification includes API-token reset/disconnect evidence`;
  }
  const credentialCleanupEvidenceRefMessage = credentialCleanupEvidenceRefError(
    source,
    opts.credentialCleanupEvidenceRef,
  );
  if (credentialCleanupEvidenceRefMessage) {
    return opts.credentialCleanupEvidenceRef
      ? credentialCleanupEvidenceRefMessage
      : `set ${prefix}_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF with ${prefix}_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign credential cleanup evidence is traceable`;
  }
  return "";
}

function manualReviewEvidenceRefError(source, evidenceRef) {
  const prefix = sourceEnvPrefix(source);
  const value = String(evidenceRef || "").trim();
  if (!value) {
    if (source === "customerio") {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving the post-final-snapshot Customer.io global/email-channel/topic eligibility matrix, separate sender-specific SMS/WhatsApp /v1/optouts review, and all six consent/subscription, cio_id/audience, automation/transactional, non-email channel, deliverability, and ecosystem reviews`;
    }
    if (source === "klaviyo") {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving post-list-suppression send-targetable membership review, Multi-Email Profile secondary-address and per-address-consent reconciliation, nullable flow/draft-message recovery or retirement, campaign-tag ID taxonomy review, and closure of all eight static checklist obligations without treating them as source inventory`;
    }
    if (source === "hubspot") {
      return `set ${prefix}_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving post-final-snapshot review of workflows, marketing email/archive, templates, reports, forms, landing pages, ecommerce, SMS, custom objects, and other CRM objects`;
    }
    return `set ${prefix}_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving consent reconciliation, campaign archive fidelity, and segment/automation rebuild review`;
  }
  if (redactSensitiveText(value) !== value) {
    return `${prefix}_LIVE_MANUAL_REVIEW_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials`;
  }
  return "";
}

function liveArtifactGuardMessage(source, opts, artifactPath = artifactDir) {
  if (
    !durableArtifactSource(source) ||
    !liveCertificationMode(source, opts) ||
    artifactPath
  ) {
    return "";
  }
  return `set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with ${sourceDisplayName(source)} live certification flags so the run writes durable evidence artifacts`;
}

function durableArtifactSource(source) {
  return (
    source === "activecampaign" ||
    source === "hubspot" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
  );
}

function liveCertificationMode(source, opts = {}) {
  if (source === "activecampaign") return activeCampaignCertificationMode(opts);
  if (source === "hubspot") return hubSpotCertificationMode(opts);
  if (source === "beehiiv") return beehiivCertificationMode(opts);
  if (source === "klaviyo") return klaviyoCertificationMode(opts);
  if (source === "customerio") return customerIOCertificationMode(opts);
  return false;
}

function activeCampaignCertificationMode(opts = {}) {
  return Boolean(
    opts.dryRun ||
    opts.commit ||
    opts.shadowCheck ||
    opts.sourceEvents ||
    opts.deltaImport ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal ||
    opts.consentExclusionReview ||
    opts.deliverabilityReview ||
    opts.manualReviewSignoff ||
    opts.smsReadiness ||
    opts.credentialCleanupReview ||
    opts.failOnDiscoveryWarnings ||
    opts.failOnSourceArchiveWarnings,
  );
}

function hubSpotCertificationMode(opts = {}) {
  return Boolean(
    opts.requireFullCertification ||
    opts.dryRun ||
    opts.commit ||
    opts.rollback ||
    opts.shadowCheck ||
    opts.sourceEvents ||
    opts.deltaImport ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal ||
    opts.manualReviewSignoff ||
    opts.credentialCleanupReview ||
    opts.failOnDiscoveryWarnings ||
    opts.sourceEventPhase ||
    opts.sourceEventJobID,
  );
}

function beehiivCertificationMode(opts = {}) {
  return Boolean(
    opts.dryRun ||
    opts.commit ||
    opts.shadowCheck ||
    opts.deltaImport ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal ||
    opts.manualReviewSignoff ||
    opts.credentialCleanupReview ||
    opts.failOnDiscoveryWarnings ||
    opts.failOnSourceArchiveWarnings,
  );
}

function klaviyoCertificationMode(opts = {}) {
  return Boolean(
    opts.dryRun ||
    opts.commit ||
    opts.shadowCheck ||
    opts.sourceEvents ||
    opts.deltaImport ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal ||
    opts.manualReviewSignoff ||
    opts.credentialCleanupReview ||
    opts.failOnDiscoveryWarnings ||
    opts.failOnSourceArchiveWarnings,
  );
}

function customerIOCertificationMode(opts = {}) {
  return Boolean(
    opts.requireFullCertification ||
    opts.dryRun ||
    opts.commit ||
    opts.rollback ||
    opts.shadowCheck ||
    opts.sourceEvents ||
    opts.deltaImport ||
    opts.pilotAcceptance ||
    opts.rollbackRehearsal ||
    opts.manualReviewSignoff ||
    opts.credentialCleanupReview ||
    opts.failOnDiscoveryWarnings ||
    opts.failOnSourceArchiveWarnings,
  );
}

function liveShadowCheckGuardMessage(
  source,
  opts,
  dryRunJobID,
  committedJobID,
) {
  if (!opts.shadowCheck || dryRunJobID || committedJobID) return "";
  const prefix = sourceEnvPrefix(source);
  return `set ${prefix}_LIVE_DRY_RUN=1 or ${prefix}_LIVE_COMMIT=1 so shadow-check has a verification report to compare`;
}

function shadowCheckDeltaError(check, opts = {}, source = "") {
  if (source === "beehiiv" || source === "klaviyo" || source === "customerio") {
    const label = sourceDisplayName(source);
    if (check?.error) {
      return `${label} shadow-check returned an execution error; cutover is not certified`;
    }
    if (check?.needs_delta_import === true) {
      return `${label} shadow-check still requires a final delta import; cutover is not certified`;
    }
    if (check?.recommended_action !== "ready_for_cutover_review") {
      return `${label} shadow-check is not ready for cutover review: ${check?.recommended_action || "unknown"}`;
    }
    if (Array.isArray(check?.blockers) && check.blockers.length > 0) {
      return `${label} shadow-check returned ${check.blockers.length} blocker(s); cutover is not certified`;
    }
  }
  if (
    opts.expectNoDeltaImport &&
    (check?.needs_delta_import === true ||
      check?.recommended_action === "run_delta_import_before_cutover")
  ) {
    return `shadow-check still requires delta import after final delta replay: ${check?.recommended_action || "unknown"}`;
  }
  return "";
}

function rollbackRehearsalCertificationError(source, report) {
  if (!Array.isArray(report?.items)) {
    return "rollback-rehearsal did not return review items";
  }
  if (!["pass", "warning", "blocker"].includes(report.status)) {
    return "rollback-rehearsal returned an unknown status";
  }
  if (report.status === "blocker") {
    return "rollback rehearsal has blocker(s); rollback is not certified";
  }
  if (strictRollbackRehearsalSource(source) && report.status !== "pass") {
    return `${sourceDisplayName(source)} rollback rehearsal must be pass for live certification; got ${report.status}`;
  }
  return "";
}

function strictRollbackRehearsalSource(source) {
  return (
    source === "activecampaign" ||
    source === "hubspot" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
  );
}

function sourceDisplayName(source) {
  switch (source) {
    case "activecampaign":
      return "ActiveCampaign";
    case "hubspot":
      return "HubSpot";
    case "beehiiv":
      return "Beehiiv";
    case "klaviyo":
      return "Klaviyo";
    case "customerio":
      return "Customer.io";
    case "mailchimp":
      return "Mailchimp";
    default:
      return sourceEnvPrefix(source);
  }
}

function sourceEnvPrefix(source) {
  return String(source || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_");
}

function missingEnvNames(opts) {
  const missing = [];
  for (const name of opts.envNames || []) {
    if (!process.env[name]) missing.push(name);
  }
  for (const names of opts.anyEnvNames || []) {
    if (!names.some((name) => process.env[name])) {
      missing.push(names.join(" or "));
    }
  }
  return missing;
}

function missingLiveCredentialGuardMessage(source, opts, missing) {
  if (
    (source !== "hubspot" && source !== "klaviyo" && source !== "customerio") ||
    !Array.isArray(missing) ||
    missing.length === 0 ||
    !liveCertificationMode(source, opts)
  ) {
    return "";
  }
  const label = sourceDisplayName(source);
  const prefix = sourceEnvPrefix(source);
  return `${label} live certification cannot run without credentials; set ${missing.join(", ")} or unset every ${prefix}_LIVE_* certification flag`;
}

function customerIOCapabilityContractError(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    return "Customer.io discovery did not return a capability contract";
  }
  const mismatches = [];
  if (capabilities.source !== "customerio") {
    mismatches.push(`source=${String(capabilities.source || "missing")}`);
  }
  if (capabilities.auth_method !== "api_key") {
    mismatches.push(
      `auth_method=${String(capabilities.auth_method || "missing")}`,
    );
  }
  const expectedSupports = {
    subscribers: true,
    segments: true,
    automations: true,
    automation_mode: "rebuild_review",
    campaign_archive: true,
    paid_subs: false,
    consent_timestamps: false,
    templates: true,
    campaigns: true,
    reports: false,
    groups: false,
    forms: false,
    landing_pages: false,
    ecommerce: false,
    crm: false,
    custom_objects: false,
    sms: false,
  };
  const supports = capabilities.supports;
  if (!supports || typeof supports !== "object") {
    mismatches.push("supports=missing");
  } else {
    for (const [key, expected] of Object.entries(expectedSupports)) {
      if (supports[key] !== expected) {
        mismatches.push(
          `supports.${key}=${String(supports[key] ?? "missing")}`,
        );
      }
    }
    for (const key of Object.keys(supports).sort()) {
      if (!Object.hasOwn(expectedSupports, key)) {
        mismatches.push(`supports.${key}=unexpected`);
      }
    }
  }
  if (mismatches.length === 0) return "";
  return `Customer.io discovery returned a stale or unsafe capability contract: ${mismatches.join(", ")}`;
}

function customerIODiscoveryCountContractError(discovery) {
  const countKeys = [
    "subscribers_count",
    "profiles_without_email_count",
    "segments_count",
    "automations_count",
    "archive_count",
    "source_archive_count",
    "paid_subs_count",
    "templates_count",
    "campaigns_count",
    "reports_count",
    "groups_count",
    "forms_count",
    "landing_pages_count",
    "ecommerce_count",
    "custom_objects_count",
    "subscription_channels_count",
    "sms_campaigns_count",
    "push_campaigns_count",
  ];
  const invalid = countKeys.filter(
    (key) => !Number.isInteger(discovery?.[key]) || Number(discovery[key]) < 0,
  );
  const mismatches = [...invalid.map((key) => `${key}=invalid`)];
  if (discovery?.source !== "customerio") {
    mismatches.push(`source=${String(discovery?.source || "missing")}`);
  }
  for (const key of [
    "paid_subs_count",
    "reports_count",
    "groups_count",
    "forms_count",
    "landing_pages_count",
    "ecommerce_count",
  ]) {
    if (Number.isInteger(discovery?.[key]) && discovery[key] !== 0) {
      mismatches.push(`${key}=${discovery[key]}`);
    }
  }
  if (
    Number.isInteger(discovery?.archive_count) &&
    Number.isInteger(discovery?.campaigns_count) &&
    discovery.archive_count > discovery.campaigns_count
  ) {
    mismatches.push("archive_count>campaigns_count");
  }
  if (
    Number.isInteger(discovery?.automations_count) &&
    Number.isInteger(discovery?.campaigns_count) &&
    discovery.automations_count > discovery.campaigns_count
  ) {
    mismatches.push("automations_count>campaigns_count");
  }
  const audiences = Array.isArray(discovery?.audiences)
    ? discovery.audiences
    : null;
  if (audiences === null) {
    mismatches.push("audiences=invalid");
  } else {
    if (
      Number.isInteger(discovery?.segments_count) &&
      audiences.length !== discovery.segments_count
    ) {
      mismatches.push("audiences.length!=segments_count");
    }
    const audienceIDs = new Set();
    for (const audience of audiences) {
      const id = typeof audience?.id === "string" ? audience.id.trim() : "";
      if (
        !id ||
        (!id.startsWith("customerio:segment:") &&
          !id.startsWith("customerio:topic:"))
      ) {
        mismatches.push("audiences.id=invalid");
        break;
      }
      if (audienceIDs.has(id)) {
        mismatches.push("audiences.id=duplicate");
        break;
      }
      audienceIDs.add(id);
    }
  }
  if (
    Number.isInteger(discovery?.source_archive_count) &&
    Number.isInteger(discovery?.campaigns_count) &&
    Number.isInteger(discovery?.custom_objects_count) &&
    Number.isInteger(discovery?.subscription_channels_count) &&
    discovery.source_archive_count <
      discovery.campaigns_count +
        discovery.custom_objects_count +
        discovery.subscription_channels_count +
        8
  ) {
    mismatches.push(
      "source_archive_count<campaigns_count+custom_objects_count+subscription_channels_count+8_checklists",
    );
  }
  if (mismatches.length === 0) return "";
  return `Customer.io discovery returned inconsistent exact inventory counts: ${mismatches.join(", ")}`;
}

function customerIODiscoveryCompletenessContractError(discovery) {
  const rows = Array.isArray(discovery?.resource_metadata)
    ? discovery.resource_metadata
    : [];
  const required = new Map([
    ["subscribers", { supported: true }],
    ["non_email_profiles", { supported: false }],
    ["segments", { supported: true }],
    [
      "subscription_topics",
      {
        supported: true,
        sourceTotal:
          (Array.isArray(discovery?.audiences)
            ? discovery.audiences.filter((audience) =>
                String(audience?.id || "").startsWith("customerio:topic:"),
              ).length
            : 0) + (discovery?.subscription_channels_count ?? 0),
        imported:
          (Array.isArray(discovery?.audiences)
            ? discovery.audiences.filter((audience) =>
                String(audience?.id || "").startsWith("customerio:topic:"),
              ).length
            : 0) + (discovery?.subscription_channels_count ?? 0),
      },
    ],
    ["campaigns", { supported: true }],
    [
      "source_archive",
      {
        supported: true,
        sourceTotal: discovery?.source_archive_count,
        imported: discovery?.source_archive_count,
        status: "preserved_for_rebuild",
      },
    ],
    ["workflow_definitions", { supported: true }],
    ["transactional", { supported: true }],
    ["templates", { supported: true }],
    ["structured_templates", { supported: true }],
    ["consent_exclusions", { supported: true }],
    ["channel_dependencies", { supported: false }],
    [
      "custom_objects",
      {
        supported: true,
        sourceTotal: discovery?.custom_objects_count,
        imported: discovery?.custom_objects_count,
      },
    ],
    [
      "deliverability",
      {
        supported: true,
        sourceTotal: 1,
        imported: 1,
        status: "preserved_for_rebuild",
      },
    ],
    [
      "ecosystem",
      {
        supported: true,
        sourceTotal: 7,
        imported: 7,
        status: "preserved_for_rebuild",
      },
    ],
  ]);
  const mismatches = [];
  for (const [resource, expected] of required) {
    const matching = rows.filter((row) => row?.resource === resource);
    if (matching.length !== 1) {
      mismatches.push(`${resource}.count=${matching.length}`);
      continue;
    }
    const row = matching[0];
    if (row.supported !== expected.supported) {
      mismatches.push(
        `${resource}.supported=${String(row.supported ?? "missing")}`,
      );
    }
    if (
      expected.sourceTotal !== undefined &&
      row.source_total !== expected.sourceTotal
    ) {
      mismatches.push(
        `${resource}.source_total=${String(row.source_total ?? "missing")}`,
      );
    }
    if (expected.imported !== undefined && row.imported !== expected.imported) {
      mismatches.push(
        `${resource}.imported=${String(row.imported ?? "missing")}`,
      );
    }
    if (expected.status !== undefined && row.status !== expected.status) {
      mismatches.push(`${resource}.status=${String(row.status ?? "missing")}`);
    }
  }
  if (rows.length !== required.size) {
    mismatches.push(`resource_metadata.count=${rows.length}`);
  }
  if (mismatches.length === 0) return "";
  return `Customer.io discovery must expose the exact profile, audience, archive, rebuild, channel, deliverability, and ecosystem completeness contract: ${mismatches.join(", ")}`;
}

function customerIOSourceArchiveInventoryContractError(report, discovery) {
  const mismatches = [];
  const expectedArchive = discovery?.source_archive_count;
  const expectedChannels = discovery?.subscription_channels_count;
  const byResource = report?.source_archive_by_resource;
  if (
    !byResource ||
    typeof byResource !== "object" ||
    Array.isArray(byResource)
  ) {
    mismatches.push("source_archive_by_resource=missing");
  } else {
    const invalidKeys = Object.entries(byResource)
      .filter(
        ([key, value]) => !key || !Number.isInteger(value) || Number(value) < 0,
      )
      .map(([key]) => key || "<empty>")
      .sort();
    if (invalidKeys.length > 0) {
      mismatches.push(
        `source_archive_by_resource.invalid=${invalidKeys.join("|")}`,
      );
    }
    const importedChannels = byResource.customerio_subscription_channel ?? 0;
    if (importedChannels !== expectedChannels) {
      mismatches.push(
        `customerio_subscription_channel=${String(importedChannels)}`,
      );
    }
    if (invalidKeys.length === 0) {
      const resourceSum = Object.values(byResource).reduce(
        (total, value) => total + value,
        0,
      );
      if (resourceSum !== expectedArchive) {
        mismatches.push(`source_archive_by_resource.sum=${resourceSum}`);
      }
    }
  }
  if (report?.source_archive_imported !== expectedArchive) {
    mismatches.push(
      `source_archive_imported=${String(
        report?.source_archive_imported ?? "missing",
      )}`,
    );
  }
  const topicCount = Array.isArray(discovery?.audiences)
    ? discovery.audiences.filter((audience) =>
        String(audience?.id || "").startsWith("customerio:topic:"),
      ).length
    : 0;
  const expectedDefinitions = topicCount + (expectedChannels ?? 0);
  const preferenceRows = Array.isArray(report?.resource_completeness)
    ? report.resource_completeness.filter(
        (row) => row?.resource === "subscription_topics",
      )
    : [];
  if (preferenceRows.length !== 1) {
    mismatches.push(`subscription_topics.count=${preferenceRows.length}`);
  } else {
    const row = preferenceRows[0];
    if (row.source_total !== expectedDefinitions) {
      mismatches.push(
        `subscription_topics.source_total=${String(
          row.source_total ?? "missing",
        )}`,
      );
    }
    if (row.imported !== expectedDefinitions) {
      mismatches.push(
        `subscription_topics.imported=${String(row.imported ?? "missing")}`,
      );
    }
  }
  if (mismatches.length === 0) return "";
  return `Customer.io verification report does not match exact discovery-bound source-archive and subscription-channel inventory: ${mismatches.join(", ")}`;
}

function customerIOCutoverReviewContractError(
  report,
  { requireRecordedEvidence = false } = {},
) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const markerByKey = new Map([
    [
      "customerio_consent_subscription_review",
      "global_topic_esp_channel_consent=reviewed",
    ],
    [
      "customerio_identity_audience_review",
      "cio_id_duplicate_email_snapshot=reviewed",
    ],
    [
      "customerio_automation_rebuild_review",
      "automation_broadcast_transactional_rebuild=reviewed",
    ],
    ["customerio_channel_dependency_review", "non_email_channels=reviewed"],
    ["customerio_deliverability_review", "sender_domain_suppression=reviewed"],
    [
      "customerio_ecosystem_dependencies_review",
      "object_event_export_dependencies=reviewed",
    ],
  ]);
  const mismatches = [];
  for (const key of customerIOManualReviewEvidenceKeys) {
    const matching = items.filter((item) => item?.key === key);
    if (matching.length !== 1) {
      mismatches.push(`${key}.count=${matching.length}`);
      continue;
    }
    if (!requireRecordedEvidence) continue;
    const item = matching[0];
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (item.status !== "pass") {
      mismatches.push(`${key}.status=${String(item.status || "missing")}`);
    }
    if (!evidence.some((entry) => String(entry).startsWith("evidence_ref="))) {
      mismatches.push(`${key}.evidence_ref=missing`);
    }
    for (const marker of [
      "CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF=1",
      "final_full_snapshot=reviewed",
      markerByKey.get(key),
    ]) {
      if (!evidence.includes(marker)) {
        mismatches.push(`${key}.${marker}=missing`);
      }
    }
    if (key === "customerio_ecosystem_dependencies_review") {
      for (const marker of [
        "static_checklist_count=8",
        "static_checklists_are_inventory=false",
      ]) {
        if (!evidence.includes(marker)) {
          mismatches.push(`${key}.${marker}=missing`);
        }
      }
    }
  }
  if (mismatches.length === 0) return "";
  return `Customer.io pilot acceptance must expose and evidence all six post-final-snapshot reviews: ${mismatches.join(", ")}`;
}

function customerIOFullSnapshotContractError(job) {
  const report = job?.verification_report;
  if (!report || typeof report !== "object") {
    return "Customer.io full snapshot did not return a verification report";
  }
  const rows = Array.isArray(report.resource_completeness)
    ? report.resource_completeness
    : [];
  const exactResources = [
    "subscribers",
    "segments",
    "campaigns",
    "source_archive",
    "templates",
  ];
  const mismatches = [];
  const rowByResource = new Map();
  for (const resource of exactResources) {
    const matching = rows.filter((row) => row?.resource === resource);
    if (matching.length !== 1) {
      mismatches.push(`${resource}.count=${matching.length}`);
      continue;
    }
    const row = matching[0];
    rowByResource.set(resource, row);
    if (
      !Number.isInteger(row.source_total) ||
      row.source_total < 0 ||
      row.imported !== row.source_total
    ) {
      mismatches.push(
        `${resource}.exact=${String(row.imported ?? "missing")}/${String(row.source_total ?? "missing")}`,
      );
    }
  }

  const epoch = String(
    job?.cursor?.__postwave_customerio_import_epoch || "",
  ).trim();
  if (!/^[a-f0-9]{64}$/u.test(epoch)) {
    mismatches.push("import_epoch=missing_or_invalid");
  }
  const fingerprintRaw = String(
    job?.cursor?.__postwave_customerio_source_fingerprint || "",
  ).trim();
  let fingerprint;
  try {
    fingerprint = JSON.parse(fingerprintRaw);
  } catch {
    mismatches.push("source_fingerprint=missing_or_invalid");
  }
  const expectedComponents = new Map([
    ["subscribers", "subscribers"],
    ["segments", "segments"],
    ["editable_templates", "templates"],
    ["sent_campaign_archive", "campaigns"],
    ["source_archive", "source_archive"],
  ]);
  if (fingerprint) {
    const fingerprintDigestValid = /^[a-f0-9]{64}$/u.test(
      String(fingerprint.digest || ""),
    );
    if (fingerprint.version !== 1 || !fingerprintDigestValid) {
      mismatches.push("source_fingerprint.header=invalid");
    }
    const components = fingerprint.components;
    if (
      !components ||
      typeof components !== "object" ||
      Object.keys(components).length !== expectedComponents.size
    ) {
      mismatches.push("source_fingerprint.components=incomplete");
    } else {
      let componentsValid = true;
      for (const [component, resource] of expectedComponents) {
        const value = components[component];
        const expectedCount = rowByResource.get(resource)?.source_total;
        if (
          !value ||
          !Number.isInteger(value.count) ||
          value.count < 0 ||
          !/^[a-f0-9]{64}$/u.test(String(value.digest || ""))
        ) {
          mismatches.push(`source_fingerprint.${component}=invalid`);
          componentsValid = false;
        } else if (
          Number.isInteger(expectedCount) &&
          value.count !== expectedCount
        ) {
          mismatches.push(
            `source_fingerprint.${component}.count=${value.count}/${expectedCount}`,
          );
        }
      }
      if (
        componentsValid &&
        fingerprintDigestValid &&
        fingerprint.digest !== customerIOFingerprintDigest(components)
      ) {
        mismatches.push("source_fingerprint.digest=integrity_mismatch");
      }
    }
  }
  if (mismatches.length === 0) return "";
  return `Customer.io commit/delta did not prove an exact fingerprint-bound full snapshot: ${mismatches.join(", ")}`;
}

function customerIOFingerprintDigest(components) {
  const canonical = {};
  for (const key of Object.keys(components).sort()) {
    canonical[key] = {
      count: components[key].count,
      digest: components[key].digest,
    };
  }
  return createHash("sha256")
    .update("postwave-customerio-source-v1\0")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function customerIOImportEpochRotationError(before, after) {
  const previous = String(
    before?.cursor?.__postwave_customerio_import_epoch || "",
  ).trim();
  const current = String(
    after?.cursor?.__postwave_customerio_import_epoch || "",
  ).trim();
  if (!/^[a-f0-9]{64}$/u.test(previous) || !/^[a-f0-9]{64}$/u.test(current)) {
    return "Customer.io commit and final delta must each carry a valid import epoch";
  }
  if (previous === current) {
    return "Customer.io final full-snapshot delta did not rotate the import epoch";
  }
  return "";
}

function klaviyoCapabilityContractError(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    return "Klaviyo discovery did not return a capability contract";
  }
  const mismatches = [];
  if (capabilities.source !== "klaviyo") {
    mismatches.push(`source=${String(capabilities.source || "missing")}`);
  }
  if (capabilities.auth_method !== "api_key") {
    mismatches.push(
      `auth_method=${String(capabilities.auth_method || "missing")}`,
    );
  }
  const expectedSupports = {
    subscribers: true,
    segments: true,
    automations: true,
    automation_mode: "rebuild_review",
    campaign_archive: true,
    templates: true,
    campaigns: true,
    forms: true,
    reports: false,
    ecommerce: false,
    sms: false,
  };
  const supports = capabilities.supports;
  if (!supports || typeof supports !== "object") {
    mismatches.push("supports=missing");
  } else {
    for (const [key, expected] of Object.entries(expectedSupports)) {
      if (supports[key] !== expected) {
        mismatches.push(
          `supports.${key}=${String(supports[key] ?? "missing")}`,
        );
      }
    }
  }
  if (mismatches.length === 0) return "";
  return `Klaviyo discovery returned a stale or unsafe capability contract: ${mismatches.join(", ")}`;
}

function klaviyoDiscoveryCountContractError(discovery) {
  const invalid = [
    "profiles_without_email_count",
    "source_archive_count",
    "sms_campaigns_count",
    "push_campaigns_count",
  ].filter(
    (key) => !Number.isInteger(discovery?.[key]) || Number(discovery[key]) < 0,
  );
  if (invalid.length === 0) return "";
  return `Klaviyo discovery must return nonnegative integer inventory counts: ${invalid.join(", ")}`;
}

function klaviyoStaticChecklistContractError(discovery) {
  const rows = Array.isArray(discovery?.resource_metadata)
    ? discovery.resource_metadata
    : [];
  const checklistResources = [
    "ecommerce",
    "reviews",
    "service",
    "cdp",
    "multi_email_profiles",
    "omni_channels",
    "deliverability",
    "marketplace",
  ];
  const mismatches = [];
  if (
    !Number.isInteger(discovery?.source_archive_count) ||
    discovery.source_archive_count < checklistResources.length
  ) {
    mismatches.push(
      `source_archive_count=${String(discovery?.source_archive_count ?? "missing")}`,
    );
  }
  for (const resource of checklistResources) {
    const matching = rows.filter((row) => row?.resource === resource);
    if (matching.length !== 1) {
      mismatches.push(`${resource}.count=${matching.length}`);
      continue;
    }
    const row = matching[0];
    if (row.source_total !== 1) {
      mismatches.push(
        `${resource}.source_total=${String(row.source_total ?? "missing")}`,
      );
    }
    if (row.imported !== 1) {
      mismatches.push(
        `${resource}.imported=${String(row.imported ?? "missing")}`,
      );
    }
    if (row.supported !== false) {
      mismatches.push(
        `${resource}.supported=${String(row.supported ?? "missing")}`,
      );
    }
    if (row.status !== "manual_rebuild_required") {
      mismatches.push(`${resource}.status=${String(row.status ?? "missing")}`);
    }
  }
  if (mismatches.length === 0) return "";
  return `Klaviyo discovery must expose eight unconditional source_total=1 static checklist rows that do not imply source inventory: ${mismatches.join(", ")}`;
}

function klaviyoMultiEmailProfileContractError(discovery) {
  const rows = Array.isArray(discovery?.resource_metadata)
    ? discovery.resource_metadata.filter(
        (row) => row?.resource === "multi_email_profiles",
      )
    : [];
  if (rows.length !== 1) {
    return `Klaviyo discovery must include exactly one multi_email_profiles source-archive/manual-review row; got ${rows.length}`;
  }
  const row = rows[0];
  const mismatches = [];
  if (row.source_total !== 1) {
    mismatches.push(`source_total=${String(row.source_total ?? "missing")}`);
  }
  if (row.imported !== 1) {
    mismatches.push(`imported=${String(row.imported ?? "missing")}`);
  }
  if (row.supported !== false) {
    mismatches.push(`supported=${String(row.supported ?? "missing")}`);
  }
  if (row.status !== "manual_rebuild_required") {
    mismatches.push(`status=${String(row.status ?? "missing")}`);
  }
  if (
    !Number.isInteger(discovery?.source_archive_count) ||
    discovery.source_archive_count < 1
  ) {
    mismatches.push(
      `source_archive_count=${String(discovery?.source_archive_count ?? "missing")}`,
    );
  }
  const description = [
    row.label,
    ...(Array.isArray(row.notes) ? row.notes : []),
  ]
    .join(" ")
    .toLowerCase();
  if (!description.includes("secondary")) {
    mismatches.push("description.secondary=missing");
  }
  if (
    !description.includes("consent") ||
    (!description.includes("per-address") &&
      !description.includes("independent"))
  ) {
    mismatches.push("description.per_address_consent=missing");
  }
  if (
    !description.includes("provider export") &&
    !description.includes("retained")
  ) {
    mismatches.push("description.manual_review_source=missing");
  }
  if (mismatches.length === 0) return "";
  return `Klaviyo discovery returned an unsafe Multi-Email Profile review contract: ${mismatches.join(", ")}`;
}

function klaviyoMultiEmailReviewContractError(
  report,
  { requireRecordedEvidence = false } = {},
) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const requiredKeys = [
    "klaviyo_consent_suppression_review",
    "klaviyo_ecosystem_dependencies_review",
  ];
  const mismatches = [];
  for (const key of requiredKeys) {
    const matching = items.filter((item) => item?.key === key);
    if (matching.length !== 1) {
      mismatches.push(`${key}.count=${matching.length}`);
      continue;
    }
    const item = matching[0];
    const description =
      `${String(item.label || "")} ${String(item.detail || "")}`.toLowerCase();
    if (requireRecordedEvidence) {
      if (
        !description.includes("multi-email") ||
        !description.includes("secondary")
      ) {
        mismatches.push(`${key}.multi_email_scope=missing`);
      }
      const evidence = Array.isArray(item.evidence) ? item.evidence : [];
      if (item.status !== "pass") {
        mismatches.push(`${key}.status=${String(item.status || "missing")}`);
      }
      if (!evidence.includes("source_archive_resource=multi_email_profiles")) {
        mismatches.push(`${key}.source_archive_evidence=missing`);
      }
    }
  }
  if (mismatches.length === 0) return "";
  return `Klaviyo pilot acceptance must tie the multi_email_profiles source-archive record to consent and ecosystem evidence: ${mismatches.join(", ")}`;
}

function klaviyoEcosystemGapReviewContractError(report) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const matching = items.filter(
    (item) => item?.key === "klaviyo_ecosystem_dependencies_review",
  );
  if (matching.length !== 1) {
    return `Klaviyo ecosystem review must appear exactly once; got ${matching.length}`;
  }
  const item = matching[0];
  const mismatches = [];
  if (item.status !== "pass") {
    mismatches.push(`status=${String(item.status || "missing")}`);
  }
  const description = String(item.detail || "").toLowerCase();
  if (
    !description.includes("checklist") ||
    !description.includes("inventory")
  ) {
    mismatches.push("static_checklist_scope=missing");
  }
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  for (const [marker, label] of [
    ["static_checklist_count=8", "static_checklist_count"],
    [
      "static_checklists_are_inventory=false",
      "static_checklists_are_inventory",
    ],
    ["nullable_definitions=reviewed", "nullable_definitions"],
    ["campaign_tags=id_only", "campaign_tags"],
  ]) {
    if (!evidence.includes(marker)) {
      mismatches.push(`${label}=missing`);
    }
  }
  if (mismatches.length === 0) return "";
  return `Klaviyo ecosystem evidence must treat eight static rows as checklists, review nullable definitions, and preserve campaign tags as IDs: ${mismatches.join(", ")}`;
}

function splitCSV(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, opts = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Tenant-ID": tenantID,
    ...(candidateSHA256 ? { "X-Migration-Expected-Build-SHA256": candidateSHA256 } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${baseURL}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  const observed = res.headers.get("X-Migration-Build-SHA256") || "";
  if (candidateSHA256) {
    const mismatch = candidateError(candidateSHA256, observed);
    if (mismatch) throw new Error(mismatch);
  }
  if (observedCandidateSHA256 && observed && observedCandidateSHA256 !== observed) throw new Error("Migration executable changed during qualification");
  observedCandidateSHA256 ||= observed;
  const text = await res.text();
  const parsed = text ? safeJSON(text) : undefined;
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : text || res.statusText;
    throw new Error(
      `${opts.method || "GET"} ${path} failed: ${res.status} ${detail}`,
    );
  }
  return parsed;
}

async function postwaveAPIRequest(path, opts = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Tenant-ID": tenantID,
    Authorization: `Bearer ${postwaveAPIKey}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(`${postwaveAPIBaseURL}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const parsed = text ? safeJSON(text) : undefined;
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : text || res.statusText;
    throw new Error(
      `${opts.method || "GET"} ${path} failed: ${res.status} ${detail}`,
    );
  }
  return parsed;
}

async function writeArtifact(source, name, payload) {
  if (!artifactDir) return;
  artifactSeq += 1;
  await mkdir(artifactDir, { recursive: true });
  const filename =
    [
      String(artifactSeq).padStart(3, "0"),
      safeArtifactSegment(artifactRunID),
      safeArtifactSegment(source),
      safeArtifactSegment(name),
    ].join("-") + ".json";
  await writeFile(
    path.join(artifactDir, filename),
    `${JSON.stringify(
      {
        artifact_schema: "postwave.live_migration_certification.v2",
        candidate_sha256: candidateSHA256 || null,
        observed_executable_sha256: observedCandidateSHA256 || null,
        harness_revision: process.env.GITHUB_SHA || null,
        full_lifecycle_required: requireLifecycle,
        source,
        name,
        captured_at: new Date().toISOString(),
        payload,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function credentialArtifact(auth, source) {
  return {
    source,
    job_id: auth?.job_id || "",
    account_id_present: Boolean(auth?.account_id),
  };
}

function sourceEventArtifact(response) {
  const events = Array.isArray(response?.events) ? response.events : [];
  const byResourceAction = {};
  let unapplied = 0;
  let manualReviewsReviewed = 0;
  let manualReviewsPending = 0;
  for (const event of events) {
    const resource = String(event?.resource_type || "unknown");
    const action = String(event?.action || "unknown");
    const key = `${resource}:${action}`;
    byResourceAction[key] = (byResourceAction[key] || 0) + 1;
    if (event?.applied !== true) unapplied += 1;
    if (action === "manual_review" && event?.applied !== true) {
      const reviewed =
        event?.review_status === "reviewed" &&
        Boolean(event?.reviewed_at) &&
        String(event?.review_detail || "").trim().length > 0 &&
        Array.isArray(event?.review_evidence) &&
        event.review_evidence.length > 0;
      if (reviewed) manualReviewsReviewed += 1;
      else manualReviewsPending += 1;
    }
  }
  return {
    monitor: {
      job_id: response?.monitor?.job_id || "",
      source: response?.monitor?.source || "",
      enabled: response?.monitor?.enabled === true,
      interval_seconds: response?.monitor?.interval_seconds ?? null,
      enabled_since: response?.monitor?.enabled_since || null,
      first_successful_sync_at:
        response?.monitor?.first_successful_sync_at || null,
      successful_sync_count: response?.monitor?.successful_sync_count ?? 0,
      max_success_gap_seconds: response?.monitor?.max_success_gap_seconds ?? 0,
      last_event_at: response?.monitor?.last_event_at || null,
      last_synced_at: response?.monitor?.last_synced_at || null,
      next_sync_at: response?.monitor?.next_sync_at || null,
      last_error_present: Boolean(response?.monitor?.last_error),
      events_seen: response?.monitor?.events_seen ?? 0,
      events_applied: response?.monitor?.events_applied ?? 0,
    },
    events_count: events.length,
    unapplied_events_count: unapplied,
    manual_reviews_reviewed: manualReviewsReviewed,
    manual_reviews_pending: manualReviewsPending,
    events_by_resource_action: byResourceAction,
  };
}

function sourceEventMonitorError(response) {
  const lastError = response?.monitor?.last_error;
  if (!lastError) return "";
  return `source-event monitor reported last_error: ${redactSensitiveText(String(lastError))}`;
}

function sourceEventContinuousOverlapError(
  source,
  response,
  referenceTimeMs = Date.now(),
) {
  if (source !== "activecampaign" && source !== "hubspot") return "";
  const label = sourceDisplayName(source);
  const monitor = response?.monitor;
  if (!monitor?.enabled) {
    return `${label} source-event certification requires the monitor to remain enabled through final delta capture`;
  }
  const enabledSinceMs = Date.parse(String(monitor.enabled_since || ""));
  const firstSyncMs = Date.parse(
    String(monitor.first_successful_sync_at || ""),
  );
  const lastSyncMs = Date.parse(String(monitor.last_synced_at || ""));
  const intervalSeconds = Number(monitor.interval_seconds);
  const successfulSyncs = Number(monitor.successful_sync_count);
  const maxGapSeconds = Number(monitor.max_success_gap_seconds);
  if (
    !Number.isFinite(enabledSinceMs) ||
    !Number.isFinite(firstSyncMs) ||
    !Number.isFinite(lastSyncMs) ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds <= 0 ||
    !Number.isInteger(successfulSyncs) ||
    successfulSyncs < 1 ||
    !Number.isInteger(maxGapSeconds) ||
    maxGapSeconds < 0
  ) {
    return `${label} source-event certification is missing durable continuous-overlap fields; apply the latest migration and keep replay enabled before certifying`;
  }
  const allowedGapMs = intervalSeconds * 1000 + sourceEventOverlapGapGraceMs;
  if (
    firstSyncMs < enabledSinceMs ||
    lastSyncMs < firstSyncMs ||
    firstSyncMs - enabledSinceMs > allowedGapMs
  ) {
    return `${label} source-event continuous-overlap timestamps are inconsistent or the first clean sync was late; re-enable replay and rebuild the overlap`;
  }
  const overlapMs = lastSyncMs - firstSyncMs;
  if (overlapMs < minimumSourceEventOverlapMs) {
    return `${label} source-event certification requires at least seven days of continuous successful replay; one immediate sync is not certification evidence`;
  }
  if (
    referenceTimeMs < lastSyncMs ||
    referenceTimeMs - lastSyncMs > allowedGapMs
  ) {
    return `${label} source-event certification requires a fresh clean sync within one allowed scheduling gap`;
  }
  if (successfulSyncs < 2 || maxGapSeconds * 1000 > allowedGapMs) {
    return `${label} source-event certification found missing or overlong clean-sync gaps in the overlap window`;
  }
  const minimumSyncs = Math.max(2, Math.floor(overlapMs / allowedGapMs) + 1);
  if (successfulSyncs < minimumSyncs) {
    return `${label} source-event certification has too few successful syncs for continuous coverage: got ${successfulSyncs}, need at least ${minimumSyncs}`;
  }
  return "";
}

function sourceEventCleanupFailureArtifact(jobID, error) {
  return {
    job_id: jobID,
    error: errorArtifact(error?.message || error),
  };
}

function discoveryArtifact(discovery) {
  if (!discovery || typeof discovery !== "object") return discovery || null;
  const copy = JSON.parse(JSON.stringify(discovery));
  if (Array.isArray(copy.warnings)) {
    copy.warnings = copy.warnings.map(redactSensitiveText);
  }
  return copy;
}

function verificationReportArtifact(report) {
  if (!report || typeof report !== "object") return report || null;
  const copy = JSON.parse(JSON.stringify(report));
  if (Array.isArray(copy.subscriber_merge_conflicts)) {
    copy.subscriber_merge_conflicts_count =
      copy.subscriber_merge_conflicts.length;
    delete copy.subscriber_merge_conflicts;
  }
  if (Array.isArray(copy.discovery_warnings)) {
    copy.discovery_warnings = copy.discovery_warnings.map(redactSensitiveText);
  }
  for (const key of [
    "campaign_archive_warnings",
    "template_warnings",
    "source_archive_warnings",
  ]) {
    if (Array.isArray(copy[key])) {
      copy[key] = copy[key].map(redactResourceWarning);
    }
  }
  return copy;
}

function redactResourceWarning(warning) {
  if (!warning || typeof warning !== "object") return warning;
  const out = { ...warning };
  if (typeof out.warning === "string") {
    out.warning = redactSensitiveText(out.warning);
  }
  return out;
}

function pilotAcceptanceArtifact(report) {
  if (!report || typeof report !== "object") return report || null;
  const copy = JSON.parse(JSON.stringify(report));
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.map(redactReportItem);
  }
  return copy;
}

function smsPilotReadinessArtifact(readiness) {
  if (!readiness || typeof readiness !== "object") return readiness || null;
  return {
    can_pilot: readiness.can_pilot === true,
    counts:
      readiness.counts && typeof readiness.counts === "object"
        ? { ...readiness.counts }
        : {},
    items: Array.isArray(readiness.items)
      ? readiness.items.map((item) => ({
          key: item?.key || "",
          label: redactSensitiveText(item?.label || ""),
          status: item?.status || "",
          detail: redactSensitiveText(item?.detail || ""),
        }))
      : [],
  };
}

function rollbackRehearsalArtifact(report) {
  if (!report || typeof report !== "object") return report || null;
  const copy = JSON.parse(JSON.stringify(report));
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.map(redactReportItem);
  }
  return copy;
}

function shadowCheckArtifact(check) {
  if (!check || typeof check !== "object") return check || null;
  const copy = JSON.parse(JSON.stringify(check));
  if (Array.isArray(copy.blockers)) {
    copy.blockers = copy.blockers.map(redactSensitiveText);
  }
  if (Array.isArray(copy.deltas)) {
    copy.deltas = copy.deltas.map((delta) => {
      if (!delta || typeof delta !== "object") return delta;
      const next = { ...delta };
      if (Array.isArray(next.notes)) {
        next.notes = next.notes.map(redactSensitiveText);
      }
      return next;
    });
  }
  return copy;
}

function rollbackArtifact(rollback) {
  if (!rollback || typeof rollback !== "object") return rollback || null;
  const copy = JSON.parse(JSON.stringify(rollback));
  if (copy.error) {
    copy.error = errorArtifact(copy.error);
  }
  return copy;
}

function rollbackCleanupFailureArtifact(jobID, error, rollback) {
  return {
    job_id: jobID,
    rollback: rollbackArtifact(rollback),
    error: errorArtifact(error?.message || error),
  };
}

function redactReportItem(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  if (typeof out.detail === "string") {
    out.detail = redactSensitiveText(out.detail);
  }
  if (Array.isArray(out.evidence)) {
    out.evidence = out.evidence.map(redactSensitiveText);
  }
  return out;
}

function cursorArtifact(cursor) {
  if (!cursor || typeof cursor !== "object") return null;
  const keys = Object.keys(cursor).sort();
  const out = {
    key_count: keys.length,
    keys,
    delta_import_snapshot_present: Boolean(cursor.delta_import_previous_job),
    delta_import_last_error_present: Boolean(cursor.delta_import_last_error),
    delta_import_started_at_present: Boolean(cursor.delta_import_started_at),
    source_event_synced_before_delta_at_present: Boolean(
      cursor.source_event_synced_before_delta_at,
    ),
  };
  if (["importing", "dry_run", "delta_import"].includes(cursor.run_mode)) {
    out.run_mode = cursor.run_mode;
  }
  if (
    ["pass", "warning", "blocker"].includes(cursor.rollback_rehearsal_status)
  ) {
    out.rollback_rehearsal_status = cursor.rollback_rehearsal_status;
  }
  if (cursor.rollback_rehearsal_generated_at) {
    out.rollback_rehearsal_generated_at_present = true;
  }
  if (cursor.rate_limit_retry_at) {
    out.rate_limit_retry_at = String(cursor.rate_limit_retry_at);
  }
  if (cursor.rate_limit_retry_after) {
    out.rate_limit_retry_after = String(cursor.rate_limit_retry_after).slice(
      0,
      80,
    );
  }
  const totalResources = Number(cursor.rollback_rehearsal_total_resources);
  if (Number.isFinite(totalResources)) {
    out.rollback_rehearsal_total_resources = totalResources;
  }
  if (
    ["pass", "warning", "blocker"].includes(
      cursor.activecampaign_deliverability_status,
    )
  ) {
    out.activecampaign_deliverability_status =
      cursor.activecampaign_deliverability_status;
  }
  out.cutover_evidence_keys = cutoverEvidenceKeysFromCursor(keys);
  out.cutover_evidence_detail_count = keys.filter(
    (key) =>
      key.startsWith("activecampaign_cutover_evidence_") &&
      key.endsWith("_detail"),
  ).length;
  out.cutover_evidence_evidence_count = keys.filter(
    (key) =>
      key.startsWith("activecampaign_cutover_evidence_") &&
      key.endsWith("_evidence"),
  ).length;
  return out;
}

function rateLimitPauseFromJob(job) {
  const retryAt = job?.cursor?.rate_limit_retry_at;
  if (!retryAt) return null;
  const retryAtMs = Date.parse(String(retryAt));
  return {
    retry_at: String(retryAt),
    retry_at_ms: Number.isFinite(retryAtMs) ? retryAtMs : 0,
    retry_after: job?.cursor?.rate_limit_retry_after
      ? String(job.cursor.rate_limit_retry_after)
      : "",
  };
}

function rateLimitPauseArtifact(job) {
  const pause = rateLimitPauseFromJob(job);
  if (!pause) return null;
  return {
    retry_at: pause.retry_at,
    retry_after: pause.retry_after || null,
    status: job?.status || "unknown",
    error: errorArtifact(job?.error),
  };
}

function jobTimeoutMessage(jobID, job) {
  const status = job?.status || "unknown";
  const pause = rateLimitPauseFromJob(job);
  if (pause) {
    return `timed out waiting for job ${jobID}; last status ${status}; source rate limit retry_at=${pause.retry_at}${pause.retry_after ? ` retry_after=${pause.retry_after}` : ""}`;
  }
  return `timed out waiting for job ${jobID}; last status ${status}`;
}

function cutoverEvidenceKeysFromCursor(keys) {
  const prefix = "activecampaign_cutover_evidence_";
  const suffix = "_status";
  return keys
    .filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
    .map((key) => key.slice(prefix.length, -suffix.length))
    .sort();
}

function errorArtifact(error) {
  if (!error) return null;
  const raw =
    typeof error === "string" ? error : JSON.stringify(error) || String(error);
  const summary = redactSensitiveText(raw).slice(0, 500);
  return {
    present: true,
    summary,
    redacted: summary !== raw.slice(0, 500),
  };
}

function redactSensitiveText(
  value,
  configuredHosts = process.env.ACTIVECAMPAIGN_ALLOWED_API_HOSTS,
) {
  let redacted = String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(
      /https?:\/\/[^\s"'<>]*(?:api-[a-z0-9-]+\.com|activehosted\.com)(?:\/[^\s"'<>]*)?/giu,
      "[redacted-activecampaign-api-url]",
    )
    .replace(
      /(^|[\s"'(<])((?:[a-z0-9-]+\.)+(?:api-[a-z0-9-]+\.com|activehosted\.com)(?:\/[^\s"'<>]*)?)/giu,
      "$1[redacted-activecampaign-api-url]",
    )
    .replace(
      /(authorization|api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*["']?[^"',\s}]+/giu,
      "$1=[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(
      /\bactivecampaign:contact:[^\s"',;)}\]]+/giu,
      "[redacted-activecampaign-source-event-id]",
    )
    .replace(
      /\bhubspot:contact:[^\s"',;)}\]]+/giu,
      "[redacted-hubspot-source-event-id]",
    )
    .replace(/(\blast_id=)[^&\s"',;)}\]]+/giu, "$1[redacted]")
    .replace(
      /(\bcontact\s+)(?:[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}|[a-z0-9:_\-]+)(\s+(?:missing|source-event|order|failed|replay)|[.;,:)]|$)/giu,
      "$1[redacted-activecampaign-contact]$2",
    );
  for (const host of configuredActiveCampaignHostsForRedaction(
    configuredHosts,
  )) {
    redacted = redacted.replace(
      new RegExp(host.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"),
      "[redacted-activecampaign-api-url]",
    );
  }
  return redacted;
}

function configuredActiveCampaignHostsForRedaction(raw) {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/u, ""))
    .filter(
      (host) =>
        host.includes(".") && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host),
    );
}

function safeArtifactSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return cleaned.slice(0, 80) || "artifact";
}

function pass(id, message) {
  results.push(resultEntry(id, message, "pass"));
}

function skip(id, message) {
  results.push(resultEntry(id, message, "skip"));
}

function fail(id, message) {
  results.push(resultEntry(id, message, "fail"));
}

function resultEntry(id, message, status) {
  const raw = String(message || "");
  const redacted = redactSensitiveText(raw);
  const sanitized = redacted.slice(0, 500);
  return {
    id,
    message: sanitized,
    status,
    ...(redacted !== raw ? { redacted: true } : {}),
    ...(redacted.length > 500 ? { truncated: true } : {}),
  };
}

function trimEnd(s) {
  return s.replace(/\/+$/u, "");
}

function compact(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runSelfTest() {
  const expectedCustomerIOCapabilities = {
    source: "customerio",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
      templates: true,
      campaigns: true,
      reports: false,
      groups: false,
      forms: false,
      landing_pages: false,
      ecommerce: false,
      crm: false,
      custom_objects: false,
      sms: false,
    },
  };
  assertEqual(
    customerIOCapabilityContractError(expectedCustomerIOCapabilities),
    "",
    "accepts the exact Customer.io rebuild-only capability contract",
  );
  assertEqual(
    customerIOCapabilityContractError({
      ...expectedCustomerIOCapabilities,
      supports: {
        ...expectedCustomerIOCapabilities.supports,
        automations: false,
        automation_mode: "none",
        reports: true,
      },
    }),
    "Customer.io discovery returned a stale or unsafe capability contract: supports.automations=false, supports.automation_mode=none, supports.reports=true",
    "rejects a Customer.io server that drops rebuild definitions or overclaims reports",
  );
  assertEqual(
    customerIOCapabilityContractError({
      ...expectedCustomerIOCapabilities,
      supports: {
        ...expectedCustomerIOCapabilities.supports,
        journeys: true,
      },
    }),
    "Customer.io discovery returned a stale or unsafe capability contract: supports.journeys=unexpected",
    "rejects unknown Customer.io runtime capability claims",
  );

  const customerIODiscovery = {
    source: "customerio",
    subscribers_count: 10,
    profiles_without_email_count: 2,
    segments_count: 3,
    automations_count: 2,
    archive_count: 1,
    source_archive_count: 17,
    paid_subs_count: 0,
    templates_count: 2,
    campaigns_count: 4,
    reports_count: 0,
    groups_count: 0,
    forms_count: 0,
    landing_pages_count: 0,
    ecommerce_count: 0,
    custom_objects_count: 2,
    subscription_channels_count: 3,
    sms_campaigns_count: 1,
    push_campaigns_count: 0,
    audiences: [
      { id: "customerio:segment:vip", subscribers_total: 4 },
      { id: "customerio:topic:product", subscribers_total: 7 },
      { id: "customerio:topic:weekly", subscribers_total: 5 },
    ],
    resource_metadata: [
      ["subscribers", true],
      ["non_email_profiles", false],
      ["segments", true],
      ["subscription_topics", true],
      ["campaigns", true],
      ["source_archive", true],
      ["workflow_definitions", true],
      ["transactional", true],
      ["templates", true],
      ["structured_templates", true],
      ["consent_exclusions", true],
      ["channel_dependencies", false],
      ["custom_objects", true],
      ["deliverability", true],
      ["ecosystem", true],
    ].map(([resource, supported]) => ({ resource, supported })),
  };
  for (const [resource, count] of [
    ["deliverability", 1],
    ["ecosystem", 7],
  ]) {
    Object.assign(
      customerIODiscovery.resource_metadata.find(
        (row) => row.resource === resource,
      ),
      {
        source_total: count,
        imported: count,
        status: "preserved_for_rebuild",
      },
    );
  }
  Object.assign(
    customerIODiscovery.resource_metadata.find(
      (row) => row.resource === "source_archive",
    ),
    {
      source_total: 17,
      imported: 17,
      status: "preserved_for_rebuild",
    },
  );
  Object.assign(
    customerIODiscovery.resource_metadata.find(
      (row) => row.resource === "subscription_topics",
    ),
    {
      source_total: 5,
      imported: 5,
    },
  );
  Object.assign(
    customerIODiscovery.resource_metadata.find(
      (row) => row.resource === "custom_objects",
    ),
    {
      source_total: 2,
      imported: 2,
    },
  );
  assertEqual(
    customerIODiscoveryCountContractError(customerIODiscovery),
    "",
    "accepts exact nonnegative Customer.io inventory bounds",
  );
  assertEqual(
    customerIODiscoveryCountContractError({
      ...customerIODiscovery,
      automations_count: 5,
      archive_count: 5,
      source_archive_count: 11,
      reports_count: 1,
    }),
    "Customer.io discovery returned inconsistent exact inventory counts: reports_count=1, archive_count>campaigns_count, automations_count>campaigns_count, source_archive_count<campaigns_count+custom_objects_count+subscription_channels_count+8_checklists",
    "rejects inconsistent Customer.io workflow, archive, and checklist bounds",
  );
  assertEqual(
    customerIODiscoveryCompletenessContractError(customerIODiscovery),
    "",
    "accepts the exact fifteen-row Customer.io discovery matrix",
  );
  const customerIOArchiveReport = {
    source_archive_imported: 17,
    source_archive_by_resource: {
      customerio_newsletter: 4,
      customerio_object_type: 2,
      customerio_subscription_channel: 3,
      customerio_migration_checklist: 8,
    },
    resource_completeness: [
      {
        resource: "subscription_topics",
        source_total: 5,
        imported: 5,
      },
    ],
  };
  assertEqual(
    customerIOSourceArchiveInventoryContractError(
      customerIOArchiveReport,
      customerIODiscovery,
    ),
    "",
    "accepts exact Customer.io channel definitions in the imported source archive",
  );
  assertEqual(
    customerIOSourceArchiveInventoryContractError(
      {
        ...customerIOArchiveReport,
        source_archive_by_resource: {
          ...customerIOArchiveReport.source_archive_by_resource,
          customerio_subscription_channel: 2,
        },
      },
      customerIODiscovery,
    ),
    "Customer.io verification report does not match exact discovery-bound source-archive and subscription-channel inventory: customerio_subscription_channel=2, source_archive_by_resource.sum=16",
    "rejects a dry-run or commit report that loses a Customer.io channel definition",
  );
  assertEqual(
    customerIODiscoveryCompletenessContractError({
      ...customerIODiscovery,
      resource_metadata: customerIODiscovery.resource_metadata.filter(
        (row) => row.resource !== "ecosystem",
      ),
    }),
    "Customer.io discovery must expose the exact profile, audience, archive, rebuild, channel, deliverability, and ecosystem completeness contract: ecosystem.count=0, resource_metadata.count=14",
    "fails closed when Customer.io discovery omits an ecosystem row",
  );

  const customerIOCredentials = {
    accountID: "31415",
    extra: {
      customerio_workspace_id: "31415",
      region: "eu",
    },
  };
  assertEqual(
    customerIOCredentialConfigError("customerio", customerIOCredentials),
    "",
    "accepts a numeric Customer.io workspace bound to an exact region",
  );
  assertEqual(
    customerIOCredentialConfigError("customerio", {
      ...customerIOCredentials,
      accountID: "workspace-name",
    }),
    "CUSTOMERIO_WORKSPACE_ID must be an explicit numeric workspace ID returned by /v1/workspaces",
    "rejects a nonnumeric Customer.io workspace selector",
  );
  assertEqual(
    customerIOCredentialConfigError("customerio", {
      ...customerIOCredentials,
      extra: { ...customerIOCredentials.extra, region: "EU" },
    }),
    "CUSTOMERIO_REGION must be exactly us or eu",
    "rejects a noncanonical Customer.io region",
  );
  assertEqual(
    customerIOCredentialConfigError("customerio", {
      ...customerIOCredentials,
      extra: {
        ...customerIOCredentials.extra,
        customerio_workspace_id: "27182",
      },
    }),
    "Customer.io account_id and customerio_workspace_id must select the same numeric workspace",
    "rejects a split Customer.io workspace binding",
  );
  assertEqual(
    customerIOSourceEventGuardMessage("customerio", { sourceEvents: true }),
    "Customer.io does not expose a complete incremental profile change feed for migration certification; unset CUSTOMERIO_LIVE_SOURCE_EVENTS and use CUSTOMERIO_LIVE_DELTA_IMPORT=1 for the authoritative final full snapshot",
    "explicitly rejects unsafe Customer.io source-event certification",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("customerio", { commit: true }, [
      "CUSTOMERIO_API_KEY",
      "CUSTOMERIO_WORKSPACE_ID",
    ]),
    "Customer.io live certification cannot run without credentials; set CUSTOMERIO_API_KEY, CUSTOMERIO_WORKSPACE_ID or unset every CUSTOMERIO_LIVE_* certification flag",
    "fails Customer.io live mode instead of skipping missing credentials",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("customerio", { rollback: true }, [
      "CUSTOMERIO_API_KEY",
    ]),
    "Customer.io live certification cannot run without credentials; set CUSTOMERIO_API_KEY or unset every CUSTOMERIO_LIVE_* certification flag",
    "treats a standalone Customer.io rollback flag as live mode",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("customerio", {}, ["CUSTOMERIO_API_KEY"]),
    "",
    "allows an unconfigured Customer.io provider to remain an ordinary skip",
  );

  const customerIOPilotOptions = {
    ...customerIOCredentials,
    commit: true,
    rollback: true,
    deltaImport: true,
    shadowCheck: true,
    rollbackRehearsal: true,
    pilotAcceptance: true,
    manualReviewSignoff: true,
    manualReviewEvidenceRef: "CIO-REVIEW-123",
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "CIO-CLEANUP-123",
  };
  assertEqual(
    customerIOFullCertificationGuardMessage("customerio", {
      requireFullCertification: true,
    }),
    "CUSTOMERIO_LIVE_REQUIRE_FULL_CERTIFICATION=1 requires CUSTOMERIO_LIVE_DRY_RUN=1, CUSTOMERIO_LIVE_COMMIT=1, CUSTOMERIO_LIVE_DELTA_IMPORT=1, CUSTOMERIO_LIVE_SHADOW_CHECK=1, CUSTOMERIO_LIVE_ROLLBACK_REHEARSAL=1, CUSTOMERIO_LIVE_PILOT_ACCEPTANCE=1, CUSTOMERIO_LIVE_ROLLBACK=1, CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF=1, CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_REVIEW=1, CUSTOMERIO_LIVE_FAIL_ON_DISCOVERY_WARNINGS=1, CUSTOMERIO_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS=1; a credentials/discovery-only run is not a Customer.io certification",
    "rejects a discovery-only Customer.io run when the workflow requires full certification",
  );
  const customerIOFullCertificationOptions = {
    ...customerIOPilotOptions,
    requireFullCertification: true,
    dryRun: true,
    failOnDiscoveryWarnings: true,
    failOnSourceArchiveWarnings: true,
  };
  assertEqual(
    customerIOFullCertificationGuardMessage(
      "customerio",
      customerIOFullCertificationOptions,
    ),
    "",
    "accepts only a complete Customer.io certification mode manifest",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("customerio", customerIOPilotOptions),
    "",
    "accepts the complete Customer.io full-snapshot pilot gate set",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("customerio", {
      ...customerIOPilotOptions,
      deltaImport: false,
    }),
    "set CUSTOMERIO_LIVE_COMMIT=1, CUSTOMERIO_LIVE_ROLLBACK=1, CUSTOMERIO_LIVE_DELTA_IMPORT=1, CUSTOMERIO_LIVE_SHADOW_CHECK=1, and CUSTOMERIO_LIVE_ROLLBACK_REHEARSAL=1 so Customer.io pilot acceptance is bound to a final authoritative full snapshot, post-delta fingerprint shadow check, rollback rehearsal, and cleanup; do not enable CUSTOMERIO_LIVE_SOURCE_EVENTS",
    "requires a final Customer.io full-snapshot delta before pilot acceptance",
  );
  assertEqual(
    liveCredentialSourcePreflightGuard(
      "customerio",
      customerIOFullCertificationOptions,
      "/durable/customerio-artifacts",
    ),
    null,
    "accepts a fully configured Customer.io live certification preflight",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "customerio",
      { ...customerIOPilotOptions, sourceEvents: true },
      "/durable/customerio-artifacts",
    ),
    {
      id: "customerio_live_source_events",
      message:
        "Customer.io does not expose a complete incremental profile change feed for migration certification; unset CUSTOMERIO_LIVE_SOURCE_EVENTS and use CUSTOMERIO_LIVE_DELTA_IMPORT=1 for the authoritative final full snapshot",
    },
    "rejects Customer.io source-event mode before any credential call",
  );
  assertEqual(
    liveArtifactGuardMessage("customerio", { commit: true }, ""),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with Customer.io live certification flags so the run writes durable evidence artifacts",
    "requires durable Customer.io certification artifacts",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        recommended_action: "ready_for_cutover_review",
        blockers: [],
      },
      { expectNoDeltaImport: true },
      "customerio",
    ),
    "",
    "accepts a clean post-delta Customer.io fingerprint shadow check",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: true,
        recommended_action: "run_delta_import_before_cutover",
        blockers: [],
      },
      { expectNoDeltaImport: true },
      "customerio",
    ),
    "Customer.io shadow-check still requires a final delta import; cutover is not certified",
    "rejects a stale Customer.io post-delta shadow check",
  );
  assertEqual(
    rollbackRehearsalCertificationError("customerio", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "Customer.io rollback rehearsal must be pass for live certification; got warning",
    "requires a passing Customer.io rollback rehearsal",
  );
  assertEqual(
    pilotAcceptanceCertificationError(
      "customerio",
      { status: "warning", warnings: 1, items: [] },
      { requirePass: true },
    ),
    "Customer.io pilot acceptance must be pass for live certification; got warning with 1 warning(s)",
    "requires passing Customer.io pilot acceptance",
  );

  const customerIOReviewMarkers = {
    customerio_consent_subscription_review:
      "global_topic_esp_channel_consent=reviewed",
    customerio_identity_audience_review:
      "cio_id_duplicate_email_snapshot=reviewed",
    customerio_automation_rebuild_review:
      "automation_broadcast_transactional_rebuild=reviewed",
    customerio_channel_dependency_review: "non_email_channels=reviewed",
    customerio_deliverability_review: "sender_domain_suppression=reviewed",
    customerio_ecosystem_dependencies_review:
      "object_event_export_dependencies=reviewed",
  };
  const customerIOReview = {
    items: customerIOManualReviewEvidenceKeys.map((key) => ({
      key,
      status: "warning",
      evidence: [],
    })),
  };
  assertEqual(
    customerIOCutoverReviewContractError(customerIOReview),
    "",
    "requires all six Customer.io cutover review keys before sign-off",
  );
  const recordedCustomerIOReview = {
    items: customerIOManualReviewEvidenceKeys.map((key) => ({
      key,
      status: "pass",
      evidence: [
        "evidence_ref=CIO-REVIEW-123",
        "CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF=1",
        "final_full_snapshot=reviewed",
        customerIOReviewMarkers[key],
        ...(key === "customerio_ecosystem_dependencies_review"
          ? [
              "static_checklist_count=8",
              "static_checklists_are_inventory=false",
            ]
          : []),
      ],
    })),
  };
  assertEqual(
    customerIOCutoverReviewContractError(recordedCustomerIOReview, {
      requireRecordedEvidence: true,
    }),
    "",
    "requires persisted evidence for all six Customer.io cutover reviews",
  );
  assertEqual(
    customerIOCutoverReviewContractError(
      {
        items: recordedCustomerIOReview.items.filter(
          (item) => item.key !== "customerio_deliverability_review",
        ),
      },
      { requireRecordedEvidence: true },
    ),
    "Customer.io pilot acceptance must expose and evidence all six post-final-snapshot reviews: customerio_deliverability_review.count=0",
    "fails Customer.io cutover certification when one review is absent",
  );

  const customerIOFingerprintComponents = {
    subscribers: { count: 10, digest: "c".repeat(64) },
    segments: { count: 3, digest: "d".repeat(64) },
    editable_templates: { count: 2, digest: "e".repeat(64) },
    sent_campaign_archive: { count: 1, digest: "f".repeat(64) },
    source_archive: { count: 12, digest: "0".repeat(64) },
  };
  const customerIOSnapshot = {
    verification_report: {
      resource_completeness: [
        { resource: "subscribers", source_total: 10, imported: 10 },
        { resource: "segments", source_total: 3, imported: 3 },
        { resource: "campaigns", source_total: 1, imported: 1 },
        { resource: "source_archive", source_total: 12, imported: 12 },
        { resource: "templates", source_total: 2, imported: 2 },
      ],
    },
    cursor: {
      __postwave_customerio_import_epoch: "a".repeat(64),
      __postwave_customerio_source_fingerprint: JSON.stringify({
        version: 1,
        digest: customerIOFingerprintDigest(customerIOFingerprintComponents),
        components: customerIOFingerprintComponents,
      }),
    },
  };
  assertEqual(
    customerIOFullSnapshotContractError(customerIOSnapshot),
    "",
    "accepts exact fingerprint-bound Customer.io snapshot evidence",
  );
  assertEqual(
    customerIOFullSnapshotContractError({
      ...customerIOSnapshot,
      verification_report: {
        resource_completeness:
          customerIOSnapshot.verification_report.resource_completeness.map(
            (row) =>
              row.resource === "subscribers"
                ? { ...row, imported: row.imported - 1 }
                : row,
          ),
      },
    }),
    "Customer.io commit/delta did not prove an exact fingerprint-bound full snapshot: subscribers.exact=9/10",
    "rejects an incomplete Customer.io full snapshot",
  );
  assertEqual(
    customerIOFullSnapshotContractError({
      ...customerIOSnapshot,
      cursor: {
        ...customerIOSnapshot.cursor,
        __postwave_customerio_source_fingerprint: JSON.stringify({
          version: 1,
          digest: "b".repeat(64),
          components: customerIOFingerprintComponents,
        }),
      },
    }),
    "Customer.io commit/delta did not prove an exact fingerprint-bound full snapshot: source_fingerprint.digest=integrity_mismatch",
    "rejects a Customer.io fingerprint whose aggregate digest was not derived from its components",
  );
  assertEqual(
    customerIOImportEpochRotationError(customerIOSnapshot, {
      cursor: { __postwave_customerio_import_epoch: "1".repeat(64) },
    }),
    "",
    "requires a newly rotated Customer.io final-delta import epoch",
  );
  assertEqual(
    customerIOImportEpochRotationError(customerIOSnapshot, customerIOSnapshot),
    "Customer.io final full-snapshot delta did not rotate the import epoch",
    "rejects reuse of Customer.io base-import fingerprint evidence",
  );

  const expectedKlaviyoCapabilities = {
    source: "klaviyo",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      templates: true,
      campaigns: true,
      forms: true,
      reports: false,
      ecommerce: false,
      sms: false,
    },
  };
  assertEqual(
    klaviyoCapabilityContractError(expectedKlaviyoCapabilities),
    "",
    "accepts the fail-closed Klaviyo rebuild-only capability contract",
  );
  assertEqual(
    klaviyoCapabilityContractError({
      ...expectedKlaviyoCapabilities,
      supports: {
        ...expectedKlaviyoCapabilities.supports,
        automation_mode: "runtime",
        reports: true,
      },
    }),
    "Klaviyo discovery returned a stale or unsafe capability contract: supports.automation_mode=runtime, supports.reports=true",
    "rejects a Klaviyo server that overclaims runtime flows or reports",
  );
  assertEqual(
    klaviyoDiscoveryCountContractError({
      profiles_without_email_count: 3,
      source_archive_count: 9,
      sms_campaigns_count: 2,
      push_campaigns_count: 1,
    }),
    "",
    "accepts explicit nonnegative Klaviyo exclusion and archive counts",
  );
  assertEqual(
    klaviyoDiscoveryCountContractError({
      profiles_without_email_count: -1,
      source_archive_count: 9,
    }),
    "Klaviyo discovery must return nonnegative integer inventory counts: profiles_without_email_count, sms_campaigns_count, push_campaigns_count",
    "fails closed when Klaviyo discovery counts are negative or missing",
  );
  const klaviyoStaticChecklistDiscovery = {
    source_archive_count: 8,
    resource_metadata: [
      "ecommerce",
      "reviews",
      "service",
      "cdp",
      "multi_email_profiles",
      "omni_channels",
      "deliverability",
      "marketplace",
    ].map((resource) => ({
      resource,
      source_total: 1,
      imported: 1,
      supported: false,
      status: "manual_rebuild_required",
    })),
  };
  assertEqual(
    klaviyoStaticChecklistContractError(klaviyoStaticChecklistDiscovery),
    "",
    "requires all eight unconditional Klaviyo static checklist rows",
  );
  assertEqual(
    klaviyoStaticChecklistContractError({
      ...klaviyoStaticChecklistDiscovery,
      resource_metadata:
        klaviyoStaticChecklistDiscovery.resource_metadata.filter(
          (row) => row.resource !== "marketplace",
        ),
    }),
    "Klaviyo discovery must expose eight unconditional source_total=1 static checklist rows that do not imply source inventory: marketplace.count=0",
    "fails closed when Klaviyo discovery omits a static checklist row",
  );
  assertEqual(
    klaviyoStaticChecklistContractError({
      ...klaviyoStaticChecklistDiscovery,
      source_archive_count: 7,
    }),
    "Klaviyo discovery must expose eight unconditional source_total=1 static checklist rows that do not imply source inventory: source_archive_count=7",
    "rejects a Klaviyo source-archive count smaller than the unconditional checklist floor",
  );
  const klaviyoMultiEmailDiscovery = {
    source_archive_count: 9,
    resource_metadata: [
      {
        resource: "multi_email_profiles",
        label: "Secondary email identities and per-address consent",
        source_total: 1,
        imported: 1,
        supported: false,
        status: "manual_rebuild_required",
        notes: [
          "Stable profile retrieval does not expose Multi-Email Profile secondary identifiers or their independent consent/suppression state. Use a provider export or retained Klaviyo access for manual review.",
        ],
      },
    ],
  };
  assertEqual(
    klaviyoMultiEmailProfileContractError(klaviyoMultiEmailDiscovery),
    "",
    "requires an explicit Klaviyo Multi-Email Profile source-archive/manual-review record",
  );
  assertEqual(
    klaviyoMultiEmailProfileContractError({
      ...klaviyoMultiEmailDiscovery,
      resource_metadata: [],
    }),
    "Klaviyo discovery must include exactly one multi_email_profiles source-archive/manual-review row; got 0",
    "fails closed when Klaviyo discovery omits the Multi-Email Profile record",
  );
  assertEqual(
    klaviyoMultiEmailProfileContractError({
      ...klaviyoMultiEmailDiscovery,
      resource_metadata: [
        {
          ...klaviyoMultiEmailDiscovery.resource_metadata[0],
          imported: 0,
        },
      ],
    }),
    "Klaviyo discovery returned an unsafe Multi-Email Profile review contract: imported=0",
    "fails closed when the Klaviyo Multi-Email Profile source-archive record is not preserved",
  );
  const klaviyoMultiEmailReview = {
    items: [
      {
        key: "klaviyo_consent_suppression_review",
        label: "Klaviyo consent and suppression review",
        detail:
          "Reconcile Multi-Email Profile secondary addresses and independent per-address consent.",
      },
      {
        key: "klaviyo_ecosystem_dependencies_review",
        label: "Klaviyo ecosystem dependency review",
        detail:
          "Review Multi-Email Profile secondary identities with ecosystem dependencies.",
      },
    ],
  };
  assertEqual(
    klaviyoMultiEmailReviewContractError(klaviyoMultiEmailReview),
    "",
    "ties Klaviyo Multi-Email Profile review to consent and ecosystem acceptance items",
  );
  assertEqual(
    klaviyoMultiEmailReviewContractError({
      items: [klaviyoMultiEmailReview.items[0]],
    }),
    "Klaviyo pilot acceptance must tie the multi_email_profiles source-archive record to consent and ecosystem evidence: klaviyo_ecosystem_dependencies_review.count=0",
    "fails closed when ecosystem acceptance omits the Klaviyo Multi-Email Profile review",
  );
  assertEqual(
    klaviyoMultiEmailReviewContractError(
      {
        items: klaviyoMultiEmailReview.items.map((item) => ({
          ...item,
          status: "pass",
          evidence: ["source_archive_resource=multi_email_profiles"],
        })),
      },
      { requireRecordedEvidence: true },
    ),
    "",
    "requires persisted Multi-Email Profile evidence on both Klaviyo acceptance items",
  );
  assertEqual(
    klaviyoMultiEmailReviewContractError(
      {
        items: klaviyoMultiEmailReview.items.map((item) => ({
          ...item,
          status: "pass",
          evidence: [],
        })),
      },
      { requireRecordedEvidence: true },
    ),
    "Klaviyo pilot acceptance must tie the multi_email_profiles source-archive record to consent and ecosystem evidence: klaviyo_consent_suppression_review.source_archive_evidence=missing, klaviyo_ecosystem_dependencies_review.source_archive_evidence=missing",
    "fails closed when Klaviyo consent and ecosystem items lack the Multi-Email Profile source-archive evidence marker",
  );
  const klaviyoEcosystemGapReview = {
    items: [
      {
        key: "klaviyo_ecosystem_dependencies_review",
        status: "pass",
        detail:
          "All eight unconditional static checklist obligations were reviewed without treating them as source inventory.",
        evidence: [
          "static_checklist_count=8",
          "static_checklists_are_inventory=false",
          "nullable_definitions=reviewed",
          "campaign_tags=id_only",
        ],
      },
    ],
  };
  assertEqual(
    klaviyoEcosystemGapReviewContractError(klaviyoEcosystemGapReview),
    "",
    "requires static-checklist, nullable-definition, and campaign-tag-ID ecosystem evidence",
  );
  assertEqual(
    klaviyoEcosystemGapReviewContractError({
      items: [
        {
          ...klaviyoEcosystemGapReview.items[0],
          evidence: klaviyoEcosystemGapReview.items[0].evidence.filter(
            (entry) => entry !== "campaign_tags=id_only",
          ),
        },
      ],
    }),
    "Klaviyo ecosystem evidence must treat eight static rows as checklists, review nullable definitions, and preserve campaign tags as IDs: campaign_tags=missing",
    "fails closed when ecosystem evidence omits the campaign-tag ID-only boundary",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("klaviyo", { dryRun: true }, [
      "KLAVIYO_API_KEY",
    ]),
    "Klaviyo live certification cannot run without credentials; set KLAVIYO_API_KEY or unset every KLAVIYO_LIVE_* certification flag",
    "fails closed when Klaviyo live certification is requested without a private key",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("klaviyo", {}, ["KLAVIYO_API_KEY"]),
    "",
    "allows an unconfigured optional Klaviyo credential smoke to remain skipped",
  );
  assertDeepEqual(
    selectedAudienceIDsFor(
      { audiences: [{ id: "aud_first" }, { id: "aud_second" }] },
      [],
    ),
    undefined,
    "requires an explicit Mailchimp audience for mutation certification",
  );
  assertDeepEqual(
    selectedAudienceIDsFor({ audiences: [{ id: "aud_a" }, { id: "aud_b" }] }, [
      "aud_b",
      "aud_a",
      "aud_b",
    ]),
    ["aud_a", "aud_b"],
    "honors, deduplicates, and sorts configured Mailchimp audience IDs",
  );
  assertThrows(
    () =>
      selectedAudienceIDsFor({ audiences: [{ id: "aud_first" }] }, [
        "aud_missing",
      ]),
    "configured Mailchimp audience ID(s) were not discovered",
    "rejects configured Mailchimp audiences outside discovery",
  );
  assertEqual(
    shouldRunDryRun({ commit: true, dryRun: false }),
    true,
    "runs the same-job dry-run prerequisite for commit-only certification",
  );
  assertEqual(
    shouldRunDryRun({ commit: false, dryRun: false }),
    false,
    "does not mutate jobs during discovery-only certification",
  );
  assertDeepEqual(
    compact({
      job_id: "job_1",
      selected_audience_ids: ["aud_first"],
      empty: "",
      missing: undefined,
    }),
    { job_id: "job_1", selected_audience_ids: ["aud_first"] },
    "keeps selected audience arrays while removing empty values",
  );
  assertEqual(
    liveCommitGuardMessage("mailchimp", { commit: true, rollback: false }),
    liveRollbackRequiredMessageFor("mailchimp"),
    "requires rollback when live commit certification is enabled",
  );
  assertEqual(
    liveCommitGuardMessage("activecampaign", { commit: true, rollback: true }),
    "",
    "allows live commit certification when rollback is enabled",
  );
  assertEqual(
    liveRollbackRequiredMessageFor("activecampaign"),
    "set ACTIVECAMPAIGN_LIVE_ROLLBACK=1 with ACTIVECAMPAIGN_LIVE_COMMIT=1 so live certification proves cleanup",
    "uses source-specific rollback guard env names",
  );
  assertEqual(
    liveSourceEventGuardMessage("activecampaign", {
      sourceEvents: true,
      commit: false,
    }),
    "set ACTIVECAMPAIGN_LIVE_COMMIT=1 so source-event certification runs against a completed import",
    "requires commit for source-event certification",
  );
  assertEqual(
    liveSourceEventGuardMessage("activecampaign", {
      sourceEvents: true,
      commit: true,
    }),
    "",
    "allows source-event certification with commit",
  );
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage({
      sourceEvents: true,
      sourceEventIntervalSeconds: 900,
    }),
    "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume a post-pilot rollback/monitor cleanup",
    "rejects the legacy one-shot ActiveCampaign source-event flow",
  );
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage({
      sourceEvents: true,
      sourceEventPhase: "prepare",
      sourceEventIntervalSeconds: 900,
      commit: true,
      rollback: false,
    }),
    "",
    "allows prepare to retain the committed job and monitor",
  );
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage({
      sourceEvents: true,
      sourceEventPhase: "prepare",
      sourceEventIntervalSeconds: 900,
      commit: true,
      rollback: true,
    }),
    "unset ACTIVECAMPAIGN_LIVE_ROLLBACK during the prepare phase so the committed job and monitor remain available for the overlap",
    "prevents prepare from rolling back the retained overlap job",
  );
  const activeCampaignFinishOptions = {
    sourceEvents: true,
    sourceEventPhase: "finish",
    sourceEventJobID: "00000000-0000-4000-8000-000000000001",
    sourceEventIntervalSeconds: 900,
    rollback: true,
    deltaImport: true,
    shadowCheck: true,
    rollbackRehearsal: true,
    consentExclusionReview: true,
    consentExclusionEvidenceRef: "CONSENT-123",
    deliverabilityReview: true,
    manualReviewSignoff: true,
    pilotAcceptance: true,
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "CERT-123",
  };
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage(activeCampaignFinishOptions),
    "",
    "allows finish to reuse the retained job with every strict cutover gate",
  );
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage({
      ...activeCampaignFinishOptions,
      sourceEventJobID: "",
    }),
    "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID to the retained job ID emitted by the prepare phase",
    "requires finish to name the retained prepare job",
  );
  const activeCampaignCleanupOptions = {
    sourceEvents: true,
    sourceEventPhase: "cleanup",
    sourceEventJobID: "00000000-0000-4000-8000-000000000001",
    sourceEventIntervalSeconds: 900,
    rollback: true,
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "CERT-123",
  };
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage(activeCampaignCleanupOptions),
    "",
    "allows cleanup-only retry with the retained job and no final gates",
  );
  assertEqual(
    activeCampaignSourceEventPhaseGuardMessage({
      ...activeCampaignCleanupOptions,
      deltaImport: true,
    }),
    "cleanup is retry-only: unset final-delta, shadow, review, SMS, rehearsal, and pilot flags so certified overlap/final-delta work is not rerun",
    "prevents cleanup-only retry from rerunning final delta",
  );
  assertEqual(
    liveDeltaImportGuardMessage("activecampaign", {
      deltaImport: true,
      commit: false,
    }),
    "set ACTIVECAMPAIGN_LIVE_COMMIT=1 so final delta import certification runs against a completed import",
    "requires commit for final delta certification",
  );
  assertEqual(
    liveDeltaImportGuardMessage("activecampaign", {
      deltaImport: true,
      commit: true,
    }),
    "",
    "allows final delta certification with commit",
  );
  assertEqual(
    liveCredentialCleanupGuardMessage("activecampaign", {
      credentialCleanupReview: true,
      commit: false,
    }),
    "set ACTIVECAMPAIGN_LIVE_COMMIT=1 and ACTIVECAMPAIGN_LIVE_ROLLBACK=1 so credential cleanup review runs after a completed isolated cutover and rollback cleanup",
    "requires commit and rollback for credential cleanup review",
  );
  assertEqual(
    liveCredentialCleanupGuardMessage("activecampaign", {
      credentialCleanupReview: true,
      commit: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_COMMIT=1 and ACTIVECAMPAIGN_LIVE_ROLLBACK=1 so credential cleanup review runs after a completed isolated cutover and rollback cleanup",
    "requires rollback for credential cleanup review",
  );
  assertEqual(
    liveCredentialCleanupGuardMessage("activecampaign", {
      credentialCleanupReview: true,
      commit: true,
      rollback: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for the API-token reset/disconnect proof",
    "requires a non-secret evidence reference for credential cleanup review",
  );
  assertEqual(
    liveCredentialCleanupGuardMessage("activecampaign", {
      credentialCleanupReview: true,
      commit: true,
      rollback: true,
      credentialCleanupEvidenceRef:
        "https://tenant.activehosted.com/api/3 Api-Token=secret-token",
    }),
    "ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive credential cleanup evidence references",
  );
  assertEqual(
    liveCredentialCleanupGuardMessage("activecampaign", {
      credentialCleanupReview: true,
      commit: true,
      rollback: true,
      credentialCleanupEvidenceRef: "CERT-123",
    }),
    "",
    "allows credential cleanup review after commit, rollback, and evidence reference are enabled",
  );
  assertEqual(
    liveConsentExclusionGuardMessage("activecampaign", {
      consentExclusionReview: true,
      commit: true,
      deltaImport: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for channel-consent and exclusion reconciliation",
    "requires traceable ActiveCampaign consent/exclusion evidence",
  );
  assertEqual(
    liveConsentExclusionGuardMessage("activecampaign", {
      consentExclusionReview: true,
      commit: true,
      deltaImport: true,
      consentExclusionEvidenceRef:
        "https://tenant.activehosted.com/api/3 contact=ada@example.com",
    }),
    "ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive ActiveCampaign consent/exclusion evidence references",
  );
  assertEqual(
    liveConsentExclusionGuardMessage("activecampaign", {
      consentExclusionReview: true,
      commit: true,
      deltaImport: true,
      consentExclusionEvidenceRef: "CONSENT-123",
    }),
    "",
    "allows consent/exclusion review after final delta with a non-secret evidence reference",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: false,
      deltaImport: false,
    }),
    "set ACTIVECAMPAIGN_LIVE_COMMIT=1, ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1, ACTIVECAMPAIGN_LIVE_DELTA_IMPORT=1, and ACTIVECAMPAIGN_LIVE_SHADOW_CHECK=1 so ActiveCampaign pilot acceptance includes source-event replay, final delta, and post-delta shadow evidence",
    "requires commit, source-event replay, final delta, and shadow check for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: false,
    }),
    "set ACTIVECAMPAIGN_LIVE_DELTA_IMPORT=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes final delta evidence",
    "requires final delta for committed ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes source-event replay evidence",
    "requires source-event replay for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_SHADOW_CHECK=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes post-delta shadow-check evidence",
    "requires post-delta shadow check for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_ROLLBACK_REHEARSAL=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes rollback rehearsal evidence",
    "requires rollback rehearsal for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes channel-consent and exclusion reconciliation evidence",
    "requires consent/exclusion review for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for channel-consent and exclusion reconciliation",
    "requires traceable consent/exclusion evidence for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
    }),
    "set ACTIVECAMPAIGN_LIVE_DELIVERABILITY_REVIEW=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes deliverability sign-off evidence",
    "requires deliverability review for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
      deliverabilityReview: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_MANUAL_REVIEW_SIGNOFF=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes manual review sign-off evidence",
    "requires manual review sign-off for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
      deliverabilityReview: true,
      manualReviewSignoff: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign live certification includes API-token reset/disconnect evidence",
    "requires credential cleanup evidence for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
      deliverabilityReview: true,
      manualReviewSignoff: true,
      credentialCleanupReview: true,
    }),
    "set ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign credential cleanup evidence is traceable",
    "requires a credential cleanup evidence reference for ActiveCampaign pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
      deliverabilityReview: true,
      manualReviewSignoff: true,
      credentialCleanupReview: true,
      credentialCleanupEvidenceRef: "api_key=secret-token",
    }),
    "ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive credential cleanup evidence references for pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("activecampaign", {
      pilotAcceptance: true,
      commit: true,
      deltaImport: true,
      sourceEvents: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      consentExclusionReview: true,
      consentExclusionEvidenceRef: "CONSENT-123",
      deliverabilityReview: true,
      manualReviewSignoff: true,
      credentialCleanupReview: true,
      credentialCleanupEvidenceRef: "CERT-123",
    }),
    "",
    "allows ActiveCampaign pilot acceptance with commit, final delta, source-event replay, post-delta shadow check, rollback rehearsal, consent/exclusion evidence, deliverability evidence, manual review sign-off, credential cleanup evidence, and evidence references",
  );
  const beehiivPilotOptions = {
    pilotAcceptance: true,
    commit: true,
    rollback: true,
    deltaImport: true,
    shadowCheck: true,
    rollbackRehearsal: true,
    manualReviewSignoff: true,
    manualReviewEvidenceRef: "BEEHIIV-REVIEW-123",
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "BEEHIIV-KEY-ROTATION-123",
  };
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      pilotAcceptance: true,
    }),
    "set BEEHIIV_LIVE_COMMIT=1, BEEHIIV_LIVE_DELTA_IMPORT=1, BEEHIIV_LIVE_SHADOW_CHECK=1, and BEEHIIV_LIVE_ROLLBACK_REHEARSAL=1 so Beehiiv pilot acceptance is bound to a final full snapshot, deletion reconciliation, shadow check, and durable rollback rehearsal",
    "requires final-delta, shadow-check, and rollback evidence for Beehiiv pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      manualReviewSignoff: false,
    }),
    "set BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF=1 so Beehiiv consent provenance, campaign archive fidelity, dynamic segment rules, and automation rebuilds are explicitly reviewed after final delta",
    "requires Beehiiv consent, campaign, segment, and automation review",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      manualReviewEvidenceRef: "",
    }),
    "set BEEHIIV_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving consent reconciliation, campaign archive fidelity, and segment/automation rebuild review",
    "requires traceable Beehiiv manual-review evidence",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      manualReviewEvidenceRef: "api_key=secret-token",
    }),
    "BEEHIIV_LIVE_MANUAL_REVIEW_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive Beehiiv manual-review evidence references",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      credentialCleanupReview: false,
    }),
    "set BEEHIIV_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 so the dedicated Beehiiv API key is rotated or revoked after rollback certification",
    "requires Beehiiv credential cleanup review",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      credentialCleanupEvidenceRef: "",
    }),
    "set BEEHIIV_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for the API-key reset/disconnect proof",
    "requires traceable Beehiiv credential cleanup evidence",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", {
      ...beehiivPilotOptions,
      credentialCleanupEvidenceRef: "api_key=secret-token",
    }),
    "BEEHIIV_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive Beehiiv credential cleanup evidence references",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("beehiiv", beehiivPilotOptions),
    "",
    "allows strict Beehiiv pilot certification only with every review and cleanup gate",
  );
  const klaviyoPilotOptions = {
    pilotAcceptance: true,
    commit: true,
    rollback: true,
    sourceEvents: true,
    sourceEventIntervalSeconds: 900,
    deltaImport: true,
    shadowCheck: true,
    rollbackRehearsal: true,
    manualReviewSignoff: true,
    manualReviewEvidenceRef: "KLAVIYO-REVIEW-123",
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "KLAVIYO-KEY-ROTATION-123",
  };
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", {
      pilotAcceptance: true,
    }),
    "set KLAVIYO_LIVE_COMMIT=1, KLAVIYO_LIVE_ROLLBACK=1, KLAVIYO_LIVE_SOURCE_EVENTS=1, KLAVIYO_LIVE_DELTA_IMPORT=1, KLAVIYO_LIVE_SHADOW_CHECK=1, and KLAVIYO_LIVE_ROLLBACK_REHEARSAL=1 so Klaviyo pilot acceptance is bound to changed-profile replay, a final full source snapshot that materializes changed addresses, disables prior source-owned identities, and verifies post-list-suppression send-targetable membership projections, clean shadow evidence, and rollback proof",
    "requires the full Klaviyo source-event, snapshot, shadow, and rollback lifecycle",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", {
      ...klaviyoPilotOptions,
      sourceEventIntervalSeconds: 0,
    }),
    "KLAVIYO_LIVE_SOURCE_EVENT_INTERVAL_SECONDS must be a positive whole number of seconds",
    "rejects an invalid Klaviyo source-event certification interval",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", {
      ...klaviyoPilotOptions,
      manualReviewSignoff: false,
    }),
    "set KLAVIYO_LIVE_MANUAL_REVIEW_SIGNOFF=1 so Klaviyo final post-list-suppression membership projections, Multi-Email Profile secondary identities and per-address consent, nullable flow/draft-message definitions, campaign tag IDs, non-email channels, deliverability, and all eight static checklist obligations receive explicit post-delta review without treating checklists as source inventory",
    "requires post-delta Klaviyo membership, identity/consent, nullable-definition, campaign-tag, and checklist review",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", {
      ...klaviyoPilotOptions,
      manualReviewEvidenceRef: "",
    }),
    "set KLAVIYO_LIVE_MANUAL_REVIEW_EVIDENCE_REF to a non-secret ticket/artifact reference proving post-list-suppression send-targetable membership review, Multi-Email Profile secondary-address and per-address-consent reconciliation, nullable flow/draft-message recovery or retirement, campaign-tag ID taxonomy review, and closure of all eight static checklist obligations without treating them as source inventory",
    "requires traceable Klaviyo manual-review evidence",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", {
      ...klaviyoPilotOptions,
      credentialCleanupReview: false,
    }),
    "set KLAVIYO_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 so the dedicated Klaviyo private API key is rotated or revoked after rollback certification",
    "requires Klaviyo credential cleanup review",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("klaviyo", klaviyoPilotOptions),
    "",
    "allows Klaviyo pilot certification only with final-snapshot, review, rollback, and cleanup gates",
  );
  const hubSpotPrepareOptions = {
    requireFullCertification: true,
    sourceEventPhase: "prepare",
    dryRun: true,
    commit: true,
    sourceEvents: true,
    sourceEventIntervalSeconds: 900,
    failOnDiscoveryWarnings: true,
  };
  const hubSpotFinishOptions = {
    requireFullCertification: true,
    sourceEventPhase: "finish",
    sourceEventJobID: "job_hubspot_retained",
    sourceEvents: true,
    sourceEventIntervalSeconds: 900,
    rollback: true,
    deltaImport: true,
    shadowCheck: true,
    rollbackRehearsal: true,
    pilotAcceptance: true,
    manualReviewSignoff: true,
    manualReviewEvidenceRef: "HS-SCOPE-123",
    credentialCleanupReview: true,
    credentialCleanupEvidenceRef: "HS-CLEANUP-123",
    failOnDiscoveryWarnings: true,
  };
  assertEqual(
    hubSpotCredentialConfigError("hubspot", {
      accountID: "12345678",
      extra: { hub_id: "12345678" },
    }),
    "",
    "accepts a portal-bound numeric HubSpot Hub ID",
  );
  assertEqual(
    hubSpotCredentialConfigError("hubspot", {
      accountID: "portal-name",
      extra: { hub_id: "portal-name" },
    }),
    "HUBSPOT_HUB_ID must be a numeric Hub ID of 1 to 64 digits",
    "rejects a nonnumeric HubSpot Hub ID",
  );
  assertEqual(
    hubSpotCredentialConfigError("hubspot", {
      accountID: "12345678",
      extra: { hub_id: "87654321" },
    }),
    "HubSpot account_id and extra.hub_id must select the same Hub ID",
    "rejects split HubSpot portal selectors",
  );
  assertEqual(
    hubSpotCredentialResponseError({
      account_id: "[redacted-hubspot-portal]",
    }),
    "",
    "accepts provider-verified HubSpot selection proof without exposing the Hub ID",
  );
  assertEqual(
    hubSpotCredentialResponseError({ account_id: "12345678" }),
    "HubSpot credentials response did not confirm a provider-verified, redacted portal binding",
    "rejects raw Hub IDs in HubSpot credential responses and artifacts",
  );
  assertEqual(
    hubSpotFullCertificationGuardMessage("hubspot", {
      requireFullCertification: true,
    }),
    "HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION=1 requires HUBSPOT_LIVE_SOURCE_EVENT_PHASE=prepare, finish, or cleanup; credentials/discovery and one-shot source-event runs are not HubSpot certification",
    "requires an explicit retained-overlap phase in the hard HubSpot profile",
  );
  assertEqual(
    hubSpotFullCertificationGuardMessage("hubspot", {
      requireFullCertification: true,
      sourceEventPhase: "prepare",
    }),
    "HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION=1 with phase=prepare requires HUBSPOT_LIVE_DRY_RUN=1, HUBSPOT_LIVE_COMMIT=1, HUBSPOT_LIVE_SOURCE_EVENTS=1, HUBSPOT_LIVE_FAIL_ON_DISCOVERY_WARNINGS=1; credentials/discovery and one-shot source-event runs are not HubSpot certification",
    "rejects an incomplete hard HubSpot prepare profile",
  );
  assertEqual(
    hubSpotFullCertificationGuardMessage("hubspot", hubSpotPrepareOptions),
    "",
    "accepts the complete hard HubSpot prepare profile",
  );
  assertEqual(
    hubSpotFullCertificationGuardMessage("hubspot", hubSpotFinishOptions),
    "",
    "accepts the complete hard HubSpot finish profile",
  );
  assertEqual(
    hubSpotSourceEventPhaseGuardMessage({
      ...hubSpotFinishOptions,
      sourceEventJobID: "",
    }),
    "set HUBSPOT_LIVE_SOURCE_EVENT_JOB_ID to the retained job ID emitted by the prepare phase",
    "requires retained HubSpot lineage for finish",
  );
  assertEqual(
    hubSpotSourceEventPhaseGuardMessage(hubSpotFinishOptions),
    "",
    "accepts a source-bound HubSpot finish profile with scope and cleanup evidence",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("hubspot", { rollback: true }, [
      "HUBSPOT_PRIVATE_APP_TOKEN or HUBSPOT_ACCESS_TOKEN",
    ]),
    "HubSpot live certification cannot run without credentials; set HUBSPOT_PRIVATE_APP_TOKEN or HUBSPOT_ACCESS_TOKEN or unset every HUBSPOT_LIVE_* certification flag",
    "treats a standalone HubSpot rollback flag as live mode instead of skipping",
  );
  assertEqual(
    missingLiveCredentialGuardMessage("hubspot", {}, [
      "HUBSPOT_PRIVATE_APP_TOKEN or HUBSPOT_ACCESS_TOKEN",
    ]),
    "",
    "allows an entirely unconfigured HubSpot provider to remain an ordinary skip",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: false,
    }),
    "set HUBSPOT_LIVE_COMMIT=1, HUBSPOT_LIVE_SOURCE_EVENTS=1, HUBSPOT_LIVE_DELTA_IMPORT=1, HUBSPOT_LIVE_SHADOW_CHECK=1, and HUBSPOT_LIVE_ROLLBACK_REHEARSAL=1 so HubSpot bridge pilot acceptance includes source-event replay, final-delta, shadow-check, and rollback evidence",
    "requires commit, source-event replay, final delta, shadow check, and rollback rehearsal for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
    }),
    "set HUBSPOT_LIVE_SOURCE_EVENTS=1 with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes source-event replay evidence",
    "requires source-event replay for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
    }),
    "set HUBSPOT_LIVE_DELTA_IMPORT=1 with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes final-delta evidence",
    "requires final delta for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
    }),
    "set HUBSPOT_LIVE_SHADOW_CHECK=1 with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes clean shadow-check evidence",
    "requires clean shadow-check evidence for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
    }),
    "set HUBSPOT_LIVE_ROLLBACK_REHEARSAL=1 with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge pilot acceptance includes rollback rehearsal evidence",
    "requires rollback rehearsal evidence for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
      rollbackRehearsal: true,
    }),
    "set HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF=1 so all 14 CRM-bridge scope rows are explicitly reviewed after the final full snapshot",
    "requires post-final-snapshot CRM-bridge scope review for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      manualReviewSignoff: true,
      manualReviewEvidenceRef: "HS-SCOPE-123",
    }),
    "set HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot bridge certification includes private-app-token revocation/rotation evidence",
    "requires credential cleanup evidence for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      manualReviewSignoff: true,
      manualReviewEvidenceRef: "HS-SCOPE-123",
      credentialCleanupReview: true,
    }),
    "set HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF with HUBSPOT_LIVE_PILOT_ACCEPTANCE=1 so HubSpot credential cleanup evidence is traceable",
    "requires a credential cleanup evidence reference for HubSpot bridge pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      manualReviewSignoff: true,
      manualReviewEvidenceRef: "HS-SCOPE-123",
      credentialCleanupReview: true,
      credentialCleanupEvidenceRef: "hubspot:contact:42 access_token=secret",
    }),
    "HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF must be a non-secret reference; remove emails, API URLs, tokens, passwords, or credentials",
    "rejects sensitive HubSpot credential cleanup evidence references for pilot acceptance",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("hubspot", {
      pilotAcceptance: true,
      commit: true,
      sourceEvents: true,
      deltaImport: true,
      shadowCheck: true,
      rollbackRehearsal: true,
      manualReviewSignoff: true,
      manualReviewEvidenceRef: "HS-SCOPE-123",
      credentialCleanupReview: true,
      credentialCleanupEvidenceRef: "CERT-HS-123",
    }),
    "",
    "allows HubSpot bridge pilot acceptance with source-event replay, final delta, shadow check, rollback rehearsal, credential cleanup evidence, and an evidence reference",
  );
  assertEqual(
    liveArtifactGuardMessage("activecampaign", { pilotAcceptance: true }, ""),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with ActiveCampaign live certification flags so the run writes durable evidence artifacts",
    "requires durable evidence artifacts for strict ActiveCampaign pilot certification",
  );
  assertEqual(
    liveArtifactGuardMessage(
      "activecampaign",
      { dryRun: true, failOnDiscoveryWarnings: true },
      "",
    ),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with ActiveCampaign live certification flags so the run writes durable evidence artifacts",
    "requires durable evidence artifacts for strict ActiveCampaign dry-run certification",
  );
  assertEqual(
    liveArtifactGuardMessage(
      "activecampaign",
      { pilotAcceptance: true },
      "/tmp/postwave-live-artifacts",
    ),
    "",
    "allows strict ActiveCampaign pilot certification when artifact output is configured",
  );
  assertEqual(
    liveArtifactGuardMessage("hubspot", { dryRun: true }, ""),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with HubSpot live certification flags so the run writes durable evidence artifacts",
    "requires durable evidence artifacts for HubSpot live certification",
  );
  assertEqual(
    liveArtifactGuardMessage(
      "hubspot",
      { pilotAcceptance: true },
      "/tmp/postwave-live-artifacts",
    ),
    "",
    "allows HubSpot live certification when artifact output is configured",
  );
  assertEqual(
    liveArtifactGuardMessage("beehiiv", { pilotAcceptance: true }, ""),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with Beehiiv live certification flags so the run writes durable evidence artifacts",
    "requires durable artifacts for Beehiiv live certification",
  );
  assertEqual(
    liveArtifactGuardMessage("klaviyo", klaviyoPilotOptions, ""),
    "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with Klaviyo live certification flags so the run writes durable evidence artifacts",
    "requires durable artifacts for Klaviyo live certification",
  );
  assertEqual(
    liveArtifactGuardMessage(
      "beehiiv",
      beehiivPilotOptions,
      "/tmp/postwave-live-artifacts",
    ),
    "",
    "allows Beehiiv live certification when artifact output is configured",
  );
  assertEqual(
    liveArtifactGuardMessage("activecampaign", {}, ""),
    "",
    "allows an ad hoc ActiveCampaign credential/discovery smoke without artifact output",
  );
  assertEqual(
    liveArtifactGuardMessage("mailchimp", { pilotAcceptance: true }, ""),
    "",
    "does not apply ActiveCampaign artifact guard to other sources",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        dryRun: true,
      },
      "",
    ),
    {
      id: "activecampaign_live_artifacts",
      message:
        "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with ActiveCampaign live certification flags so the run writes durable evidence artifacts",
    },
    "preflight blocks ActiveCampaign certification before provider calls when artifact output is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        sourceEvents: true,
      },
      "",
    ),
    {
      id: "activecampaign_live_artifacts",
      message:
        "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with ActiveCampaign live certification flags so the run writes durable evidence artifacts",
    },
    "preflight prioritizes evidence output before other ActiveCampaign live guards",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      { sourceEvents: true },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "activecampaign_live_source_events",
      message:
        "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume a post-pilot rollback/monitor cleanup",
    },
    "preflight requires an explicit retained source-event phase before provider calls",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        credentialCleanupReview: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "activecampaign_live_credential_cleanup_review",
      message:
        "set ACTIVECAMPAIGN_LIVE_COMMIT=1 and ACTIVECAMPAIGN_LIVE_ROLLBACK=1 so credential cleanup review runs after a completed isolated cutover and rollback cleanup",
    },
    "preflight blocks credential cleanup review before provider calls when commit is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        credentialCleanupReview: true,
        commit: true,
        rollback: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "activecampaign_live_credential_cleanup_review",
      message:
        "set ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for the API-token reset/disconnect proof",
    },
    "preflight blocks credential cleanup review before provider calls when the evidence reference is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        pilotAcceptance: true,
        commit: true,
        rollback: true,
        deltaImport: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "activecampaign_live_pilot_acceptance",
      message:
        "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1 with ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1 so ActiveCampaign pilot acceptance includes source-event replay evidence",
    },
    "preflight blocks ActiveCampaign pilot acceptance before provider calls when source-event replay is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "activecampaign",
      {
        pilotAcceptance: true,
        commit: true,
        rollback: true,
        deltaImport: true,
        sourceEvents: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "activecampaign_live_source_events",
      message:
        "set ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume a post-pilot rollback/monitor cleanup",
    },
    "preflight prevents legacy one-shot ActiveCampaign pilot certification",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "hubspot",
      {
        dryRun: true,
      },
      "",
    ),
    {
      id: "hubspot_live_artifacts",
      message:
        "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with HubSpot live certification flags so the run writes durable evidence artifacts",
    },
    "preflight blocks HubSpot certification before provider calls when artifact output is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "hubspot",
      {
        sourceEvents: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "hubspot_live_source_events",
      message:
        "set HUBSPOT_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume rollback/monitor cleanup",
    },
    "preflight prevents a legacy one-shot HubSpot source-event certification run",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "hubspot",
      {
        credentialCleanupReview: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "hubspot_live_credential_cleanup_review",
      message:
        "set HUBSPOT_LIVE_COMMIT=1 and HUBSPOT_LIVE_ROLLBACK=1 so credential cleanup review runs after a completed isolated cutover and rollback cleanup",
    },
    "preflight blocks HubSpot credential cleanup review before provider calls when commit is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "hubspot",
      {
        credentialCleanupReview: true,
        commit: true,
        rollback: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "hubspot_live_credential_cleanup_review",
      message:
        "set HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF to a non-secret ticket/artifact/screenshot reference for the private-app-token revocation/rotation proof",
    },
    "preflight blocks HubSpot credential cleanup review before provider calls when the evidence reference is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "hubspot",
      {
        pilotAcceptance: true,
        commit: true,
        rollback: true,
        sourceEvents: true,
        deltaImport: true,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "hubspot_live_source_events",
      message:
        "set HUBSPOT_LIVE_SOURCE_EVENT_PHASE=prepare for the retained overlap run, finish after at least seven days, or cleanup to resume rollback/monitor cleanup",
    },
    "preflight prevents legacy one-shot HubSpot pilot certification",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard("beehiiv", beehiivPilotOptions, ""),
    {
      id: "beehiiv_live_artifacts",
      message:
        "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with Beehiiv live certification flags so the run writes durable evidence artifacts",
    },
    "preflight blocks Beehiiv certification before provider calls when artifact output is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard("klaviyo", klaviyoPilotOptions, ""),
    {
      id: "klaviyo_live_artifacts",
      message:
        "set POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR or MIGRATION_LIVE_ARTIFACT_DIR with Klaviyo live certification flags so the run writes durable evidence artifacts",
    },
    "preflight blocks Klaviyo certification before provider calls when artifact output is missing",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "klaviyo",
      klaviyoPilotOptions,
      "/tmp/postwave-live-artifacts",
    ),
    null,
    "preflight accepts the complete credentialed Klaviyo certification gate set",
  );
  assertDeepEqual(
    liveCredentialSourcePreflightGuard(
      "beehiiv",
      {
        ...beehiivPilotOptions,
        manualReviewSignoff: false,
      },
      "/tmp/postwave-live-artifacts",
    ),
    {
      id: "beehiiv_live_pilot_acceptance",
      message:
        "set BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF=1 so Beehiiv consent provenance, campaign archive fidelity, dynamic segment rules, and automation rebuilds are explicitly reviewed after final delta",
    },
    "preflight blocks Beehiiv pilot certification before provider calls when review evidence is disabled",
  );
  assertEqual(
    livePilotAcceptanceGuardMessage("mailchimp", {
      pilotAcceptance: true,
      commit: false,
      deltaImport: false,
    }),
    "",
    "does not apply ActiveCampaign pilot acceptance guard to other sources",
  );
  assertEqual(
    liveShadowCheckGuardMessage(
      "activecampaign",
      { shadowCheck: true },
      "",
      "",
    ),
    "set ACTIVECAMPAIGN_LIVE_DRY_RUN=1 or ACTIVECAMPAIGN_LIVE_COMMIT=1 so shadow-check has a verification report to compare",
    "requires a dry-run or commit report for shadow-check certification",
  );
  assertEqual(
    liveShadowCheckGuardMessage(
      "activecampaign",
      { shadowCheck: true },
      "job_dry_run",
      "",
    ),
    "",
    "allows shadow-check certification after dry-run",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: true,
        recommended_action: "run_delta_import_before_cutover",
      },
      { expectNoDeltaImport: true },
    ),
    "shadow-check still requires delta import after final delta replay: run_delta_import_before_cutover",
    "fails final shadow check when delta is still required",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: false,
        recommended_action: "ready_for_cutover_review",
      },
      { expectNoDeltaImport: true },
    ),
    "",
    "allows final shadow check when no delta remains",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: false,
        recommended_action: "manual_review_required",
        blockers: ["condition-set rebuild evidence is missing"],
      },
      {},
      "beehiiv",
    ),
    "Beehiiv shadow-check is not ready for cutover review: manual_review_required",
    "fails standalone Beehiiv shadow certification when manual review remains",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: false,
        recommended_action: "ready_for_cutover_review",
        blockers: ["unexpected blocker"],
      },
      {},
      "beehiiv",
    ),
    "Beehiiv shadow-check returned 1 blocker(s); cutover is not certified",
    "fails standalone Beehiiv shadow certification when blockers remain",
  );
  assertEqual(
    shadowCheckDeltaError(
      {
        needs_delta_import: false,
        recommended_action: "manual_review_required",
        blockers: ["Klaviyo flow rebuild remains pending"],
      },
      {},
      "klaviyo",
    ),
    "Klaviyo shadow-check is not ready for cutover review: manual_review_required",
    "fails Klaviyo shadow certification while flow or snapshot review remains",
  );
  assertEqual(
    combinedCertificationError(new Error("pilot blocked"), undefined).message,
    "pilot blocked",
    "keeps post-commit certification errors after cleanup succeeds",
  );
  assertEqual(
    combinedCertificationError(
      new Error("pilot blocked"),
      new Error("rollback failed"),
    ).message,
    "pilot blocked; rollback cleanup also failed: rollback failed",
    "preserves post-commit and rollback cleanup failures together",
  );
  assertEqual(
    combinedCertificationError(
      new Error("pilot blocked"),
      undefined,
      new Error("cleanup proof missing"),
    ).message,
    "pilot blocked; credential cleanup review also failed: cleanup proof missing",
    "preserves post-commit and credential cleanup review failures together",
  );
  assertEqual(
    combinedCertificationError(
      new Error("pilot blocked"),
      new Error("rollback failed"),
      new Error("cleanup proof missing"),
    ).message,
    "pilot blocked; rollback cleanup also failed: rollback failed; credential cleanup review also failed: cleanup proof missing",
    "preserves post-commit, rollback cleanup, and credential cleanup review failures together",
  );
  assertEqual(
    combinedSourceEventCertificationError(
      new Error("source-event monitor reported last_error"),
      new Error("disable failed"),
    ).message,
    "source-event monitor reported last_error; source-event monitor cleanup also failed: disable failed",
    "preserves source-event certification and monitor cleanup failures together",
  );
  assertEqual(
    sourceEventFinishCleanupAllowed(undefined),
    true,
    "allows monitor cleanup and rollback only after finish gates pass",
  );
  assertEqual(
    sourceEventFinishCleanupAllowed(new Error("pilot blocked")),
    false,
    "retains the monitor and job when a finish gate needs operator retry",
  );
  assertDeepEqual(
    activeCampaignSourceEventCleanupPlan("completed"),
    { verifyPilot: true, runRollback: true, error: "" },
    "cleanup-only retry revalidates pilot evidence without rerunning delta",
  );
  assertDeepEqual(
    activeCampaignSourceEventCleanupPlan("completed", {
      cleanupAuthorized: true,
    }),
    { verifyPilot: false, runRollback: true, error: "" },
    "same-run finish proceeds directly from passing pilot to rollback",
  );
  assertDeepEqual(
    activeCampaignSourceEventCleanupPlan("rolled_back", {
      cleanupAuthorized: true,
    }),
    { verifyPilot: false, runRollback: false, error: "" },
    "cleanup-only retry skips an already completed rollback and retries monitor disable",
  );
  assertEqual(
    activeCampaignSourceEventCleanupPlan("rolled_back").error,
    "rolled-back ActiveCampaign cleanup is missing durable post-pilot authorization",
    "refuses to label arbitrary rolled-back jobs as certified cleanup",
  );
  assertDeepEqual(
    hubSpotSourceEventCleanupPlan("completed"),
    { verifyPilot: true, runRollback: true, error: "" },
    "HubSpot cleanup revalidates strict pilot before creating durable cleanup authorization",
  );
  assertDeepEqual(
    hubSpotSourceEventCleanupPlan("rolled_back", {
      cleanupAuthorized: true,
    }),
    { verifyPilot: false, runRollback: false, error: "" },
    "HubSpot cleanup retries local session deletion without rerunning a completed rollback",
  );
  assertEqual(
    hubSpotSourceEventCleanupPlan("rolled_back").error,
    "rolled-back HubSpot cleanup is missing durable post-pilot authorization",
    "HubSpot cleanup refuses an arbitrary rolled-back job",
  );
  assertEqual(
    activeCampaignCleanupOnlyContractError(),
    "",
    "cleanup-only retry cannot call source sync, delta, shadow, rehearsal, or review writers",
  );
  const cleanupAuthorizationPrefix =
    "activecampaign_cutover_evidence_" +
    activeCampaignPostPilotCleanupEvidenceKey;
  const cleanupAuthorizedJob = {
    id: "job_1",
    source: "activecampaign",
    status: "completed",
    completed_at: "2026-07-08T00:00:00Z",
    cursor: {
      [`${cleanupAuthorizationPrefix}_status`]: "pass",
      [`${cleanupAuthorizationPrefix}_reviewed_at`]: "2026-07-08T00:01:00Z",
      source_event_overlap_snapshot_v1: "{}",
      [activeCampaignPostPilotCleanupStartedAtKey]: "2026-07-08T00:02:00Z",
    },
  };
  assertEqual(
    activeCampaignPostPilotCleanupAuthorizationError(cleanupAuthorizedJob),
    "",
    "accepts durable cleanup authorization bound after the latest final delta",
  );
  assertEqual(
    activeCampaignPostPilotCleanupAuthorizationError({
      ...cleanupAuthorizedJob,
      completed_at: "2026-07-08T00:02:00Z",
    }),
    "durable post-pilot cleanup authorization is stale for the latest final delta",
    "invalidates cleanup authorization when another final delta completes",
  );
  assertEqual(
    durableActiveCampaignCleanupStartError(cleanupAuthorizedJob, "job_1"),
    "",
    "requires authorization and a durable cleanup-start claim before rollback",
  );
  assertEqual(
    durableActiveCampaignCleanupStartError(
      {
        ...cleanupAuthorizedJob,
        cursor: {
          ...cleanupAuthorizedJob.cursor,
          [activeCampaignPostPilotCleanupStartedAtKey]: undefined,
        },
      },
      "job_1",
    ),
    "source-event monitor was disabled without a durable ActiveCampaign cleanup-start claim; do not begin rollback",
    "refuses rollback when monitor disable did not atomically claim cleanup start",
  );
  assertEqual(
    durableActiveCampaignRollbackCompletionError(
      {
        id: "job_1",
        source: "activecampaign",
        status: "rolled_back",
        rollback_until: null,
      },
      "job_1",
    ),
    "",
    "requires durable rolled-back job state before monitor disable",
  );
  assertEqual(
    durableActiveCampaignRollbackCompletionError(
      {
        id: "job_1",
        source: "activecampaign",
        status: "completed",
        rollback_until: "2026-07-20T00:00:00Z",
      },
      "job_1",
    ),
    "rollback progress completed but durable job state is not rolled_back with its rollback deadline cleared; retry cleanup before recording credential-cleanup evidence",
    "does not trust process-local completed rollback progress before durable persistence",
  );
  const hubSpotCleanupAuthorizationPrefix =
    "hubspot_cutover_evidence_" + hubSpotPostPilotCleanupEvidenceKey;
  const hubSpotCleanupAuthorizedJob = {
    id: "job_hs",
    source: "hubspot",
    status: "rolled_back",
    completed_at: "2026-07-08T00:00:00Z",
    rollback_until: null,
    source_session_expires_at: null,
    cursor: {
      [`${hubSpotCleanupAuthorizationPrefix}_status`]: "pass",
      [`${hubSpotCleanupAuthorizationPrefix}_reviewed_at`]:
        "2026-07-08T00:01:00Z",
      source_event_overlap_snapshot_v1: "{}",
      [hubSpotPostPilotCleanupStartedAtKey]: "2026-07-08T00:02:00Z",
      [hubSpotPostPilotSourceSessionClearedAtKey]: "2026-07-08T00:02:01Z",
    },
  };
  assertEqual(
    durableHubSpotCleanupStartError(hubSpotCleanupAuthorizedJob, "job_hs"),
    "",
    "HubSpot cleanup requires durable authorization, cleanup start, and local session deletion",
  );
  assertEqual(
    durableHubSpotRollbackCompletionError(
      hubSpotCleanupAuthorizedJob,
      "job_hs",
    ),
    "",
    "HubSpot external token cleanup waits for local session deletion and durable rollback completion",
  );
  assertEqual(
    durableHubSpotCleanupStartError(
      {
        ...hubSpotCleanupAuthorizedJob,
        cursor: {
          ...hubSpotCleanupAuthorizedJob.cursor,
          [hubSpotPostPilotSourceSessionClearedAtKey]: undefined,
        },
      },
      "job_hs",
    ),
    "HubSpot local source-session deletion was not durably recorded; do not begin rollback or external token cleanup",
    "HubSpot cleanup fails closed when local source-session deletion is missing",
  );
  assertEqual(
    activeCampaignFinishRequiredRollbackHeadroomMs(100, 200, 50),
    450,
    "reserves a final-delta wait plus rate-limit/grace and a separate rollback wait",
  );
  const rollbackHeadroomNow = Date.parse("2026-07-16T00:00:00Z");
  assertEqual(
    activeCampaignFinishRollbackWindowError(
      { rollback_until: "2026-07-16T02:00:00Z" },
      rollbackHeadroomNow,
      60 * 60 * 1000,
    ),
    "",
    "allows final delta while the retained base import has rollback headroom",
  );
  assertEqual(
    activeCampaignFinishRollbackWindowError(
      { rollback_until: "2026-07-16T00:30:00Z" },
      rollbackHeadroomNow,
      60 * 60 * 1000,
    ),
    "retained ActiveCampaign job does not have enough rollback-window headroom for final delta; do not mutate it, and start a new isolated prepare run or follow the recovery runbook",
    "blocks final delta before mutating an almost-unrollbackable retained job",
  );
  assertEqual(
    activeCampaignFinishRollbackWindowError(
      { rollback_until: "2026-07-16T00:00:00.450Z" },
      rollbackHeadroomNow,
      activeCampaignFinishRequiredRollbackHeadroomMs(100, 200, 50),
    ),
    "",
    "accepts the exact two-stage cleanup headroom boundary",
  );
  assertEqual(
    activeCampaignFinishRollbackWindowError(
      { rollback_until: "2026-07-16T00:00:00.449Z" },
      rollbackHeadroomNow,
      activeCampaignFinishRequiredRollbackHeadroomMs(100, 200, 50),
    ),
    "retained ActiveCampaign job does not have enough rollback-window headroom for final delta; do not mutate it, and start a new isolated prepare run or follow the recovery runbook",
    "rejects one millisecond less than final-delta plus rollback cleanup headroom",
  );
  assertDeepEqual(
    sourceEventCleanupRetryArtifact(
      "job_1",
      "rollback",
      new Error("rollback failed for ada@example.com"),
    ),
    {
      job_id: "job_1",
      stage: "rollback",
      cleanup_only_retry: true,
      monitor_verified_disabled: true,
      monitor_disable_retry_required: false,
      rollback_completed: false,
      overlap_and_final_delta_reuse: true,
      error: {
        present: true,
        summary: "rollback failed for [redacted-email]",
        redacted: true,
      },
    },
    "records retryable rollback cleanup without invalidating overlap evidence",
  );
  assertDeepEqual(
    sourceEventFinishRetryArtifact(
      "job_1",
      new Error("pilot blocked for ada@example.com with Api-Token=secret"),
    ),
    {
      job_id: "job_1",
      monitor_retained: true,
      rollback_deferred: true,
      retry_after_resolution: true,
      error: {
        present: true,
        summary: "pilot blocked for [redacted-email] with Api-Token=[redacted]",
        redacted: true,
      },
    },
    "records a sanitized retry artifact without disabling or rolling back",
  );
  assertEqual(
    rollbackRehearsalCertificationError("activecampaign", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "ActiveCampaign rollback rehearsal must be pass for live certification; got warning",
    "requires a fully passing ActiveCampaign rollback rehearsal",
  );
  assertEqual(
    rollbackRehearsalCertificationError("mailchimp", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "",
    "keeps warning-tolerant rollback rehearsal behavior for non-strict sources",
  );
  assertEqual(
    rollbackRehearsalCertificationError("hubspot", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "HubSpot rollback rehearsal must be pass for live certification; got warning",
    "requires a fully passing HubSpot rollback rehearsal",
  );
  assertEqual(
    rollbackRehearsalCertificationError("beehiiv", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "Beehiiv rollback rehearsal must be pass for live certification; got warning",
    "requires a fully passing Beehiiv rollback rehearsal",
  );
  assertEqual(
    rollbackRehearsalCertificationError("klaviyo", {
      status: "warning",
      items: [{ key: "tracked_resources", status: "warning" }],
    }),
    "Klaviyo rollback rehearsal must be pass for live certification; got warning",
    "requires a fully passing Klaviyo rollback rehearsal",
  );
  assertEqual(
    rollbackRehearsalCertificationError("activecampaign", {
      status: "pass",
      items: [{ key: "tracked_resources", status: "pass" }],
    }),
    "",
    "allows passing ActiveCampaign rollback rehearsal",
  );
  const beforeWarnings = results.length;
  assertEqual(
    handleDiscoveryWarnings(
      "activecampaign",
      { warnings: ["forms count unavailable"] },
      { failOnDiscoveryWarnings: true },
    ),
    false,
    "can fail live certification on discovery warnings",
  );
  results.length = beforeWarnings;
  const beforeSourceArchiveWarnings = results.length;
  assertEqual(
    handleSourceArchiveWarnings(
      "activecampaign",
      {
        source_archive_warnings: [
          {
            resource: "activecampaign_form",
            name: "forms",
            warning: "forms source archive unavailable",
          },
        ],
      },
      { failOnSourceArchiveWarnings: true },
    ),
    false,
    "can fail live certification on source archive warnings",
  );
  results.length = beforeSourceArchiveWarnings;
  assertEqual(
    sourceArchiveWarningsPostCommitError(
      "activecampaign",
      {
        source_archive_warnings: [
          {
            resource: "activecampaign_form",
            name: "forms",
            warning: "forms source archive unavailable",
          },
        ],
      },
      { failOnSourceArchiveWarnings: true },
    )?.message,
    "activecampaign commit produced 1 source archive warning(s) under strict certification; rollback cleanup will still be attempted",
    "strict committed source archive warnings become post-commit errors instead of skipping cleanup",
  );
  assertEqual(
    sourceArchiveWarningsPostCommitError(
      "activecampaign",
      { source_archive_warnings: [] },
      { failOnSourceArchiveWarnings: true },
    ),
    null,
    "clean committed source archive reports do not create post-commit errors",
  );
  assertDeepEqual(
    activeCampaignManualReviewEvidenceItems({
      items: [
        {
          key: "activecampaign_templates_review",
          status: "warning",
        },
        {
          key: "activecampaign_deliverability_review",
          status: "warning",
        },
        {
          key: "activecampaign_segments_review",
          status: "blocker",
        },
        {
          key: "activecampaign_audience_schema_review",
          status: "blocker",
        },
        {
          key: "activecampaign_campaign_archive_fidelity_review",
          status: "blocker",
        },
        {
          key: "sms_readiness",
          status: "blocker",
        },
        {
          key: "activecampaign_forms_review",
          status: "pass",
        },
        {
          key: "some_other_warning",
          status: "warning",
        },
        {
          key: "source_archive_warnings",
          status: "blocker",
        },
        {
          key: "source_discovery_warnings",
          status: "pass",
        },
        {
          key: "activecampaign_automation_rebuild_review",
          status: "blocker",
        },
        {
          key: "activecampaign_templates_review",
          status: "blocker",
        },
      ],
    }).map((item) => item.key),
    [
      "activecampaign_templates_review",
      "activecampaign_segments_review",
      "activecampaign_audience_schema_review",
      "activecampaign_campaign_archive_fidelity_review",
      "source_archive_warnings",
    ],
    "manual review sign-off targets reviewable source blockers but never blanket-signs SMS readiness",
  );
  const smsVerification = {
    resource_completeness: [{ resource: "sms", source_total: 2, imported: 2 }],
  };
  assertEqual(
    activeCampaignSMSInventoryDetected(smsVerification),
    true,
    "detects ActiveCampaign SMS inventory from resource completeness",
  );
  assertEqual(
    activeCampaignSMSReadinessGuardMessage(
      "activecampaign",
      smsVerification,
      { pilotAcceptance: true },
      { baseURL: "https://api.postwave.example", apiKey: "scoped-key" },
    ),
    "set ACTIVECAMPAIGN_LIVE_SMS_READINESS=1 when ActiveCampaign SMS inventory is detected so the harness verifies /api/v1/sms/pilot-readiness before recording sms_readiness evidence",
    "requires the dedicated readiness flow instead of manual SMS sign-off",
  );
  assertEqual(
    activeCampaignSMSReadinessGuardMessage(
      "activecampaign",
      smsVerification,
      { pilotAcceptance: true, smsReadiness: true },
      { baseURL: "", apiKey: "scoped-key" },
    ),
    "set POSTWAVE_API_URL with ACTIVECAMPAIGN_LIVE_SMS_READINESS=1 so the harness can query /api/v1/sms/pilot-readiness",
    "requires an API endpoint before checking SMS readiness",
  );
  assertEqual(
    activeCampaignSMSReadinessGuardMessage(
      "activecampaign",
      smsVerification,
      { pilotAcceptance: true, smsReadiness: true },
      { baseURL: "https://api.postwave.example", apiKey: "" },
    ),
    "set POSTWAVE_API_KEY to a tenant API key with read:reports scope; sms_readiness evidence is recorded only after /api/v1/sms/pilot-readiness passes",
    "requires a scoped API key before checking SMS readiness",
  );
  assertEqual(
    activeCampaignSMSReadinessGuardMessage(
      "activecampaign",
      smsVerification,
      { pilotAcceptance: true, smsReadiness: true },
      { baseURL: "https://api.postwave.example", apiKey: "scoped-key" },
    ),
    "",
    "allows the readiness flow only when its scoped API client is configured",
  );
  assertEqual(
    smsPilotReadinessCertificationError({
      can_pilot: false,
      items: [{ key: "approved_sender", status: "blocker" }],
    }),
    "SMS pilot readiness must pass before sms_readiness evidence is recorded; non-passing checks: approved_sender",
    "rejects failed readiness before cutover evidence can be recorded",
  );
  assertEqual(
    smsPilotReadinessCertificationError({
      can_pilot: true,
      items: [
        { key: "approved_sender", status: "pass" },
        { key: "recipient_consent", status: "pass" },
      ],
    }),
    "",
    "accepts a fully passing SMS readiness result",
  );
  const originalFetch = globalThis.fetch;
  try {
    const beehiivReviewCalls = [];
    const beehiivReviewStatuses = new Map([
      ["beehiiv_consent_reconciliation", "warning"],
      ["beehiiv_segment_rules_review", "warning"],
      ["beehiiv_campaign_archive_fidelity", "blocker"],
      ["beehiiv_automation_retirement_review", "blocker"],
      ["beehiiv_website_capture_rebuild_review", "blocker"],
      ["beehiiv_boosts_recommendations_rebuild_review", "blocker"],
      ["beehiiv_ad_network_review", "blocker"],
    ]);
    let beehiivRebuild = {
      rank: 1,
      name: "Welcome series",
      source_id: "automation_1",
      status: "not_started",
      test_evidence: "",
    };
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      beehiivReviewCalls.push({ path, method, body });
      let response;
      if (path.endsWith("/cutover-evidence") && method === "PATCH") {
        beehiivReviewStatuses.set(body.key, body.status);
        response = {
          status: "warning",
          items: [...beehiivReviewStatuses].map(([key, status]) => ({
            key,
            status,
          })),
        };
      } else if (path.endsWith("/automation-rebuilds") && method === "PATCH") {
        beehiivRebuild = { ...beehiivRebuild, ...body };
        response = beehiivRebuild;
      } else if (path.endsWith("/automation-rebuilds")) {
        response = { items: [beehiivRebuild] };
      } else if (path.endsWith("/pilot-acceptance")) {
        response = {
          status: [...beehiivReviewStatuses.values()].every(
            (status) => status === "pass",
          )
            ? "pass"
            : "warning",
          items: [...beehiivReviewStatuses].map(([key, status]) => ({
            key,
            status,
          })),
        };
      } else {
        throw new Error(
          `unexpected Beehiiv self-test request: ${method} ${path}`,
        );
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const beforeBeehiivReviewResults = results.length;
    await runBeehiivManualReviewSignoffCertification(
      "beehiiv",
      "job_beehiiv",
      "BEEHIIV-REVIEW-123",
    );
    results.length = beforeBeehiivReviewResults;
    assertDeepEqual(
      beehiivReviewCalls.map(({ path, method }) => ({ path, method })),
      [
        {
          path: "/v1/migrations/job_beehiiv/pilot-acceptance",
          method: "GET",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/cutover-evidence",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/automation-rebuilds",
          method: "GET",
        },
        {
          path: "/v1/migrations/job_beehiiv/automation-rebuilds",
          method: "PATCH",
        },
        {
          path: "/v1/migrations/job_beehiiv/automation-rebuilds",
          method: "GET",
        },
        {
          path: "/v1/migrations/job_beehiiv/pilot-acceptance",
          method: "GET",
        },
      ],
      "persists and re-reads Beehiiv consent, campaign, segment, parity-gap, and automation evidence before shadow certification",
    );
    assertDeepEqual(
      beehiivReviewCalls[9].body,
      {
        rank: 1,
        name: "Welcome series",
        source_id: "automation_1",
        status: "test_passed",
        owner: "live-migration-operator",
        notes:
          "Beehiiv API metadata was rebuilt or deliberately retired; no source workflow was activated automatically.",
        test_evidence: "evidence_ref=BEEHIIV-REVIEW-123",
      },
      "records explicit test evidence for each Beehiiv automation rebuild",
    );

    const customerIOReviewCalls = [];
    const customerIOReviewState = new Map(
      customerIOManualReviewEvidenceKeys.map((key) => [
        key,
        { key, status: "warning", evidence: [] },
      ]),
    );
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      customerIOReviewCalls.push({ path, method, body });
      if (path.endsWith("/cutover-evidence") && method === "PATCH") {
        customerIOReviewState.set(body.key, body);
      } else if (!path.endsWith("/pilot-acceptance") || method !== "GET") {
        throw new Error(
          `unexpected Customer.io self-test request: ${method} ${path}`,
        );
      }
      const items = [...customerIOReviewState.values()];
      const response = {
        status: items.every((item) => item.status === "pass")
          ? "pass"
          : "warning",
        items,
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const beforeCustomerIOReviewResults = results.length;
    await runCustomerIOManualReviewSignoffCertification(
      "customerio",
      "job_customerio",
      "CIO-REVIEW-123",
    );
    results.length = beforeCustomerIOReviewResults;
    assertDeepEqual(
      customerIOReviewCalls.map(({ method }) => method),
      ["GET", "PATCH", "PATCH", "PATCH", "PATCH", "PATCH", "PATCH", "GET"],
      "persists exactly six Customer.io cutover reviews between pilot reads",
    );
    assertDeepEqual(
      customerIOReviewCalls
        .filter(({ method }) => method === "PATCH")
        .map(({ body }) => body.key),
      customerIOManualReviewEvidenceKeys,
      "records every Customer.io cutover review key once",
    );
    for (const { body } of customerIOReviewCalls.filter(
      ({ method }) => method === "PATCH",
    )) {
      assertEqual(
        body.evidence.includes("evidence_ref=CIO-REVIEW-123"),
        true,
        `records traceable Customer.io evidence for ${body.key}`,
      );
      assertEqual(
        body.evidence.includes(customerIOReviewMarkers[body.key]),
        true,
        `records the source-specific Customer.io marker for ${body.key}`,
      );
    }
    assertDeepEqual(
      customerIOReviewCalls.at(-1),
      {
        path: "/v1/migrations/job_customerio/pilot-acceptance",
        method: "GET",
        body: undefined,
      },
      "re-reads persisted Customer.io pilot evidence before certification",
    );

    const failedReadinessCalls = [];
    globalThis.fetch = async (url, init) => {
      failedReadinessCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          can_pilot: false,
          items: [{ key: "approved_sender", status: "blocker" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await assertRejects(
      () =>
        runActiveCampaignSMSReadinessCertification("activecampaign", "job_sms"),
      "SMS pilot readiness must pass before sms_readiness evidence is recorded",
      "does not record SMS cutover evidence after a failed readiness result",
    );
    assertEqual(
      failedReadinessCalls.length,
      1,
      "failed SMS readiness stops before the cutover-evidence PATCH",
    );
    assertEqual(
      failedReadinessCalls[0].url.endsWith("/api/v1/sms/pilot-readiness"),
      true,
      "failed SMS readiness calls only the readiness endpoint",
    );

    const passingReadinessCalls = [];
    globalThis.fetch = async (url, init) => {
      passingReadinessCalls.push({ url: String(url), init });
      if (passingReadinessCalls.length === 1) {
        return new Response(
          JSON.stringify({
            can_pilot: true,
            items: [
              { key: "recipient_consent", status: "pass" },
              { key: "approved_sender", status: "pass" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          items: [{ key: "sms_readiness", status: "pass" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await runActiveCampaignSMSReadinessCertification(
      "activecampaign",
      "job_sms",
    );
    assertEqual(
      passingReadinessCalls.length,
      2,
      "passing SMS readiness is followed by exactly one evidence request",
    );
    assertEqual(
      passingReadinessCalls[0].url.endsWith("/api/v1/sms/pilot-readiness"),
      true,
      "SMS certification checks readiness before recording evidence",
    );
    assertEqual(
      passingReadinessCalls[1].url.endsWith(
        "/v1/migrations/job_sms/cutover-evidence",
      ),
      true,
      "SMS certification records evidence only after readiness passes",
    );
    assertDeepEqual(
      JSON.parse(String(passingReadinessCalls[1].init.body)),
      {
        key: "sms_readiness",
        status: "pass",
        detail:
          "Moosewave SMS pilot readiness returned can_pilot=true after final delta import.",
        evidence: [
          "ACTIVECAMPAIGN_LIVE_SMS_READINESS=1",
          "passing_readiness_checks=approved_sender,recipient_consent",
        ],
      },
      "SMS evidence request contains only the passing readiness marker",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEqual(
    pilotAcceptanceCertificationError(
      "activecampaign",
      {
        status: "warning",
        warnings: 1,
        items: [{ key: "activecampaign_templates_review", status: "warning" }],
      },
      { requirePass: true },
    ),
    "ActiveCampaign pilot acceptance must be pass for live certification; got warning with 1 warning(s)",
    "requires a fully passing ActiveCampaign pilot acceptance report",
  );
  assertEqual(
    pilotAcceptanceCertificationError(
      "mailchimp",
      {
        status: "warning",
        warnings: 1,
        items: [{ key: "legacy_review", status: "warning" }],
      },
      {},
    ),
    "",
    "keeps warning-tolerant pilot acceptance behavior for non-strict sources",
  );
  assertEqual(
    pilotAcceptanceCertificationError(
      "beehiiv",
      {
        status: "warning",
        warnings: 1,
        items: [{ key: "beehiiv_segment_rules_review", status: "warning" }],
      },
      { requirePass: true },
    ),
    "Beehiiv pilot acceptance must be pass for live certification; got warning with 1 warning(s)",
    "requires a fully passing Beehiiv pilot acceptance report",
  );
  assertEqual(
    pilotAcceptanceCertificationError(
      "klaviyo",
      {
        status: "warning",
        warnings: 1,
        items: [{ key: "klaviyo_flow_rebuild_review", status: "warning" }],
      },
      { requirePass: true },
    ),
    "Klaviyo pilot acceptance must be pass for live certification; got warning with 1 warning(s)",
    "requires a fully passing Klaviyo pilot acceptance report",
  );
  assertEqual(
    beehiivAutomationRebuildsCertificationError({}),
    "automation-rebuilds did not return review items",
    "fails closed when Beehiiv automation rebuild inventory is malformed",
  );
  assertEqual(
    beehiivAutomationRebuildsCertificationError({
      items: [
        {
          rank: 1,
          status: "test_passed",
          test_evidence: "evidence_ref=BEEHIIV-REVIEW-123",
        },
        { rank: 2, status: "not_started" },
      ],
    }),
    "Beehiiv automation rebuild review remains incomplete for rank(s): 2",
    "blocks Beehiiv shadow certification while an automation rebuild is pending",
  );
  assertEqual(
    beehiivAutomationRebuildsCertificationError({
      items: [{ rank: 1, status: "test_passed", test_evidence: "" }],
    }),
    "Beehiiv automation rebuild review remains incomplete for rank(s): 1",
    "requires test evidence for a passing Beehiiv automation rebuild",
  );
  assertEqual(
    beehiivAutomationRebuildsCertificationError({
      items: [
        {
          rank: 1,
          status: "test_passed",
          test_evidence: "evidence_ref=BEEHIIV-REVIEW-123",
        },
        {
          rank: 2,
          status: "approved_not_needed",
          test_evidence: "evidence_ref=BEEHIIV-REVIEW-123",
        },
      ],
    }),
    "",
    "accepts only fully evidenced Beehiiv automation rebuild outcomes",
  );
  assertEqual(
    klaviyoAutomationRebuildsCertificationError({
      items: [
        {
          rank: 1,
          status: "test_passed",
          test_evidence: "evidence_ref=KLAVIYO-REVIEW-123",
        },
        { rank: 2, status: "not_started" },
      ],
    }),
    "Klaviyo flow rebuild review remains incomplete for rank(s): 2",
    "blocks Klaviyo certification while any flow rebuild is pending",
  );
  assertEqual(
    klaviyoAutomationRebuildsCertificationError({
      items: [
        {
          rank: 1,
          status: "approved_not_needed",
          test_evidence: "evidence_ref=KLAVIYO-REVIEW-123",
        },
      ],
    }),
    "",
    "accepts a fully evidenced Klaviyo flow retirement",
  );
  assertEqual(
    resourceWarningSummary({
      resource: "activecampaign_form",
      warning: "forms source archive unavailable",
    }),
    "activecampaign_form: forms source archive unavailable",
    "summarizes resource warnings without names",
  );
  assertDeepEqual(
    credentialArtifact(
      { job_id: "job_1", account_id: "https://account.api-us1.com/api/3" },
      "activecampaign",
    ),
    { source: "activecampaign", job_id: "job_1", account_id_present: true },
    "credential artifact records job identity without copying account identifiers",
  );
  assertEqual(
    safeArtifactSegment("ActiveCampaign live/run:1"),
    "ActiveCampaign_live_run_1",
    "sanitizes artifact filename segments",
  );
  const sanitizedSourceEventExample = sourceEventArtifact({
    monitor: {
      job_id: "job_1",
      tenant_id: "tenant_1",
      source: "activecampaign",
      enabled: true,
      interval_seconds: 900,
      enabled_since: "2026-07-01T00:00:00Z",
      first_successful_sync_at: "2026-07-01T00:01:00Z",
      successful_sync_count: 700,
      max_success_gap_seconds: 900,
      cursor: "raw-cursor",
      last_error: "contact ada@example.com failed",
      events_seen: 4,
      events_applied: 1,
    },
    events: [
      {
        source_event_id: "activecampaign:contact:42:2026-01-01",
        resource_type: "subscriber",
        action: "upsert",
        applied: true,
        payload: { email: "ada@example.com" },
      },
      {
        source_event_id: "activecampaign:contact:44:2026-01-01",
        resource_type: "activecampaign_non_email_contact",
        action: "manual_review",
        applied: false,
        review_status: "pending",
        payload: { phone: "+15551234567" },
      },
      {
        source_event_id: "activecampaign:contact:45:2026-01-01",
        resource_type: "activecampaign_non_email_contact",
        action: "manual_review",
        applied: false,
        review_status: "reviewed",
        reviewed_at: "2026-07-08T00:00:00Z",
        review_detail: "ada@example.com reconciled",
        review_evidence: ["secret-review-ticket"],
        payload: { phone: "+15557654321" },
      },
      {
        source_event_id: "activecampaign:contact:43:2026-01-01",
        resource_type: "subscriber",
        action: "upsert",
        applied: false,
        error: "ada@example.com",
        payload: { email: "ada@example.com" },
      },
    ],
  });
  assertDeepEqual(
    sanitizedSourceEventExample,
    {
      monitor: {
        job_id: "job_1",
        source: "activecampaign",
        enabled: true,
        interval_seconds: 900,
        enabled_since: "2026-07-01T00:00:00Z",
        first_successful_sync_at: "2026-07-01T00:01:00Z",
        successful_sync_count: 700,
        max_success_gap_seconds: 900,
        last_event_at: null,
        last_synced_at: null,
        next_sync_at: null,
        last_error_present: true,
        events_seen: 4,
        events_applied: 1,
      },
      events_count: 4,
      unapplied_events_count: 3,
      manual_reviews_reviewed: 1,
      manual_reviews_pending: 1,
      events_by_resource_action: {
        "subscriber:upsert": 2,
        "activecampaign_non_email_contact:manual_review": 2,
      },
    },
    "source-event artifacts summarize events without raw payloads or contact identifiers",
  );
  assertEqual(
    sourceEventMonitorError({
      monitor: {
        last_error:
          "contact ada@example.com failed with Api-Token: secret at https://tenant.api-us1.com/api/3",
      },
    }),
    "source-event monitor reported last_error: contact [redacted-email] failed with Api-Token=[redacted] at [redacted-activecampaign-api-url]",
    "source-event certification errors redact provider details",
  );
  assertEqual(
    sourceEventMonitorError({ monitor: { last_error: "" } }),
    "",
    "source-event certification allows monitors without sync errors",
  );
  assertEqual(
    sourceEventMonitorDisableVerificationError(
      { monitor: { job_id: "job_1", enabled: false } },
      "job_1",
    ),
    "",
    "accepts a GET-confirmed disabled monitor after a lost DELETE response",
  );
  assertEqual(
    sourceEventMonitorDisableVerificationError(
      { monitor: { job_id: "job_1", enabled: true } },
      "job_1",
    ),
    "source-event monitor disable was not durably observable; cleanup remains incomplete",
    "fails closed when monitor disable did not persist",
  );
  const continuousSourceEventResponse = {
    monitor: {
      enabled: true,
      interval_seconds: 900,
      enabled_since: "2026-07-01T00:00:00Z",
      first_successful_sync_at: "2026-07-01T00:01:00Z",
      last_synced_at: "2026-07-08T00:01:00Z",
      successful_sync_count: 700,
      max_success_gap_seconds: 900,
    },
    events: [],
  };
  assertEqual(
    sourceEventContinuousOverlapError(
      "activecampaign",
      continuousSourceEventResponse,
      Date.parse("2026-07-08T00:01:30Z"),
    ),
    "",
    "accepts durable seven-day ActiveCampaign source-event coverage",
  );
  assertEqual(
    sourceEventContinuousOverlapError(
      "activecampaign",
      {
        monitor: {
          ...continuousSourceEventResponse.monitor,
          last_synced_at: "2026-07-01T00:02:00Z",
          successful_sync_count: 2,
        },
      },
      Date.parse("2026-07-01T00:02:30Z"),
    ),
    "ActiveCampaign source-event certification requires at least seven days of continuous successful replay; one immediate sync is not certification evidence",
    "rejects one immediate sync as ActiveCampaign certification evidence",
  );
  assertEqual(
    sourceEventContinuousOverlapError(
      "hubspot",
      continuousSourceEventResponse,
      Date.parse("2026-07-08T00:01:30Z"),
    ),
    "",
    "accepts durable seven-day HubSpot changed-contact coverage",
  );
  assertEqual(
    sourceEventContinuousOverlapError(
      "hubspot",
      {
        monitor: {
          ...continuousSourceEventResponse.monitor,
          last_synced_at: "2026-07-01T00:02:00Z",
          successful_sync_count: 2,
        },
      },
      Date.parse("2026-07-01T00:02:30Z"),
    ),
    "HubSpot source-event certification requires at least seven days of continuous successful replay; one immediate sync is not certification evidence",
    "rejects one immediate sync as HubSpot certification evidence",
  );
  assertEqual(
    sourceEventResolutionError({
      events: [
        {
          action: "manual_review",
          applied: false,
          review_status: "pending",
        },
      ],
    }),
    "ActiveCampaign source-event finish found 1 pending manual-review row(s); record non-secret reconciliation evidence with PATCH /v1/migrations/{job}/source-events/{result UUID}/review, then retry finish",
    "retains finish for unresolved row-level manual review",
  );
  assertEqual(
    sourceEventResolutionError({
      events: [
        {
          action: "manual_review",
          applied: false,
          review_status: "reviewed",
          reviewed_at: "2026-07-08T00:00:00Z",
          review_detail: "reconciled without identifiers",
          review_evidence: ["TICKET-123"],
        },
      ],
    }),
    "",
    "allows finish after each manual-review row has durable non-secret evidence",
  );
  assertDeepEqual(
    sourceEventCleanupFailureArtifact(
      "job_1",
      new Error(
        "disable failed for ada@example.com with Api-Token: secret at https://tenant.api-us1.com/api/3",
      ),
    ),
    {
      job_id: "job_1",
      error: {
        present: true,
        summary:
          "disable failed for [redacted-email] with Api-Token=[redacted] at [redacted-activecampaign-api-url]",
        redacted: true,
      },
    },
    "source-event cleanup failure artifacts redact provider details",
  );
  const sanitizedDiscoveryExample = discoveryArtifact({
    subscribers_count: 2,
    warnings: [
      "forms count unavailable for ada@example.com with Api-Token: secret at https://tenant.api-us1.com/api/3/forms",
    ],
  });
  assertDeepEqual(
    sanitizedDiscoveryExample,
    {
      subscribers_count: 2,
      warnings: [
        "forms count unavailable for [redacted-email] with Api-Token=[redacted] at [redacted-activecampaign-api-url]",
      ],
    },
    "discovery artifacts redact provider warning text",
  );
  const sanitizedVerificationExample = verificationReportArtifact({
    subscribers_imported: 2,
    discovery_warnings: ["custom objects count failed for ada@example.com"],
    source_archive_warnings: [
      {
        resource: "activecampaign_form",
        source_id: "source_archive_warning:forms",
        name: "forms",
        warning:
          "forms source archive unavailable: Api-Key: secret https://tenant.activehosted.com/api/3/forms",
      },
    ],
    subscriber_merge_conflicts: [
      {
        email: "ada@example.com",
        source_ids: ["contact-1", "contact-2"],
        tags: ["vip"],
      },
    ],
    resource_completeness: [],
  });
  assertDeepEqual(
    sanitizedVerificationExample,
    {
      subscribers_imported: 2,
      discovery_warnings: ["custom objects count failed for [redacted-email]"],
      source_archive_warnings: [
        {
          resource: "activecampaign_form",
          source_id: "source_archive_warning:forms",
          name: "forms",
          warning:
            "forms source archive unavailable: Api-Key=[redacted] [redacted-activecampaign-api-url]",
        },
      ],
      resource_completeness: [],
      subscriber_merge_conflicts_count: 1,
    },
    "verification report artifacts remove email-bearing merge-conflict rows and redact warning text",
  );
  const sanitizedCursorExample = cursorArtifact({
    run_mode: "delta_import",
    delta_import_previous_job: '{"email":"ada@example.com"}',
    delta_import_last_error: "delta import failed for ada@example.com",
    delta_import_started_at: "2026-07-04T00:09:00Z",
    source_event_synced_before_delta_at: "2026-07-04T00:08:00Z",
    rollback_rehearsal_status: "pass",
    rollback_rehearsal_generated_at: "2026-07-04T00:00:00Z",
    rollback_rehearsal_total_resources: "42",
    rate_limit_retry_at: "2026-07-04T00:10:00Z",
    rate_limit_retry_after: "2m0s",
    activecampaign_deliverability_status: "pass",
    activecampaign_deliverability_detail:
      "tracking link checked for ada@example.com",
    activecampaign_deliverability_evidence:
      '["operator note mentions ada@example.com"]',
    activecampaign_cutover_evidence_activecampaign_templates_review_status:
      "pass",
    activecampaign_cutover_evidence_activecampaign_templates_review_detail:
      "template note for ada@example.com",
    activecampaign_cutover_evidence_activecampaign_templates_review_evidence:
      '["template evidence"]',
  });
  assertEqual(
    JSON.stringify(sanitizedCursorExample).includes("ada@example.com"),
    false,
    "cursor artifacts omit raw cursor values that may contain contact data",
  );
  assertDeepEqual(
    sanitizedCursorExample.cutover_evidence_keys,
    ["activecampaign_templates_review"],
    "cursor artifacts preserve cutover evidence keys without evidence values",
  );
  assertEqual(
    sanitizedCursorExample.delta_import_snapshot_present,
    true,
    "cursor artifacts retain delta snapshot presence",
  );
  assertEqual(
    sanitizedCursorExample.delta_import_started_at_present,
    true,
    "cursor artifacts retain final-delta start evidence presence",
  );
  assertEqual(
    sanitizedCursorExample.source_event_synced_before_delta_at_present,
    true,
    "cursor artifacts retain pre-delta source-event sync evidence presence",
  );
  assertEqual(
    sanitizedCursorExample.rate_limit_retry_at,
    "2026-07-04T00:10:00Z",
    "cursor artifacts retain provider retry-at timestamps for paused live certification jobs",
  );
  assertDeepEqual(
    rateLimitPauseArtifact({
      status: "importing",
      cursor: {
        rate_limit_retry_at: "2026-07-04T00:10:00Z",
        rate_limit_retry_after: "2m0s",
      },
      error: "source rate limited for ada@example.com",
    }),
    {
      retry_at: "2026-07-04T00:10:00Z",
      retry_after: "2m0s",
      status: "importing",
      error: {
        present: true,
        summary: "source rate limited for [redacted-email]",
        redacted: true,
      },
    },
    "rate-limit pause artifacts preserve scheduling details without raw error PII",
  );
  assertEqual(
    jobTimeoutMessage("job_1", {
      status: "importing",
      cursor: {
        rate_limit_retry_at: "2026-07-04T00:10:00Z",
        rate_limit_retry_after: "2m0s",
      },
    }),
    "timed out waiting for job job_1; last status importing; source rate limit retry_at=2026-07-04T00:10:00Z retry_after=2m0s",
    "timeout messages explain provider rate-limit pauses",
  );
  const sanitizedErrorExample = errorArtifact(
    "activecampaign contact ada@example.com failed: Api-Token: secret-token https://tenant.api-us1.com/api/3",
  );
  assertDeepEqual(
    sanitizedErrorExample,
    {
      present: true,
      summary:
        "activecampaign contact [redacted-email] failed: Api-Token=[redacted] [redacted-activecampaign-api-url]",
      redacted: true,
    },
    "error artifacts redact emails, token-like details, and ActiveCampaign account URLs",
  );
  assertEqual(
    redactSensitiveText("tenant.activehosted.com/api/3/forms"),
    "[redacted-activecampaign-api-url]",
    "redacts bare ActiveCampaign activehosted hosts",
  );
  assertEqual(
    redactSensitiveText(
      "request https://tenant.eu.provider.example/api/3 failed with status 503",
      "tenant.eu.provider.example",
    ),
    "request https://[redacted-activecampaign-api-url]/api/3 failed with status 503",
    "redacts operator-configured ActiveCampaign hosts without removing diagnostics",
  );
  assertEqual(
    redactSensitiveText(
      'source-event replay failed for activecampaign:contact:42:2026-05-12T11:00:00Z:abcdef; cursor "last_at=2026-05-12T11%3A00%3A00Z&last_id=42&offset=1"; activecampaign: contact 42 source-event order moved backwards',
    ),
    'source-event replay failed for [redacted-activecampaign-source-event-id]; cursor "last_at=2026-05-12T11%3A00%3A00Z&last_id=[redacted]&offset=1"; activecampaign: contact [redacted-activecampaign-contact] source-event order moved backwards',
    "redacts ActiveCampaign source-event identifiers and cursor contact IDs",
  );
  assertEqual(
    redactSensitiveText(
      "source-event replay failed for hubspot:contact:42:2026-05-12T11:00:00Z:abcdef with access_token=secret",
    ),
    "source-event replay failed for [redacted-hubspot-source-event-id] with access_token=[redacted]",
    "redacts HubSpot source-event identifiers and token-like details",
  );
  assertDeepEqual(
    errorArtifact(
      "activecampaign request failed at tenant.api-us1.com/api/3 for ada@example.com Api-Token: secret",
    ),
    {
      present: true,
      summary:
        "activecampaign request failed at [redacted-activecampaign-api-url] for [redacted-email] Api-Token=[redacted]",
      redacted: true,
    },
    "error artifacts redact bare ActiveCampaign API hosts",
  );
  const beforeResultRedaction = results.length;
  fail(
    "activecampaign_credentials",
    "credential failed for ada@example.com Api-Token: secret https://tenant.activehosted.com/api/3",
  );
  assertDeepEqual(
    results[results.length - 1],
    {
      id: "activecampaign_credentials",
      message:
        "credential failed for [redacted-email] Api-Token=[redacted] [redacted-activecampaign-api-url]",
      status: "fail",
      redacted: true,
    },
    "result ledger redacts provider/customer details before console and summary artifacts",
  );
  results.length = beforeResultRedaction;
  const sanitizedPilotExample = pilotAcceptanceArtifact({
    status: "warning",
    warnings: 1,
    items: [
      {
        key: "activecampaign_templates_review",
        status: "warning",
        detail: "template reviewed by ada@example.com",
        evidence: ["Access-Token: secret-token", "safe note"],
      },
    ],
  });
  assertDeepEqual(
    sanitizedPilotExample.items[0],
    {
      key: "activecampaign_templates_review",
      status: "warning",
      detail: "template reviewed by [redacted-email]",
      evidence: ["Access-Token=[redacted]", "safe note"],
    },
    "pilot acceptance artifacts redact item detail and evidence text",
  );
  const sanitizedRollbackRehearsalExample = rollbackRehearsalArtifact({
    status: "warning",
    items: [
      {
        key: "tracked_resources",
        status: "warning",
        detail: "operator ada@example.com saw Api-Key: secret",
      },
    ],
  });
  assertEqual(
    sanitizedRollbackRehearsalExample.items[0].detail,
    "operator [redacted-email] saw Api-Key=[redacted]",
    "rollback rehearsal artifacts redact item details",
  );
  const sanitizedShadowExample = shadowCheckArtifact({
    recommended_action: "manual_review_required",
    blockers: ["template review assigned to ada@example.com"],
    deltas: [
      {
        resource: "templates",
        notes: ["Access Token: secret-token"],
      },
    ],
  });
  assertDeepEqual(
    sanitizedShadowExample,
    {
      recommended_action: "manual_review_required",
      blockers: ["template review assigned to [redacted-email]"],
      deltas: [
        {
          resource: "templates",
          notes: ["Access Token=[redacted]"],
        },
      ],
    },
    "shadow-check artifacts redact blockers and notes",
  );
  const sanitizedRollbackExample = rollbackArtifact({
    state: "failed",
    error: "rollback failed for ada@example.com with api_key=secret",
  });
  assertDeepEqual(
    sanitizedRollbackExample.error,
    {
      present: true,
      summary: "rollback failed for [redacted-email] with api_key=[redacted]",
      redacted: true,
    },
    "rollback artifacts redact failure error text",
  );
  assertDeepEqual(
    rollbackCleanupFailureArtifact(
      "job_1",
      new Error("rollback failed for ada@example.com with Api-Token: secret"),
      { state: "running", error: "last poll saw ada@example.com" },
    ),
    {
      job_id: "job_1",
      rollback: {
        state: "running",
        error: {
          present: true,
          summary: "last poll saw [redacted-email]",
          redacted: true,
        },
      },
      error: {
        present: true,
        summary:
          "rollback failed for [redacted-email] with Api-Token=[redacted]",
        redacted: true,
      },
    },
    "rollback cleanup failure artifacts redact start/poll errors and last status",
  );
  await writeArtifact("self-test", "helpers", {
    status: "pass",
    credential_artifact: credentialArtifact(
      { job_id: "job_1", account_id: "https://account.api-us1.com/api/3" },
      "activecampaign",
    ),
    source_event_artifact: sanitizedSourceEventExample,
    discovery_artifact: sanitizedDiscoveryExample,
    verification_report_artifact: sanitizedVerificationExample,
    cursor_artifact: sanitizedCursorExample,
    error_artifact: sanitizedErrorExample,
    pilot_acceptance_artifact: sanitizedPilotExample,
    rollback_rehearsal_artifact: sanitizedRollbackRehearsalExample,
    shadow_check_artifact: sanitizedShadowExample,
    rollback_artifact: sanitizedRollbackExample,
  });
  console.log("PASS self_test: live migration validation helpers");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function assertThrows(fn, expectedMessage, message) {
  try {
    fn();
  } catch (err) {
    if (String(err?.message || err).includes(expectedMessage)) return;
    throw new Error(
      `${message}: expected error containing ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(String(err?.message || err))}`,
    );
  }
  throw new Error(`${message}: expected function to throw`);
}

async function assertRejects(fn, expectedMessage, message) {
  try {
    await fn();
  } catch (err) {
    if (String(err?.message || err).includes(expectedMessage)) return;
    throw new Error(
      `${message}: expected error containing ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(String(err?.message || err))}`,
    );
  }
  throw new Error(`${message}: expected function to reject`);
}
