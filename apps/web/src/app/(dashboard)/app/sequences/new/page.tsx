// SPDX-License-Identifier: AGPL-3.0-only
import { listTemplates } from "@/lib/voice-api";
import { SequenceBuilder } from "./_components/sequence-builder";
import {
  DeferredAiBriefPanel,
  DeferredTemplatePicker,
} from "./_components/deferred-panels";

export default async function NewSequencePage() {
  let templates: Awaited<ReturnType<typeof listTemplates>> = [];
  let templateLoadError: string | null = null;
  try {
    templates = await listTemplates();
  } catch (error) {
    templateLoadError =
      error instanceof Error ? error.message : "Template starters unavailable.";
  }
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:space-y-8 sm:px-6 sm:py-6 md:p-8">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          New sequence
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drag steps from the palette onto the canvas, or pick a template below
          to start from a curated structure.
        </p>
      </header>
      <SequenceBuilder />
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Or generate from a brief
        </h2>
        <DeferredAiBriefPanel />
      </section>
      {templates.length > 0 || templateLoadError ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Or start from a template
          </h2>
          <DeferredTemplatePicker
            templates={templates}
            loadError={templateLoadError}
          />
        </section>
      ) : null}
    </div>
  );
}
