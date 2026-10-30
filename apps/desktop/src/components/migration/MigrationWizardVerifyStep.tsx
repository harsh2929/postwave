import { type ReactElement, useId } from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import type { MigrationJob, MigrationPreview } from "../../lib/api-client";
import { getDashboardUrl } from "../../lib/dashboard-url";
import { setSection } from "../../lib/store";
import { tauriApi } from "../../lib/tauri";
import { toast } from "../Toast";
import {
  AuthFailedBanner,
  CancelledBanner,
  SourceUnavailableBanner,
} from "./MigrationErrorBanners";
import { TimeEvidence } from "./MigrationHistorySurface";
import { MigrationVerificationEvidence } from "./MigrationVerificationEvidence";
import { isMigrationAuthFailureMessage } from "./failure-classification";
import {
  formatMigrationCount,
  parseMigrationTime,
} from "./migrations-surface-helpers";
import { migrationCredentialLabel } from "../../lib/migration-sources";

interface MigrationWizardVerifyStepProps {
  job: MigrationJob | null;
  preview: MigrationPreview | null;
  err: string | null;
  onClose: () => void;
  onRollback: () => void;
  onReenterKey: () => void;
}

export function MigrationWizardVerifyStep({
  job,
  preview,
  err,
  onClose,
  onRollback,
  onReenterKey,
}: MigrationWizardVerifyStepProps): ReactElement {
  const errMsg = job?.error ?? err ?? "";
  if (job?.status === "failed") {
    if (/cancel/i.test(errMsg)) {
      return (
        <CancelledBanner
          importedSubscribers={
            preview?.subscribers_imported ?? job.progress?.subscribers_done ?? 0
          }
          onView={() => openSubscribers(onClose)}
          onRollback={onRollback}
        />
      );
    }
    if (isMigrationAuthFailureMessage(errMsg)) {
      return (
        <AuthFailedBanner
          onReenter={onReenterKey}
          credentialLabel={migrationCredentialLabel(job.source)}
        />
      );
    }
    if (isSourceUnavailable(errMsg)) {
      return (
        <>
          <SourceUnavailableBanner sourceLabel={String(job.source)} />
          <p className="muted migration-wizard-support-copy">
            Provider detail is withheld in the desktop client. Use job{" "}
            <code>{job.id}</code> as the support reference and review tracked
            partial writes before starting a replacement.
          </p>
        </>
      );
    }
    return (
      <div className="migration-truth-callout is-limited" role="alert">
        <strong>Migration stopped before completion.</strong>
        <span>
          Provider and server detail is intentionally withheld. Review tracked
          partial writes and rollback evidence for job <code>{job.id}</code>{" "}
          before retrying.
        </span>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="migration-truth-callout is-limited" role="status">
        <strong>Completion snapshot is not verified.</strong>
        <span>
          The desktop client has no final job record. Close this window and
          refresh migration history before treating the import as complete.
        </span>
      </div>
    );
  }

  if (job.status === "rolled_back") {
    return (
      <div className="migration-wizard-verification">
        <div className="migration-truth-callout is-warning" role="status">
          <strong>
            The server reports that this migration was rolled back.
          </strong>
          <span>
            Job <code>{job.id}</code> · source <code>{job.source}</code>. Any
            attached import report describes the original represented scope; it
            is not final deletion proof.
          </span>
        </div>
        <MigrationVerificationEvidence job={job} />
      </div>
    );
  }

  if (job.status !== "completed") {
    return (
      <div className="migration-truth-callout is-warning" role="status">
        <strong>A terminal completion snapshot is not verified.</strong>
        <span>
          Job <code>{job.id}</code> is still reported as{" "}
          <code>{job.status}</code>. Close this window and refresh migration
          history before treating the import as complete.
        </span>
      </div>
    );
  }

  const rollbackDeadline = verifiedFutureTime(job.rollback_until);
  const imported =
    job.verification_report?.subscribers_imported ??
    job.progress?.subscribers_done;
  const limitedCutover =
    job.source === "beehiiv" ||
    job.source === "klaviyo" ||
    job.source === "customerio";
  return (
    <div className="migration-wizard-verification">
      <div
        className={`migration-truth-callout ${limitedCutover ? "is-limited" : "is-supported"}`}
        role="status"
      >
        <strong>
          {job.source === "beehiiv"
            ? "Initial import finished; cutover is not certified."
            : job.source === "klaviyo"
              ? "Initial import finished; Klaviyo cutover is not certified."
              : job.source === "customerio"
                ? "Initial import finished; Customer.io cutover is not certified."
                : "The server reports that the migration completed."}
        </strong>
        <span>
          Job <code>{job.id}</code> · source <code>{job.source}</code>
        </span>
        <span>
          {rollbackDeadline ? (
            <>
              Verified rollback deadline:{" "}
              <TimeEvidence value={rollbackDeadline} />
            </>
          ) : (
            "No currently valid rollback deadline was verified. Do not assume a seven-day window."
          )}
        </span>
      </div>

      <MigrationVerificationEvidence job={job} />

      {job.source === "klaviyo" ? (
        <div className="migration-truth-callout is-limited">
          <strong>Klaviyo cutover requires separate final evidence.</strong>
          <span>
            Freeze source changes; run the final full-snapshot delta plus fresh
            verification and shadow checks; rebuild, test, or retire every flow.
            Only sent email campaigns entered campaign history; SMS/push sends
            remain non-executable source-archive evidence. Stable profile
            retrieval exposed only the primary email: reconcile secondary
            addresses and independent per-address consent from the multi-email
            source-archive record, with evidence attached to consent and
            ecosystem review. Confirm that every stable-ID email A→B change was
            resolved by materializing B and disabling prior source-owned A in
            the full snapshot before incremental replay resumes. Treat
            list/segment counts and tags as the enumerated send-targetable
            projection after validated list-level suppressions, not raw
            membership. Recover or retire nullable flow/draft-message
            definitions and resolve campaign tag IDs where names/groups matter.
            The eight static source-archive checklist rows are obligations, not
            source inventory. Reports, SMS runtime and consent continuity, and
            ecommerce were not imported.
          </span>
        </div>
      ) : null}

      {job.source === "customerio" ? (
        <div className="migration-truth-callout is-limited">
          <strong>Customer.io cutover requires separate final evidence.</strong>
          <span>
            Keep the immutable US/EU workspace binding; freeze source changes;
            run a final full profile snapshot, fresh shadow verification, and
            rollback rehearsal. Rebuild, test, or retire every campaign and
            API-broadcast workflow. Sent email newsletters entered campaign
            history only with at least one explicit{" "}
            <code>language=&quot;&quot;</code> default and provable source
            composition. The lowest stable content ID represents a
            multi-default/A-B set with an explicit warning; all variants remain
            evidence, translations were never silently selected, and invalid
            layout/body composition remains source evidence. Newsletter and
            Design Studio HTML are exact source content/composition, not
            provider-rendered output; Liquid,
            CSS/assets/components/styles/transformers, and per-recipient
            rendering require validation. Transactional definitions, non-email
            sends, channel preferences and identities, object dependencies,
            deliverability, and ecosystem obligations remain read-only source
            evidence. Verify <code>cio_id</code> ownership for duplicate emails,
            authoritative email moves and deletions, global unsubscribe plus
            topic/channel preferences, profiles without email, and any
            GDPR-suppressed identifiers requiring a support export. Complete the
            consent, identity/audience, workflow rebuild, channel,
            deliverability, and ecosystem review gates. This bridge has no
            complete Customer.io profile-change feed, so source-event replay is
            not cutover evidence.
          </span>
        </div>
      ) : null}

      {job.source === "beehiiv" ? (
        <BeehiivWizardCutoverAction jobId={job.id} />
      ) : null}

      {typeof imported === "number" && imported > 0 ? (
        <div className="migration-wizard-destination-action">
          <button
            type="button"
            className="btn"
            onClick={() => openSubscribers(onClose)}
          >
            View destination subscribers ({formatMigrationCount(imported)})
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BeehiivWizardCutoverAction({
  jobId,
}: {
  jobId: string;
}): ReactElement {
  const reasonId = useId();
  const operation = useSingleFlightOperation({
    ownerId: `migration-wizard-cutover-${jobId}`,
    label: "Open hosted Beehiiv cutover review",
    detail:
      "Wait for the hosted cutover review handoff before leaving Moosewave.",
  });
  const openReview = (): void => {
    const flight = operation.run(async () => {
      const review = new URL(
        `/app/migrations/${encodeURIComponent(jobId)}`,
        `${getDashboardUrl()}/`,
      );
      try {
        await tauriApi.openUrl(review.toString());
      } catch {
        toast.error({
          message: "Hosted cutover review could not be opened.",
          detail: `No external page was confirmed. Use migration job ${jobId} as the support reference.`,
        });
      }
    });
    if (flight) void flight;
  };
  return (
    <div className="migration-wizard-cutover-action">
      <div className="migration-truth-callout is-limited">
        <strong>Beehiiv billing and automation cutover remain separate.</strong>
        <span>
          Premium memberships are metadata only; no Stripe billing objects or
          ownership were imported. Rebuild or retire automations and verify a
          separate billing handoff before cutover.
        </span>
      </div>
      <button
        type="button"
        className="btn"
        aria-disabled={operation.active || undefined}
        aria-busy={operation.active || undefined}
        aria-describedby={operation.active ? reasonId : undefined}
        onClick={() => {
          if (!operation.active) openReview();
        }}
      >
        {operation.active
          ? "Opening hosted review…"
          : "Continue Beehiiv cutover review in web"}
      </button>
      {operation.active ? (
        <p id={reasonId} className="migration-action-reason" role="status">
          The hosted review is already being opened.
        </p>
      ) : null}
    </div>
  );
}

function verifiedFutureTime(value: unknown): string | null {
  const parsed = parseMigrationTime(value);
  return parsed !== null && parsed > Date.now()
    ? new Date(parsed).toISOString()
    : null;
}

function isSourceUnavailable(message: string): boolean {
  return /unreachable|HTTP\s*5\d\d|status\s*5\d\d|5\d\d\s*(response|error)|timeout|temporarily\s+unavailable/i.test(
    message,
  );
}

function openSubscribers(onClose: () => void): void {
  onClose();
  setSection("subscribers");
}
