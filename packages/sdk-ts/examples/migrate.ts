/**
 * Kick off a Mailchimp → Moosewave migration.
 *
 * Run:  POSTWAVE_API_KEY=... POSTWAVE_TENANT=acme tsx examples/migrate.ts
 */
import { PostwaveClient } from "@postwave/sdk";

const pw = new PostwaveClient({
  apiKey: process.env.POSTWAVE_API_KEY!,
  tenantId: process.env.POSTWAVE_TENANT,
});

async function main(): Promise<void> {
  // 1. Get the OAuth URL — open it in a browser.
  const { authorize_url, state } = await pw.migrations.start("mailchimp");
  console.log("Visit:", authorize_url);
  console.log("Expected state:", state);

  // After the user finishes OAuth, the gateway calls our callback and we
  // get back a job_id. For this example we'll assume it's been minted.
  const jobId = process.env.POSTWAVE_JOB_ID;
  if (!jobId) {
    console.log("Re-run with POSTWAVE_JOB_ID=<id-from-callback>");
    return;
  }

  // 2. List audiences, then provide an explicit operator-selected scope.
  const discovery = await pw.migrations.discover("mailchimp", jobId);
  console.log("Available audiences:", discovery.audiences ?? []);
  const selectedAudienceIds = (process.env.MAILCHIMP_AUDIENCE_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (selectedAudienceIds.length === 0) {
    console.log(
      "Re-run with MAILCHIMP_AUDIENCE_IDS=<comma-separated IDs selected from discovery>",
    );
    return;
  }
  const scopedDiscovery = await pw.migrations.discover(
    "mailchimp",
    jobId,
    selectedAudienceIds,
  );
  console.log(
    `Scoped inventory: ${scopedDiscovery.subscribers_count} subscribers, ${scopedDiscovery.segments_count} segments.`,
  );

  // 3. Dry run, then poll until verification ready.
  await pw.migrations.dryRun("mailchimp", jobId, selectedAudienceIds);
  for (;;) {
    const job = await pw.migrations.get(jobId);
    console.log(job.status, job.progress);
    if (job.status === "awaiting_confirmation" || job.status === "failed")
      break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // 4. Inspect the verification report.
  const report = await pw.migrations.verification(jobId);
  console.log(
    `${report.subscribers_imported} would import, data loss ${report.data_loss_estimate_pct}%`,
  );

  // 5. Commit the real run.
  await pw.migrations.commit("mailchimp", jobId, selectedAudienceIds);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
