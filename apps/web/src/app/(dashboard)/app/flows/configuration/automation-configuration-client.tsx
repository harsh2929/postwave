// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, ShieldCheck } from "lucide-react";
import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON,
  AUTOMATIONS_RUNTIME_AVAILABLE,
  OMNICHANNEL_DRAFT_CREATION_AVAILABLE,
  OMNICHANNEL_EXECUTION_AVAILABLE,
  TRIGGER_DELAY_LEARNING_AVAILABLE,
  ZERO_COPY_ALERTING_AVAILABLE,
  ZERO_COPY_DLQ_RECOVERY_AVAILABLE,
  ZERO_COPY_LIVE_POLL_AVAILABLE,
} from "@/lib/automation-operational-availability";
const ZeroCopyDraftsPanel = dynamic(
  () =>
    import("./zero-copy-drafts-panel").then(
      (module) => module.ZeroCopyDraftsPanel,
    ),
  { ssr: false, loading: () => <ConfigurationPanelLoading /> },
);
const TriggerDelayPanel = dynamic(
  () =>
    import("./trigger-delay-panel").then(
      (module) => module.TriggerDelayPanel,
    ),
  { ssr: false, loading: () => <ConfigurationPanelLoading /> },
);

export function AutomationConfigurationClient() {
  const [section, setSection] = useState<"warehouse" | "timing">("warehouse");
  const [timingActivated, setTimingActivated] = useState(false);
  const me = useQuery({ queryKey: ["whoami"], queryFn: whoami });
  if (me.isPending)
    return (
      <PageShell>
        <p role="status">Loading automation configuration authority…</p>
      </PageShell>
    );
  if (me.isError)
    return (
      <PageShell>
        <div role="alert" className="space-y-3 rounded-lg border border-destructive p-4">
          <p>{apiErrorMessage(me.error, "Workspace authority could not be loaded")}</p>
          <Button variant="outline" onClick={() => void me.refetch()}>
            <RefreshCw aria-hidden className="size-4" /> Retry
          </Button>
        </div>
      </PageShell>
    );

  const identity = me.data;
  const canAdmin =
    !identity.viewer_mode &&
    ["owner", "admin"].includes(effectiveAuthRole(identity));
  const queryScope = [
    "automation-configuration",
    identity.tenant_id,
    identity.user_id,
    effectiveAuthRole(identity),
    Boolean(identity.viewer_mode),
  ] as const;
  const runtimeFlagsClosed =
    !AUTOMATIONS_RUNTIME_AVAILABLE &&
    !ZERO_COPY_LIVE_POLL_AVAILABLE &&
    !ZERO_COPY_ALERTING_AVAILABLE &&
    !ZERO_COPY_DLQ_RECOVERY_AVAILABLE &&
    !TRIGGER_DELAY_LEARNING_AVAILABLE &&
    !OMNICHANNEL_DRAFT_CREATION_AVAILABLE &&
    !OMNICHANNEL_EXECUTION_AVAILABLE;

  return (
    <PageShell>
      <header className="space-y-3">
        <Button asChild variant="ghost" className="w-fit">
          <Link href="/app/flows"><ArrowLeft aria-hidden className="size-4" /> Back to flows</Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">Automation configuration</h1>
          <p className="text-sm text-muted-foreground">
            Safe, inert configuration parity for warehouse trigger drafts and manual timing overrides.
          </p>
        </div>
      </header>

      <div role="note" className="space-y-3 rounded-lg border border-warning/50 bg-warning/10 p-4">
        <div className="flex gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div>
            <h2 className="font-semibold">Draft-only operational boundary</h2>
            <p className="text-sm">{AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON}</p>
          </div>
        </div>
        <ol className="grid gap-2 text-sm sm:grid-cols-4">
          <li className="rounded-md border bg-background/70 p-3"><strong className="block">1. Define</strong>Available for the two scoped configuration stores.</li>
          <li className="rounded-md border bg-background/70 p-3"><strong className="block">2. Validate</strong>Input and SQL policy only; no live dependency check.</li>
          <li className="rounded-md border bg-background/70 p-3"><strong className="block text-destructive">3. Execute</strong>Release-held; no activation or polling control is rendered.</li>
          <li className="rounded-md border bg-background/70 p-3"><strong className="block text-destructive">4. Observe</strong>Read-only; enqueue records, alert thresholds, and recovery entries can be inspected per draft, but none is delivery proof and no poll, alert-edit, or retry control is rendered.</li>
        </ol>
        {!runtimeFlagsClosed ? (
          <p role="alert" className="font-medium text-destructive">
            The compiled availability policy is inconsistent. Runtime controls remain withheld.
          </p>
        ) : null}
      </div>

      <Tabs
        value={section}
        onValueChange={(next) => {
          const selected = next === "timing" ? "timing" : "warehouse";
          if (selected === "timing") setTimingActivated(true);
          setSection(selected);
        }}
      >
        <TabsList aria-label="Automation configuration sections">
          <TabsTrigger value="warehouse">Warehouse drafts</TabsTrigger>
          <TabsTrigger value="timing">Manual timing override</TabsTrigger>
        </TabsList>
        <TabsContent
          value="warehouse"
          forceMount
          className="pt-3 data-[state=inactive]:hidden"
        >
          <ZeroCopyDraftsPanel
            me={identity}
            queryScope={queryScope}
            canAdmin={canAdmin}
          />
        </TabsContent>
        {timingActivated ? (
          <TabsContent
            value="timing"
            forceMount
            className="pt-3 data-[state=inactive]:hidden"
          >
            <TriggerDelayPanel
              me={identity}
              queryScope={queryScope}
              canAdmin={canAdmin}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageShell>
  );
}

function ConfigurationPanelLoading() {
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      role="status"
      aria-live="polite"
      aria-label="Loading automation configuration panel"
    >
      <div className="h-5 w-48 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
    </section>
  );
}
