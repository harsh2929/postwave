// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/** Exact-admin configuration plus static, non-tenant release availability. */
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Boxes, RefreshCw, ShieldCheck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { whoami } from "@/lib/auth-api";
import { onContextEpochObserved, readContextEpoch } from "@/lib/context-epoch";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import {
  SERVICE_SUITE_QUERY_ROOT,
  serviceSuiteIdentity,
  type ServiceSuiteIdentity,
} from "@/lib/service-suite-access";
import {
  getServiceSuiteCatalog,
  getServiceSuiteConfig,
  type ServiceCapability,
} from "@/lib/service-suite-api";
import { useAppOrigin } from "@/lib/use-app-origin";

import { CustomerHubConfigEditor } from "./customer-hub-config-editor";

// Below the fold and never on the critical path: the Customer Agent draft
// panel loads on demand so the held control costs the route no initial JS.
const CustomerAgentPanel = dynamic(
  () =>
    import("./customer-agent-panel").then(
      (module) => module.CustomerAgentPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading Customer Agent draft panel"
        className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
      >
        Loading Customer Agent draft panel…
      </div>
    ),
  },
);

const ServiceSuiteOperations = dynamic(
  () =>
    import("./service-suite-operations").then(
      (module) => module.ServiceSuiteOperations,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
      >
        Loading protected Helpdesk operations…
      </div>
    ),
  },
);

export default function ServiceSuitePage() {
  const queryClient = useQueryClient();
  const origin = useAppOrigin();
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  useEffect(() => onContextEpochObserved(setContextEpoch), []);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const verifiedAfterMount =
    meQuery.isFetchedAfterMount && !meQuery.isFetching && meQuery.isSuccess;
  const identity = useMemo(
    () =>
      verifiedAfterMount
        ? serviceSuiteIdentity({
            me: meQuery.data ?? null,
            origin,
            contextEpoch,
          })
        : null,
    [contextEpoch, meQuery.data, origin, verifiedAfterMount],
  );

  useEffect(() => {
    const serviceSuiteQuery = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === SERVICE_SUITE_QUERY_ROOT;
    if (!identity) {
      void queryClient.cancelQueries({ predicate: serviceSuiteQuery });
      queryClient.removeQueries({ predicate: serviceSuiteQuery });
      return;
    }
    const retired = (query: { queryKey: readonly unknown[] }) =>
      serviceSuiteQuery(query) && query.queryKey[1] !== identity.fingerprint;
    void queryClient.cancelQueries({ predicate: retired });
    queryClient.removeQueries({ predicate: retired });
    return () => {
      void queryClient.cancelQueries({ predicate: serviceSuiteQuery });
      queryClient.removeQueries({ predicate: serviceSuiteQuery });
    };
  }, [identity, queryClient]);

  if (
    meQuery.isPending ||
    meQuery.isFetching ||
    !meQuery.isFetchedAfterMount ||
    (meQuery.isSuccess && (!origin || !contextEpoch))
  ) {
    return (
      <BoundaryMessage title="Service suite" body="Verifying admin access…" />
    );
  }

  if (meQuery.isError) {
    return (
      <OperationsShell className="max-w-5xl">
        <OperationsHeader
          icon={Boxes}
          eyebrow="Release controls"
          title="Service suite"
          description="Review stored workspace configuration separately from static platform availability."
        />
        <OperationsFailure
          title="Admin access could not be verified"
          description="No service-suite configuration, catalog, or Helpdesk record was requested. Check the connection and try again."
          onRetry={() => void meQuery.refetch()}
          retrying={meQuery.isFetching}
        />
      </OperationsShell>
    );
  }

  if (!identity) {
    return (
      <BoundaryMessage
        title="Service suite"
        body="Owner or admin access is required. No service-suite configuration or tenant content was requested for this role or view-as context."
      />
    );
  }

  return (
    <ServiceSuiteAdminPage key={identity.fingerprint} identity={identity} />
  );
}

function BoundaryMessage({ title, body }: { title: string; body: string }) {
  return (
    <OperationsShell className="max-w-5xl">
      <OperationsHeader
        icon={Boxes}
        eyebrow="Release controls"
        title={title}
        description={body}
      />
      <div
        role="status"
        className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
      >
        {body}
      </div>
    </OperationsShell>
  );
}

