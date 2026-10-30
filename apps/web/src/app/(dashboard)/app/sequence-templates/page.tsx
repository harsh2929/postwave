// SPDX-License-Identifier: AGPL-3.0-only
import { Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { Button } from "@/components/ui/button";
import { asRoute } from "@/lib/typed-routes";
import { ApiError } from "@/lib/api";
import { isServiceNotDeployed } from "@/lib/service-availability";
import { listTemplates } from "@/lib/voice-api";

import { SequenceTemplatesBrowser } from "./sequence-templates-browser";

// One notice per page; server components have no useId.
const NOT_DEPLOYED_ID = "sequence-templates-not-deployed";

export default async function SequenceTemplatesPage() {
  let templates: Awaited<ReturnType<typeof listTemplates>> = [];
  let loadError: string | null = null;
  // 503 service_not_deployed: this environment doesn't run sequences. Said
  // once, with no "Try again", and the create action switched off.
  let notDeployed = false;
  try {
    templates = await listTemplates();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login?next=%2Fapp%2Fsequence-templates");
    }
    notDeployed = isServiceNotDeployed(error);
    loadError =
      error instanceof Error
        ? error.message
        : "Sequence templates could not be loaded.";
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-7 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
            <Workflow className="h-4 w-4" />
            Voice sequences
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Sequence templates
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Multi-email writing structures for launches, onboarding, nurture,
            and re-engagement. These are separate from the visual newsletter
            designs used by campaigns.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/app/templates">Newsletter designs</Link>
          </Button>
          {notDeployed ? (
            <Button
              disabled
              aria-describedby={NOT_DEPLOYED_ID}
              className="w-full sm:w-auto"
            >
              <Plus className="h-4 w-4" />
              New template
            </Button>
          ) : (
            <Button asChild className="w-full sm:w-auto">
              <Link href={asRoute("/app/sequence-templates/new")}>
                <Plus className="h-4 w-4" />
                New template
              </Link>
            </Button>
          )}
        </div>
      </header>

      {notDeployed ? (
        <ServiceNotDeployedNotice
          id={NOT_DEPLOYED_ID}
          title="Sequence templates aren't set up in this environment"
        >
          Templates can&apos;t be browsed or created here, so creating one is
          switched off. Newsletter designs still work.
        </ServiceNotDeployedNotice>
      ) : (
        <SequenceTemplatesBrowser templates={templates} loadError={loadError} />
      )}
    </div>
  );
}
