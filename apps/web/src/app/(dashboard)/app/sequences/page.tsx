// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { Mic2, Plus, ShieldAlert, Workflow } from "lucide-react";

import { listSequences, listTemplates } from "@/lib/voice-api";
import type { SequenceListItem } from "@/lib/voice-types";
import {
  resolveTemplateName,
  templateNameLookup,
} from "@/lib/sequence-helpers";
import { SEQUENCE_RUNTIME_UNAVAILABLE_REASON } from "@/lib/sequence-operational-availability";
import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/lib/analytics-format";
import { anyServiceNotDeployed } from "@/lib/service-availability";
import { SequencesHub } from "./_components/sequences-hub";

// One notice per page, so a fixed id is unique; server components have no
// useId. The disabled actions point their aria-describedby at it.
const NOT_DEPLOYED_ID = "sequences-not-deployed";

export default async function SequencesPage() {
  // Voice service is optional. Degrade gracefully — and per-resource — when it
  // is not up: a sequences failure must not be masked as "no sequences yet".
  const [seqResult, tplResult] = await Promise.allSettled([
    listSequences(),
    listTemplates(),
  ]);
  const rawSequences = seqResult.status === "fulfilled" ? seqResult.value : [];
  const templates = tplResult.status === "fulfilled" ? tplResult.value : [];
  const seqError =
    seqResult.status === "rejected"
      ? errorText(seqResult.reason, "Sequences could not be loaded.")
      : null;
  const tplError =
    tplResult.status === "rejected"
      ? errorText(tplResult.reason, "Sequence templates could not be loaded.")
      : null;
  // Both reads answered 503 service_not_deployed: this environment doesn't
  // run sequences. That is not an outage that "will return", and creating or
  // generating one here cannot work, so those actions are switched off.
  const notDeployed = anyServiceNotDeployed(
    seqResult.status === "rejected" ? seqResult.reason : undefined,
    tplResult.status === "rejected" ? tplResult.reason : undefined,
  );

  // Resolve the raw template_id column into a friendly template name (SEQ-038).
  const lookup = templateNameLookup(templates);
  const rows: SequenceListItem[] = rawSequences.map((s) => ({
    ...s,
    templateName: resolveTemplateName(s.templateName, lookup),
  }));

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:space-y-8 sm:px-6 sm:py-6 md:p-8">
      <header className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Sequences
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Design and review version-protected email sequence drafts in your
            voice.
          </p>
        </div>
        {notDeployed ? (
          <Button
            disabled
            aria-describedby={NOT_DEPLOYED_ID}
            className="w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            New sequence
          </Button>
        ) : (
          <Button asChild className="w-full sm:w-auto">
            <Link href="/app/sequences/new">
              <Plus className="h-4 w-4" />
              New sequence
            </Link>
          </Button>
        )}
      </header>

      {notDeployed ? (
        <ServiceNotDeployedNotice
          id={NOT_DEPLOYED_ID}
          title="Sequences aren't set up in this environment"
        >
          Sequence drafts and templates can&apos;t be listed, created or
          generated here, so those actions are switched off.
        </ServiceNotDeployedNotice>
      ) : null}

      <section
        aria-label="Sequence runtime availability"
        className="flex items-start gap-3 rounded-lg border border-warning-subtle bg-warning-subtle/40 p-4"
      >
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-warning-emphasis"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="text-sm font-medium">Draft designer only</p>
          <p className="text-sm text-muted-foreground">
            {SEQUENCE_RUNTIME_UNAVAILABLE_REASON}
          </p>
        </div>
      </section>

      {/* Discoverability for the two purpose-built surfaces that used to be
          unlinked from the hub: the sequence-template browser (SEQ-001) and
          the voice profile (SEQ-006). */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Link
          href="/app/sequence-templates"
          className="group flex min-w-0 items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
        >
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-accent text-primary">
            <Workflow className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              Sequence templates
            </span>
            <span className="block text-xs text-muted-foreground">
              {notDeployed
                ? "Not available in this environment"
                : tplError
                  ? "Templates unavailable right now"
                  : `Browse ${templates.length} ${pluralize(templates.length, "template")} to start from`}
            </span>
          </span>
        </Link>
        <Link
          href="/app/sequences/voice-profile"
          className="group flex min-w-0 items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
        >
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-accent text-primary">
            <Mic2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">Voice profile</span>
            <span className="block text-xs text-muted-foreground">
              The quiet engine behind every generated email
            </span>
          </span>
        </Link>
      </div>

      {seqError && !notDeployed ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-emphasis"
        >
          {seqError} The voice service may be down; templates and sequences will
          return when it recovers.
        </div>
      ) : null}
      {tplError && !seqError && !notDeployed ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {tplError} You can still work with existing sequences below.
        </div>
      ) : null}

      <div data-tour="dashboard-sequence-library" className="scroll-mt-40">
        <SequencesHub
          rows={rows}
          notDeployedId={notDeployed ? NOT_DEPLOYED_ID : undefined}
        />
      </div>
    </div>
  );
}

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