function ServiceSuiteAdminPage({
  identity,
}: {
  identity: ServiceSuiteIdentity;
}) {
  const [section, setSection] = useState<"availability" | "helpdesk">(
    "availability",
  );
  const config = useQuery({
    queryKey: [...identity.queryBase, "config"],
    queryFn: ({ signal }) =>
      getServiceSuiteConfig(identity.tenantId, { signal }),
    staleTime: STALE.reference,
  });
  const catalog = useQuery({
    queryKey: [...identity.queryBase, "catalog"],
    queryFn: ({ signal }) => getServiceSuiteCatalog({ signal }),
    staleTime: STALE.reference,
  });
  const c = config.data;
  const cat = catalog.data;

  return (
    <OperationsShell className="max-w-5xl">
      <OperationsHeader
        icon={Boxes}
        eyebrow="Release controls"
        title="Service suite availability"
        description="Compare stored workspace intent with static release metadata, or open the protected Helpdesk record queue. Neither view proves a customer runtime, provider execution, or delivery path."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void Promise.all([config.refetch(), catalog.refetch()]);
            }}
            loading={config.isFetching || catalog.isFetching}
          >
            <RefreshCw aria-hidden />
            Refresh availability
          </Button>
        }
      />

      <Tabs
        value={section}
        onValueChange={(value) =>
          setSection(value === "helpdesk" ? "helpdesk" : "availability")
        }
      >
        <TabsList aria-label="Service suite sections">
          <TabsTrigger value="availability">Availability</TabsTrigger>
          <TabsTrigger value="helpdesk">Helpdesk operations</TabsTrigger>
        </TabsList>

        <TabsContent value="availability" className="space-y-5">
          <OperationsSection
            id="ss-config"
            title="Recorded workspace configuration"
            description="Tenant-bound values saved by an administrator, and the form that replaces them. An absent record is not a configured default."
          >
            {config.isPending ? (
              <OperationsLoading
                label="Loading workspace configuration"
                rows={4}
              />
            ) : config.isError || !c ? (
              <OperationsFailure
                title="Workspace configuration could not be shown"
                description="The tenant-bound response failed or did not match the supported contract. Static release metadata is still evaluated separately."
                onRetry={() => void config.refetch()}
                retrying={config.isFetching}
              />
            ) : (
              <>
                {c.version === "absent" ? (
                  <div className="rounded-lg border border-dashed p-6 text-center">
                    <p className="text-sm font-medium">
                      No stored configuration
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      This workspace has not recorded service-suite
                      preferences. The form below starts from the server&apos;s
                      defaults for a new record; they are not presented as
                      configured until an administrator saves them.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-3 rounded-lg bg-muted/35 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium">
                          Stored status: {humanize(c.status)}
                        </p>
                        <p className="mt-1 break-words text-muted-foreground">
                          Runtime held · {humanize(c.runtimeReasonCode)}
                        </p>
                      </div>
                      <Badge variant="outline">
                        Customer agent effectively off
                      </Badge>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      Stored toggles express admin intent only. They do not
                      prove publication, a storefront runtime, provider
                      execution, or customer availability.
                    </p>
                  </>
                )}
                <CustomerHubConfigEditor
                  identity={identity}
                  config={c}
                  verifiedAt={config.dataUpdatedAt}
                  onRefresh={() => void config.refetch()}
                  refreshing={config.isFetching}
                />
                {c.version === "absent" ? null : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Last recorded update:{" "}
                    {formatWireTimestamp(c.updatedAt, "never")}
                  </p>
                )}
              </>
            )}
          </OperationsSection>

          <OperationsSection
            id="ss-release"
            title="Static release availability"
            description="Platform-wide catalog metadata; it is not tenant-bound evidence."
          >
            {catalog.isPending ? (
              <OperationsLoading
                label="Loading static release catalog"
                rows={5}
              />
            ) : catalog.isError || !cat ? (
              <OperationsFailure
                title="Static catalog could not be shown"
                description="The platform response failed or did not match the supported contract. Workspace configuration above remains independent."
                onRetry={() => void catalog.refetch()}
                retrying={catalog.isFetching}
              />
            ) : (
              <>
                <p className="text-sm leading-6 text-muted-foreground">
                  This catalog is static server metadata and is not
                  tenant-bound. Outbound reply delivery, inbound email bridging,
                  privacy lifecycle, customer-hub runtime, channel runtime, and
                  macro usage evidence remain release-held. Customer-agent
                  writes, spam assessment writes, and resource creation are also
                  held. The archived customer-agent implementation mode is
                  deterministic template only; it is not an available runtime or
                  provider execution.
                </p>
                {cat.capabilities.length === 0 ? (
                  <p className="mt-4 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    No capability entries are published in this catalog.
                  </p>
                ) : (
                  <ul className="mt-4 divide-y overflow-hidden rounded-lg border">
                    {cat.capabilities.map((capability) => (
                      <CapabilityRow
                        key={capability.key}
                        capability={capability}
                      />
                    ))}
                  </ul>
                )}
                <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                  <Guardrail
                    label="Draft-only artifacts"
                    value={cat.guardrail.draftOnly}
                  />
                  <Guardrail
                    label="Provider execution blocked"
                    value={!cat.guardrail.providerExecuted}
                  />
                  <Guardrail
                    label="Customer mutations blocked"
                    value={!cat.guardrail.customerMutations}
                  />
                  <Guardrail
                    label="Human review required"
                    value={cat.guardrail.requiresHumanReview}
                  />
                </div>
              </>
            )}
          </OperationsSection>

          <OperationsSection
            id="ss-customer-agent"
            title="Customer Agent draft"
            description="The draft-reply verb reads its availability from the static catalog above. While the catalog reports it held, no request leaves this page."
          >
            {catalog.isPending ? (
              <OperationsLoading
                label="Loading Customer Agent availability"
                rows={2}
              />
            ) : (
              <CustomerAgentPanel catalog={cat ?? null} />
            )}
          </OperationsSection>

          <OperationsSection
            id="ss-catalog"
            title="Channel and status vocabulary"
            description="Schema tokens supported by the static catalog—not live conversations, connections, queues, or delivery paths."
          >
            {catalog.isPending ? (
              <OperationsLoading label="Loading channel vocabulary" rows={3} />
            ) : catalog.isError || !cat ? (
              <OperationsFailure
                title="Channel vocabulary could not be shown"
                description="It depends on the same static catalog response above. Retry that response to restore this section."
                onRetry={() => void catalog.refetch()}
                retrying={catalog.isFetching}
              />
            ) : (
              <>
                {cat.channels.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    No channel classifications are published in this catalog.
                  </p>
                ) : (
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {cat.channels.map((channel) => (
                      <li
                        key={channel.key}
                        className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <bdi className="break-words">{channel.label}</bdi>
                        <span className="text-xs text-muted-foreground">
                          Catalog: {humanize(channel.runtimeStatus)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Conversation-status schema tokens
                  </p>
                  {cat.conversationStatuses.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No status tokens are published.
                    </p>
                  ) : (
                    <ul
                      className="mt-2 flex flex-wrap gap-2"
                      aria-label="Conversation-status schema tokens"
                    >
                      {cat.conversationStatuses.map((status) => (
                        <li key={status}>
                          <Badge variant="secondary">{status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </OperationsSection>
        </TabsContent>

        <TabsContent value="helpdesk">
          {section === "helpdesk" ? (
            <ServiceSuiteOperations identity={identity} />
          ) : null}
        </TabsContent>
      </Tabs>
    </OperationsShell>
  );
}

function CapabilityRow({ capability }: { capability: ServiceCapability }) {
  return (
    <li className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="break-words">{humanize(capability.key)}</span>
      <span className="break-words text-xs text-muted-foreground sm:text-right">
        {humanize(capability.status)}
        {capability.code ? ` · ${capability.code}` : ""}
        {capability.executionMode
          ? ` · archived mode: ${humanize(capability.executionMode)}`
          : ""}
      </span>
    </li>
  );
}

function Guardrail({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border p-3">
      <ShieldCheck
        className={value ? "size-4 text-success" : "size-4 text-destructive"}
        aria-hidden
      />
      <span>{label}</span>
      <span className="sr-only">: {value ? "yes" : "no"}</span>
    </div>
  );
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
