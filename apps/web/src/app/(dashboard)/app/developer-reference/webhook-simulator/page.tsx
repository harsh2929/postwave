// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * /app/developer-reference/webhook-simulator — fire a synthetic event at an
 * outbound webhook destination and reconcile its outcome.
 *
 * Desktop has had this surface (pages/WebhookSimulator.tsx); web reached none
 * of its three routes. It is nested under Developer reference, which links to
 * it, rather than added as a new top-level route.
 *
 * ADMIN ONLY, and fail-closed. The server requires the exact effective
 * owner/admin role for every playground route (apikeys.RequireExactTenantAdmin
 * — a custom role's additive admin grant is not enough), and View as viewer
 * lowers the effective role. So until `/auth/me` proves an owner/admin session
 * that is not viewing as a viewer, the simulator is not mounted and no
 * destination, catalog or fire request is made.
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, FlaskConical } from "lucide-react";

import {
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { useAdminGate } from "@/lib/use-admin-gate";

const WebhookSimulator = dynamic(
  () =>
    import("./_components/webhook-simulator").then(
      (module) => module.WebhookSimulator,
    ),
  {
    ssr: false,
    loading: () => <SectionSkeleton rows={4} />,
  },
);

export default function WebhookSimulatorPage() {
  const gate = useAdminGate();

  return (
    <DataSurfaceShell className="max-w-5xl">
      <Link
        href="/app/developer-reference"
        className="gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Developer reference
      </Link>
      <DataSurfaceHeader
        icon={FlaskConical}
        eyebrow="Build with Moosewave"
        title="Webhook simulator"
        description="Pick an outbound webhook, review one real signed request, and inspect its durable outcome. An unresolved fire stays fenced until you reconcile it."
      />
      {gate.state === "loading" ? (
        <SectionSkeleton rows={4} />
      ) : gate.state === "error" || !gate.identity ? (
        <QueryError
          title="Workspace identity could not be loaded"
          description="No simulator catalog, destination, or fire request was made without a verified workspace context."
          onRetry={gate.retry}
        />
      ) : !gate.canWrite ? (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          Workspace owner or admin access is required to view webhook
          destinations or fire simulator events
          {gate.identity.viewer_mode === true
            ? " — you are viewing as a viewer"
            : ""}
          . No simulator catalog or destination data was loaded.
        </p>
      ) : (
        <WebhookSimulator identity={gate.identity} role={gate.role} />
      )}
    </DataSurfaceShell>
  );
}
