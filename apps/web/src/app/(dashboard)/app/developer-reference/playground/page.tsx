// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * /app/developer-reference/playground — the API playground (desktop
 * pages/APIPlayground.tsx): browse the live OpenAPI contract and send
 * requests to it with the dashboard session.
 *
 * Nested under Developer reference, which links here, rather than added as a
 * new top-level route.
 *
 * Gating. Every signed-in role may browse the reference and run the reads its
 * role allows; each operation's minimum role comes from the contract
 * (`x-required-role`, then `x-required-scopes`), and the effective role —
 * lowered by View as viewer — must meet it before Send is enabled. Nothing is
 * requested until `/auth/me` resolves, and the contract itself is fetched
 * only once identity is known, so the catalog is cached per workspace + role.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, TerminalSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { apiErrorMessage } from "@/lib/api";
import { playgroundStorageScope } from "@/lib/api-playground-storage";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";

// The workspace (runner, request transport, and contract catalog) renders only
// once identity and the contract have resolved, so it loads behind that gate
// rather than in the route's entry graph.
const PlaygroundWorkspace = dynamic(
  () =>
    import("./_components/playground-workspace").then(
      (module) => module.PlaygroundWorkspace,
    ),
  { loading: () => <SectionSkeleton rows={4} /> },
);

const DESCRIPTION =
  "Browse the live API contract and send requests with your dashboard session. Reads send on click; every change is reviewed as the exact request before it leaves.";

export default function ApiPlaygroundPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const catalogQuery = useQuery({
    queryKey: [
      ...base("api-playground", meQuery.data?.tenant_id ?? "anon", role),
      "catalog",
    ],
    queryFn: async ({ signal }) => {
      const { loadPlaygroundCatalog } =
        await import("@/lib/api-playground-transport");
      return loadPlaygroundCatalog(signal);
    },
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
    retry: false,
  });

  return (
    <DataSurfaceShell className="max-w-7xl">
      <Link
        href="/app/developer-reference"
        className="gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Developer reference
      </Link>
      <DataSurfaceHeader
        icon={TerminalSquare}
        eyebrow="Build with Moosewave"
        title="API playground"
        description={DESCRIPTION}
      />
      {meQuery.isPending ? (
        <SectionSkeleton rows={4} />
      ) : meQuery.isError || !meQuery.data ? (
        <QueryError
          title="Workspace identity could not be loaded"
          description="No API contract or request was loaded without a verified workspace context."
          onRetry={() => void meQuery.refetch()}
        />
      ) : catalogQuery.isPending ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            Loading the live API contract…
          </p>
          <SectionSkeleton rows={4} />
        </div>
      ) : catalogQuery.isError || !catalogQuery.data ? (
        <QueryError
          title="The API contract is unavailable"
          description={`${apiErrorMessage(catalogQuery.error, "The contract could not be loaded.")} No operation was made runnable from a partial or malformed contract.`}
          onRetry={() => void catalogQuery.refetch()}
        />
      ) : (
        <PlaygroundWorkspace
          key={`${meQuery.data.tenant_id}:${meQuery.data.user_id}:${role ?? "unresolved"}`}
          catalog={catalogQuery.data}
          role={role}
          scope={playgroundStorageScope(
            meQuery.data.tenant_id,
            meQuery.data.user_id,
          )}
          workspaceLabel={
            meQuery.data.workspace_name ||
            meQuery.data.workspace_slug ||
            "this workspace"
          }
        />
      )}
    </DataSurfaceShell>
  );
}
